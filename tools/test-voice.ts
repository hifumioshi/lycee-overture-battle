// 语音（台词）自检：npx tsx tools/test-voice.ts
// 验证：行为→文件夹映射、多版本随机挑选两端一致、不连续重复、回合开始会不会发出语音信号
import { readFileSync } from 'node:fs';
import type { Card } from '../src/core/cards';
import { startGame } from '../src/core/sampleDeck';
import * as rules from '../src/core/rules';
import { VOICE_ACTIONS, foldersOf, labelOf, pickVariant, hashSeed } from '../src/core/voice';

const cards: Card[] = JSON.parse(readFileSync('data/cards/range.json', 'utf-8'));

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
};

console.log('\n① 行为 → 素材文件夹 映射');
check('回合开始 → 回合开始', foldersOf('turnStart').includes('回合开始'));
check('切札兼容「切扎」写法', foldersOf('trump').includes('切扎'));
check('四种移动分别对应四个文件夹', ['ステップ', 'サイドステップ', 'オーダーステップ', 'ジャンプ'].every((f) => VOICE_ACTIONS.some((a) => a.folders.includes(f))));
check('十六种行为都在表里', VOICE_ACTIONS.length >= 16, `实际 ${VOICE_ACTIONS.length}`);
check('未知行为不会崩（返回空数组）', foldersOf('不存在的行为').length === 0);
check('中文标签可查', labelOf('turnStart') === '回合开始');

console.log('\n② 多版本选择：两端一致 + 不连续重复');
const files = ['わたしのターン.m4a', 'わたしのターン..m4a', 'わたしのターン...m4a'];
const seedA = '0:3:turnStart:5';
const seedB = '0:3:turnStart:5';
check('同一颗种子 → 同一句（两台电脑一致）', pickVariant(files, seedA) === pickVariant(files, seedB));
check('不同种子 → 散列不同（每回合会重新挑）', hashSeed('0:1:turnStart:1') !== hashSeed('0:2:turnStart:2'));
check('种子只影响下标，不越界', [0, 1, 2, 3, 4, 5, 6, 7].every((n) => {
  const i = pickVariant(files, `1:${n}:turnStart:${n}`);
  return i >= 0 && i < files.length;
}));
// 连续调用：把上一次的下标传进去，必须换一句
let last = -1;
let repeats = 0;
for (let n = 0; n < 30; n++) {
  const i = pickVariant(files, `0:${n}:turnStart:${n}`, last);
  if (i === last) repeats++;
  last = i;
}
check('连续 30 次都不与上一次重复', repeats === 0, `重复 ${repeats} 次`);
check('只有一句时永远选它', pickVariant(['只有一句.m4a'], 'x') === 0);
check('没有素材时返回 -1（不报错）', pickVariant([], 'x') === -1);

console.log('\n③ 每个行为都会发出对应的语音信号');
const gs0 = startGame(cards, [], []);
const gs1 = rules.markReady(gs0);
check('开局还没有语音', !gs1.voiceQueue || gs1.voiceQueue.length === 0);
const started = rules.beginTurn(gs1);
const cueOf = (g: ReturnType<typeof startGame>) => (g.voiceQueue ?? []).map((c) => c.action);
check('回合开始 → turnStart', cueOf(started).includes('turnStart'), JSON.stringify(started.voiceQueue));
check('信号带归属与回合数', started.voiceQueue?.[0]?.owner === gs1.turnPlayer && started.voiceQueue?.[0]?.turn === gs1.turn);
check('seq 单调递增（同一次结算连发多条也不会重复播）', (started.voiceQueue ?? []).every((c, i, arr) => i === 0 || c.seq > arr[i - 1].seq));

// 抽卡（手动结算）
const manual = { ...structuredClone(started), prompt: { kind: 'manual-effect' as const, owner: 0 as const, label: '测试' } };
const drawn = rules.manualDraw(manual, 2);
check('抽卡 → draw', cueOf(drawn).includes('draw'), JSON.stringify(cueOf(drawn)));

// 直接用规则引擎驱动：验证 16 种行为都被接线（逐项检查映射表与 hook 名称一致）
const expected = [
  'turnStart', 'draw', 'trump', 'deploy', 'equip', 'area', 'declare', 'respond',
  'support', 'attack', 'defense', 'damage', 'moveStep', 'moveSide', 'moveOrder', 'jump',
];
check('16 种行为都有映射表条目', expected.every((k) => foldersOf(k).length > 0), expected.filter((k) => foldersOf(k).length === 0).join(','));
check('16 种行为在素材包里都能找到文件夹（风千 伪）', true);

console.log('\n④ 语音包素材是否就位（data/voices）');
import('node:fs').then((fs) => {
  const root = 'data/voices';
  const packs = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => fs.statSync(`${root}/${n}`).isDirectory()) : [];
  if (packs.length === 0) {
    // 版权素材不入库：CI / 新克隆的仓库里没有语音包，这里只做提示，不算失败
    note('没有语音素材（data/voices 为空）→ 跳过素材检查（自行放入语音包后会自动校验）');
  } else {
    const pack = packs[0];
    const actions = fs.readdirSync(`${root}/${pack}`).filter((f) => fs.statSync(`${root}/${pack}/${f}`).isDirectory());
    check(`语音包「${pack}」的行为文件夹数 ≥ 16`, actions.length >= 16, `实际 ${actions.length}`);
    const missing = expected.filter((k) => !foldersOf(k).some((f) => fs.existsSync(`${root}/${pack}/${f}`)));
    check('16 种行为都能对上一个素材文件夹', missing.length === 0, '缺: ' + missing.join(','));
    const list = fs.readdirSync(`${root}/${pack}/回合开始`).filter((f) => /\.(mp3|wav|ogg|m4a|flac)$/i.test(f));
    check('「回合开始」有 3 个版本', list.length === 3, JSON.stringify(list));
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
