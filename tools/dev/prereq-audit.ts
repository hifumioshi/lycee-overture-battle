/*
 * 前置条件审计（开发端）：把每张卡的效果拆开，列出「要让这个效果动起来，必须在哪个区域放什么卡」，
 * 并到卡池里确认这张卡存不存在。不跑对局，只做静态核对。
 *
 * 用法：npx tsx tools/dev/prereq-audit.ts
 * 产出：tools/_fuzz/prereq-audit.md（人看）+ prereq-audit.json（机器用，给场景 runner 读）
 */
import fs from 'node:fs';
import type { Card } from '../../src/core/cards';
import { parseCard, type EffAction, type EffOption } from '../../src/core/clauses';

const cards: Card[] = JSON.parse(fs.readFileSync('data/cards/range.json', 'utf-8'));
const byId = new Map(cards.map((c) => [c.id, c]));

type Need = {
  cardId: string;
  cardName: string;
  action: string;
  zone: 'deck' | 'trash' | 'hand' | 'field' | 'area' | 'scene';
  what: string; // 人话描述
  candidates: string[]; // 卡池里满足条件的卡号
  ok: boolean; // 卡池里能不能找到
  loose?: boolean; // 只靠宽松匹配找到（需人工确认卡名）
  cond?: string; // 场景条件（需额外摆几张之类）
};

/** 严格匹配：去空白后完全相等，或一方完整包含另一方且长度接近（避免"雪"命中一切） */
function strictMatch(cardName: string, needle: string): boolean {
  const flat = (s: string) => s.replace(/[\s　]/g, '');
  const c = flat(cardName);
  const n = flat(needle);
  if (!c || !n) return false;
  if (c === n) return true;
  const [long, short] = c.length >= n.length ? [c, n] : [n, c];
  return long.includes(short) && long.length - short.length <= 3;
}

/** 宽松匹配：任一方包含另一方（仅用于提示"可能需要人工确认"） */
function looseMatch(cardName: string, needle: string): boolean {
  const flat = (s: string) => s.replace(/[\s　]/g, '');
  const c = flat(cardName);
  const n = flat(needle);
  if (!c || !n) return false;
  return c.includes(n) || n.includes(c);
}

/** 按 action 的过滤条件在卡池里找候选卡 */
function candidatesFor(a: EffAction): { ids: string[]; loose: boolean } {
  let pool = cards.slice();
  let looseUsed = false;
  // 卡名限定（names 可能是一整串"／"分隔的名字，逐个试）
  if (a.names && a.names.length > 0) {
    const needles = a.names.flatMap((n) => n.split(/[／\/、・]/)).map((s) => s.trim()).filter(Boolean);
    let hit = pool.filter((c) => needles.some((n) => strictMatch(c.name ?? '', n)));
    if (hit.length === 0) {
      hit = pool.filter((c) => needles.some((n) => looseMatch(c.name ?? '', n)));
      looseUsed = hit.length > 0;
    }
    pool = hit;
  }
  // 区域/卡类型
  if (a.areaName) pool = pool.filter((c) => strictMatch(c.name ?? '', a.areaName!) || looseMatch(c.name ?? '', a.areaName!));
  if (a.kind === 'deploy' || a.anyChar) pool = pool.filter((c) => c.type === 'character');
  if (a.kind === 'place') pool = pool.filter((c) => c.type === 'area' || c.type === 'item' || c.type === 'event');
  if (a.kind === 'equip') pool = pool.filter((c) => c.type === 'item');
  // 属性 / 费用 / EX / 能力过滤
  if (a.element) pool = pool.filter((c) => (c.elements ?? '').includes(a.element!));
  if (a.costMax !== undefined) pool = pool.filter((c) => (c.cost ?? '').length <= a.costMax!);
  if (a.exEq !== undefined) pool = pool.filter((c) => (c.ex ?? 0) === a.exEq);
  if (a.hasAbility) pool = pool.filter((c) => (c.ability ?? '').includes(a.hasAbility!));
  if (a.excludeAbility) pool = pool.filter((c) => !(c.ability ?? '').includes(a.excludeAbility!));
  return { ids: pool.map((c) => c.id), loose: looseUsed };
}

function needsOfAction(owner: Card, a: EffAction, out: Need[]): void {
  const push = (zone: Need['zone'], what: string, cond?: string) => {
    const { ids, loose } = candidatesFor(a);
    out.push({
      cardId: owner.id,
      cardName: owner.name ?? owner.id,
      action: a.t,
      zone,
      what,
      candidates: ids.slice(0, 6),
      ok: ids.length > 0,
      loose,
      cond,
    });
  };

  switch (a.t) {
    case 'search':
      push(
        a.fromTrashOnly ? 'trash' : 'deck',
        `从${a.fromTrashOnly ? '垃圾箱' : '卡组'}检索并${a.kind === 'deploy' ? '登场' : a.kind === 'place' ? '配置' : a.kind === 'equip' ? '装备' : '加入手牌'}${a.areaName ? `「${a.areaName}」` : a.anyChar ? '任意角色' : (a.names ?? []).join('／') || '指定卡'}${a.free ? '（無償）' : ''}`,
      );
      break;
    case 'store':
    case 'storeUnder':
      push('hand', `把「${a.areaName ?? a.storageName ?? (a.names ?? []).join('／')}」放到${a.t === 'store' ? '置き場' : '角色下方'}（需先在手里/场上）`, a.cap ? `上限 ${a.cap} 张` : undefined);
      break;
    case 'storeUnderArea':
      push('field', `把卡放到「${a.areaName ?? '指定エリア'}」下方（需场上已有该エリア）`);
      break;
    case 'storeAll':
      push('field', `把${a.names?.join('／') ?? '指定卡'}全部收进置き場`);
      break;
    case 'reviveSelf':
      push('trash', '这张卡自己要在垃圾箱里（复活自己）');
      break;
    case 'exileTrashCopy':
      push('trash', '需要垃圾箱里有同名/指定卡（复制其效果）');
      break;
    case 'trashCopyToDeckBottom':
      push('trash', '需要垃圾箱里有可放回卡组底的卡');
      break;
    case 'healDeck':
      push('trash', '需要垃圾箱里有卡（回复卡组）');
      break;
    case 'equipSelfToTarget':
      push('hand', '需要场上有可被装备的我方角色');
      break;
    case 'discardChar':
    case 'discardCharUpTo':
      push('field', a.target === 'opponent' ? '需要对方场上有角色' : '需要（我方/指定）场上有角色');
      break;
    case 'forceDefend':
      push('field', '需要场上有指定角色（强制防御目标）');
      break;
    case 'dmgZero':
    case 'setDp0':
      push('scene', '需要场上有目标角色');
      break;
    default:
      break;
  }
}

/** 条件里隐含的场景要求（越多的置き場/下方卡/弃牌次数等） */
function sceneCondsOf(opts: EffOption[], out: Need[], owner: Card): void {
  for (const o of opts) {
    const c = o.cond;
    if (!c) continue;
    const map: Record<string, string> = {
      under3: '自己/该角色下方要有 3 张卡',
      oppDiscarded1: '对方本回合要有 1 次破弃',
      oppDiscarded2: '对方本回合要有 2 次破弃',
      oppHandDiscard: '对方要有手牌可破弃',
      af2WithT: '自己 AF 要有 2 个以上角色',
      selfDp0: '自己当前 DP 为 0',
      storage4: '置き場要有 4 张以上',
      friendlyN4: '场上同名牌要有 4 张',
      friendlyN2: '场上同名牌要有 2 张',
      charge1: '要有 1 张充能卡',
    };
    out.push({
      cardId: owner.id,
      cardName: owner.name ?? owner.id,
      action: `条件:${c}`,
      zone: 'scene',
      what: map[c] ?? c,
      candidates: [],
      ok: true,
      cond: o.condParam,
    });
  }
}

const allNeeds: Need[] = [];
const perCard = new Map<string, Need[]>();

for (const card of cards) {
  const parsed = parseCard(card);
  const needs: Need[] = [];
  for (const d of parsed.declared) {
    for (const o of d.options) for (const a of o.actions) needsOfAction(card, a, needs);
    sceneCondsOf(d.options, needs, card);
  }
  for (const t of parsed.triggers) {
    for (const o of t.options) for (const a of o.actions) needsOfAction(card, a, needs);
    sceneCondsOf(t.options, needs, card);
  }
  if (needs.length > 0) {
    perCard.set(card.id, needs);
    allNeeds.push(...needs);
  }
}

fs.mkdirSync('tools/_fuzz', { recursive: true });
fs.writeFileSync('tools/_fuzz/prereq-audit.json', JSON.stringify([...perCard.entries()].map(([id, needs]) => ({ id, name: byId.get(id)?.name, needs })), null, 2), 'utf-8');

// 汇总
const missing = allNeeds.filter((n) => !n.ok && n.zone !== 'scene');
const looseOnes = allNeeds.filter((n) => n.ok && n.loose);
const byZone = new Map<string, number>();
for (const n of allNeeds) byZone.set(n.zone, (byZone.get(n.zone) ?? 0) + 1);

const lines: string[] = [];
lines.push('# 前置条件审计（开发端）', '');
lines.push(`卡池 ${cards.length} 张；涉及效果前置的卡 ${perCard.size} 张；前置条目 ${allNeeds.length} 条（其中卡池找不到对应卡的 ${missing.length} 条）。`, '');
lines.push('## 按区域统计', '');
lines.push('| 区域 | 条目数 |', '|---|---|');
for (const [z, n] of [...byZone.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${z} | ${n} |`);
lines.push('');
if (missing.length > 0) {
  lines.push('## ⚠ 卡池里找不到对应卡的前置（本次测试无法构造，需人工确认）', '');
  for (const m of missing) lines.push(`- ${m.cardId} ${m.cardName}：${m.what}（action=${m.action}, 区域=${m.zone}）`);
  lines.push('');
}
if (looseOnes.length > 0) {
  lines.push('## ⚠ 只靠宽松匹配找到的前置（卡名可能对不上，需人工确认）', '');
  for (const m of looseOnes) lines.push(`- ${m.cardId} ${m.cardName}：${m.what}（候选：${m.candidates.join(', ')}）`);
  lines.push('');
}
lines.push('## 每张卡需要的场景/卡', '');
for (const [id, needs] of [...perCard.entries()].slice(0, 400)) {
  lines.push(`### ${id} ${byId.get(id)?.name ?? ''}`, '');
  for (const n of needs) {
    const cand = n.candidates.length ? `（候选：${n.candidates.join(', ')}）` : '';
    lines.push(`- [${n.zone}] ${n.what}${n.ok ? '' : ' ❌ 卡池无对应卡'}${cand}`);
  }
  lines.push('');
}
fs.writeFileSync('tools/_fuzz/prereq-audit.md', lines.join('\n'), 'utf-8');

console.log(`审计完成：${perCard.size} 张卡有前置需求，共 ${allNeeds.length} 条`);
console.log(`其中卡池找不到对应卡：${missing.length} 条`);
console.log(`明细：tools/_fuzz/prereq-audit.md`);
