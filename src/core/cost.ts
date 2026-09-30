// 费用解析/抵扣/支付判断（rules.ts 与 effectEngine.ts 共用，避免循环依赖）
import type { GameState, PlayerIndex, CardInstance } from './game';
import type { Card } from './cards';
import { parseCard } from './clauses';

const _costAbCache = new Map<string, { generate: string; tag: string; lose: boolean; perTurn: number; underCost: number; noDeployTurn: boolean } | null>();
function costAbOf(card: Card): { generate: string; tag: string; lose: boolean; perTurn: number; underCost: number; noDeployTurn: boolean } | null {
  let ab = _costAbCache.get(card.id);
  if (ab === undefined) {
    const p = parseCard(card);
    ab = p.costAbilities[0] ?? null;
    _costAbCache.set(card.id, ab);
  }
  return ab;
}

/** 能否支付：对每个费用组，在手牌中找到 EX 总和足够（≥点数）的对应属性卡 */
export function parseCost(cost: string): { elem: string; points: number }[] {
  if (!cost) return [];
  const groups: { elem: string; points: number }[] = [];
  for (const ch of cost) {
    const g = groups.find((x) => x.elem === ch);
    if (g) g.points++;
    else groups.push({ elem: ch, points: 1 });
  }
  return groups;
}

export type CostContext = { kind: 'deploy' | 'event' | 'equip' | 'declare' | 'support'; card?: Card };

function costPoints(cost: string): number {
  return cost.length;
}

function poolTagOk(tag: string, ctx: CostContext): boolean {
  if (tag === '') return true;
  if (tag === 'no_char') return ctx.kind !== 'deploy';
  if (tag === 'equip_only') return ctx.kind === 'equip';
  if (tag === 'surprise_char') return ctx.kind === 'deploy' && (ctx.card?.basicAbilities ?? '').includes('サプライズ');
  if (tag === 'char3plus_or_supporter') {
    return (ctx.kind === 'deploy' && (costPoints(ctx.card?.cost ?? '') >= 3 || (ctx.card?.basicAbilities ?? '').includes('サポーター'))) || ctx.kind === 'support';
  }
  return false;
}

/** 用 [コスト]能力生成的费用抵扣费用；返回剩余费用（''=全部可抵扣）并消费 exPool */
export function poolAdjustedCost(gs: GameState, player: PlayerIndex, cost: string, ctx: CostContext): string {
  const groups = parseCost(cost);
  const pool = gs.players[player].exPool;
  let rest = '';
  for (const g of groups) {
    let need = g.points;
    for (const e of pool) {
      if (need <= 0) break;
      if (e.points <= 0 || e.elem !== g.elem) continue;
      if (!poolTagOk(e.tag, ctx)) continue;
      const take = Math.min(need, e.points);
      need -= take;
      e.points -= take;
    }
    for (let i = 0; i < need; i++) rest += g.elem;
  }
  gs.players[player].exPool = pool.filter((e) => e.points > 0);
  return rest;
}

/** 能否支付：对每个费用组，在手牌中找到 EX 总和足够（≥点数）的对应属性卡 */
export function canPayCost(gs: GameState, player: PlayerIndex, cost: string, excludeUid?: string): boolean {
  const groups = parseCost(cost);
  if (groups.length === 0) return true;
  // 手牌候选（排除要使用的卡）
  const hand = gs.players[player].hand.filter((c) => c.uid !== excludeUid);
  // 未分配的卡池（记录 uid 是否可用）
  const pool = hand.map((c) => ({ inst: c, used: false }));
  for (const g of groups) {
    const need = g.points;
    if (need <= 0) continue;
    // 候选：指定属性（無 表示任意属性）
    const candidates = pool
      .filter((x) => !x.used && (g.elem === '無' || (gs.cardsById[x.inst.cardId]?.elements ?? '').includes(g.elem)))
      .sort((a, b) => (gs.cardsById[b.inst.cardId]?.ex ?? 0) - (gs.cardsById[a.inst.cardId]?.ex ?? 0));
    let sum = 0;
    for (const c of candidates) {
      const ex = gs.cardsById[c.inst.cardId]?.ex ?? 0;
      if (ex <= 0) continue;
      sum += ex;
      c.used = true;
      if (sum >= need) break;
    }
    if (sum < need) return false;
  }
  return true;
}

/** 场上（含角色、其装备道具、エリア、特殊置场）当前可用的 [コスト] 能力，其产出能否覆盖费用缺额
 *  （Bug ⑤：手牌不足但场上有可产费能力时，不应直接拒绝，应进入费用面板供玩家产费） */
export function canCostPoolCover(gs: GameState, player: PlayerIndex, cost: string, ctx: CostContext): boolean {
  const groups = parseCost(cost);
  if (groups.length === 0) return true;
  const st = gs.players[player];
  const needChars = new Set<string>();
  for (const g of groups) needChars.add(g.elem);
  // 场上的 [コスト] 能力其产出与需求元素有交集（含 無 = 任意元素可抵）→ 允许进入费用面板由玩家产费
  const usableCount = (inst: CardInstance | null | undefined) => {
    if (!inst) return false;
    const card = gs.cardsById[inst.cardId];
    if (!card) return false;
    const ab = costAbOf(card);
    if (!ab) return false;
    if (ab.lose && inst.lost?.includes('cost')) return false;
    const key = `cost:${inst.uid}:${gs.turn}`;
    if ((st.perTurn[key] ?? 0) >= ab.perTurn) return false;
    if (ab.noDeployTurn && inst.deployedTurn === gs.turn) return false;
    if (ab.underCost > 0 && (inst.under?.length ?? 0) < ab.underCost) return false;
    if (!poolTagOk(ab.tag, ctx)) return false;
    // 無（任意属性）可被任意产费元素抵扣
    if (needChars.has('無')) return true;
    for (const ch of ab.generate) if (needChars.has(ch)) return true;
    return false;
  };
  for (let r = 0; r < 2; r++) {
    for (let a = 0; a < 3; a++) {
      const cell = st.field[r][a];
      if (usableCount(cell) || usableCount(cell?.equip) || usableCount(st.fieldAreas[r][a])) return true;
    }
  }
  for (const sp of st.special) if (usableCount(sp)) return true;
  return false;
}
