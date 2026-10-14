/*
 * 打包「增量更新」用的内容树 + 安装包自带内容（baseline）
 *
 * 用法：node tools/pack-update.mjs [--version 0.21.0] [--content .] [--baseline baseline] [--out updates-dist] [--no-prune]
 *
 * 产出：
 *   baseline/            安装包自带的内容（dist + dist-electron + state.json），首次安装/离线可玩
 *   updates-dist/
 *     manifest.json      玩家端要对比的清单（每个文件 sha256 + 大小 + 下载地址）
 *     files/<xx>/<sha>   内容寻址的文件实体（未变的文件不重复上传，服务器只存一份）
 *     state.json         与清单配套的本地记录模板（baseline 里也放一份）
 *
 * 输出会打印两组数字：
 *   「玩家端要下载」= 相对上一个清单变化的文件（这就是每次更新玩家真正下载的量）
 *   「需要上传」    = 服务器上还没有的文件实体
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);

const repo = process.cwd();
const contentDir = path.resolve(repo, argOf('content', '.'));
const baselineDir = path.resolve(repo, argOf('baseline', 'baseline'));
const outDir = path.resolve(repo, argOf('out', 'updates-dist'));
const prune = !has('no-prune');

const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf-8'));
const version = String(argOf('version', pkg.version)).replace(/^v/, '');

/** 参与增量更新的内容 = 渲染层产物 + 主进程产物 */
const CONTENT_PARTS = ['dist', 'dist-electron'];

/** 开发端隔离硬校验：内容树里只允许这两类目录，开发工具（tools/ 等）绝不允许进安装包或更新清单 */
const ALLOWED_PREFIX = CONTENT_PARTS.map((p) => p + '/');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
const kb = (n) => (n >= 1048576 ? mb(n) : (n / 1024).toFixed(1) + ' KB');

function walk(dir, sub = '') {
  const out = [];
  const base = sub ? path.join(dir, sub) : dir;
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = sub ? sub + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// ===== 1. 扫描内容并计算哈希 =====
const files = {};
let totalBytes = 0;
for (const part of CONTENT_PARTS) {
  const root = path.join(contentDir, part);
  if (!fs.existsSync(root)) {
    console.error(`✗ 找不到 ${part}（请先执行 npm run build）`);
    process.exit(1);
  }
  for (const rel of walk(root)) {
    const abs = path.join(root, rel);
    const buf = fs.readFileSync(abs);
    const h = sha256(buf);
    files[`${part}/${rel}`] = { sha256: h, size: buf.length, url: `files/${h.slice(0, 2)}/${h}` };
    totalBytes += buf.length;
  }
}

// ===== 2. 与上一个清单对比（玩家端要下载多少）=====
// 先做开发端隔离校验：任何不属于 dist/ dist-electron/ 的路径都不允许被打进去
for (const rel of Object.keys(files)) {
  if (!ALLOWED_PREFIX.some((p) => rel.startsWith(p))) {
    console.error(`✗ 打包内容里出现了不该出现的路径：${rel}（只允许 dist/ 与 dist-electron/，开发工具不能被玩家下载到）`);
    process.exit(1);
  }
}
const prevManifestPath = path.join(outDir, 'manifest.json');
let prev = null;
try {
  prev = JSON.parse(fs.readFileSync(prevManifestPath, 'utf-8'));
} catch {
  prev = null;
}

let changed = [];
let removed = [];
if (prev && prev.files) {
  for (const [rel, info] of Object.entries(files)) {
    if (!prev.files[rel] || prev.files[rel].sha256 !== info.sha256) changed.push({ rel, size: info.size });
  }
  for (const rel of Object.keys(prev.files)) if (!files[rel]) removed.push(rel);
} else {
  changed = Object.entries(files).map(([rel, info]) => ({ rel, size: info.size }));
}

// ===== 3. 生成 baseline（安装包自带内容）=====
if (!has('skip-baseline')) {
  fs.rmSync(baselineDir, { recursive: true, force: true });
  for (const part of CONTENT_PARTS) copyFileAll(path.join(contentDir, part), path.join(baselineDir, part));
}

function copyFileAll(srcDir, dstDir) {
  for (const rel of walk(srcDir)) copyFile(path.join(srcDir, rel), path.join(dstDir, rel));
}

const state = { version, files: Object.fromEntries(Object.entries(files).map(([rel, i]) => [rel, i.sha256])) };
fs.writeFileSync(path.join(baselineDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');

// ===== 4. 写内容寻址文件实体（服务器上已有的不重复放）=====
const blobRoot = path.join(outDir, 'files');
let uploadedBytes = 0;
let uploadedCount = 0;
for (const [rel, info] of Object.entries(files)) {
  const dst = path.join(blobRoot, info.sha256.slice(0, 2), info.sha256);
  if (fs.existsSync(dst)) continue;
  copyFile(path.join(contentDir, rel), dst);
  uploadedBytes += info.size;
  uploadedCount++;
}

// ===== 5. 写清单 =====
const manifest = {
  version,
  generatedAt: new Date().toISOString(),
  note: `Lycee Overture 对战平台 内容包 v${version}`,
  files,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(prevManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');

// ===== 5.1 生成「这次要上传到服务器的文件」清单 =====
// 规则：始终上传 manifest.json；文件实体只需要传「相对上一个清单变化」的那些。
//   · 玩家端永远只需要"相对自己已装版本变化"的文件，而这些变化都包含在差量里；
//   · 首次发布（没有上一个清单）时，内容已经随安装包发出去（baseline），
//     所以只需要上传 manifest.json —— 不用传 111 MB。
const uploadList = ['manifest.json'];
if (prev && prev.files) {
  for (const c of changed) {
    const info = files[c.rel];
    if (info) uploadList.push(`files/${info.sha256.slice(0, 2)}/${info.sha256}`);
  }
}
fs.writeFileSync(path.join(outDir, 'upload-list.txt'), uploadList.join('\n') + '\n', 'utf-8');

// ===== 6. 清理服务器上不再被引用的实体 =====
let pruned = 0;
if (prune && fs.existsSync(blobRoot)) {
  const used = new Set(Object.values(files).map((i) => i.sha256));
  for (const d of fs.readdirSync(blobRoot)) {
    const dir = path.join(blobRoot, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!used.has(f)) {
        fs.unlinkSync(path.join(dir, f));
        pruned++;
      }
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
}

// ===== 7. 报告 =====
const changedBytes = changed.reduce((s, x) => s + x.size, 0);
console.log('');
console.log(`内容版本：v${version}`);
console.log(`内容文件：${Object.keys(files).length} 个，合计 ${mb(totalBytes)}（含卡图）`);
console.log('');
console.log(`▶ 玩家端本次需下载：${changed.length} 个文件，${kb(changedBytes)}${prev ? `（上一清单 v${prev.version}）` : '（首次发布，等于全部内容）'}`);
if (changed.length > 0) {
  for (const c of changed.slice().sort((a, b) => b.size - a.size).slice(0, 25)) console.log(`     ${kb(c.size).padStart(10)}  ${c.rel}`);
  if (changed.length > 25) console.log(`     … 其余 ${changed.length - 25} 个略`);
}
if (removed.length) console.log(`   同时会删除 ${removed.length} 个旧文件`);
console.log('');
console.log(`▶ 需要上传到服务器的文件：${uploadList.length} 个，${kb(
  uploadList.filter((p) => p.startsWith('files/')).reduce((s, p) => {
    const hit = Object.values(files).find((i) => `files/${i.sha256.slice(0, 2)}/${i.sha256}` === p);
    return s + (hit ? hit.size : 0);
  }, 0),
)}${prev ? '' : '（首次发布：内容随安装包发出，只需传 manifest.json）'}`);
console.log(`   清单文件：${path.join(outDir, 'upload-list.txt')}`);
console.log(`   上传脚本：powershell -File tools/upload-updates.ps1 -Server ubuntu@你的服务器IP`);
console.log(`   上传目录：${outDir}`);
console.log('');
console.log('提示：卡图（dist/images/*.png）哈希不变就不会重复上传/下载，这是「只更新改动部分」的关键。');
if (pruned) console.log(`（已清理服务器上不再引用的实体 ${pruned} 个）`);
