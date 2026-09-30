// 调试单个卡片的解析结果
import { readFileSync } from 'node:fs';
import { parseCard } from '../src/core/clauses';

const cards = JSON.parse(readFileSync('public/cards.json', 'utf-8'));
const ids = process.argv.slice(2);
for (const id of ids) {
  const c = cards.find((x) => x.id === id);
  if (!c) {
    console.log(`!! 找不到 ${id}`);
    continue;
  }
  const p = parseCard(c);
  console.log(`===== ${c.id} ${c.name} =====`);
  console.log('原文:', JSON.stringify(c.ability));
  for (const d of p.declared) {
    console.log(`-- 宣言[${d.cost}] (${d.tag}) --`);
    for (const o of d.options) {
      console.log(`   [${o.parsed ? 'OK' : 'X'}] ${o.id} ${o.label}${o.partialRaw ? ` 剩余:${JSON.stringify(o.partialRaw)}` : ''}`);
      for (const a of o.actions) console.log(`        ${a.t} ${a.target ?? ''} ${a.stat ?? ''} ${a.amount ?? ''} ${a.n ?? ''} ${a.names ?? ''} ${a.kind ?? ''}`);
    }
  }
  for (const t of p.triggers) {
    console.log(`-- 诱発(${t.trigger}) cond=${JSON.stringify(t.condition)} --`);
    for (const o of t.options) {
      console.log(`   [${o.parsed ? 'OK' : 'X'}] ${o.id} ${o.label}${o.partialRaw ? ` 剩余:${JSON.stringify(o.partialRaw)}` : ''}`);
      for (const a of o.actions) console.log(`        ${a.t} ${a.target ?? ''} ${a.stat ?? ''} ${a.amount ?? ''} ${a.n ?? ''} ${a.names ?? ''} ${a.kind ?? ''}`);
    }
  }
  console.log('常时:', JSON.stringify(p.continuous.map((x) => [x.target, x.element ?? '', x.stats, x.condition])));
  console.log('コスト:', JSON.stringify(p.costAbilities.map((x) => [x.generate, x.tag, x.perTurn, x.underCost])));
}
