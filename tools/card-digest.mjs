// 输出 LO-6845~LO-6971 全部卡的紧凑摘要（按编号升序），供逐张制作效果时查阅
import { readFileSync, writeFileSync } from 'node:fs';

const cards = JSON.parse(readFileSync('public/cards.json', 'utf-8'));
const range = cards.filter((c) => {
  const m = /^LO-(\d+)/.exec(c.id || '');
  if (!m) return false;
  const n = parseInt(m[1], 10);
  return n >= 6845 && n <= 6971;
});
range.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

const flat = (s) => (s || '').replace(/<br\s*\/?>/gi, '|').replace(/\n+/g, '|');
const lines = [];
for (const c of range) {
  lines.push(`### ${c.id} ${c.name} [${c.typeRaw}] ${c.elements}/${c.cost} AP${c.ap} DP${c.dp} SP${c.sp} DMG${c.dmg} EX${c.ex}`);
  if (c.basicAbilities) lines.push(`基本: ${c.basicAbilities}`);
  if (c.ability) lines.push(`效果: ${flat(c.ability)}`);
  lines.push('');
}
writeFileSync('tools/card-digest.txt', lines.join('\n'), 'utf-8');
console.log(`cards: ${range.length} -> tools/card-digest.txt`);
