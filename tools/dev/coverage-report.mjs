/*
 * 开发端：按属性分组跑对局机器人，汇总"全卡覆盖"与"涉及问题的卡"
 * 用法：node tools/dev/coverage-report.mjs
 * 产出：tools/_fuzz/coverage-report.md
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const cards = JSON.parse(fs.readFileSync('data/cards/range.json', 'utf-8'));
const OUT = 'tools/_fuzz';
fs.mkdirSync(OUT, { recursive: true });

const ELEMENTS = ['月', '雪', '花', '日', '宙'];
const covered = new Set();
const involved = new Map(); // 卡号 -> { name, kinds:Set, count }
const kindsTotal = new Map();
let lines = [];

for (const el of ELEMENTS) {
  const t0 = Date.now();
  let out = '';
  try {
    // 用 execSync（走 shell）：Windows 上 npx 是 npx.cmd，execFileSync 直接调会失败
    out = execSync(`npx tsx tools/fuzz-rules.ts --games 12 --steps 300 --element ${el}`, {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(path.join(OUT, `run-${el}.txt`), out, 'utf-8');

  const cov = /已覆盖卡号：(.+)/.exec(out);
  const covCount = cov ? cov[1].split(',').filter(Boolean).length : 0;
  for (const id of cov ? cov[1].split(',').filter(Boolean) : []) covered.add(id);

  // 统计该属性里"涉及问题"的卡：只要某条发现里出现了卡名，就记这个卡号
  const findingLines = out.split('\n').filter((l) => l.includes('· 第') || l.includes('连续'));
  const kinds = new Map();
  for (const l of out.split('\n')) {
    const k = /【(.+?)】/.exec(l);
    if (k) kinds.set(k[1], (kinds.get(k[1]) ?? 0) + 1);
  }
  for (const [k, v] of kinds) kindsTotal.set(k, (kindsTotal.get(k) ?? 0) + v);

  for (const c of cards) {
    if (!c.name) continue;
    const hit = findingLines.filter((l) => l.includes(c.name));
    if (hit.length > 0) {
      const rec = involved.get(c.id) ?? { name: c.name, kinds: new Set(), count: 0 };
      rec.count += hit.length;
      for (const l of hit) {
        const k = /【(.+?)】/.exec(out.split('\n').find((x) => x.includes('· 第') && x.includes(c.name)) ?? '');
        if (k) rec.kinds.add(k[1]);
      }
      involved.set(c.id, rec);
    }
  }
  lines.push(`| ${el} | ${secs}s | ${covCount} | ${findingLines.length} |`);
  console.log(`【${el}】${secs}s 覆盖 ${covCount} / 报告 ${findingLines.length} 行`);
}

const missing = cards.filter((c) => !covered.has(c.id));
const md = [
  '# 对局机器人：按属性分组跑 · 覆盖与问题卡汇总',
  '',
  '> 测试卡表 = 该属性每张卡 ×4（仅测试用，不影响正式 60 张构筑）。每组 12 局 × 300 步。',
  '',
  '| 属性 | 用时 | 覆盖卡数 | 报告行数 |',
  '|---|---|---|---|',
  ...lines,
  '',
  `**覆盖并集：${covered.size} / ${cards.length} 张**`,
  '',
  '## 问题类型统计',
  '',
  ...[...kindsTotal.entries()].map(([k, v]) => `- ${k}：${v}`),
  '',
  `## 从未成功使用过的卡（测试盲区，${missing.length} 张）`,
  '',
  missing.length ? missing.map((c) => `${c.id} ${c.name}`).join('、') : '（无）',
  '',
  `## 出现报告行里涉及的卡（${involved.size} 张，需逐条定性）`,
  '',
  involved.size
    ? [...involved.entries()].map(([id, v]) => `- ${id} ${v.name}（${v.count} 行，类型：${[...v.kinds].join('/') || '—'}）`).join('\n')
    : '（无）',
  '',
  '> 注意：这些卡只是"报告行里出现过"，**尚不能判定为游戏 bug**——检测器此前已暴露两处假报告根因（战报 200 条上限、机器人过期引用），需逐条复核后再定性。',
  '',
].join('\n');

fs.writeFileSync(path.join(OUT, 'coverage-report.md'), md, 'utf-8');
console.log(`\n覆盖并集 ${covered.size}/${cards.length}，盲区 ${missing.length} 张，涉及问题的卡 ${involved.size} 张`);
console.log(`报告：${OUT}/coverage-report.md`);
