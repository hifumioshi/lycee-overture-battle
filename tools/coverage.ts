// 效果覆盖度检测：统计 208 张卡里，哪些效果能被当前引擎自动解析
import { readFileSync } from 'node:fs';
import type { Card } from '../src/core/cards';
import { parseEffects, parseDeclaredEffect } from '../src/core/effects';
import { hasTag, hasHandDeclare, hasDeclare, hasMoveAbility, moveAbilityTags } from '../src/core/abilities';
import { formatAbilityText } from '../src/core/cards';

const cards: Card[] = JSON.parse(readFileSync('data/cards/range.json', 'utf-8'));

function countTags(a: string): number {
  let n = 0;
  for (const t of ['[常時]', '[誘発]', '[宣言]', '[手札宣言]', '[コスト]', '[自動]', '[起動]']) {
    const re = new RegExp(t.replace('[', '\\[').replace(']', '\\]'), 'g');
    n += (a.match(re) || []).length;
  }
  return n;
}

let autoCards = 0; // 至少一个效果能自动执行
let fullCards = 0; // 所有效果标签都被自动解析
let totalTags = 0;
let parsedTags = 0;
const perCard: { id: string; name: string; tags: number; parsed: number; auto: string[]; miss: string[] }[] = [];

for (const c of cards) {
  const a = formatAbilityText(c.ability || '');
  const tags = countTags(a);
  const auto: string[] = [];
  // 登场抽牌 / 登场数值
  const deployEffects = parseEffects(c).filter((e) => e.kind === 'deploy-draw' || e.kind === 'deploy-stat');
  if (deployEffects.length > 0) auto.push('登场效果');
  // 常时数值
  const cont = parseEffects(c).filter((e) => e.kind === 'continuous-stat');
  if (cont.length > 0) auto.push(`常时(${cont.map((e) => e.target).join(',')})`);
  // 宣言效果
  if (hasTag(c, '宣言') && parseDeclaredEffect(c, '宣言')) auto.push('宣言数值/抽牌');
  // 手札宣言
  if (hasTag(c, '手札宣言') && parseDeclaredEffect(c, '手札宣言')) auto.push('手札宣言数值/抽牌');
  // 移动基本能力
  // (基本能力不在效果文本里，单独看 basicAbilities)
  const moveTags = moveAbilityTags({ cardId: c.id, basicAbilities: c.basicAbilities } as never);
  if (moveTags.length > 0) auto.push('移动能力');

  const parsed = auto.length;
  if (parsed > 0) autoCards++;
  if (parsed >= tags) fullCards++;
  totalTags += tags;
  parsedTags += parsed;
  perCard.push({ id: c.id, name: c.name, tags, parsed, auto, miss: [] });
}

const withEffect = cards.filter((c) => formatAbilityText(c.ability || '').length > 0).length;
console.log(`卡总数: ${cards.length}，有效果文本: ${withEffect}`);
console.log(`效果标签总数: ${totalTags}`);
console.log(`至少一个效果可自动执行: ${autoCards}/${cards.length} (${((autoCards / cards.length) * 100).toFixed(1)}%)`);
console.log(`全部效果标签都自动执行: ${fullCards}/${cards.length} (${((fullCards / cards.length) * 100).toFixed(1)}%)`);
console.log(`标签级覆盖: ${parsedTags}/${totalTags} (${((parsedTags / Math.max(totalTags, 1)) * 100).toFixed(1)}%)`);

console.log('\n没有自动效果的卡（前 12 张）:');
const none = perCard.filter((p) => p.parsed === 0);
for (const p of none.slice(0, 12)) {
  console.log(`  ${p.id} ${p.name} | 标签数: ${p.tags}`);
}

console.log(`\n没有自动效果的卡总数: ${none.length}`);
