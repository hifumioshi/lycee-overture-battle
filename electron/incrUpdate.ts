/*
 * 增量更新器（网游式：只下载「哈希变了」的文件）
 *
 * 与 electron-updater 的区别：
 *   electron-updater 下载的是整个安装包（190MB，且 Electron 安装包是整体压缩，差异下载几乎没效果）。
 *   这里改成：服务器放一份 manifest.json（每个文件的相对路径 + sha256 + 大小 + 下载地址），
 *   客户端对比本地记录的哈希，只下载变化的文件（改代码通常 ~0.5MB，加卡才多）。
 *
 * 安全策略：
 *   1) 全部下载到 <appRoot>/staged，边下边算 sha256，对不上直接丢弃；
 *   2) 只有全部文件校验通过才写 .ready 标记；
 *   3) 真正的替换发生在下次启动的最早期（bootstrap.js），失败会自动回退上一版本。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type IncrFile = { sha256: string; size: number; url: string };
export type IncrManifest = { version: string; files: Record<string, IncrFile>; generatedAt?: string; note?: string };
export type IncrState = { version: string; files: Record<string, string> };

export type IncrStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'latest'; version: string }
  | { state: 'available'; version: string; bytes: number; files: number }
  | { state: 'downloading'; version: string; percent: number; got: number; total: number; files: number }
  | { state: 'ready'; version: string; bytes: number; files: number }
  | { state: 'error'; message: string }
  | { state: 'unsupported'; message: string };

/** 默认更新源：与中继同机同端口（国内下载快，也不用另开防火墙端口） */
const DEFAULT_UPDATE_URL = 'http://62.234.140.123:9600/updates/';

/** 内容目录（bootstrap.js 决定：安装版在 %APPDATA%，开发/解压版在程序目录） */
export function contentRoot(): string {
  return process.env.LYCEE_CONTENT_ROOT || process.cwd();
}
/** 可写根目录（暂存更新放在这里；便携版为空 = 不支持更新） */
export function appRoot(): string {
  return process.env.LYCEE_APP_ROOT || path.join(process.env.LYCEE_CONTENT_ROOT || process.cwd(), 'app');
}
export function canIncrementalUpdate(): boolean {
  return process.env.LYCEE_CAN_UPDATE === '1';
}
/** 数据目录（卡组/战歌/语音/relay.txt 所在目录，由主进程设置） */
function dataDir(): string {
  return process.env.LYCEE_DATA_DIR || path.join(contentRoot(), '..');
}

/** 更新源地址：环境变量 > data/update.txt > 与中继同机 > 内置默认 */
export function updateBaseUrl(): string {
  const env = (process.env.LYCEE_UPDATE_URL || '').trim();
  if (env) return env.endsWith('/') ? env : env + '/';
  for (const name of ['update.txt', 'relay.txt']) {
    try {
      const raw = fs.readFileSync(path.join(dataDir(), name), 'utf-8').split(/\r?\n/)[0].trim();
      if (!raw) continue;
      if (name === 'update.txt') return raw.endsWith('/') ? raw : raw + '/';
      const host = raw.replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
      return `http://${host}/updates/`;
    } catch {
      /* 没有这个配置文件 */
    }
  }
  return DEFAULT_UPDATE_URL;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** 本地已安装内容的记录（版本 + 每个文件的哈希） */
export function readLocalState(): IncrState {
  const st = readJson<IncrState>(path.join(contentRoot(), 'state.json'));
  if (st && st.files && typeof st.version === 'string') return st;
  return { version: process.env.LYCEE_CONTENT_VERSION || '0.0.0', files: {} };
}

export function localVersion(): string {
  return readLocalState().version;
}

/** 清单里的相对路径必须安全（不能是绝对路径、不能跳出暂存目录） */
export function isSafeRel(rel: string): boolean {
  if (!rel || rel.length > 300) return false;
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel)) return false;
  if (rel.includes('..') || rel.includes('\\') || rel.includes('\0')) return false;
  return true;
}

/** 版本比较：a 比 b 新返回 1，相同 0，旧 -1（只比较数字段，忽略后缀） */
export function compareVersion(a: string, b: string): number {
  const pa = String(a).replace(/^v/, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 下载单个文件并校验 sha256（边下边算，不额外占内存） */
async function fetchFile(url: string, dest: string, expectSha: string, onBytes?: (n: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    got += buf.length;
    hash.update(buf);
    if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
    onBytes?.(buf.length);
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  const actual = hash.digest('hex');
  if (actual !== expectSha) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
    throw new Error(`文件校验失败（可能下载损坏）：${path.basename(dest)}`);
  }
  fs.renameSync(tmp, dest);
}

/** 计算本地文件哈希（仅用于本地没有 state.json 时的一次性对照，比如老版本目录） */
function hashFile(p: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

/** 需要下载哪些文件（对比远端清单与本地记录） */
export function planUpdate(
  remote: IncrManifest,
  local: IncrState,
  contentDir: string,
): { need: { rel: string; info: IncrFile }[]; obsolete: string[]; bytes: number } {
  const need: { rel: string; info: IncrFile }[] = [];
  const hasLocalState = Object.keys(local.files).length > 0;
  for (const [rel, info] of Object.entries(remote.files)) {
    if (!isSafeRel(rel)) throw new Error(`更新清单里有不安全的路径：${rel}`);
    if (!info || !/^[0-9a-f]{64}$/i.test(String(info.sha256))) throw new Error(`更新清单里的哈希不合法：${rel}`);
    const known = local.files[rel];
    if (known && known === info.sha256) continue;
    if (!hasLocalState) {
      // 没有本地清单：按实际文件哈希判断（一次性开销）
      const actual = hashFile(path.join(contentDir, rel));
      if (actual && actual === info.sha256) continue;
    }
    need.push({ rel, info });
  }
  const obsolete = Object.keys(local.files).filter((rel) => !remote.files[rel]);
  return { need, obsolete, bytes: need.reduce((s, x) => s + (x.info.size || 0), 0) };
}

export type IncrDeps = {
  onStatus: (s: IncrStatus) => void;
  /** 允许测试替换下载/清单地址 */
  fetchManifest?: (url: string) => Promise<IncrManifest>;
};

let running = false;

/** 检查并下载更新（幂等：已在下载时直接返回当前状态） */
export async function checkAndStage(deps: IncrDeps): Promise<IncrStatus> {
  if (!canIncrementalUpdate()) {
    const s: IncrStatus = { state: 'unsupported', message: '当前形态不支持自动更新（便携版请下载安装版）' };
    deps.onStatus(s);
    return s;
  }
  if (running) return { state: 'checking' };
  running = true;
  const push = deps.onStatus;
  try {
    push({ state: 'checking' });
    const base = updateBaseUrl();
    const manifestUrl = base + 'manifest.json';
    const remote = deps.fetchManifest
      ? await deps.fetchManifest(manifestUrl)
      : ((await (async () => {
          const res = await fetch(manifestUrl, { redirect: 'follow' });
          if (!res.ok) throw new Error(`获取更新清单失败 HTTP ${res.status}`);
          return (await res.json()) as IncrManifest;
        })()) as IncrManifest);
    if (!remote || !remote.files || !remote.version) throw new Error('更新清单格式不正确');

    const local = readLocalState();
    if (compareVersion(remote.version, local.version) <= 0) {
      const s: IncrStatus = { state: 'latest', version: local.version };
      push(s);
      return s;
    }

    const plan = planUpdate(remote, local, contentRoot());
    if (plan.need.length === 0) {
      // 内容没变（只改了版本号）→ 直接记下新版本
      const s: IncrStatus = { state: 'latest', version: remote.version };
      push(s);
      return s;
    }

    push({ state: 'available', version: remote.version, bytes: plan.bytes, files: plan.need.length });

    const staged = path.join(appRoot(), 'staged');
    fs.rmSync(staged, { recursive: true, force: true });
    const filesDir = path.join(staged, 'files');

    let got = 0;
    let done = 0;
    const total = plan.bytes;
    const queue = [...plan.need];
    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const url = /^https?:/i.test(item.info.url) ? item.info.url : base + item.info.url.replace(/^\//, '');
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await fetchFile(url, path.join(filesDir, item.rel), item.info.sha256, (n) => {
              got += n;
              const percent = total > 0 ? Math.min(99, Math.floor((got / total) * 100)) : 0;
              push({ state: 'downloading', version: remote.version, percent, got, total, files: plan.need.length });
            });
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
        if (lastErr) throw lastErr;
        done++;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    const nextState: IncrState = { version: remote.version, files: {} };
    for (const [rel, info] of Object.entries(remote.files)) nextState.files[rel] = info.sha256;
    fs.writeFileSync(path.join(staged, 'state.json'), JSON.stringify(nextState, null, 2), 'utf-8');
    fs.writeFileSync(path.join(staged, '.ready'), new Date().toISOString(), 'utf-8');
    // 记下待生效版本（重启后由 bootstrap 应用）
    try {
      const appStatePath = path.join(appRoot(), 'state.json');
      const prev = readJson<Record<string, unknown>>(appStatePath) || {};
      fs.writeFileSync(
        appStatePath,
        JSON.stringify({ ...prev, pendingVersion: remote.version }, null, 2),
        'utf-8',
      );
    } catch {
      /* 忽略 */
    }

    const s: IncrStatus = { state: 'ready', version: remote.version, bytes: plan.bytes, files: plan.need.length };
    push(s);
    return s;
  } catch (e) {
    const s: IncrStatus = { state: 'error', message: e instanceof Error ? e.message : String(e) };
    push(s);
    return s;
  } finally {
    running = false;
  }
}
