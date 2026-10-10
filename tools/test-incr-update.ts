/*
 * 增量更新测试：node/tsx tools/test-incr-update.ts
 *
 * 覆盖：
 *   1. 版本比较
 *   2. 差量计算（只列哈希变化的文件、算出要下载的字节数、识别要删除的旧文件）
 *   3. 清单安全校验（路径穿越、假哈希）
 *   4. 端到端：起一个真实的静态分发（复用中继服务器的 /updates 路由），
 *      在临时内容目录上跑一次真实的"检查 → 下载 → 逐文件 sha256 校验 → 暂存"，
 *      断言「只下载了变化的文件」且字节数与差量一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startRelay } from '../server/index.js';
import {
  compareVersion,
  isSafeRel,
  planUpdate,
  checkAndStage,
  updateBaseUrl,
  type IncrManifest,
  type IncrState,
  type IncrStatus,
} from '../electron/incrUpdate.js';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, name: string, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
};
const eq = (a: unknown, b: unknown, name: string) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

const sha = (buf: Buffer | string) => crypto.createHash('sha256').update(buf).digest('hex');

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lycee-${tag}-`));
}
function write(p: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

console.log('\n[1] 版本比较');
eq(compareVersion('0.21.0', '0.20.1'), 1, '0.21.0 > 0.20.1');
eq(compareVersion('0.20.1', '0.20.1'), 0, '相等');
eq(compareVersion('v0.20.0', '0.20.1'), -1, '旧版本（带 v 前缀）');
eq(compareVersion('0.21.10', '0.21.9'), 1, '多位数字按数值比较');

console.log('\n[2] 清单安全校验');
ok(isSafeRel('dist/index.html'), '正常相对路径通过');
ok(isSafeRel('dist-electron/main.js'), '主进程路径通过');
ok(!isSafeRel('../evil.js'), '拒绝 ../');
ok(!isSafeRel('C:/Windows/system32/x.dll'), '拒绝绝对路径');
ok(!isSafeRel('dist\\..\\evil.js'), '拒绝反斜杠路径');

console.log('\n[3] 差量计算');
const localState: IncrState = {
  version: '0.20.1',
  files: { 'dist/index.html': sha('a'), 'dist/old.js': sha('old'), 'dist/images/keep.png': sha('keep') },
};
const remoteManifest: IncrManifest = {
  version: '0.21.0',
  files: {
    'dist/index.html': { sha256: sha('a'), size: 1, url: 'files/x/' + sha('a') }, // 未变
    'dist/images/keep.png': { sha256: sha('keep'), size: 4, url: 'files/y/' + sha('keep') }, // 未变
    'dist/assets/new.js': { sha256: sha('new'), size: 100, url: 'files/z/' + sha('new') }, // 新增
    'dist/assets/index.js': { sha256: sha('changed'), size: 2048, url: 'files/w/' + sha('changed') }, // 变化
  },
};
const plan = planUpdate(remoteManifest, localState, tmpDir('plan'));
eq(plan.need.length, 2, '只列出 2 个需要下载的文件');
eq(plan.bytes, 2148, '要下载的字节数正确');
eq(plan.obsolete.length, 1, '识别出 1 个应删除的旧文件');
eq(plan.obsolete[0], 'dist/old.js', '被删除的是 dist/old.js');

console.log('\n[4] 本地没有清单时按实际文件哈希判断');
const root4 = tmpDir('hash');
write(path.join(root4, 'dist', 'images', 'keep.png'), 'keep');
const plan4 = planUpdate(
  { version: '0.21.0', files: { 'dist/images/keep.png': { sha256: sha('keep'), size: 4, url: 'u' } } },
  { version: '', files: {} },
  root4,
);
eq(plan4.need.length, 0, '内容一致的文件不会被重复下载');

console.log('\n[5] 端到端：真实静态分发 + 真实下载校验');
async function main(): Promise<void> {
const serverRoot = tmpDir('updroot'); // 服务器上的 updates 目录
const contentRoot = tmpDir('content'); // 客户端当前内容目录
const appRoot = tmpDir('approot'); // 客户端暂存目录

// 旧版本内容（客户端已有）
const filesV1: Record<string, string> = {
  'dist/index.html': '<html>v1</html>',
  'dist-electron/main.js': 'console.log("v1")',
  'dist/images/LO-1.png': 'PNG-AA',
  'dist/images/LO-2.png': 'PNG-BB',
};
const stateV1: IncrState = { version: '0.21.0', files: {} };
for (const [rel, content] of Object.entries(filesV1)) {
  write(path.join(contentRoot, rel), content);
  stateV1.files[rel] = sha(content);
}
write(path.join(contentRoot, 'state.json'), JSON.stringify(stateV1, null, 2));

// 新版本内容（服务器上）：改 1 个 JS、删 1 张卡图、加 1 张卡图
const filesV2: Record<string, string> = {
  'dist/index.html': '<html>v1</html>', // 未变
  'dist-electron/main.js': 'console.log("v2-changed")', // 变化（模拟改代码）
  'dist/images/LO-1.png': 'PNG-AA', // 未变
  'dist/images/LO-3.png': 'PNG-CCCCCCCC', // 新增卡图
};
const manifestV2: IncrManifest = { version: '0.21.1', generatedAt: new Date().toISOString(), files: {} };
for (const [rel, content] of Object.entries(filesV2)) {
  const h = sha(content);
  manifestV2.files[rel] = { sha256: h, size: Buffer.byteLength(content), url: `files/${h.slice(0, 2)}/${h}` };
  write(path.join(serverRoot, 'files', h.slice(0, 2), h), content);
}
write(path.join(serverRoot, 'manifest.json'), JSON.stringify(manifestV2, null, 2));

// 用中继服务器（同一进程）分发 /updates
const relay = startRelay(0, { updatesDir: serverRoot });
const port = relay.wss.address()!.port;
process.env.LYCEE_UPDATE_URL = `http://127.0.0.1:${port}/updates/`;
eq(updateBaseUrl(), `http://127.0.0.1:${port}/updates/`, '更新源地址来自环境变量');
process.env.LYCEE_CONTENT_ROOT = contentRoot;
process.env.LYCEE_APP_ROOT = appRoot;
process.env.LYCEE_CAN_UPDATE = '1';

const statuses: IncrStatus[] = [];
const result = await checkAndStage({ onStatus: (s) => statuses.push(s) });
eq(result.state, 'ready', '最终状态是 ready（已下载并校验完成）');
if (result.state === 'ready') {
  eq(result.version, '0.21.1', '版本号正确');
  eq(result.files, 2, '只下载 2 个变化的文件');
  const expectBytes = Buffer.byteLength('console.log("v2-changed")') + Buffer.byteLength('PNG-CCCCCCCC');
  eq(result.bytes, expectBytes, '下载字节数 = 只有变化的部分');
}
ok(
  statuses.some((s) => s.state === 'available') && statuses.some((s) => s.state === 'downloading'),
  '过程中有 available / downloading 状态（界面能显示体积和进度）',
);

const stagedFiles = fs.readdirSync(path.join(appRoot, 'staged', 'files', 'dist-electron'));
eq(stagedFiles.length, 1, '暂存目录里只有被改动的文件');
ok(fs.existsSync(path.join(appRoot, 'staged', '.ready')), '写入了 .ready 标记（重启才生效）');
const stagedState = JSON.parse(fs.readFileSync(path.join(appRoot, 'staged', 'state.json'), 'utf-8'));
eq(Object.keys(stagedState.files).length, 4, '新清单覆盖全部 4 个文件（用于启动时删除旧文件）');
ok(!('dist/images/LO-2.png' in stagedState.files), '新清单里已删掉旧卡图（启动时会清理）');

// 再检查一次：内容已经是最新 → 不再重复下载
eq(updateBaseUrl(), `http://127.0.0.1:${port}/updates/`, '更新源仍正确');
const again = await checkAndStage({ onStatus: () => {} });
ok(again.state === 'ready' || again.state === 'latest', '重复检查不会出错');

// 服务器路由安全性：路径穿越必须 404
const evil = await fetch(`http://127.0.0.1:${port}/updates/../../package.json`);
eq(evil.status, 404, '分发服务拒绝 ../ 路径穿越');
const notFound = await fetch(`http://127.0.0.1:${port}/updates/files/zz/none`);
eq(notFound.status, 404, '不存在的文件返回 404');
const manifestRes = await fetch(`http://127.0.0.1:${port}/updates/manifest.json`);
eq(manifestRes.headers.get('cache-control'), 'no-store', '清单不缓存（每次都拿最新）');
const blobRes = await fetch(`http://127.0.0.1:${port}/updates/files/${manifestV2.files['dist/images/LO-3.png'].sha256.slice(0, 2)}/${manifestV2.files['dist/images/LO-3.png'].sha256}`);
ok(
  (blobRes.headers.get('cache-control') || '').includes('immutable'),
  '内容寻址的文件实体可长期缓存（不重复下载）',
);

// 坏哈希必须被拒绝
const badRoot = tmpDir('badroot');
write(path.join(badRoot, 'manifest.json'), JSON.stringify({
  version: '0.22.0',
  files: { 'dist/index.html': { sha256: sha('别的什么'), size: 5, url: 'files/aa/' + sha('x') } },
}, null, 2));
const relay2 = startRelay(0, { updatesDir: badRoot });
process.env.LYCEE_UPDATE_URL = `http://127.0.0.1:${relay2.wss.address()!.port}/updates/`;
const bad = await checkAndStage({ onStatus: () => {} });
eq(bad.state, 'error', '下载内容与哈希不符时报错（不会装上坏文件）');
if (bad.state === 'error') ok(bad.message.includes('校验失败') || bad.message.includes('下载失败'), '错误信息说明了原因', bad.message);

// 不安全清单必须被拒绝
const evilRoot = tmpDir('evilroot');
write(path.join(evilRoot, 'manifest.json'), JSON.stringify({
  version: '0.23.0',
  files: { '../../evil.js': { sha256: sha('x'), size: 1, url: 'files/aa/x' } },
}, null, 2));
const relay3 = startRelay(0, { updatesDir: evilRoot });
process.env.LYCEE_UPDATE_URL = `http://127.0.0.1:${relay3.wss.address()!.port}/updates/`;
const evilResult = await checkAndStage({ onStatus: () => {} });
eq(evilResult.state, 'error', '清单里有 ../ 路径时报错，不写入');
if (evilResult.state === 'error') ok(evilResult.message.includes('不安全'), '错误信息提示路径不安全', evilResult.message);

await relay.close();
await relay2.close();
await relay3.close();
for (const d of [root4, serverRoot, contentRoot, appRoot, badRoot, evilRoot]) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
}

void main();
