// 效果执行引擎：把 clauses 解析出的结构应用到对局状态
// 核心：效果链（pending.stage 逐动作执行），需要玩家选择时生成对应提示。
import type { GameState, PlayerIndex, CardInstance, PendingEffect, RowName, AreaIndex } from './game';
import { pushVoice } from './game';
import type { Card } from './cards';
import { parseBasicAbilities } from './cards';
import { parseCard, ParsedCard, EffAction, EffOption, EffTarget, TriggerClause, STAT_LABEL } from './clauses';
import { poolAdjustedCost, canPayCost, canCostPoolCover } from './cost';

const cache = new Map<string, ParsedCard>();
export function getParsed(card: Card): ParsedCard {
  let p = cache.get(card.id);
  if (!p) {
    p = parseCard(card);
    cache.set(card.id, p);
  }
  return p;
}

export function cardName(gs: GameState, uid: string): string {
  const loc = engineLoc(gs, uid);
  if (!loc) return '?';
  return gs.cardsById[loc.inst.cardId]?.name ?? loc.inst.cardId;
}

export interface LocInfo {
  player: PlayerIndex;
  zone: 'deck' | 'hand' | 'trash' | 'shield' | 'special' | 'field' | 'removed' | 'charge' | 'under' | 'equip' | 'area';
  row?: RowName;
  area?: AreaIndex;
  index: number;
  inst: CardInstance;
}

export function engineLoc(gs: GameState, uid: string): LocInfo | null {
  for (const p of [0, 1] as PlayerIndex[]) {
    const st = gs.players[p];
    const zones: [LocInfo['zone'], CardInstance[]][] = [
      ['deck', st.deck],
      ['hand', st.hand],
      ['trash', st.trash],
      ['shield', st.shield],
      ['special', st.special],
      ['removed', st.removed],
    ];
    for (const [z, list] of zones) {
      const idx = list.findIndex((c) => c.uid === uid);
      if (idx >= 0) return { player: p, zone: z, index: idx, inst: list[idx] };
    }
    for (let r = 0; r < 2; r++) {
      for (let a = 0; a < 3; a++) {
        const cell = st.field[r][a];
        if (cell && cell.uid === uid) return { player: p, zone: 'field', row: r === 0 ? 'AF' : 'DF', area: a as AreaIndex, index: -1, inst: cell };
        const areaCard = st.fieldAreas[r][a];
        if (areaCard && areaCard.uid === uid) return { player: p, zone: 'area', row: r === 0 ? 'AF' : 'DF', area: a as AreaIndex, index: -1, inst: areaCard };
        if (cell) {
          for (const c of cell.charge) if (c.uid === uid) return { player: p, zone: 'charge', index: -1, inst: c };
          for (const c of cell.under) if (c.uid === uid) return { player: p, zone: 'under', index: -1, inst: c };
          if (cell.equip && cell.equip.uid === uid) return { player: p, zone: 'equip', index: -1, inst: cell.equip };
        }
      }
    }
  }
  return null;
}

function ownerOf(gs: GameState, uid: string): PlayerIndex | null {
  return engineLoc(gs, uid)?.player ?? null;
}

/** 场上（含特殊置场/フィールド上的エリア）某玩家的一张卡 */
export function fieldCards(gs: GameState, p: PlayerIndex, includeSpecial = false): CardInstance[] {
  const out: CardInstance[] = [];
  for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) {
    const c = gs.players[p].field[r][a];
    if (c) out.push(c);
    const ar = gs.players[p].fieldAreas[r][a];
    if (ar) out.push(ar);
  }
  if (includeSpecial) out.push(...gs.players[p].special);
  return out;
}

/** 卡的全名（能力名 + 卡名，如「Orohoraの箱 僧間理亜」），去掉空格用于匹配 */
function cardFullName(gs: GameState, cardId: string): string {
  const c = gs.cardsById[cardId];
  if (!c) return '';
  return ((c.abilityName ? c.abilityName + ' ' : '') + (c.name ?? '')).replace(/\s/g, '');
}

/** 判断卡是否与「能力名+卡名」或单卡名匹配（忽略空格，支持「Orohoraの箱 僧間理亜」这类引用） */
function cardMatchesName(gs: GameState, cardId: string, name: string): boolean {
  const norm = (name ?? '').replace(/\s/g, '');
  if (!norm) return false;
  const c = gs.cardsById[cardId];
  if (!c) return false;
  return cardFullName(gs, cardId) === norm || (c.name ?? '').replace(/\s/g, '') === norm;
}

/* ================= 有效数值 ================= */

function instBase(card: Card): { ap: number; dp: number; sp: number; dmg: number } {
  return { ap: card.ap, dp: card.dp, sp: card.sp, dmg: card.dmg };
}

/** 计算有效数值（基础 + 临时 + 临时设定 + 常时效果） */
export function effectiveStats(gs: GameState, uid: string): { ap: number; dp: number; sp: number; dmg: number } {
  const loc = engineLoc(gs, uid);
  if (!loc) return { ap: 0, dp: 0, sp: 0, dmg: 0 };
  const inst = loc.inst;
  const card = gs.cardsById[inst.cardId];
  if (!card) return { ap: 0, dp: 0, sp: 0, dmg: 0 };
  const out = instBase(card);
  out.ap += inst.tempMods.ap;
  out.dp += inst.tempMods.dp;
  out.sp += inst.tempMods.sp;
  out.dmg += inst.tempMods.dmg;
  if (inst.tempSet.ap !== undefined) out.ap = inst.tempSet.ap;
  if (inst.tempSet.dp !== undefined) out.dp = inst.tempSet.dp;
  if (inst.tempSet.sp !== undefined) out.sp = inst.tempSet.sp;
  if (inst.tempSet.dmg !== undefined) out.dmg = inst.tempSet.dmg;
  const owner = loc.player;
  // 条件判定（需要 owner 的置き場信息）
  const condOk = (src: CardInstance, c: { condition: string; storageName?: string }): boolean => {
    if (c.condition === 'charge1') return src.charge.length > 0;
    if (c.condition === 'under4') return src.under.length >= 4;
    if (c.condition === 'storage1') return (gs.players[owner].storage[c.storageName ?? ''] ?? []).length >= 1;
    return true;
  };
  // 自己携带的常时（角色自身 / 装备的道具）
  const applyContinuous = (source: CardInstance, holderUid: string) => {
    const sc = gs.cardsById[source.cardId];
    if (!sc) return;
    const p = getParsed(sc);
    for (const c of p.continuous) {
      if (c.target === 'self') {
        if (source.uid === holderUid || (loc.zone === 'equip' && source.uid === inst.uid) || (inst.equip && inst.equip.uid === source.uid)) {
          if (condOk(source, c)) for (const s of c.stats) out[s.stat] += s.amount;
        }
      }
    }
  };
  applyContinuous(inst, inst.uid);
  if (inst.equip) applyContinuous(inst.equip, inst.uid);
  // 场上所有卡的“味方全体/属性”常时（含自身：味方キャラ全て 包括自己）
  const targets: CardInstance[] = fieldCards(gs, owner, true);
  for (const src of targets) {
    const sc = gs.cardsById[src.cardId];
    if (!sc) continue;
    const p = getParsed(sc);
    for (const c of p.continuous) {
      if (!condOk(src, c)) continue;
      const isAF = loc.zone === 'field' && loc.row === 'AF';
      const isDF = loc.zone === 'field' && loc.row === 'DF';
      const ok =
        c.target === 'allFriendly' ||
        (c.target === 'afFriendly' && isAF) ||
        (c.target === 'dfFriendly' && isDF) ||
        (c.target === 'elementFriendly' && card.elements.includes(c.element ?? '')) ||
        (c.target === 'afElement' && isAF && card.elements.includes(c.element ?? '')) ||
        (c.target === 'abilityAF' && isAF && (card.basicAbilities ?? '').includes(c.hasAbility ?? ''));
      if (ok) for (const s of c.stats) out[s.stat] += s.amount;
    }
  }
  return out;
}

/** 是否有アグレッシブ（基本能力或エリア授予） */
export function hasAggressive(gs: GameState, uid: string): boolean {
  const loc = engineLoc(gs, uid);
  if (!loc || loc.zone !== 'field') return false;
  const card = gs.cardsById[loc.inst.cardId];
  if (!card) return false;
  if ((card.basicAbilities ?? '').includes('アグレッシブ')) return true;
  const owner = loc.player;
  for (const src of fieldCards(gs, owner, true)) {
    const sc = gs.cardsById[src.cardId];
    if (!sc) continue;
    for (const c of getParsed(sc).continuous) {
      if (c.grantAggressive && c.target === 'allFriendly') {
        if ((card.dmg ?? 0) >= 2 || (card.sp ?? 0) >= 2) return true;
      }
    }
  }
  return false;
}

/** 登场回合角色是否能造成伤害（エリア限制） */
export function blocksFirstTurnDamage(gs: GameState, owner: PlayerIndex): boolean {
  for (const src of fieldCards(gs, owner, true)) {
    const sc = gs.cardsById[src.cardId];
    if (!sc) continue;
    for (const c of getParsed(sc).continuous) if (c.blockFirstTurnDamage) return true;
  }
  return false;
}

/** 常时：味方角色是否可支援非相邻角色（6962 相手ターン中） */
export function playerSupportAnyRange(gs: GameState, owner: PlayerIndex): boolean {
  for (const src of fieldCards(gs, owner, true)) {
    const sc = gs.cardsById[src.cardId];
    if (!sc) continue;
    for (const c of getParsed(sc).continuous) if (c.supportAnyRange) return true;
  }
  return false;
}

/** 常时：是否禁止宣言费用 0 点以下的[サポーター]（6962） */
export function playerBanZeroCostSupporter(gs: GameState, owner: PlayerIndex): boolean {
  for (const src of fieldCards(gs, owner, true)) {
    const sc = gs.cardsById[src.cardId];
    if (!sc) continue;
    for (const c of getParsed(sc).continuous) if (c.banZeroCostSupporter) return true;
  }
  return false;
}

/* ================= 目标候选 ================= */

function matchesTarget(gs: GameState, owner: PlayerIndex, act: EffAction, side: PlayerIndex, row: RowName | null, cand: CardInstance): boolean {
  const card = gs.cardsById[cand.cardId];
  if (!card) return false;
  if (act.row === 'AF' && row !== 'AF') return false;
  if (act.row === 'DF' && row !== 'DF') return false;
  if (act.element && !card.elements.includes(act.element)) return false;
  if (act.hasAbility && !(card.basicAbilities ?? '').includes(act.hasAbility)) return false;
  if (act.costMax !== undefined && card.cost.length > act.costMax) return false;
  void side;
  return true;
}

/** 某动作的目标候选（oneFriendly/oneOpponent → 场上角色；战斗时点指定对方攻击者） */
export function targetCandidates(gs: GameState, owner: PlayerIndex, act: EffAction): { uid: string; name: string; cardId: string }[] {
  if (act.battleAttacker && act.target === 'oneOpponent' && gs.battle) {
    const aLoc = engineLoc(gs, gs.battle.attackerUid);
    if (aLoc && aLoc.zone === 'field') {
      return [{ uid: aLoc.inst.uid, name: gs.cardsById[aLoc.inst.cardId]?.name ?? aLoc.inst.cardId, cardId: aLoc.inst.cardId }];
    }
    return [];
  }
  const out: { uid: string; name: string; cardId: string }[] = [];
  const friendly = act.target === 'oneFriendly' || act.target === 'chosen';
  const side = friendly ? owner : ((1 - owner) as PlayerIndex);
  for (let r = 0; r < 2; r++) {
    for (let a = 0; a < 3; a++) {
      const c = gs.players[side].field[r][a];
      if (c && matchesTarget(gs, owner, act, side, r === 0 ? 'AF' : 'DF', c)) {
        out.push({ uid: c.uid, name: gs.cardsById[c.cardId]?.name ?? c.cardId, cardId: c.cardId });
      }
    }
  }
  return out;
}

/** 动作是否需要选择目标（只有单体目标需要玩家指定） */
export function actionNeedsTarget(act: EffAction): boolean {
  if (act.target !== 'oneFriendly' && act.target !== 'oneOpponent' && act.target !== 'chosen') return false;
  return act.t === 'stat' || act.t === 'dmgZero' || act.t === 'untap' || act.t === 'setDp0' || act.t === 'discardChar' || act.t === 'grantBonus' || act.t === 'equipSelfToTarget';
}

/* ================= 单动作应用 ================= */

function applyStat(gs: GameState, target: CardInstance, stat: string, amount: number): void {
  if (stat === 'ap' || stat === 'dp' || stat === 'sp' || stat === 'dmg') {
    target.tempMods[stat] += amount;
  }
}

function pushLog(gs: GameState, msg: string): void {
  gs.log.push(msg);
  if (gs.log.length > 300) gs.log.splice(0, gs.log.length - 300);
}

function drawN(gs: GameState, p: PlayerIndex, n: number, opts: { voice?: boolean } = {}): number {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const st = gs.players[p];
    if (st.deck.length === 0) break;
    const top = st.deck.pop()!;
    top.faceUp = true;
    st.hand.push(top);
    drawn++;
  }
  // 语音：抽卡（回合开始那一次不播，由「回合开始」台词代表）
  if (drawn > 0 && opts.voice !== false) pushVoice(gs, p, 'draw');
  return drawn;
}

function discardDeckTop(gs: GameState, p: PlayerIndex, n: number): number {
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const st = gs.players[p];
    if (st.deck.length === 0) break;
    const top = st.deck.pop()!;
    top.faceUp = true;
    st.trash.unshift(top);
    cnt++;
  }
  return cnt;
}

/** 回复：从ゴミ箱把最多 n 张（随机）放回牌堆底；仅「回復しシャッフル」时洗牌 */
function healDeck(gs: GameState, p: PlayerIndex, n: number, shuffle = false): number {
  const st = gs.players[p];
  let cnt = 0;
  const pool = [...st.trash];
  // 随机取 n 张
  const picked: CardInstance[] = [];
  while (picked.length < n && pool.length > 0) {
    const j = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(j, 1)[0]);
  }
  for (const c of picked) {
    const idx = st.trash.indexOf(c);
    if (idx >= 0) {
      st.trash.splice(idx, 1);
      c.faceUp = false; // 牌堆中的卡必须是背面朝上（回血后牌堆顶不再显示正面）
      st.deck.push(c);
      cnt++;
    }
  }
  if (cnt > 0 && shuffle) {
    // 洗牌
    for (let i = st.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [st.deck[i], st.deck[j]] = [st.deck[j], st.deck[i]];
    }
  }
  return cnt;
}

function removeFromField(gs: GameState, p: PlayerIndex, row: RowName, area: AreaIndex): void {
  const st = gs.players[p];
  const cell = st.field[row === 'AF' ? 0 : 1][area];
  if (!cell) return;
  st.field[row === 'AF' ? 0 : 1][area] = null;
  if (cell.equip) {
    cell.equip.faceUp = true;
    st.trash.unshift(cell.equip);
    cell.equip = null;
  }
  cell.faceUp = true;
  st.trash.unshift(cell);
}

/** 把某实例从当前区域移除（不进ゴミ箱，供检索用） */
export function pullInstance(gs: GameState, uid: string): LocInfo | null {
  const loc = engineLoc(gs, uid);
  if (!loc) return null;
  const p = loc.player;
  const st = gs.players[p];
  if (loc.zone === 'field') {
    const cell = st.field[loc.row === 'AF' ? 0 : 1][loc.area ?? 0];
    st.field[loc.row === 'AF' ? 0 : 1][loc.area ?? 0] = null;
    return loc;
  }
  const map: Record<string, CardInstance[]> = {
    deck: st.deck,
    hand: st.hand,
    trash: st.trash,
    shield: st.shield,
    special: st.special,
    removed: st.removed,
  };
  const list = map[loc.zone];
  if (list && loc.index >= 0 && loc.index < list.length) {
    list.splice(loc.index, 1);
  }
  return loc;
}

/** 检索装备（6887）：目标已选 → 支付费用并实际装备（Bug ⑧⑨⑩）
 *  返回新状态；若返回的状态带 prompt（费用选择 / 装备诱発选择）由调用方直接返回 */
function applySearchEquip(gs: GameState, pending: PendingEffect, act: EffAction, stage: number): GameState {
  const owner = pending.owner;
  const st = gs.players[owner];
  const sq = pending.searchEquip;
  if (!sq) return gs;
  const itemInst =
    st.deck.find((c) => c.uid === sq.itemUid) ?? st.trash.find((c) => c.uid === sq.itemUid) ?? null;
  const itemCard = itemInst ? gs.cardsById[itemInst.cardId] : undefined;
  if (!itemCard) {
    pushLog(gs, `「${cardName(gs, pending.sourceUid)}」：检索到的道具已不存在，装备失败。`);
    pending.searchEquip = null;
    return gs;
  }
  const itemCost = itemCard.cost ?? '';
  if (itemCost && !sq.free && !pending.equipPaid) {
    const restCost = poolAdjustedCost(gs, owner, itemCost, { kind: 'equip', card: itemCard });
    if (restCost && !canPayCost(gs, owner, restCost) && !canCostPoolCover(gs, owner, restCost, { kind: 'equip', card: itemCard })) {
      pushLog(gs, `「${cardName(gs, pending.sourceUid)}」：费用不足，无法支付装备「${itemCard.name}」的费用（${itemCost}），装备失败。`);
      pending.searchEquip = null;
      return gs;
    }
    if (restCost) {
      gs.prompt = {
        kind: 'cost-pay',
        cost: restCost,
        actionLabel: `装备「${itemCard.name}」（支付道具费用）`,
        owner,
        pending: { action: 'searchEquipPay', uid: sq.itemUid, charUid: pending.targetUid ?? '', itemCardId: itemCard.id, effectPending: { ...pending, stage } },
        candidates: st.hand.map((c) => ({
          uid: c.uid,
          name: gs.cardsById[c.cardId]?.name ?? c.cardId,
          elements: gs.cardsById[c.cardId]?.elements ?? '',
          ex: gs.cardsById[c.cardId]?.ex ?? 0,
          cardId: c.cardId,
        })),
      };
      return gs;
    }
  }
  // 装备执行：从牌堆/ゴミ箱取出 → 装备到目标角色
  const targetLoc = pending.targetUid ? engineLoc(gs, pending.targetUid) : null;
  if (!targetLoc || targetLoc.zone !== 'field' || targetLoc.inst.equip) {
    pushLog(gs, `「${cardName(gs, pending.sourceUid)}」：装备目标不可用，装备失败。`);
    pending.searchEquip = null;
    return gs;
  }
  let item: CardInstance | null = null;
  const di = st.deck.findIndex((c) => c.uid === sq.itemUid);
  if (di >= 0) {
    item = st.deck.splice(di, 1)[0];
  } else {
    const ti = st.trash.findIndex((c) => c.uid === sq.itemUid);
    if (ti >= 0) item = st.trash.splice(ti, 1)[0];
  }
  if (!item) {
    pushLog(gs, `「${cardName(gs, pending.sourceUid)}」：检索到的道具已不存在，装备失败。`);
    pending.searchEquip = null;
    return gs;
  }
  item.faceUp = true;
  targetLoc.inst.equip = item;
  pushLog(gs, `「${cardName(gs, pending.sourceUid)}」：检索的「${itemCard.name}」装备给「${cardName(gs, targetLoc.inst.uid)}」`);
  pending.searchEquip = null;
  // 装備したとき诱発链（Bug ⑧）
  return continueTriggerChain(gs, 'equip', owner, item.uid);
}

/** 执行单个动作（目标已确定：pending.targetUid / extraUids / alt 检索方式） */
export function applySingleAction(
  gs: GameState,
  pending: PendingEffect,
  act: EffAction,
  searchAlt: boolean,
): { prompt: boolean; msg: string } {
  const owner = pending.owner;
  const src = engineLoc(gs, pending.sourceUid);
  const srcName = cardName(gs, pending.sourceUid);
  const actLabel = (t: EffTarget) => (t === 'self' ? '自身' : t === 'oneFriendly' ? '味方角色' : t === 'oneOpponent' ? '对方角色' : t === 'allFriendly' ? '味方全部' : t === 'afFriendly' ? '味方前列全部' : t === 'dfFriendly' ? '味方后列全部' : t === 'elementFriendly' ? '味方同属性全部' : t === 'afElement' ? '味方前列同属性' : t === 'chosen' ? '指定角色' : '');
  const pickTargets = (target: EffTarget): CardInstance[] => {
    const out: CardInstance[] = [];
    if (target === 'self') {
      if (src && src.zone === 'equip') {
        // 道具自身效果作用于装备者
        for (const p of [0, 1] as PlayerIndex[]) {
          for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) {
            const cell = gs.players[p].field[r][a];
            if (cell && cell.equip?.uid === src.inst.uid) out.push(cell);
          }
        }
      } else if (src) {
        out.push(src.inst);
      }
    } else if (target === 'oneFriendly' || target === 'oneOpponent' || target === 'chosen' || target === 'supported') {
      let uid = pending.targetUid;
      if (target === 'supported' && src) uid = src.inst.supports?.attackerUid ?? null;
      const loc = uid ? engineLoc(gs, uid) : null;
      if (loc && loc.zone === 'field') out.push(loc.inst);
    } else if (target === 'allFriendly' || target === 'afFriendly' || target === 'dfFriendly' || target === 'elementFriendly' || target === 'afElement') {
      for (let r = 0; r < 2; r++) {
        for (let a = 0; a < 3; a++) {
          const c = gs.players[owner].field[r][a];
          if (!c) continue;
          const row = r === 0 ? 'AF' : 'DF';
          if (target === 'afFriendly' && row !== 'AF') continue;
          if (target === 'dfFriendly' && row !== 'DF') continue;
          if ((target === 'elementFriendly' || target === 'afElement') && !(gs.cardsById[c.cardId]?.elements ?? '').includes(act.element ?? '')) continue;
          if (target === 'afElement' && row !== 'AF') continue;
          out.push(c);
        }
      }
    } else if (target === 'ownDeck' || target === 'oppDeck') {
      // 非角色目标
    }
    return out;
  };

  switch (act.t) {
    case 'stat': {
      const targets = pickTargets(act.target ?? 'none');
      let amount = act.amount ?? 0;
      if (act.countName) {
        let n = 0;
        for (const host of fieldCards(gs, owner, true)) {
          if ((gs.cardsById[host.cardId]?.name ?? '') === act.countName) n++;
        }
        amount = n;
      }
      for (const t of targets) applyStat(gs, t, act.stat ?? 'ap', amount);
      const label = STAT_LABEL[act.stat ?? 'ap'];
      return { prompt: false, msg: `「${srcName}」：${actLabel(act.target ?? 'none')} ${label} ${amount > 0 ? `+${amount}` : amount}` };
    }
    case 'draw': {
      const n = drawN(gs, owner, act.n ?? 1);
      // 6963：使用了自己的道具/手札宣言能力抽牌 → 记录（回合内触发手札破弃）
      const srcL0 = engineLoc(gs, pending.sourceUid);
      const srcC0 = srcL0 ? gs.cardsById[srcL0.inst.cardId] : undefined;
      if (srcC0 && (srcC0.type === 'item' || (srcC0.ability ?? '').includes('[手札宣言]'))) {
        gs.players[owner].turnCounters.ownDeclareDraws = (gs.players[owner].turnCounters.ownDeclareDraws ?? 0) + 1;
        if (!gs.lastAreaEvent) gs.lastAreaEvent = { kind: 'ownDeclareDraw', owner };
      }
      return { prompt: false, msg: `「${srcName}」：抽 ${n} 张` };
    }
    case 'search': {
      const st = gs.players[owner];
      const names = act.names ?? [];
      const hits: { inst: CardInstance; zone: 'deck' | 'trash' }[] = [];
      const matchCard = (cid: string): boolean => {
        const card = gs.cardsById[cid];
        if (!card) return false;
        if (act.anyChar) {
          if (card.type !== 'character') return false;
          if (act.excludeAbility && (card.basicAbilities ?? '').includes(act.excludeAbility)) return false;
          if (act.hasAbility && !(card.basicAbilities ?? '').includes(act.hasAbility)) return false;
          if (act.exEq !== undefined && card.ex !== act.exEq) return false;
          return true;
        }
        // 名字匹配：支持「能力名+卡名」全名（如「初雪から桜まで 小坂井綾」），忽略空格
        const norm = (s: string) => (s ?? '').replace(/\s/g, '');
        const fullName = (card.abilityName ? card.abilityName + ' ' : '') + card.name;
        return names.some((n) => norm(n) === norm(card.name) || norm(n) === norm(fullName));
      };
      for (const c of st.deck) if (!act.fromTrashOnly && matchCard(c.cardId)) hits.push({ inst: c, zone: 'deck' });
      for (const c of st.trash) if (matchCard(c.cardId)) hits.push({ inst: c, zone: 'trash' });
      if (hits.length === 0) {
        return { prompt: false, msg: `「${srcName}」检索：牌堆/ゴミ箱中没有找到符合条件的卡（${act.anyChar ? '任意角色' : names.join('、')}）` };
      }
      // 检索后使用其手札宣言能力（6862 家族）：列出所有命中的手札宣言子句让玩家选择
      if (act.kind === 'useDeclare') {
        const clauses: { uid: string; idx: number; label: string }[] = [];
        for (const h of hits) {
          const hc = gs.cardsById[h.inst.cardId];
          if (!hc) continue;
          const pp = getParsed(hc);
          pp.declared.forEach((d, di) => {
            if (d.tag !== '手札宣言') return;
            clauses.push({ uid: h.inst.uid, idx: di, label: `「${hc.name}」[${d.cost}] ${d.options.map((o) => o.label).join(' / ').slice(0, 44)}` });
          });
        }
        if (clauses.length === 0) {
          return { prompt: false, msg: `「${srcName}」检索：命中的卡没有手札宣言能力` };
        }
        gs.prompt = {
          kind: 'effect-choice',
          owner,
          title: `「${srcName}」检索到手札宣言能力，请选择要使用的`,
          multi: false,
          max: 1,
          options: clauses.map((c) => ({ id: `${c.uid}|${c.idx}`, label: c.label, cardId: gs.cardsById[hits.find((h) => h.inst.uid === c.uid)?.inst.cardId ?? '']?.id ?? '' })),
          pending: { ...pending, searchDone: false, trigger: '__useDeclare' },
        };
        return { prompt: true, msg: '检索中' };
      }
      const kind = searchAlt && act.altKind ? act.altKind : act.kind ?? 'deploy';
      const modeLabels = { deploy: '登场', place: '配置', hand: '加入手牌', charge: '作为充能', equip: '装备' };
      gs.prompt = {
        kind: 'search-deploy',
        owner,
        title: `「${srcName}」检索到 ${hits.length} 张「${names.join('」/「')}」，选择处理方式（${modeLabels[kind]}）`,
        mode: kind,
        altMode: act.altKind,
        free: act.free,
        candidates: hits.map((h) => ({ uid: h.inst.uid, name: gs.cardsById[h.inst.cardId]?.name ?? h.inst.cardId, zone: h.zone === 'deck' ? 'デッキ' : 'ゴミ箱', cardId: gs.cardsById[h.inst.cardId]?.id ?? '' })),
        pending: { ...pending, searchDone: false },
      };
      return { prompt: true, msg: '检索中' };
    }
    case 'charge': {
      if (!src) return { prompt: false, msg: '' };
      const st = gs.players[owner];
      let n = 0;
      for (const uid of pending.extraUids) {
        if (n >= (act.n ?? 1)) break;
        const idx = st.trash.findIndex((c) => c.uid === uid);
        if (idx >= 0) {
          const c = st.trash.splice(idx, 1)[0];
          src.inst.charge.push(c);
          n++;
        }
      }
      return { prompt: false, msg: `「${srcName}」充能 ${n} 张` };
    }
    case 'discardCharge': {
      if (!src) return { prompt: false, msg: '' };
      let n = 0;
      for (const uid of pending.extraUids) {
        if (n >= (act.n ?? 1)) break;
        const idx = src.inst.charge.findIndex((c) => c.uid === uid);
        if (idx >= 0) {
          const c = src.inst.charge.splice(idx, 1)[0];
          c.faceUp = true;
          gs.players[owner].trash.unshift(c);
          n++;
        }
      }
      return { prompt: false, msg: `「${srcName}」破弃充能 ${n} 张` };
    }
    case 'untap': {
      const targets = pickTargets(act.target ?? 'none');
      for (const t of targets) t.tapped = false;
      return { prompt: false, msg: `「${srcName}」：${actLabel(act.target ?? 'none')} 变为未行动` };
    }
    case 'dmgZero': {
      let targets: CardInstance[];
      if ((act.n ?? 1) > 1) {
        targets = [];
        for (const uid of pending.extraUids) {
          const loc = engineLoc(gs, uid);
          if (loc && loc.zone === 'field') targets.push(loc.inst);
        }
      } else {
        targets = pickTargets(act.target ?? 'none');
      }
      for (const t of targets) {
        t.tempSet.dmg = 0;
        t.tapped = false;
      }
      return { prompt: false, msg: `「${srcName}」：${targets.map((t) => gs.cardsById[t.cardId]?.name ?? t.cardId).join('、') || actLabel(act.target ?? 'none')} DMG=0 且未行动` };
    }
    case 'discardDeck': {
      const t = act.target === 'ownDeck' ? owner : ((1 - owner) as PlayerIndex);
      const n = discardDeckTop(gs, t, act.n ?? 1);
      return { prompt: false, msg: `「${srcName}」：${t === owner ? '己方' : '对方'}牌堆破弃 ${n} 张` };
    }
    case 'healDeck': {
      const t = act.target === 'ownDeck' ? owner : ((1 - owner) as PlayerIndex);
      const st = gs.players[t];
      // 玩家已选卡（extraUids）→ 移动到牌组底（不洗牌；「回復しシャッフル」才洗牌）
      if (pending.extraUids.length > 0) {
        let n3 = 0;
        for (const uid3 of pending.extraUids) {
          const idx3 = st.trash.findIndex((c) => c.uid === uid3);
          if (idx3 >= 0) {
            const c3 = st.trash.splice(idx3, 1)[0];
            c3.faceUp = false; // 放回牌堆底 → 背面朝上
            st.deck.push(c3);
            n3++;
          }
        }
        if (act.shuffle && n3 > 0) {
          for (let i = st.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [st.deck[i], st.deck[j]] = [st.deck[j], st.deck[i]];
          }
        }
        return { prompt: false, msg: `「${srcName}」：从ゴミ箱回复 ${n3} 张到牌组底${act.shuffle ? '并洗牌' : ''}` };
      }
      // 规则 1530：デッキ回復由玩家从ゴミ箱选卡（卡面写「ランダムに」的才随机）
      if (act.random !== true) {
        const n2 = act.n ?? 1;
        if (st.trash.length === 0) {
          return { prompt: false, msg: `「${srcName}」：ゴミ箱没有卡可回复` };
        }
        gs.prompt = {
          kind: 'card-pick',
          owner: t,
          title: `「${srcName}」：从ゴミ箱选择要回复的 ${n2} 张卡（放回牌组底${act.shuffle ? '并洗牌' : ''}）`,
          max: Math.min(n2, st.trash.length),
          candidates: st.trash.map((c) => ({ uid: c.uid, name: gs.cardsById[c.cardId]?.name ?? c.cardId, cardId: c.cardId })),
          zone: 'trash',
          sourceUid: pending.sourceUid,
          purpose: 'healDeck',
          param: act.shuffle ? 'shuffle' : undefined,
          pending: { ...pending, stage: pending.stage },
        };
        return { prompt: true, msg: '选择回复卡中' };
      }
      const n = healDeck(gs, t, act.n ?? 1, act.shuffle === true);
      return { prompt: false, msg: `「${srcName}」：${t === owner ? '己方' : '对方'}牌堆回复 ${n} 张${act.shuffle ? '并洗牌' : '（放卡组底）'}` };
    }
    case 'discardHand': {
      const st = gs.players[owner];
      let n = 0;
      for (const uid of pending.extraUids) {
        const idx = st.hand.findIndex((c) => c.uid === uid);
        if (idx >= 0) {
          const c = st.hand.splice(idx, 1)[0];
          c.faceUp = true;
          st.trash.unshift(c);
          n++;
        }
      }
      return { prompt: false, msg: `「${srcName}」：破弃手牌 ${n} 张` };
    }
    case 'discardHandOrUnder': {
      // 从手牌或味方「X」（エリア/角色）下方合计破弃 N 张
      const st = gs.players[owner];
      const name = act.names?.[0] ?? '';
      let n = 0;
      for (const uid of pending.extraUids) {
        const hi = st.hand.findIndex((c) => c.uid === uid);
        if (hi >= 0) {
          const c = st.hand.splice(hi, 1)[0];
          c.faceUp = true;
          st.trash.unshift(c);
          n++;
          continue;
        }
        const hosts: CardInstance[] = [...st.special];
        for (let r = 0; r < 2; r++) {
          for (let a = 0; a < 3; a++) {
            const ar = st.fieldAreas[r][a];
            if (ar && (gs.cardsById[ar.cardId]?.name ?? '') === name) hosts.push(ar);
            const cell = st.field[r][a];
            if (cell && (gs.cardsById[cell.cardId]?.name ?? '') === name) hosts.push(cell);
          }
        }
        let found = false;
        for (const host of hosts) {
          const ui = host.under.findIndex((c) => c.uid === uid);
          if (ui >= 0) {
            const c = host.under.splice(ui, 1)[0];
            c.faceUp = true;
            st.trash.unshift(c);
            n++;
            found = true;
            break;
          }
        }
        void found;
      }
      pending.underPicked = n; // discardCharUpTo 触发门槛用
      return { prompt: false, msg: `「${srcName}」：从手牌/「${name}」下方破弃 ${n} 张` };
    }
    case 'shield': {
      // 规则：从自己的ゴミ箱把卡放到シールド置き場
      const st = gs.players[owner];
      let n = 0;
      for (let i = 0; i < (act.n ?? 1); i++) {
        if (st.trash.length === 0) break;
        const c = st.trash.shift()!;
        c.faceUp = true;
        st.shield.push(c);
        n++;
      }
      return { prompt: false, msg: `「${srcName}」：从ゴミ箱获得护盾 +${n}` };
    }
    case 'exileTrashCopy': {
      const st = gs.players[owner];
      const srcLoc0 = engineLoc(gs, pending.sourceUid);
      const srcCard = srcLoc0 ? gs.cardsById[srcLoc0.inst.cardId] : undefined;
      const idx = st.trash.findIndex((c) => srcCard && c.cardId === srcCard.id);
      if (idx >= 0) {
        const c = st.trash.splice(idx, 1)[0];
        st.removed.unshift(c);
        return { prompt: false, msg: `「${srcName}」：ゴミ箱中的此卡被除外` };
      }
      return { prompt: false, msg: `「${srcName}」：ゴミ箱中没有此卡可除外` };
    }
    case 'discardChar':
    case 'discardCharUpTo': {
      const uids = pending.extraUids.length > 0 ? pending.extraUids : pending.targetUid ? [pending.targetUid] : [];
      let cnt = 0;
      for (const uid of uids) {
        const loc = uid ? engineLoc(gs, uid) : null;
        if (loc && loc.zone === 'field') {
          removeFromField(gs, loc.player, loc.row!, loc.area!);
          // 记录：对方效果使味方离场（复活条件用）
          gs.players[loc.player].turnCounters.oppDiscarded = (gs.players[loc.player].turnCounters.oppDiscarded ?? 0) + 1;
          cnt++;
        }
      }
      return { prompt: false, msg: `「${srcName}」：破弃对方角色 ${cnt} 体` };
    }
    case 'loseAbility': {
      if (src) {
        if (pending.declIdx >= 0) src.inst.lost.push(`decl${pending.declIdx}`);
        else if (pending.trigIdx >= 0) src.inst.lost.push(`trig${pending.trigIdx}`);
        else src.inst.lost.push('cost');
      }
      return { prompt: false, msg: `「${srcName}」：此能力失去` };
    }
    case 'setDp0': {
      const targets = pickTargets(act.target ?? 'none');
      for (const t of targets) t.tempSet.dp = 0;
      return { prompt: false, msg: `「${srcName}」：${actLabel(act.target ?? 'none')} DP=0` };
    }
    case 'removeSelf': {
      const loc = src ? engineLoc(gs, src.inst.uid) : null;
      if (loc && loc.zone === 'field') {
        removeFromField(gs, loc.player, loc.row!, loc.area!);
      } else if (loc && loc.zone === 'area') {
        gs.players[loc.player].fieldAreas[loc.row === 'AF' ? 0 : 1][loc.area ?? 0] = null;
        loc.inst.faceUp = true;
        gs.players[loc.player].trash.unshift(loc.inst);
      } else if (loc && loc.zone === 'special') {
        const idx = gs.players[loc.player].special.indexOf(loc.inst);
        if (idx >= 0) {
          gs.players[loc.player].special.splice(idx, 1);
          loc.inst.faceUp = true;
          gs.players[loc.player].trash.unshift(loc.inst);
        }
      } else if (loc && loc.zone === 'equip') {
        // 道具自爆：解除装备进ゴミ箱
        for (const p of [0, 1] as PlayerIndex[]) {
          for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) {
            const cell = gs.players[p].field[r][a];
            if (cell && cell.equip?.uid === loc.inst.uid) {
              cell.equip = null;
              loc.inst.faceUp = true;
              gs.players[p].trash.unshift(loc.inst);
            }
          }
        }
      }
      return { prompt: false, msg: `「${srcName}」离场/破弃` };
    }
    case 'exileSelf': {
      const loc = src ? engineLoc(gs, src.inst.uid) : null;
      if (loc && loc.zone === 'area') {
        gs.players[loc.player].fieldAreas[loc.row === 'AF' ? 0 : 1][loc.area ?? 0] = null;
        loc.inst.faceUp = true;
        gs.players[loc.player].removed.unshift(loc.inst);
      } else if (loc && loc.zone === 'special') {
        const idx = gs.players[loc.player].special.indexOf(loc.inst);
        if (idx >= 0) {
          gs.players[loc.player].special.splice(idx, 1);
          loc.inst.faceUp = true;
          gs.players[loc.player].removed.unshift(loc.inst);
        }
      }
      return { prompt: false, msg: `「${srcName}」被除外` };
    }
    case 'store': {
      const st = gs.players[owner];
      const name = act.storageName ?? '';
      const list = st.storage[name] ?? (st.storage[name] = []);
      // 「カードがN枚以下の…置き場に置ける」= 放第 N+1 张后即达上限（超过 N 张时不可再放）
      if ((act.cap ?? 99) > 0 && list.length > (act.cap ?? 99)) {
        pending.placedAny = false; // 未放置（Bug 3：置いたとき才抽）
        return { prompt: false, msg: `「${srcName}」：「${name}」置き場已满（上限 ${(act.cap ?? 99) + 1}），无法放入` };
      }
      let n = 0;
      for (const uid of pending.extraUids) {
        if (n >= (act.n ?? 99)) break;
        if ((act.cap ?? 99) > 0 && list.length > (act.cap ?? 99)) break;
        const idx = st.trash.findIndex((c) => c.uid === uid);
        if (idx >= 0) {
          const c = st.trash.splice(idx, 1)[0];
          c.faceUp = true;
          list.push(c);
          n++;
        }
      }
      pending.placedAny = n > 0;
      return { prompt: false, msg: `「${srcName}」：ゴミ箱 ${n} 张放入「${name}」置き場（${list.length} 张）` };
    }
    case 'storeUnder': {
      if (!src) return { prompt: false, msg: '' };
      const st = gs.players[owner];
      // 「そのエリア」：优先指向本选项内检索配置的エリア（6960 触发 → AMBITIOUS MISSION），否则为触发源
      const targetUid = pending.placedAreaUid || src.inst.uid;
      const targetLoc = engineLoc(gs, targetUid);
      const target = targetLoc && targetLoc.zone === 'area' ? targetLoc.inst : src.inst;
      const targetName = gs.cardsById[target.cardId]?.name ?? '?';
      if ((act.cap ?? 99) > 0 && target.under.length > (act.cap ?? 99)) {
        pending.placedAny = false; // 未放置（Bug 3）
        return { prompt: false, msg: `「${srcName}」：「${targetName}」下方已满（上限 ${(act.cap ?? 99) + 1}），无法放入` };
      }
      let n = 0;
      for (const uid of pending.extraUids) {
        if (n >= (act.n ?? 99)) break;
        if ((act.cap ?? 99) > 0 && target.under.length > (act.cap ?? 99)) break;
        const idx = st.trash.findIndex((c) => c.uid === uid);
        if (idx >= 0) {
          const c = st.trash.splice(idx, 1)[0];
          c.faceUp = true;
          target.under.push(c);
          n++;
        }
      }
      pending.placedAny = n > 0;
      return { prompt: false, msg: `「${srcName}」：ゴミ箱 ${n} 张放入「${targetName}」下方（${target.under.length} 张）` };
    }
    case 'trashCopyToDeckBottom': {
      const st = gs.players[owner];
      const srcLoc0 = engineLoc(gs, pending.sourceUid);
      const srcCard = srcLoc0 ? gs.cardsById[srcLoc0.inst.cardId] : undefined;
      const idx = st.trash.findIndex((c) => srcCard && c.cardId === srcCard.id);
      if (idx >= 0) {
        const c = st.trash.splice(idx, 1)[0];
        c.faceUp = false; // 放回牌堆底 → 背面朝上
        st.deck.unshift(c);
        return { prompt: false, msg: `「${srcName}」：ゴミ箱中的此卡放回牌堆底` };
      }
      return { prompt: false, msg: `「${srcName}」：ゴミ箱中没有此卡` };
    }
    case 'discardedToDeckBottom': {
      // エンゲージ登场被破弃的角色（ゴミ箱中的同名卡）放回牌堆底
      const st = gs.players[owner];
      const e = gs.lastEngageDiscard;
      if (e) {
        const idx = st.trash.findIndex((c) => c.cardId === e.cardId);
        if (idx >= 0) {
          const c = st.trash.splice(idx, 1)[0];
          c.faceUp = false; // 放回牌堆底 → 背面朝上
          st.deck.unshift(c);
          return { prompt: false, msg: `「${srcName}」：被破弃的「${e.name}」放回牌堆底` };
        }
      }
      return { prompt: false, msg: `「${srcName}」：ゴミ箱中没有被破弃的角色` };
    }
    case 'recoverDiscarded': {
      // エンゲージ括弧效果「破棄キャラを回復」：被破弃的角色放回牌堆底（不洗牌）
      const st = gs.players[owner];
      const e = gs.lastEngageDiscard;
      if (e) {
        const idx = st.trash.findIndex((c) => c.cardId === e.cardId);
        if (idx >= 0) {
          const c = st.trash.splice(idx, 1)[0];
          c.faceUp = false; // 放回牌堆底 → 背面朝上
          st.deck.unshift(c);
          return { prompt: false, msg: `「${srcName}」：被破弃的「${e.name}」回牌堆底` };
        }
      }
      return { prompt: false, msg: `「${srcName}」：ゴミ箱中没有被破弃的角色` };
    }
    case 'storeUnderArea': {
      // 放入持有者指定名称的エリア（如 AMBITIOUS MISSION）下方
      const st = gs.players[owner];
      let area: CardInstance | undefined = st.special.find((c) => (gs.cardsById[c.cardId]?.name ?? '') === act.areaName);
      if (!area) {
        for (let r = 0; r < 2 && !area; r++) for (let a = 0; a < 3 && !area; a++) {
          const ar = st.fieldAreas[r][a];
          if (ar && (gs.cardsById[ar.cardId]?.name ?? '') === act.areaName) area = ar;
        }
      }
      if (!area) return { prompt: false, msg: `「${srcName}」：场上没有「${act.areaName}」エリア` };
      let n = 0;
      for (const uid of pending.extraUids) {
        if (n >= (act.n ?? 99)) break;
        const idx = st.trash.findIndex((c) => c.uid === uid);
        if (idx >= 0) {
          const c = st.trash.splice(idx, 1)[0];
          c.faceUp = true;
          area.under.push(c);
          n++;
        }
      }
      pending.placedAny = n > 0;
      return { prompt: false, msg: `「${srcName}」：ゴミ箱 ${n} 张放入「${act.areaName}」下方` };
    }
    case 'reviveSelf': {
      if (pending.extraUids.length > 0) return { prompt: false, msg: '' }; // 已由 chooseSlot 放置
      const st = gs.players[owner];
      const srcLoc0 = engineLoc(gs, pending.sourceUid);
      const srcCard = srcLoc0 ? gs.cardsById[srcLoc0.inst.cardId] : undefined;
      const idx = st.trash.findIndex((c) => srcCard && c.cardId === srcCard.id);
      if (idx >= 0) {
        // 找第一个空格
        let slot: { r: number; a: number } | null = null;
        for (let r = 0; r < 2 && !slot; r++) for (let a = 0; a < 3; a++) {
          if (!st.field[r][a]) {
            slot = { r, a };
            break;
          }
        }
        if (!slot) return { prompt: false, msg: `「${srcName}」：场上没有空位，无法复活登场` };
        const c = st.trash.splice(idx, 1)[0];
        c.faceUp = true;
        c.tapped = (act.n ?? 0) > 0;
        c.deployedTurn = gs.turn;
        st.field[slot.r][slot.a] = c;
        return { prompt: false, msg: `「${srcName}」：ゴミ箱中的此卡免费登场${(act.n ?? 0) > 0 ? '（行动済み）' : ''}` };
      }
      return { prompt: false, msg: `「${srcName}」：ゴミ箱中没有此卡` };
    }
    case 'moveSelfDF': {
      if (!src || src.zone !== 'field') return { prompt: false, msg: '' };
      const st = gs.players[owner];
      for (let a = 0; a < 3; a++) {
        if (!st.field[1][a]) {
          st.field[src.row === 'AF' ? 0 : 1][src.area ?? 0] = null;
          st.field[1][a] = src.inst;
          return { prompt: false, msg: `「${srcName}」移动到味方ＤＦ` };
        }
      }
      return { prompt: false, msg: `「${srcName}」：ＤＦ没有空位` };
    }
    case 'storeAll': {
      const st = gs.players[owner];
      const name = act.names?.[0] ?? '';
      const storageName = act.storageName ?? '';
      let n = 0;
      for (let r = 0; r < 2; r++) {
        for (let a = 0; a < 3; a++) {
          const cell = st.field[r][a];
          if (cell && cardMatchesName(gs, cell.cardId, name)) {
            st.field[r][a] = null;
            cell.faceUp = true;
            (st.storage[storageName] ?? (st.storage[storageName] = [])).push(cell);
            n++;
          }
        }
      }
      return { prompt: false, msg: `「${srcName}」：味方「${name}」${n} 体放入「${storageName}」置き場` };
    }
    case 'equipSelfToTarget': {
      const st = gs.players[owner];
      const srcLoc0 = engineLoc(gs, pending.sourceUid);
      const srcCard = srcLoc0 ? gs.cardsById[srcLoc0.inst.cardId] : undefined;
      const idx = st.trash.findIndex((c) => srcCard && c.cardId === srcCard.id);
      const targetLoc = pending.targetUid ? engineLoc(gs, pending.targetUid) : null;
      if (idx >= 0 && targetLoc && targetLoc.zone === 'field' && !targetLoc.inst.equip) {
        const c = st.trash.splice(idx, 1)[0];
        c.faceUp = true;
        targetLoc.inst.equip = c;
        pending.equippedUid = c.uid;
        return { prompt: false, msg: `「${srcName}」：ゴミ箱中的此道具装备给「${gs.cardsById[targetLoc.inst.cardId]?.name ?? '?'}」` };
      }
      return { prompt: false, msg: `「${srcName}」：无法装备（ゴミ箱中没有此道具或目标已装备）` };
    }
    case 'selfToDeckBottom': {
      const loc0 = src ? engineLoc(gs, src.inst.uid) : null;
      if (loc0 && loc0.zone === 'field') {
        const st2 = gs.players[loc0.player];
        st2.field[loc0.row === 'AF' ? 0 : 1][loc0.area ?? 0] = null;
        loc0.inst.faceUp = false;
        st2.deck.unshift(loc0.inst);
        return { prompt: false, msg: `「${srcName}」放回牌堆底` };
      }
      return { prompt: false, msg: '' };
    }
    case 'grantBonusIfNone': {
      if (!src) return { prompt: false, msg: '' };
      const sc = gs.cardsById[src.inst.cardId];
      // 已拥有（卡面基本能力 或 效果已授予的临时ボーナス）→ 不再重复授予（Bug ④）
      const hasBasic = (sc ? basicAbilityValue(sc, 'ボーナス') !== '' : false) || !!src.inst.tempBonus;
      if (!hasBasic) {
        src.inst.tempBonus = act.bonus ?? null;
        return { prompt: false, msg: `「${srcName}」获得ボーナス（${act.bonus === 'discardDeck' ? '对方牌堆破弃1' : '己方牌堆回复1'}）` };
      }
      return { prompt: false, msg: `「${srcName}」已有ボーナス` };
    }
    case 'forceDefend': {
      // 强制防御：给“被加成的味方角色”标记指定防御目标
      const tUid = pending.targetUid;
      const tLoc = tUid ? engineLoc(gs, tUid) : null;
      const fUid = pending.forceTarget;
      if (tLoc && fUid) {
        tLoc.inst.tempForceDefend = { targetUid: fUid, turn: gs.turn };
        return { prompt: false, msg: `「${cardName(gs, tUid as string)}」被指定：下次攻击时对方必须用「${cardName(gs, fUid as string)}」防御` };
      }
      return { prompt: false, msg: '' };
    }
    case 'grantBonus': {
      const uid = pending.targetUid;
      const loc = uid ? engineLoc(gs, uid) : null;
      if (loc) {
        loc.inst.tempBonus = act.bonus ?? null;
        return { prompt: false, msg: `「${srcName}」：目标获得ボーナス（${act.bonus === 'discardDeck' ? '对方牌堆破弃1' : '己方牌堆回复1'}）` };
      }
      return { prompt: false, msg: '' };
    }
    case 'supportAsDp': {
      // 6962：自ターン中，味方キャラ支援宣言时，可把「这次支援的参考值」从支援角色的 SP 改为其 DP（玩家已确认）
      const b = gs.battle;
      const last = b?.lastSupport;
      const isYes = pending.extraUids.includes('yes');
      if (!last || !isYes) return { prompt: false, msg: '' };
      const supLoc = last.supporterUid ? engineLoc(gs, last.supporterUid) : null;
      const dpVal = supLoc ? effectiveStats(gs, last.supporterUid).dp : 0;
      const tLoc = last.targetUid ? engineLoc(gs, last.targetUid) : null;
      if (tLoc && tLoc.zone === 'field') {
        // 撤销原来按 SP 加的支援修正，再按支援角色的 DP 重新支援
        const side = last.attackerSide ? 'ap' : 'dp';
        tLoc.inst.tempMods[side] = Math.max(0, tLoc.inst.tempMods[side] - last.sp);
        tLoc.inst.tempMods[side] += dpVal;
        if (b) {
          if (last.attackerSide) b.supportAP = Math.max(0, (b.supportAP ?? 0) - last.sp) + dpVal;
          else b.supportDP = Math.max(0, (b.supportDP ?? 0) - last.sp) + dpVal;
        }
        return { prompt: false, msg: `「${srcName}」：支援参考值改为该角色的 ＤＰ（＋${dpVal}）` };
      }
      return { prompt: false, msg: '' };
    }
    default:
      return { prompt: false, msg: '' };
  }
}

/* ================= 效果链 ================= */

/** 从 pending 中取回选项动作列表 */
function pendingActions(gs: GameState, pending: PendingEffect): EffAction[] {
  const src = engineLoc(gs, pending.sourceUid);
  if (!src) return [];
  const card = gs.cardsById[src.inst.cardId];
  if (!card) return [];
  const p = getParsed(card);
  if (pending.declIdx >= 0 && p.declared[pending.declIdx]) {
    const opt = p.declared[pending.declIdx].options.find((o) => o.id === pending.optionId);
    return opt ? opt.actions : [];
  }
  if (pending.trigIdx >= 0 && p.triggers[pending.trigIdx]) {
    const opt = p.triggers[pending.trigIdx].options.find((o) => o.id === pending.optionId);
    return opt ? opt.actions : [];
  }
  return [];
}

/** 选项条件检查：返回不满足的原因（null = 满足） */
export function optionCondFails(gs: GameState, pending: PendingEffect): string | null {
  const opt = pendingOption(gs, pending);
  if (!opt?.cond) return null;
  const src = engineLoc(gs, pending.sourceUid);
  const owner = pending.owner;
  switch (opt.cond) {
    case 'under3':
      return src && src.inst.under.length >= 3 ? null : '此エリア下方不足 3 张';
    case 'oppDiscarded1':
      return (gs.players[owner].turnCounters.oppDiscarded ?? 0) >= 1 ? null : '本回合味方未因对方效果离场';
    case 'oppDiscarded2':
      return (gs.players[owner].turnCounters.oppDiscarded ?? 0) >= 2 ? null : '本回合味方因对方效果离场不足 2 体';
    case 'oppHandDiscard':
      return null; // 手牌破弃追踪未实现 → 近似允许（日志说明）
    case 'af2WithT': {
      let n = 0;
      for (let a = 0; a < 3; a++) {
        const c = gs.players[owner].field[0][a];
        if (c && (gs.cardsById[c.cardId]?.ability ?? '').includes('[T]:')) n++;
      }
      return n >= 2 ? null : '味方ＡＦ中使用代償[T]的角色不足 2 体';
    }
    case 'selfDp0':
      return src && effectiveStats(gs, src.inst.uid).dp === 0 ? null : '此角色 DP 不为 0';
    case 'charge1':
      return src && src.inst.charge.length >= 1 ? null : '此角色没有充能（チャージ不足 1 张）';
    case 'storage4': {
      const storageName = opt.actions.find((a) => a.storageName)?.storageName ?? '';
      return (gs.players[owner].storage[storageName] ?? []).length >= 4 ? null : `「${storageName}」置き場不足 4 张`;
    }
    case 'friendlyN4':
    case 'friendlyN2': {
      const name = opt.condParam ?? '';
      const n = countFriendlyNamed(gs, owner, name);
      const need = opt.cond === 'friendlyN4' ? 4 : 2;
      return n >= need ? null : `味方「${name}」不足 ${need} 张`;
    }
    default:
      return null;
  }
}

/** 某玩家场上（フィールド上的エリア + 特殊置场 + 装备道具）同名「X」的枚数 */
function countFriendlyNamed(gs: GameState, owner: PlayerIndex, name: string): number {
  let n = 0;
  for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) {
    const ar = gs.players[owner].fieldAreas[r][a];
    if (ar && cardMatchesName(gs, ar.cardId, name)) n++;
    const cell = gs.players[owner].field[r][a];
    if (cell?.equip && cardMatchesName(gs, cell.equip.cardId, name)) n++;
  }
  return n;
}

/** 动作级条件（中段条件前缀）检查：不满足则跳过该动作 */
function actionCondFails(gs: GameState, pending: PendingEffect, act: EffAction): string | null {
  if (!act.cond) return null;
  const src = engineLoc(gs, pending.sourceUid);
  const owner = pending.owner;
  switch (act.cond) {
    case 'under3':
      return src && src.inst.under.length >= 3 ? null : '此エリア下方不足 3 张';
    case 'storage4': {
      const opt = pendingOption(gs, pending);
      const name = act.condParam ?? act.storageName ?? opt?.actions.find((a) => a.storageName)?.storageName ?? '';
      return (gs.players[owner].storage[name] ?? []).length >= 4 ? null : `「${name}」置き場不足 4 张`;
    }
    case 'friendlyN2':
    case 'friendlyN4': {
      const name = act.condParam ?? '';
      const n = countFriendlyNamed(gs, owner, name);
      return n >= (act.cond === 'friendlyN4' ? 4 : 2) ? null : `味方「${name}」不足 ${act.cond === 'friendlyN4' ? 4 : 2} 张`;
    }
    case 'discardedNamed': {
      const e = gs.lastEngageDiscard;
      const norm = (s: string) => s.replace(/\s/g, '');
      return e && norm(e.name) === norm(act.condParam ?? '') ? null : `被破弃的角色不是「${act.condParam ?? ''}」`;
    }
    case 'yushuAreaDestroy': {
      // 自毁条件：味方AF原DMG≥N 的角色 ≤M 体，或非由「玉樹桜」能力配置 → 此エリア破弃
      const [dmgT, cntT] = (act.condParam ?? '2:2').split(':').map(Number);
      let n = 0;
      for (let a = 0; a < 3; a++) {
        const c = gs.players[owner].field[0][a];
        if (c && (gs.cardsById[c.cardId]?.dmg ?? 0) >= dmgT) n++;
      }
      const placedByYushu = src?.inst.placedByYushu === true;
      if (n <= cntT || !placedByYushu) return null; // 满足自毁条件 → 执行破弃
      return `自毁条件不满足（味方AF原DMG≥${dmgT} 有 ${n} 体且由玉樹桜配置）`;
    }
    default:
      return null;
  }
}

/** 某玩家的空场地格（复活登场用，不含配置限制检查） */
export function freeFieldSlots(gs: GameState, owner: PlayerIndex): { row: RowName; area: AreaIndex }[] {
  const out: { row: RowName; area: AreaIndex }[] = [];
  for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) {
    if (!gs.players[owner].field[r][a]) out.push({ row: r === 0 ? 'AF' : 'DF', area: a as AreaIndex });
  }
  return out;
}

/** 效果链内触发子句的 perTurn key（用于跳过已处理子句） */
export function trigChainKey(p2: PendingEffect, turn: number): string | undefined {
  return p2.trigIdx >= 0 && p2.trigger ? `${p2.trigger}:${p2.sourceUid}:${p2.trigIdx}:${turn}` : undefined;
}

/** 继续执行效果链（从 pending.stage 开始） */
export function finalizeActions(gs: GameState, pending: PendingEffect): GameState {
  let next: GameState = structuredClone(gs);
  const p2: PendingEffect = structuredClone(pending);
  const skipKey = trigChainKey(p2, next.turn);
  // 选项条件
  const condFail = optionCondFails(next, p2);
  if (condFail) {
    pushLog(next, `「${cardName(next, p2.sourceUid)}」条件未满足（${condFail}），效果不发动。`);
    next.prompt = null;
    if (p2.trigger) return continueTriggerChain(next, p2.trigger, p2.owner, p2.scanAll ? null : p2.sourceUid, skipKey);
    return next;
  }
  const actions = pendingActions(next, p2);
  let i = p2.stage;
  if (p2.skipCurrent) {
    // 取消选卡等：跳过当前动作（Bug ④：6848 手牌/下方破弃取消）
    p2.skipCurrent = false;
    i = Math.min(i + 1, actions.length);
  }
  for (; i < actions.length; i++) {
    const act = actions[i];
    // 动作级条件（中段条件前缀）不满足 → 跳过该动作
    const actCondFail = actionCondFails(next, p2, act);
    if (actCondFail) {
      pushLog(next, `「${cardName(next, p2.sourceUid)}」条件未满足（${actCondFail}），跳过。`);
      continue;
    }
    const needsT = actionNeedsTarget(act) && act.target !== 'self' && !p2.targetUid;
    if (needsT) {      const cands = targetCandidates(next, p2.owner, act);
      if (cands.length === 0) {
        pushLog(next, `「${cardName(next, p2.sourceUid)}」没有可指定的目标，跳过。`);
        continue;
      }
      if (cands.length === 1) {
        p2.targetUid = cands[0].uid;
        continue;
      }
      next.prompt = {
        kind: 'declare-target',
        uid: p2.sourceUid,
        tag: p2.declIdx >= 0 ? '宣言' : '诱発',
        owner: p2.owner,
        actionLabel: `「${cardName(next, p2.sourceUid)}」效果：选择目标（${act.label ?? ''}）`,
        candidates: cands,
        pending: { ...p2, stage: i },
      };
      return next;
    }
    if (act.t === 'search') {
      // 已处理过的检索（登场/放弃后恢复外层链）→ 跳过，防止重复弹检索（bug 修复）
      if (p2.searchDone) {
        // 检索装备（6887）：目标已选 → 实际执行装备（非「無償で」需支付道具费用）
        if (act.kind === 'equip' && p2.searchEquip && p2.targetUid) {
          const eqR = applySearchEquip(next, p2, act, i);
          if (eqR.prompt) return eqR;
          next = eqR;
        }
        continue;
      }
      p2.stage = i; // 同步 stage 到提示携带的 pend（恢复链从正确位置继续）
      const r = applySingleAction(next, p2, act, false);
      if (r.prompt) {
        return next;
      }
      p2.searchDone = true;
      pushLog(next, r.msg);
      continue;
    }
    if (act.t === 'discardHand' && p2.extraUids.length === 0 && next.players[p2.owner].hand.length > 0) {
      const hand = next.players[p2.owner].hand;
      next.prompt = {
        kind: 'effect-choice',
        owner: p2.owner,
        title: `「${cardName(next, p2.sourceUid)}」：选择要破弃的 ${act.n ?? 1} 张手牌`,
        multi: (act.n ?? 1) > 1,
        max: act.n ?? 1,
        options: hand.map((c) => ({ id: c.uid, label: gs.cardsById[c.cardId]?.name ?? c.cardId, cardId: c.cardId })),
        pending: { ...p2, stage: i },
      };
      return next;
    }
    // 支援值作为 DP（6962）：玩家确认是否转换
    if (act.t === 'supportAsDp' && !p2.extraUids.includes('yes') && !p2.extraUids.includes('no')) {
      const last = next.battle?.lastSupport;
      if (!last) {
        pushLog(next, `「${cardName(next, p2.sourceUid)}」：没有最近的支援可转换。`);
        continue;
      }
      next.prompt = {
        kind: 'effect-choice',
        owner: p2.owner,
        title: `「${cardName(next, p2.sourceUid)}」：把这次支援值（SP ${last.sp}）作为 DP？`,
        multi: false,
        max: 1,
        options: [
          { id: 'yes', label: `作为 DP（DP +${last.sp}，AP 减回）` },
          { id: 'no', label: '保持 AP' },
        ],
        pending: { ...p2, stage: i },
      };
      return next;
    }
    if (act.t === 'dmgZero' && (act.n ?? 1) > 1 && p2.extraUids.length === 0) {
      const cands = targetCandidates(next, p2.owner, act);
      if (cands.length > 0) {
        next.prompt = {
          kind: 'effect-choice',
          owner: p2.owner,
          title: `「${cardName(next, p2.sourceUid)}」：选择最多 ${act.n} 个角色（DMG=0 且未行动）`,
          multi: true,
          max: act.n ?? 1,
          options: cands.map((c) => ({ id: c.uid, label: c.name })),
          pending: { ...p2, stage: i },
        };
        return next;
      }
      pushLog(next, `「${cardName(next, p2.sourceUid)}」没有可指定的目标，跳过。`);
      continue;
    }
    // 充能/置き場/エリア下方：需要玩家选择具体卡片
    if ((act.t === 'store' || act.t === 'storeUnder' || act.t === 'storeUnderArea' || act.t === 'charge' || act.t === 'discardCharge') && p2.extraUids.length === 0) {
      const srcL = engineLoc(next, p2.sourceUid);
      const st = next.players[p2.owner];
      const isDiscard = act.t === 'discardCharge';
      const availList: CardInstance[] = isDiscard ? (srcL?.inst.charge ?? []) : st.trash;
      if (availList.length === 0) {
        pushLog(next, `「${cardName(next, p2.sourceUid)}」：没有可选的卡（${isDiscard ? '充能为空' : 'ゴミ箱为空'}），跳过。`);
        continue;
      }
      const zone = isDiscard ? 'charge' : 'trash';
      const purpose = ({ store: 'store', storeUnder: 'storeUnder', storeUnderArea: 'storeUnder', charge: 'charge', discardCharge: 'discardCharge' } as const)[act.t];
      const title =
        act.t === 'discardCharge'
          ? `「${cardName(next, p2.sourceUid)}」：选择要破弃的 ${act.n ?? 1} 张充能`
          : act.t === 'store'
            ? `「${cardName(next, p2.sourceUid)}」：选择放入「${act.storageName}」置き場的卡（最多 ${act.n ?? 99} 张）`
            : act.t === 'storeUnder'
              ? `「${cardName(next, p2.sourceUid)}」：选择放入此エリア下方的卡（最多 ${act.n ?? 99} 张）`
              : act.t === 'storeUnderArea'
                ? `「${cardName(next, p2.sourceUid)}」：选择放入「${act.areaName}」下方的卡`
                : `「${cardName(next, p2.sourceUid)}」：选择放入充能的卡（最多 ${act.n ?? 1} 张）`;
      next.prompt = {
        kind: 'card-pick',
        owner: p2.owner,
        title,
        max: act.n ?? 1,
        candidates: availList.map((c) => ({ uid: c.uid, name: gs.cardsById[c.cardId]?.name ?? c.cardId, cardId: c.cardId })),
        zone,
        sourceUid: srcL?.inst.uid ?? null,
        purpose,
        pending: { ...p2, stage: i },
      };
      return next;
    }
    // 手牌或味方「X」（エリア/角色）下方合计破弃：玩家选择具体卡
    if (act.t === 'discardHandOrUnder' && p2.extraUids.length === 0) {
      const st0 = next.players[p2.owner];
      const name0 = act.names?.[0] ?? '';
      const cands: CardInstance[] = [...st0.hand];
      for (const host of fieldCards(next, p2.owner, true)) {
        if ((next.cardsById[host.cardId]?.name ?? '') === name0) cands.push(...host.under);
      }
      if (cands.length === 0) {
        pushLog(next, `「${cardName(next, p2.sourceUid)}」：没有可破弃的卡（手牌/「${name0}」下方为空）。`);
        continue;
      }
      const srcL1 = engineLoc(next, p2.sourceUid);
      next.prompt = {
        kind: 'card-pick',
        owner: p2.owner,
        title: `「${cardName(next, p2.sourceUid)}」：选择要破弃的卡（手牌或「${name0}」下方，合计最多 ${act.n ?? 1} 张）`,
        max: act.n ?? 1,
        candidates: cands.map((c) => ({ uid: c.uid, name: next.cardsById[c.cardId]?.name ?? c.cardId, cardId: c.cardId })),
        zone: 'hand-under',
        sourceUid: srcL1?.inst.uid ?? null,
        purpose: 'handUnder',
        pending: { ...p2, stage: i },
      };
      return next;
    }
    // 破弃对方角色（N 体まで）：须先完成上面的合计破弃才触发
    if (act.t === 'discardCharUpTo') {
      const prevAct = actions[i - 1];
      const need = prevAct && prevAct.t === 'discardHandOrUnder' ? prevAct.n ?? 5 : 0;
      const pickedN = prevAct && prevAct.t === 'discardHandOrUnder' ? p2.underPicked ?? 0 : p2.extraUids.length;
      // 若 extraUids 已是对方场上角色（本次选择已完成）→ 直接应用
      const allOppField = p2.extraUids.length > 0 && p2.extraUids.every((u) => {
        const l = engineLoc(next, u);
        return l && l.zone === 'field' && l.player === (1 - p2.owner) as PlayerIndex;
      });
      if (!allOppField) {
        if (pickedN < need) {
          pushLog(next, `「${cardName(next, p2.sourceUid)}」：未破弃满 ${need} 张，后续效果不发动。`);
          continue;
        }
        const cands2 = targetCandidates(next, p2.owner, { t: 'discardChar', target: 'oneOpponent' } as EffAction);
        if (cands2.length === 0) {
          pushLog(next, `「${cardName(next, p2.sourceUid)}」：没有可破弃的对方角色。`);
          continue;
        }
        if (cands2.length === 1) {
          p2.extraUids = [cands2[0].uid];
        } else {
          const srcL2 = engineLoc(next, p2.sourceUid);
          next.prompt = {
            kind: 'card-pick',
            owner: p2.owner,
            title: `「${cardName(next, p2.sourceUid)}」：选择要破弃的对方角色（最多 ${act.n ?? 1} 体）`,
            max: act.n ?? 1,
            candidates: cands2.map((c) => ({ uid: c.uid, name: c.name, cardId: engineLoc(next, c.uid)?.inst.cardId ?? '' })),
            zone: 'field',
            sourceUid: srcL2?.inst.uid ?? null,
            purpose: 'discardOppChar',
            pending: { ...p2, stage: i },
          };
          return next;
        }
      }
    }
    // 复活登场：空位多于 1 个时由玩家选择位置
    if (act.t === 'reviveSelf' && p2.extraUids.length === 0) {
      const freeSlots = freeFieldSlots(next, p2.owner);
      if (freeSlots.length === 0) {
        pushLog(next, `「${cardName(next, p2.sourceUid)}」：场上没有空位，无法复活登场。`);
        continue;
      }
      if (freeSlots.length > 1) {
        next.prompt = {
          kind: 'slot-pick',
          owner: p2.owner,
          title: `「${cardName(next, p2.sourceUid)}」：选择复活登场的位置`,
          uid: p2.sourceUid,
          slots: freeSlots,
          purpose: 'revive',
          tapped: (act.n ?? 0) > 0,
          pending: { ...p2, stage: i },
        };
        return next;
      }
    }
    // 破弃/移除前记录可能离场的道具（离场诱発用）
    const preEquip = (() => {
      if (act.t === 'discardChar' && p2.targetUid) {
        const l = engineLoc(next, p2.targetUid);
        return l?.inst.equip?.uid ?? null;
      }
      if (act.t === 'removeSelf') {
        const l = engineLoc(next, p2.sourceUid);
        return l?.zone === 'equip' ? l.inst.uid : null;
      }
      return null;
    })();
    // 强制防御：需要额外指定对方角色（forceTarget）
    if (act.t === 'forceDefend' && !p2.forceTarget) {
      const fCands = targetCandidates(next, p2.owner, { t: 'forceDefend', target: 'oneOpponent' } as EffAction);
      if (fCands.length === 1) {
        p2.forceTarget = fCands[0].uid;
      } else if (fCands.length > 1) {
        next.prompt = {
          kind: 'declare-target',
          uid: p2.sourceUid,
          tag: '宣言',
          owner: p2.owner,
          actionLabel: `「${cardName(next, p2.sourceUid)}」：选择强制防御的对方角色`,
          candidates: fCands,
          pending: { ...p2, stage: i },
        };
        return next;
      }
    }
    // 置いたとき 抽牌：紧接放置动作且未放置 → 不抽（Bug 3）
    if (act.t === 'draw' && i > 0) {
      const prevAct = actions[i - 1];
      if ((prevAct.t === 'store' || prevAct.t === 'storeUnder' || prevAct.t === 'storeUnderArea') && p2.placedAny === false) {
        pushLog(next, `「${cardName(next, p2.sourceUid)}」：未放置卡，不抽。`);
        continue;
      }
    }
    // 效果装备（Bug ⑨）：非「無償で装備」需支付道具费用（6955/6957 手札宣言装备）
    if (act.t === 'equipSelfToTarget' && !p2.equipPaid && !act.free) {
      const eqSrcL = engineLoc(next, p2.sourceUid);
      const eqCard = eqSrcL ? next.cardsById[eqSrcL.inst.cardId] : undefined;
      const eqCost = eqCard?.cost ?? '';
      if (eqCard && eqCost) {
        const restCost = poolAdjustedCost(next, p2.owner, eqCost, { kind: 'equip', card: eqCard });
        if (restCost && !canPayCost(next, p2.owner, restCost) && !canCostPoolCover(next, p2.owner, restCost, { kind: 'equip', card: eqCard })) {
          pushLog(next, `「${cardName(next, p2.sourceUid)}」：费用不足，无法支付装备费用（${eqCost}），装备失败。`);
          continue;
        }
        if (restCost) {
          next.prompt = {
            kind: 'cost-pay',
            cost: restCost,
            actionLabel: `装备「${eqCard.name}」（支付道具费用）`,
            owner: p2.owner,
            pending: { action: 'equipSelfToTargetPay', uid: eqSrcL!.inst.uid, itemCardId: eqCard.id, effectPending: { ...p2, stage: i } },
            candidates: next.players[p2.owner].hand.map((c) => ({
              uid: c.uid,
              name: next.cardsById[c.cardId]?.name ?? c.cardId,
              elements: next.cardsById[c.cardId]?.elements ?? '',
              ex: next.cardsById[c.cardId]?.ex ?? 0,
              cardId: c.cardId,
            })),
          };
          return next;
        }
      }
    }
    p2.stage = i; // 同步 stage 到提示携带的 pend（恢复链从正确位置继续）
    const r = applySingleAction(next, p2, act, false);
    if (r.prompt) return next; // 需要玩家选择（如デッキ回復选卡）→ 等待选择后继续
    pushLog(next, r.msg);
    // 效果装备成功 → 装備したとき诱発链（Bug ⑧）
    if (act.t === 'equipSelfToTarget' && p2.equippedUid) {
      const afterEq = continueTriggerChain(next, 'equip', p2.owner, p2.equippedUid);
      if (afterEq.prompt) return afterEq;
      next = afterEq;
    }
    p2.extraUids = []; // 消费型动作已用完选卡，清空避免残留给后续动作
    // 放置失败（下方/置き場已满或无法放入）→ 中止整段效果链（LO-6959：判定放不下后不再抽牌/回血/洗牌）
    if ((act.t === 'store' || act.t === 'storeUnder' || act.t === 'storeUnderArea') && p2.placedAny === false) {
      pushLog(next, `「${cardName(next, p2.sourceUid)}」：未放置卡，后续效果不再处理。`);
      break;
    }
    // 破弃对方角色 → 触发对方的“味方キャラ因对方效果离场”诱発
    if (act.t === 'discardChar' && p2.targetUid) {
      const victimOwner = (1 - p2.owner) as PlayerIndex;
      const after = continueTriggerChain(next, 'oppCharLeaves', victimOwner, null);
      if (after.prompt) return after;
      next = after;
    }
    // 道具离场 → 「このアイテムが場を離れたとき」诱発
    if (preEquip) {
      const iOwner = act.t === 'discardChar' ? ((1 - p2.owner) as PlayerIndex) : p2.owner;
      const after2 = continueTriggerChain(next, 'itemLeaves', iOwner, preEquip);
      if (after2.prompt) return after2;
      next = after2;
    }
  }
  // 选项部分解析：剩余文本 → 手动面板
  const partial = pendingPartialRaw(next, p2);
  if (partial) {
    next.prompt = { kind: 'manual-effect', title: `「${cardName(next, p2.sourceUid)}」效果（部分需手动）`, text: partial, owner: p2.owner };
    return next;
  }
  // 链结束：若为诱発 → 继续扫描同类别触发（跳过刚处理的子句）
  if (p2.trigger === '__event') {
    // 嵌套效果链（如 6862 检索后用手札宣言）完成后 → 恢复外层链
    if (p2.resumePending) {
      const rp: PendingEffect = structuredClone(p2.resumePending);
      rp.searchDone = true;
      return finalizeActions(next, rp);
    }
    const firedE = maybeFireAreaEvent(next);
    if (firedE.prompt) return firedE;
    next = firedE;
    next.prompt = null;
    return next;
  }
  if (p2.trigger) {
    return continueTriggerChain(next, p2.trigger, p2.owner, p2.scanAll ? null : p2.sourceUid, skipKey);
  }
  const fired = maybeFireAreaEvent(next);
  if (fired.prompt) return fired;
  next = fired;
  next.prompt = null;
  return next;
}

function pendingOption(gs: GameState, pending: PendingEffect): EffOption | null {
  const src = engineLoc(gs, pending.sourceUid);
  if (!src) return null;
  const card = gs.cardsById[src.inst.cardId];
  if (!card) return null;
  const p = getParsed(card);
  if (pending.declIdx >= 0) return p.declared[pending.declIdx]?.options.find((o) => o.id === pending.optionId) ?? null;
  if (pending.trigIdx >= 0) return p.triggers[pending.trigIdx]?.options.find((o) => o.id === pending.optionId) ?? null;
  return null;
}

function pendingPartialRaw(gs: GameState, pending: PendingEffect): string | null {
  return pendingOption(gs, pending)?.partialRaw ?? null;
}

/** 触发条件检查（不满足返回 false；供扫描循环与候选收集共用） */
function triggerCondOk(gs: GameState, src: CardInstance, tc: TriggerClause, owner: PlayerIndex): boolean {
  const rowOf = (inst: CardInstance): RowName | null => {
    const l = engineLoc(gs, inst.uid);
    return l && l.zone === 'field' ? l.row ?? null : null;
  };
  // 条件检查：相手の先攻１ターン目以外 = 只有当「对手是先攻且在其第 1 回合」才不触发
  if (tc.condition.includes('notTurn1') && gs.turn === 1 && owner !== gs.turnPlayer) return false;
  // 「このキャラにサポートをしたとき」= 被支援者诱发：只有“本次被支援的那张卡”才触发（Bug：支援 6907 时场上 6910 不得触发）
  if (tc.supportTargetOnly) {
    const lastS = gs.battle?.lastSupport;
    if (!lastS || lastS.targetUid !== src.uid) return false;
  }
  // 「自ターン中」（如 6962 支援值作为 DP）只在己方回合触发
  if (tc.condition.includes('ownTurn') && owner !== gs.turnPlayer) return false;
  // 「相手ターン中」（如 6958 对方回合开始）只在对方回合触发
  if (tc.condition.includes('oppTurn') && owner === gs.turnPlayer) return false;
  if (tc.condition.includes('toDF') && rowOf(src) !== 'DF') return false;
  if (tc.condition.includes('toAF') && rowOf(src) !== 'AF') return false;
  // 「ＡＦ/ＤＦのこのキャラ」：触发效果明确限定该角色所在的列（如 6900 相手ターン开始时 AF 此卡未行动化）
  for (const opt of tc.options) {
    for (const a of opt.actions) {
      if (a.target === 'self' && a.row === 'AF' && rowOf(src) !== 'AF') return false;
      if (a.target === 'self' && a.row === 'DF' && rowOf(src) !== 'DF') return false;
    }
  }
  if (tc.condition.includes('engageDmg:')) {
    const need = parseInt(tc.condition.split('engageDmg:')[1] ?? '0', 10) || 0;
    if (!gs.lastEngageDiscard || gs.lastEngageDiscard.dmg < need) return false;
  } else if (tc.condition.includes('engageAny')) {
    if (!gs.lastEngageDiscard) return false;
  }
  if (tc.condition.includes('ownUsed:')) {
    const parts = tc.condition.split(':');
    const charCost = parseInt(parts[1] ?? '3', 10) || 3;
    const paidMin = parseInt(parts[2] ?? '1', 10) || 1;
    const ev = gs.lastAreaEvent;
    if (!ev || ev.kind !== 'ownUsed' || (ev.paid ?? 0) < paidMin) return false;
    const cc = ev.cardId ? gs.cardsById[ev.cardId] : undefined;
    const isItemOrArea = cc && (cc.type === 'item' || cc.type === 'area');
    const isSurpriseChar = cc && cc.type === 'character' && (cc.basicAbilities ?? '').includes('サプライズ') && (cc.cost ?? '').length >= charCost;
    if (!(isItemOrArea || isSurpriseChar)) return false;
  } else if (tc.condition.includes('ownUsedMulti')) {
    const ev = gs.lastAreaEvent;
    if (!ev) return false;
    if (ev.kind === 'ownUsed') {
      const cc = ev.cardId ? gs.cardsById[ev.cardId] : undefined;
      const isItem = cc && cc.type === 'item';
      if (!((ev.paid ?? 0) >= 1 && (isItem || ev.usedFrom === 'handDeclare'))) return false;
    } else if (ev.kind === 'oppBattleCharLeft') {
      // ok
    } else if (ev.kind === 'friendlyNamedLeft') {
      const needName = tc.condition.split('ownUsedMulti:')[1] ?? '';
      if (!ev.name || ev.name.replace(/\s/g, '') !== needName) return false;
    } else {
      return false;
    }
  } else if (tc.condition.includes('ownDeclareDraw')) {
    if (!(gs.players[owner].turnCounters.ownDeclareDraws ?? 0)) return false;
  }
  if (tc.condition.includes('allCost2Under3')) {
    const allCost2 = fieldCards(gs, owner, false).every((c) => (gs.cardsById[c.cardId]?.cost ?? '').length <= 2);
    if (!allCost2 || src.under.length < 3) return false;
  }
  return true;
}

/** 触发链推进：扫描某类别未处理的触发（skipKey 跳过刚处理完的子句；forceKey 强制只触发指定子句） */
export function continueTriggerChain(gs: GameState, trigger: string, owner: PlayerIndex, sourceUid: string | null, skipKey?: string, forceScanAll = false, forceKey?: string): GameState {
  const next: GameState = structuredClone(gs);
  // 事件根（无 skipKey/forceKey）：同类触发开始新一轮事件 → 清空"本事件已处理"记录
  if (skipKey === undefined && forceKey === undefined) next.pendingFiredKeys = [];
  const firedKeys = next.pendingFiredKeys ?? (next.pendingFiredKeys = []);
  const srcList = sourceUid
    ? (() => {
        const loc = engineLoc(next, sourceUid);
        return loc ? [loc.inst] : [];
      })()
    : fieldCards(next, owner, true);
  const scanAll = sourceUid === null || forceScanAll;
  // 全局扫描：多个诱発同时触发 → 回合玩家选择先处理哪个（Bug 5）
  if (sourceUid === null) {
    const cands: { src: CardInstance; ti: number; key: string; label: string; cardId: string }[] = [];
    for (const src of srcList) {
      const card = next.cardsById[src.cardId];
      if (!card) continue;
      const p = getParsed(card);
      for (let ti = 0; ti < p.triggers.length; ti++) {
        const tc = p.triggers[ti];
        if (tc.trigger !== trigger) continue;
        if (src.lost.includes(`trig${ti}`)) continue;
        const key = `${trigger}:${src.uid}:${ti}:${next.turn}`;
        if (skipKey === key) continue;
        if (firedKeys.includes(key)) continue; // 本事件已处理过
        if ((next.players[owner].perTurn[key] ?? 0) >= (tc.perTurn ?? 99)) continue;
        if (!triggerCondOk(next, src, tc, owner)) continue;
        cands.push({ src, ti, key, label: `「${card.name}」：${tc.options.map((o) => o.label).join(' / ').slice(0, 40)}`, cardId: card.id });
      }
    }
    if (cands.length > 1) {
      next.prompt = {
        kind: 'effect-choice',
        owner,
        title: `多个诱発同时触发（${triggerLabel(trigger)}）：选择先处理的`,
        multi: false,
        max: 1,
        options: cands.map((c) => ({ id: `${c.src.uid}|${c.ti}|${c.key}`, label: c.label, cardId: c.cardId })),
        pending: { sourceUid: '', owner, declIdx: -1, trigIdx: -1, optionId: '', optionLabel: '', trigger: '__triggerPick', stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true, scanAll: true, scanTrigger: trigger },
      };
      return next;
    }
  }
  for (const src of srcList) {
    const card = next.cardsById[src.cardId];
    if (!card) continue;
    const p = getParsed(card);
    for (let ti = 0; ti < p.triggers.length; ti++) {
      const tc = p.triggers[ti];
      if (tc.trigger !== trigger) continue;
      if (src.lost.includes(`trig${ti}`)) continue;
      const key = `${trigger}:${src.uid}:${ti}:${next.turn}`;
      if (forceKey ? key !== forceKey : skipKey === key) continue;
      if (firedKeys.includes(key) && key !== forceKey) continue; // 本事件已处理（同事件不重复触发）
      const used = next.players[owner].perTurn[key] ?? 0;
      if (used >= (tc.perTurn ?? 99)) continue;
      next.players[owner].perTurn[key] = used + 1;
      firedKeys.push(key); // 标记本事件已处理（去重：6904/6907 被支援诱发一次支援只能触发一次）
      // 条件检查（统一函数：相手の先攻１ターン目以外 / 位置 / エンゲージ / 使用了自己的卡 等）
      if (!triggerCondOk(next, src, tc, owner)) continue;
      // 单选项且无需目标/检索/手牌 → 自动应用
      if (tc.options.length === 1) {
        const opt = tc.options[0];
        const condPend: PendingEffect = { sourceUid: src.uid, owner, declIdx: -1, trigIdx: ti, optionId: opt.id, optionLabel: opt.label, trigger, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true, scanAll };
        if (optionCondFails(next, condPend)) continue;
        // 可选触发（できる/置ける 等）→ 弹「是否处理」选择（Bug 14/7：不能自动执行）
        if (opt.optional) {
          // 「支援值作为DP」自带 yes/no 选择：不再额外问“是否处理”，直接进入效果链（由动作弹 yes/no）
          if (opt.actions.some((a) => a.t === 'supportAsDp')) {
            return finalizeActions(next, condPend);
          }
          next.prompt = {
            kind: 'effect-choice',
            owner,
            title: `「${card.name}」诱発效果（${triggerLabel(trigger)}）：是否处理？`,
            multi: false,
            max: 1,
            options: [
              { id: opt.id, label: opt.label + (opt.parsed ? '' : '（部分手动）'), cardId: card.id },
              { id: '__skip', label: '不处理（放弃该诱発）', cardId: card.id },
            ],
            // optionId 留空：选中后由 chooseEffectOption 走常规选项分支（否则会被误当手牌破弃选择）
            pending: { ...condPend, optionId: '' },
          };
          return next;
        }
        if (opt.parsed) {
          // 目标候选 ≤1 的目标动作也可自动应用
          let auto = true;
          for (const a of opt.actions) {
            if (a.t === 'search' || a.t === 'discardHand' || a.t === 'equipSelfToTarget' || (a.t === 'dmgZero' && (a.n ?? 1) > 1) || a.t === 'store' || a.t === 'storeUnder' || a.t === 'storeUnderArea' || a.t === 'charge' || a.t === 'discardCharge' || a.t === 'reviveSelf' || a.t === 'supportAsDp' || (a.t === 'healDeck' && a.random !== true)) {
              auto = false;
              break;
            }
            if (actionNeedsTarget(a)) {
              const cands = targetCandidates(next, owner, a);
              if (cands.length > 1) {
                auto = false;
                break;
              }
            }
          }
          if (auto) {
            const pend: PendingEffect = { sourceUid: src.uid, owner, declIdx: -1, trigIdx: ti, optionId: opt.id, optionLabel: opt.label, trigger, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true };
            // 唯一候选目标自动指定
            for (const a of opt.actions) {
              if (actionNeedsTarget(a)) {
                const cands = targetCandidates(next, owner, a);
                if (cands.length === 1) pend.targetUid = cands[0].uid;
              }
            }
            let msg = '';
            for (const a of opt.actions) {
              if (actionCondFails(next, pend, a)) continue;
              const r = applySingleAction(next, pend, a, false);
              msg += r.msg + '；';
            }
            pushLog(next, `「${card.name}」诱発（${triggerLabel(trigger)}）：${msg || opt.label}`);
            continue;
          }
        } else if (opt.actions.length === 0) {
          next.prompt = {
            kind: 'manual-effect',
            title: `「${card.name}」诱発（${triggerLabel(trigger)}）`,
            text: tc.raw,
            owner,
          };
          return next;
        }
        // 单个选项但需要玩家选择（检索/选卡等）→ 直接进入效果链（会弹对应选择面板）
        return finalizeActions(next, condPend);
      }
      if (tc.options.length === 0) continue;
      // 需要玩家选择（可选触发附加「不处理」选项）
      next.prompt = {
        kind: 'effect-choice',
        owner,
        title: `「${card.name}」诱発效果（${triggerLabel(trigger)}）：请选择`,
        multi: false,
        max: 1,
        options: [
          ...tc.options.map((o) => ({ id: o.id, label: o.label + (o.parsed ? '' : '（部分手动）'), cardId: card.id })),
          ...(tc.options.some((o) => o.optional) ? [{ id: '__skip', label: '不处理（放弃该诱発）', cardId: card.id }] : []),
        ],
        pending: { sourceUid: src.uid, owner, declIdx: -1, trigIdx: ti, optionId: '', optionLabel: '', trigger, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true, scanAll },
      };
      return next;
    }
  }
  // 检索登场等：登场诱发链全部结束后恢复外层效果链
  for (const src of srcList) {
    if (src.pendingResumeChain) {
      const rp = src.pendingResumeChain;
      src.pendingResumeChain = null;
      rp.searchDone = true;
      return finalizeActions(next, rp);
    }
  }
  return maybeFireAreaEvent(next);
}

/** 使用了自己的道具/エリア/手札宣言/サプライズ角色等事件 → 触发 6961/6963 エリア诱発（每事件一次） */
function maybeFireAreaEvent(gs: GameState): GameState {
  const next = gs;
  if (next.lastAreaEvent && !next.lastAreaEvent.fired) {
    const ev = next.lastAreaEvent;
    ev.fired = true;
    const trig = ev.kind === 'ownDeclareDraw' ? 'ownDeclareDraw' : 'ownCardUsed';
    return continueTriggerChain(next, trig, ev.owner, null);
  }
  next.prompt = null;
  // 对方回合开始诱発已全部结算完 → 恢复“自回合开始诱発”阶段（BeginTurn 拆分为两段，避免互相清掉提示）
  if (next.pendingTurnStart) {
    return runTurnStartChain(next, next.pendingTurnStart.owner);
  }
  // 回合开始诱発（对方回合开始 + 自回合开始）全部处理完 → 执行スタートフェイズ：重置 + 抽牌（Bug ①：诱发完毕才抽牌）
  // 仅当已进入自回合开始诱発链且其全部结算后才执行（对方回合开始诱発阶段不提前抽牌）
  if (next.pendingStartPhase && next.turnStartChainDone && !next.prompt) {
    const ph = next.pendingStartPhase;
    next.pendingStartPhase = null;
    next.turnStartChainDone = false;
    return finishStartPhase(next, ph.owner);
  }
  return next;
}

/** 回合开始的スタートフェイズ：全体重置（ウェイクアップ）+ 抽牌（ウォームアップ：先攻第 1 回合 1 张、其余 2 张） */
function finishStartPhase(gs: GameState, owner: PlayerIndex): GameState {
  const next: GameState = structuredClone(gs);
  // ウェイクアップ：行动済み全部未行动，清临时修正；登场ターン制限在自回合开始时消失
  for (let r = 0; r < 2; r++) {
    for (let a = 0; a < 3; a++) {
      const c = next.players[owner].field[r][a];
      if (c) {
        c.tapped = false;
        c.tempMods = { ap: 0, dp: 0, sp: 0, dmg: 0 };
        c.tempSet = {};
        c.supports = null;
        c.tempBonus = null;
        c.tempForceDefend = null;
        c.deployedTurn = null;
      }
      const ar = next.players[owner].fieldAreas[r][a];
      if (ar) ar.deployedTurn = null;
    }
  }
  // ウォームアップ：抽 2（先攻第 1 回合抽 1）
  const isFirstTurn = next.turn === 1;
  const n = isFirstTurn ? 1 : 2;
  const before = next.players[owner].deck.length;
  const drawn = Math.min(n, before);
  for (let i = 0; i < drawn; i++) {
    const top = next.players[owner].deck.pop()!;
    top.faceUp = true;
    next.players[owner].hand.push(top);
  }
  pushLog(next, `玩家 ${owner + 1} 第 ${next.turn} 回合开始：全体重置，抽 ${drawn} 张。`);
  next.phase = 'main';
  next.battle = null;
  next.prompt = null;
  if (next.players[owner].deck.length === 0) {
    next.phase = 'gameover';
    next.prompt = { kind: 'gameover', winner: (1 - owner) as PlayerIndex };
    pushLog(next, `玩家 ${owner + 1} 牌堆归零！玩家 ${2 - owner} 获胜！`);
    return next;
  }
  return next;
}

export function triggerLabel(t: string): string {
  return (
    { deploy: '登场时', turnStart: '自回合开始时', oppTurnStart: '对方回合开始时', turnEnd: '自回合结束时', down: '此角色倒下时', defenderLeaves: '对方防御角色离场时', dealtDamage: '被支援角色造成伤害时', supportUsed: '支援时', oppCharLeaves: '味方角色因对方效果离场时', areaDeploy: '此エリア配置时', equip: '装备时', itemLeaves: '此道具离场时', engageDiscard: 'エンゲージ登场破弃时' }[t] ?? t
  );
}

/* ================= 登场 / 回合 / 事件 入口 ================= */

/** 基本能力值文本（[标签:[值]]） */
export function basicAbilityValue(card: Card, tag: string): string {
  return parseBasicAbilities(card.basicAbilities ?? '').find((a) => a.tag === tag)?.value ?? '';
}

/** 从チャージ基本能力值中取出张数（值如「２枚チャージする。」→ 2） */
function chargeNumber(value: string): number {
  const m = /([０-９]+)/.exec(value);
  if (!m) return 1;
  const half = m[1].replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)));
  return parseInt(half, 10) || 1;
}

/** 登场：充能（チャージ基本能力，由玩家选择ゴミ箱卡）+ 回合回复 + 登场诱発 */
export function runDeployChain(gs: GameState, uid: string, owner: PlayerIndex): GameState {
  let next: GameState = structuredClone(gs);
  const loc = engineLoc(next, uid);
  if (!loc || loc.zone !== 'field') return next;
  const card = next.cardsById[loc.inst.cardId];
  if (!card) return next;
  const bas = parseBasicAbilities(card.basicAbilities ?? '');
  // チャージ（Bug 2）：① 先选是否破弃牌堆（0~N）→ ② 再从ゴミ箱选 0~N 张充能
  const chargeAb = bas.find((a) => a.tag === 'チャージ');
  if (chargeAb) {
    const n = chargeNumber(chargeAb.value);
    const deckLen = next.players[owner].deck.length;
    const maxMill = Math.min(n, deckLen);
    const millOpts: { id: string; label: string }[] = [];
    for (let k = 0; k <= maxMill; k++) millOpts.push({ id: String(k), label: k === 0 ? '不破弃牌堆' : `破弃牌堆 ${k} 张` });
    next.prompt = {
      kind: 'effect-choice',
      owner,
      title: `「${card.name}」登场充能：是否先破弃牌堆补充ゴミ箱？（最多 ${n} 张，之后从ゴミ箱选卡充能）`,
      multi: false,
      max: 1,
      options: millOpts,
      pending: { sourceUid: loc.inst.uid, owner, declIdx: -1, trigIdx: -1, optionId: '', optionLabel: '', trigger: '__chargeMill', stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true },
    };
    return next;
  }
  return runDeployChainResume(next, uid, owner);
}

/** 充能选择完成后继续：回合回复 + 登场诱発 */
export function runDeployChainResume(gs: GameState, uid: string, owner: PlayerIndex): GameState {
  let next: GameState = structuredClone(gs);
  const loc = engineLoc(next, uid);
  if (!loc || loc.zone !== 'field') return next;
  const card = next.cardsById[loc.inst.cardId];
  if (!card) return next;
  const bas = parseBasicAbilities(card.basicAbilities ?? '');
  // ターンリカバリー（规则 2169）：后攻玩家第 1 回合（全局第 2 回合）登场时处理；本回合自己的[リカバリー][ターンリカバリー]只处理一次
  const trAb = bas.find((a) => a.tag === 'ターンリカバリー');
  if (trAb && next.turn === 2 && owner === next.turnPlayer && !(next.players[owner].turnCounters.turnRecoveryUsed ?? 0)) {
    next.players[owner].turnCounters.turnRecoveryUsed = 1;
    const acts: EffAction[] = [];
    parseActionListPublic(trAb.value, acts);
    if (acts.length > 0) {
      const pend: PendingEffect = { sourceUid: uid, owner, declIdx: -1, trigIdx: -1, optionId: '', optionLabel: '', trigger: null, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true };
      for (const a of acts) {
        const r = applySingleAction(next, pend, a, false);
        if (r.prompt) return next; // 需要玩家选择（デッキ回復等）→ 等选完继续
        pushLog(next, `「${card.name}」ターンリカバリー：${r.msg}`);
      }
    }
  }
  // エンゲージ登场（破弃己方角色登场）：先处理括弧效果与エンゲージ登場诱発，再处理登场诱発
  if (loc.inst.pendingEngage) {
    const dUid = loc.inst.pendingEngage.discardedUid;
    loc.inst.pendingEngage = null;
    const afterEngage = runEngageResolve(next, owner, uid, dUid);
    if (afterEngage.prompt) return afterEngage;
    next = afterEngage;
  }
  // 登场诱発
  return continueTriggerChain(next, 'deploy', owner, uid);
}

/** エンゲージ登场结算：处理括弧效果（破棄キャラ回復/シールド/牌堆破弃/目标效果）后，触发エンゲージ登場诱発 */
export function runEngageResolve(gs: GameState, owner: PlayerIndex, uid: string, discardedUid: string): GameState {
  let next: GameState = structuredClone(gs);
  const loc = engineLoc(next, uid);
  if (!loc || loc.zone !== 'field') return next;
  const card = next.cardsById[loc.inst.cardId];
  if (!card) return next;
  const val = basicAbilityValue(card, 'エンゲージ');
  if (val) {
    const acts: EffAction[] = [];
    const leftover = parseActionListPublic(val, acts);
    if (leftover.replace(/[。\s]/g, '').length > 0) {
      next.prompt = { kind: 'manual-effect', title: `「${card.name}」エンゲージ效果（部分需手动）`, text: leftover, owner };
      return next;
    }
    if (acts.length === 0) {
      pushLog(next, `「${card.name}」エンゲージ登场（无括弧效果）。`);
    } else {
      const tAct = acts.find((a) => actionNeedsTarget(a) && a.target !== 'self');
      if (tAct) {
        const cands = targetCandidates(next, owner, tAct);
        if (cands.length === 0) {
          pushLog(next, `「${card.name}」エンゲージ：没有可指定的目标，括弧效果落空。`);
        } else if (cands.length === 1) {
          const pend = makePending(uid, owner, { trigger: '__engage', optionId: 'engage' });
          pend.targetUid = cands[0].uid;
          for (const a of acts) {
            const r = applySingleAction(next, pend, a, false);
            if (r.prompt) return next;
            pushLog(next, `「${card.name}」エンゲージ：${r.msg}`);
          }
        } else {
          next.prompt = {
            kind: 'declare-target',
            uid,
            tag: 'エンゲージ',
            owner,
            actionLabel: `「${card.name}」エンゲージ：选择目标（${tAct.label ?? ''}）`,
            candidates: cands,
            pending: makePending(uid, owner, { trigger: '__engage', optionId: 'engage' }),
          };
          return next;
        }
      } else {
        const pend = makePending(uid, owner, { trigger: '__engage', optionId: 'engage' });
        for (const a of acts) {
          const r = applySingleAction(next, pend, a, false);
          if (r.prompt) return next;
          pushLog(next, `「${card.name}」エンゲージ：${r.msg}`);
        }
      }
    }
  }
  // エンゲージ登場诱発（6940 家族等：破弃了原DMG≥N的角色时）
  return continueTriggerChain(next, 'engageDiscard', owner, uid);
}

/** 回合开始（自回合）：先清 exPool/perTurn，再处理自回合开始诱発 */
export function runTurnStartChain(gs: GameState, player: PlayerIndex): GameState {
  let next: GameState = structuredClone(gs);
  next.pendingTurnStart = null; // 阶段已执行，清除待执行标记
  next.turnStartChainDone = true; // 已进入自回合开始诱発链（之后链尾才执行「重置+抽牌」）
  next.players[player].exPool = [];
  next.players[player].perTurn = {};
  for (const src of fieldCards(next, player, false)) {
    src.tempSet = {};
  }
  return continueTriggerChain(next, 'turnStart', player, null);
}

/** 对方回合开始诱発 */
export function runOppTurnStartChain(gs: GameState, player: PlayerIndex): GameState {
  return continueTriggerChain(structuredClone(gs), 'oppTurnStart', player, null);
}

/** 自回合结束诱発 */
export function runTurnEndChain(gs: GameState, player: PlayerIndex): GameState {
  return continueTriggerChain(structuredClone(gs), 'turnEnd', player, null);
}

/** 事件使用：解析事件文本并执行 */
export function runEventChain(gs: GameState, owner: PlayerIndex, uid: string): GameState {
  const next: GameState = structuredClone(gs);
  const loc = engineLoc(next, uid);
  const card = loc ? next.cardsById[loc.inst.cardId] : undefined;
  if (!card || card.type !== 'event') return next;
  void loc;
  const p = getParsed(card);
  if (p.declared.length > 0) {
    // 事件文本可能被当作宣言块解析（无标签事件）→ 用原始文本
  }
  const actions: EffAction[] = [];
  const leftover = parseActionListPublic(card.ability ?? '', actions);
  if (leftover.replace(/[。\s]/g, '').length > 0) {
    next.prompt = {
      kind: 'manual-effect',
      title: `事件「${card.name}」`,
      text: `${card.ability ?? ''}\n\n（以下部分需手动结算：${leftover}）`,
      owner,
    };
    return next;
  }
  if (actions.length === 0) {
    pushLog(next, `事件「${card.name}」已使用（无可执行效果）。`);
    return next;
  }
  // 需要目标 → 目标选择（事件流程：pending.trigger='__event'）
  const tAct = actions.find((a) => actionNeedsTarget(a));
  if (tAct) {
    const cands = targetCandidates(next, owner, tAct);
    if (cands.length === 0) {
      pushLog(next, `事件「${card.name}」没有可指定的目标，效果落空。`);
      return next;
    }
    next.prompt = {
      kind: 'declare-target',
      uid,
      tag: '事件',
      owner,
      actionLabel: `事件「${card.name}」：选择目标（${tAct.label ?? ''}）`,
      candidates: cands,
      pending: { sourceUid: uid, owner, declIdx: -1, trigIdx: -1, optionId: 'evt', optionLabel: '事件效果', trigger: '__event', stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true },
    };
    return next;
  }
  const pend: PendingEffect = { sourceUid: uid, owner, declIdx: -1, trigIdx: -1, optionId: 'evt', optionLabel: '事件效果', trigger: '__event', stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true };
  for (const a of actions) {
    const r = applySingleAction(next, pend, a, false);
    if (r.prompt) return next;
    pushLog(next, `事件「${card.name}」：${r.msg}`);
  }
  return next;
}

/** 装备：处理装备诱発 */
export function runEquipChain(gs: GameState, owner: PlayerIndex, itemUid: string): GameState {
  return continueTriggerChain(structuredClone(gs), 'equip', owner, itemUid);
}

/** エリア配置诱発 */
export function runAreaDeployChain(gs: GameState, owner: PlayerIndex, uid: string): GameState {
  return continueTriggerChain(structuredClone(gs), 'areaDeploy', owner, uid);
}

/** 支援：把支援角色 SP 加入攻击者 AP（临时），处理支援诱発（全局扫描：支援者自身 + 味方エリア如 6962） */
export function applySupport(gs: GameState, owner: PlayerIndex, supporterUid: string, attackerUid: string): GameState {
  const next: GameState = structuredClone(gs);
  const sLoc = engineLoc(next, supporterUid);
  const aLoc = engineLoc(next, attackerUid);
  if (!sLoc || !aLoc || aLoc.zone !== 'field') return next;
  const sp = effectiveStats(next, supporterUid).sp;
  aLoc.inst.tempMods.ap += sp;
  sLoc.inst.tapped = true;
  sLoc.inst.supports = { attackerUid, battleTurn: next.turn };
  pushLog(next, `「${cardName(next, supporterUid)}」支援「${cardName(next, attackerUid)}」：AP +${sp}。`);
  return continueTriggerChain(next, 'supportUsed', owner, null);
}

/** 被支援角色造成伤害时诱発 */
export function runDealtDamageChain(gs: GameState, owner: PlayerIndex, attackerUid: string): GameState {
  const next: GameState = structuredClone(gs);
  // 找出本回合支援过该攻击者的角色，处理其 dealtDamage 诱発
  for (const src of fieldCards(next, owner, true)) {
    if (src.supports && src.supports.attackerUid === attackerUid && src.supports.battleTurn === next.turn) {
      return continueTriggerChain(next, 'dealtDamage', owner, src.uid);
    }
  }
  return next;
}

/** 对方防御角色离场时诱発（1回合3次限制由 perTurn 控制） */
export function runDefenderLeavesChain(gs: GameState, owner: PlayerIndex): GameState {
  return continueTriggerChain(structuredClone(gs), 'defenderLeaves', owner, null);
}

/** ボーナス基本能力（击破对战角色后） */
export function runBonusChain(gs: GameState, owner: PlayerIndex, uid: string): GameState {
  const next: GameState = structuredClone(gs);
  const loc = engineLoc(next, uid);
  if (!loc || loc.zone !== 'field') return next;
  const card = next.cardsById[loc.inst.cardId];
  if (!card) return next;
  // 临时获得的ボーナス
  if (loc.inst.tempBonus) {
    if (loc.inst.tempBonus === 'discardDeck') {
      discardDeckTop(next, (1 - owner) as PlayerIndex, 1);
      pushLog(next, `「${card.name}」ボーナス：对方牌堆破弃 1 张。`);
    } else {
      const pendB: PendingEffect = { sourceUid: uid, owner, declIdx: -1, trigIdx: -1, optionId: '', optionLabel: '', trigger: null, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true };
      const rB = applySingleAction(next, pendB, { t: 'healDeck', target: 'ownDeck', n: 1 } as EffAction, false);
      if (rB.prompt) return next; // 玩家从ゴミ箱选回复卡
      pushLog(next, `「${card.name}」ボーナス：${rB.msg}`);
    }
    loc.inst.tempBonus = null;
    return next;
  }
  const val = basicAbilityValue(card, 'ボーナス');
  if (val) {
    const acts: EffAction[] = [];
    parseActionListPublic(val, acts);
    const pend: PendingEffect = { sourceUid: uid, owner, declIdx: -1, trigIdx: -1, optionId: '', optionLabel: '', trigger: null, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true };
    for (const a of acts) {
      const r = applySingleAction(next, pend, a, false);
      if (r.prompt) return next;
      pushLog(next, `「${card.name}」ボーナス：${r.msg}`);
    }
  }
  return next;
}

/** ペナルティ基本能力（离场时） */
export function runPenaltyChain(gs: GameState, owner: PlayerIndex, uid: string): GameState {
  const next: GameState = structuredClone(gs);
  const loc = engineLoc(next, uid);
  const card = loc ? next.cardsById[loc.inst.cardId] : undefined;
  if (!card) return next;
  const val = basicAbilityValue(card, 'ペナルティ');
  if (val) {
    const acts: EffAction[] = [];
    parseActionListPublic(val, acts);
    const pend: PendingEffect = { sourceUid: uid, owner, declIdx: -1, trigIdx: -1, optionId: '', optionLabel: '', trigger: null, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true };
    for (const a of acts) {
      const r = applySingleAction(next, pend, a, false);
      if (r.prompt) return next;
      pushLog(next, `「${card.name}」ペナルティ：${r.msg}`);
    }
  }
  return next;
}

/** 倒下诱発（down：ダウンしたとき） */
export function runDownChain(gs: GameState, owner: PlayerIndex, uid: string): GameState {
  return continueTriggerChain(structuredClone(gs), 'down', owner, uid);
}

/* ================= 动作列表解析公开版（clauses 转发） ================= */
import { parseActionList } from './clauses';
export function parseActionListPublic(text: string, out: EffAction[]): string {
  return parseActionList(text, out);
}

export function makePending(sourceUid: string, owner: PlayerIndex, extra?: Partial<PendingEffect>): PendingEffect {
  return {
    sourceUid,
    owner,
    declIdx: extra?.declIdx ?? -1,
    trigIdx: extra?.trigIdx ?? -1,
    optionId: extra?.optionId ?? '',
    optionLabel: extra?.optionLabel ?? '',
    trigger: extra?.trigger ?? null,
    stage: extra?.stage ?? 0,
    targetUid: extra?.targetUid ?? null,
    forceTarget: extra?.forceTarget ?? null,
    extraUids: extra?.extraUids ?? [],
    searchDone: extra?.searchDone ?? false,
    paidCost: extra?.paidCost ?? true,
  };
}
