// 扫描测试区间所有卡的基本能力原始格式
import { readFile } from 'node:fs/promises';

const cards = JSON.parse(await readFile('data/cards/range.json', 'utf-8'));
const map = {};
for (const c of cards) {
  const raw = c.basicAbilities || '';
  if (!map[raw]) map[raw] = [];
  map[raw].push(c.id);
}
const keys = Object.keys(map).sort();
console.log('卡数:', cards.length);
console.log('不同格式数量:', keys.length);
for (const k of keys) {
  console.log(JSON.stringify(k), '<-', map[k].slice(0, 4).join(','));
}
