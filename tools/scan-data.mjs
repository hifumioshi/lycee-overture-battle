// 扫描数据：类型分布、费用格式、EX 值分布
import { readFile } from 'node:fs/promises';

const cards = JSON.parse(await readFile('data/cards/range.json', 'utf-8'));

const typeCount = {};
const costFormats = {};
const exCount = {};
const elemCount = {};
const rarityCount = {};
for (const c of cards) {
  typeCount[c.typeRaw] = (typeCount[c.typeRaw] || 0) + 1;
  if (c.cost) costFormats[c.cost] = (costFormats[c.cost] || 0) + 1;
  exCount[`EX${c.ex}`] = (exCount[`EX${c.ex}`] || 0) + 1;
  if (c.elements) elemCount[c.elements] = (elemCount[c.elements] || 0) + 1;
  rarityCount[c.rarity] = (rarityCount[c.rarity] || 0) + 1;
}

console.log('=== 类型分布 ===');
console.log(JSON.stringify(typeCount, null, 2));
console.log('\n=== 费用格式 ===');
for (const k of Object.keys(costFormats).sort()) console.log(JSON.stringify(k), 'x', costFormats[k]);
console.log('\n=== EX 分布 ===');
console.log(JSON.stringify(exCount, null, 2));
console.log('\n=== 属性分布 ===');
console.log(JSON.stringify(elemCount, null, 2));
console.log('\n=== 稀有度分布 ===');
console.log(JSON.stringify(rarityCount, null, 2));
