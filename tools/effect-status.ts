// 208 张卡逐卡效果状态报告：解析 clauses，统计每张卡的效果是否可自动执行
import { readFileSync } from 'node:fs';
import type { Card } from '../src/core/cards';
import { parseCard } from '../src/core/clauses';
import { formatAbilityText } from '../src/core/cards';

const cards: Card[] = JSON.parse(readFileSync('public/cards.json', 'utf-8'));
const range = cards.filter((c) => {
  const m = /^LO-(\d+)/.exec(c.id || '');
  if (!m) return false;
  const n = parseInt(m[1], 10);
  return n >= 6845 && n <= 6971;
});
range.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

let fullyAuto = 0;
let partialAuto = 0;
let manualOnly = 0;
let noEffect = 0;

for (const c of range) {
  const p = parseCard(c);
  const rows: string[] = [];
  for (const d of p.declared) {
    const ok = d.options.filter((o) => o.parsed).length;
    rows.push(`  宣言[${d.cost}]: ${ok}/${d.options.length} 选项自动`);
    for (const o of d.options) if (!o.parsed) rows.push(`    ✗ ${o.label.slice(0, 30)} | 剩余: ${(o.partialRaw ?? '').slice(0, 80)}`);
  }
  for (const t of p.triggers) {
    const ok = t.options.filter((o) => o.parsed).length;
    rows.push(`  诱発(${t.trigger}): ${ok}/${t.options.length} 选项自动`);
    for (const o of t.options) if (!o.parsed) rows.push(`    ✗ ${o.label.slice(0, 30)} | 剩余: ${(o.partialRaw ?? '').slice(0, 80)}`);
  }
  for (const cont of p.continuous) {
    rows.push(`  常时: ${cont.target}${cont.condition !== 'none' ? `(${cont.condition})` : ''} ${cont.grantAggressive ? 'アグレッシブ授予' : ''}${cont.blockFirstTurnDamage ? '登场回合伤害限制' : ''} 自动`);
  }
  for (const cst of p.costAbilities) {
    rows.push(`  コスト: 生成[${cst.generate}] 自动`);
  }
  if (p.trump) rows.push(`  切札: ${p.trump.parsed ? '自动' : '手动'}`);

  const hasAny = p.declared.length + p.triggers.length + p.continuous.length + p.costAbilities.length + (p.trump ? 1 : 0) > 0;
  const totalOpts = [...p.declared.map((d) => d.options.length), ...p.triggers.map((t) => t.options.length)].reduce((a, b) => a + b, 0);
  const autoOpts = [
    ...p.declared.map((d) => d.options.filter((o) => o.parsed).length),
    ...p.triggers.map((t) => t.options.filter((o) => o.parsed).length),
  ].reduce((a, b) => a + b, 0);
  const contOk = p.continuous.length > 0;
  const costOk = p.costAbilities.length > 0;
  const trumpOk = !!p.trump?.parsed;
  // 存在 [誘発] 块但一个触发都没解析出来（如 エンゲージ登場 等未支持的触发句）→ 视为部分自动
  const raw = formatAbilityText(c.ability || '');
  const rawHasTriggerBlock = /\[誘発\]/.test(raw);
  const unparsedTriggerBlock = rawHasTriggerBlock && p.triggers.length === 0;
  const optPartial = [...p.declared.map((d) => d.options), ...p.triggers.map((t) => t.options)].flat().some((o) => !o.parsed);
  const trumpPartial = !!p.trump && !p.trump.parsed;

  let status: string;
  if (!hasAny && !rawHasTriggerBlock) {
    status = '无效果';
    noEffect++;
  } else if (!optPartial && !trumpPartial && !unparsedTriggerBlock) {
    status = '✅ 全自动';
    fullyAuto++;
  } else if (autoOpts > 0 || contOk || costOk || trumpOk || rawHasTriggerBlock) {
    status = '🟡 部分自动';
    partialAuto++;
  } else {
    status = '❌ 仅手动';
    manualOnly++;
  }
  console.log(`LO-${c.id.padEnd(9)} ${status} ${c.name}`);
  for (const r of rows) console.log(r);
}

console.log(`\n=== 总计 ${range.length} 张 ===`);
console.log(`✅ 全自动: ${fullyAuto}`);
console.log(`🟡 部分自动: ${partialAuto}`);
console.log(`❌ 仅手动: ${manualOnly}`);
console.log(`无效果: ${noEffect}`);
