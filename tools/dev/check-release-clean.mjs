/*
 * 正式构建检查：确认产物里**没有**开发端功能（单人测试模式 / 对局机器人等）
 * 用法：node tools/dev/check-release-clean.mjs
 * 任一命中即退出码 1 —— 用在 npm run build:release 和打包前置检查里。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['dist', 'dist-electron'];
// 开发端功能的特征串（出现在正式产物里 = 漏出去了）
const MARKERS = ['🧪 测试模式', '测试模式：卡牌检索', '单人测试模式', 'devTest', 'devAddToHand'];

let hits = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs|css|html|json|map)$/i.test(e.name)) {
      let text = '';
      try {
        text = fs.readFileSync(p, 'utf-8');
      } catch {
        continue;
      }
      for (const m of MARKERS) if (text.includes(m)) hits.push(`${p}  ←  含「${m}」`);
    }
  }
};

for (const r of ROOTS) if (fs.existsSync(r)) walk(r);

if (hits.length > 0) {
  console.error('✗ 正式构建里发现了开发端功能，已阻止：');
  for (const h of hits) console.error('   ' + h);
  console.error('\n请用 `npm run build`（不带 VITE_DEV_TOOLS）重新构建正式版。');
  process.exit(1);
}
console.log('✓ 正式构建干净：产物里没有开发端功能（测试模式等）');
