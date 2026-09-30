// 基础规则引擎（阶段 3）
// 依据官方规则实现：回合流程、费用支付（EX）、登场（配置限制/登场回合限制）、
// 攻击/防御/交战判定、伤害（牌堆破弃/护盾）、手牌调整、胜负判定。
// 卡牌效果由 effectEngine + clauses 执行（阶段 5 效果系统）。
import { GameState, PlayerIndex, RowName, AreaIndex, CardInstance, RpsChoice, PendingEffect, PendingAction, ResponseItem, PromptState, shuffle, pushVoice } from './game';
import type { Card } from './cards';
import { formatAbilityText, parseBasicAbilities } from './cards';
import { effectiveStats, runDeployEffects, parseDeclaredEffect, DeclaredEffect, deployTriggerTexts, deployTriggerCount, parsedDeployCount } from './effects';
import { hasHandDeclare, hasDeclare, hasMoveAbility, moveAbilityTags, hasEngage } from './abilities';
import * as eng from './effectEngine';
import { getParsed } from './effectEngine';
import { EffOption, EffAction, parseTiming } from './clauses';

export const ELEMENTS = ['花', '月', '宙', '雪', '日', '無'];

function clone(gs: GameState): GameState {
  return structuredClone(gs);
}

function log(gs: GameState, msg: string): void {
  gs.log.push(msg);
  if (gs.log.length > 300) gs.log.splice(0, gs.log.length - 300);
}

function cardName(gs: GameState, uid: string): string {
  const inst = findInst(gs, uid);
  return inst ? (gs.cardsById[inst.cardId]?.name ?? inst.cardId) : '?';
}

function findInst(gs: GameState, uid: string): CardInstance | null {
  for (const p of [0, 1] as PlayerIndex[]) {
    const st = gs.players[p];
    for (const list of [st.deck, st.hand, st.trash, st.shield, st.special, st.removed]) {
      const c = list.find((x) => x.uid === uid);
      if (c) return c;
    }
    for (let r = 0; r < 2; r++) {
      for (let a = 0; a < 3; a++) {
        const c = st.field[r][a];
        if (c && c.uid === uid) return c;
        if (c?.equip?.uid === uid) return c.equip;
        const ar = st.fieldAreas[r][a];
        if (ar && ar.uid === uid) return ar;
      }
    }
  }
  return null;
}

function fieldCell(gs: GameState, player: PlayerIndex, row: RowName, area: AreaIndex): CardInstance | null {
  return gs.players[player].field[row === 'AF' ? 0 : 1][area];
}

/** 可配置エリア的フィールド（规则 0310：フィールド1つにエリア1枚；该格没有エリア即可配置） */
export function validAreaSlots(gs: GameState, player: PlayerIndex): { row: RowName; area: AreaIndex }[] {
  const out: { row: RowName; area: AreaIndex }[] = [];
  for (const row of ['AF', 'DF'] as RowName[]) {
    for (let a = 0 as AreaIndex; a < 3; a++) {
      if (!gs.players[player].fieldAreas[row === 'AF' ? 0 : 1][a]) out.push({ row, area: a });
    }
  }
  return out;
}

/** 同编号（忽略尾部字母，如 LO-6969 与 LO-6969-A）角色是否已在场上（可排除指定格——エンゲージ登场破弃目标格） */
export function sameNumberOnField(gs: GameState, player: PlayerIndex, cardId: string, exclude?: { row: RowName; area: AreaIndex }): boolean {
  const m = /^LO-(\d+)/.exec(cardId);
  if (!m) return false;
  for (let r = 0; r < 2; r++) {
    for (let a = 0; a < 3; a++) {
      if (exclude && exclude.row === (r === 0 ? 'AF' : 'DF') && exclude.area === a) continue;
      const c = gs.players[player].field[r][a];
      if (c && /^LO-(\d+)/.exec(c.cardId)?.[1] === m[1]) return true;
    }
  }
  return false;
}

/* ================= 费用支付 ================= */

export { parseCost, poolAdjustedCost, canPayCost } from './cost';
export type { CostContext } from './cost';
import { parseCost, poolAdjustedCost, canPayCost, canCostPoolCover, type CostContext } from './cost';

/** 支付费用：从手牌移除对应属性卡到ゴミ箱，返回被支付的卡 uid 列表 */
export function payCost(gs: GameState, player: PlayerIndex, cost: string, excludeUid?: string): string[] {
  const groups = parseCost(cost);
  const paid: string[] = [];
  const st = gs.players[player];
  const pool = st.hand.filter((c) => c.uid !== excludeUid).map((c) => ({ inst: c, used: false }));
  for (const g of groups) {
    let need = g.points;
    if (need <= 0) continue;
    const candidates = pool
      .filter((x) => !x.used && (g.elem === '無' || (gs.cardsById[x.inst.cardId]?.elements ?? '').includes(g.elem)))
      .sort((a, b) => (gs.cardsById[b.inst.cardId]?.ex ?? 0) - (gs.cardsById[a.inst.cardId]?.ex ?? 0));
    for (const c of candidates) {
      if (need <= 0) break;
      const ex = gs.cardsById[c.inst.cardId]?.ex ?? 0;
      if (ex <= 0) continue;
      c.used = true;
      need -= ex;
      paid.push(c.inst.uid);
    }
  }
  // 从手牌移除到ゴミ箱（保持顺序）
  for (const uid of paid) {
    const idx = st.hand.findIndex((c) => c.uid === uid);
    if (idx >= 0) {
      const inst = st.hand.splice(idx, 1)[0];
      inst.faceUp = true;
      st.trash.unshift(inst);
    }
  }
  return paid;
}

/* ================= 配置位置 ================= */

/** 角色能否配置到指定格子（依据 positionFlags，空=无限制） */
export function canPlaceAt(gs: GameState, player: PlayerIndex, uid: string, row: RowName, area: AreaIndex): boolean {
  const inst = findInst(gs, uid);
  if (!inst) return false;
  const card = gs.cardsById[inst.cardId];
  if (!card) return false;
  const flags = card.positionFlags ?? '';
  if (flags.trim() === '') return true;
  const idx = row === 'AF' ? area : 3 + area;
  const ch = flags[idx];
  return ch === '左' || ch === '中' || ch === '右';
}

/** 自动选择第一个可配置的空格 */
export function findAutoSlot(gs: GameState, player: PlayerIndex, uid: string): { row: RowName; area: AreaIndex } | null {
  for (const row of ['AF', 'DF'] as RowName[]) {
    for (let a = 0 as AreaIndex; a < 3; a++) {
      if (!fieldCell(gs, player, row, a) && canPlaceAt(gs, player, uid, row, a)) {
        return { row, area: a };
      }
    }
  }
  return null;
}

/** 该角色所有可配置的空格（登场位置由玩家选择；エンゲージ角色额外包含己方被占用的格子） */
export function validDeploySlots(gs: GameState, player: PlayerIndex, uid: string): { row: RowName; area: AreaIndex }[] {
  const out: { row: RowName; area: AreaIndex }[] = [];
  for (const row of ['AF', 'DF'] as RowName[]) {
    for (let a = 0 as AreaIndex; a < 3; a++) {
      if (!fieldCell(gs, player, row, a) && canPlaceAt(gs, player, uid, row, a)) out.push({ row, area: a });
    }
  }
  // エンゲージ：可以破弃己方场上的角色登场（占用格也算可选）
  const inst = findInst(gs, uid);
  const card = inst ? gs.cardsById[inst.cardId] : undefined;
  if (card && hasEngage(card)) {
    for (const row of ['AF', 'DF'] as RowName[]) {
      for (let a = 0 as AreaIndex; a < 3; a++) {
        const cell = fieldCell(gs, player, row, a);
        if (cell && canPlaceAt(gs, player, uid, row, a)) out.push({ row, area: a });
      }
    }
  }
  return out;
}

/* ================= 石头剪刀布（决定先攻） ================= */

/** 双方就位后开启石头剪刀布 */
export function markReady(gs: GameState): GameState {
  const next = clone(gs);
  if (next.phase === 'gameover') return gs;
  next.ready = true;
  next.rps = { p0: null, p1: null };
  next.prompt = { kind: 'rps' };
  log(next, '双方已就位，进行石头剪刀布决定先攻！');
  return next;
}

function rpsWinner(a: RpsChoice, b: RpsChoice): -1 | 0 | 1 {
  if (a === b) return -1; // 平局
  const beats: Record<RpsChoice, RpsChoice> = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  return beats[a] === b ? 0 : 1;
}

const RPS_LABEL: Record<RpsChoice, string> = { rock: '石头', paper: '布', scissors: '剪刀' };

/** 玩家选择石头剪刀布 */
export function chooseRps(gs: GameState, player: PlayerIndex, choice: RpsChoice): GameState {
  const next = clone(gs);
  if (next.prompt?.kind !== 'rps' || !next.rps) return gs;
  if (player === 0) next.rps.p0 = choice;
  else next.rps.p1 = choice;
  const p0 = next.rps.p0;
  const p1 = next.rps.p1;
  if (p0 && p1) {
    const win = rpsWinner(p0, p1);
    if (win === -1) {
      log(next, `平局（${RPS_LABEL[p0]} 对 ${RPS_LABEL[p1]}）！再来一次。`);
      next.rps = { p0: null, p1: null };
      return next;
    }
    next.turnPlayer = win as PlayerIndex;
    next.prompt = null;
    next.rps = null;
    log(next, `玩家 ${win + 1} 石头剪刀布获胜（${RPS_LABEL[p0]} 对 ${RPS_LABEL[p1]}），先攻！`);
    // 结果弹窗：先展示“你先手/你后手”，确认后再进入起手换牌
    next.prompt = { kind: 'rps-result', winner: win as PlayerIndex, p0, p1, turnPlayer: win as PlayerIndex, opponent: (1 - win) as PlayerIndex };
  }
  return next;
}

/** 确认石头剪刀布结果 → 进入起手换牌（先攻先决定） */
export function confirmRpsResult(gs: GameState): GameState {
  const next = clone(gs);
  if (next.prompt?.kind !== 'rps-result') return gs;
  next.prompt = null;
  const win = next.turnPlayer;
  next.mulligan = { stage: 0 };
  next.prompt = { kind: 'mulligan', owner: win as PlayerIndex };
  log(next, `起手换牌：玩家 ${win + 1}（先攻）先决定是否重抽。`);
  return next;
}

/** 起手换牌选择（redraw=true 重抽 7 张） */
export function chooseMulligan(gs: GameState, redraw: boolean): GameState {
  const next = clone(gs);
  if (next.prompt?.kind !== 'mulligan' || !next.mulligan) return gs;
  const p = next.mulligan.stage === 0 ? next.turnPlayer : ((1 - next.turnPlayer) as PlayerIndex);
  if (redraw) {
    // 手札全部放回牌堆并洗牌 → 抽 7
    const st = next.players[p];
    while (st.hand.length > 0) {
      const c = st.hand.pop()!;
      c.faceUp = false;
      st.deck.push(c);
    }
    st.deck = shuffle(st.deck);
    for (let i = 0; i < 7; i++) {
      if (st.deck.length === 0) break;
      const top = st.deck.pop()!;
      top.faceUp = true;
      st.hand.push(top);
    }
    log(next, `玩家 ${p + 1} 起手换牌：重抽 7 张。`);
  } else {
    log(next, `玩家 ${p + 1} 保留当前手牌。`);
  }
  next.mulligan = { stage: (next.mulligan.stage + 1) as 0 | 1 | 2 };
  if (next.mulligan.stage === 2) {
    next.mulligan = null;
    next.prompt = null;
    log(next, '起手换牌完成。请点击「开始回合」。');
  } else {
    const other = (1 - p) as PlayerIndex;
    next.prompt = { kind: 'mulligan', owner: other };
    log(next, `起手换牌：玩家 ${other + 1}（后攻）决定是否重抽。`);
  }
  return next;
}

/** 开始回合：Wake up（全部重置）+ Warm up（抽 2；先攻第 1 回合抽 1）+ 回合开始诱発 */
export function beginTurn(gs: GameState): GameState {
  if (gs.phase === 'gameover') return gs;
  let next = clone(gs);
  const p = next.turnPlayer;
  // 语音：自己回合开始（两台电脑据此播同一个人的「回合开始」台词）
  pushVoice(next, p, 'turnStart');
  // 回合管理清理（回合开始诱発之前）
  next.players[p].exPool = [];
  next.players[p].perTurn = {};
  next.players[p].turnCounters = {};
  // 回合顺序（规则：① ターン開始時诱発 → ② スタートフェイズ[重置→抽牌] → ③ メイン）
  // 诱发全部处理完后再执行「重置+抽牌」（Bug ①：诱发完毕才是抽牌）
  next.pendingStartPhase = { owner: p };
  // 对方回合开始诱発（前一回合玩家的“相手ターン開始時”）
  next = eng.runOppTurnStartChain(next, (1 - p) as PlayerIndex);
  // 若对方回合开始诱発需要玩家选择 → 先处理；自回合开始诱発待其结算完后由引擎恢复
  if (next.prompt) {
    next.pendingTurnStart = { owner: p };
    return next;
  }
  // 自回合开始诱発（全部处理完后由引擎执行 重置+抽牌）
  next = eng.runTurnStartChain(next, p);
  return next;
}

/** 结束回合：自回合结束诱発 → 手牌调整（>8 弃到 7），随后交给对方 */
export function endTurn(gs: GameState): GameState {
  let next = clone(gs);
  if (next.phase === 'gameover') return gs;
  if (next.phase !== 'main') return gs;
  const p = next.turnPlayer;
  next = eng.runTurnEndChain(next, p);
  // 回合结束诱発需要玩家选择 → 先处理选择，处理完自动继续
  if (next.prompt) {
    next.phase = 'end';
    return next;
  }
  // 规则：优先权转移 —— 对手可同意结束或自由时点行动
  return openEndMainWindow(next);
}

/** 回合结束流程收尾：手牌调整（>8 弃到 7），随后交给对方 */
function finishEndTurn(gs: GameState): GameState {
  const next = clone(gs);
  const p = next.turnPlayer;
  const hand = next.players[p].hand;
  if (hand.length > 8) {
    next.prompt = { kind: 'hand-adjust', need: hand.length - 7 };
    log(next, `手牌 ${hand.length} 张超过 8 张，需破弃 ${hand.length - 7} 张。`);
    next.phase = 'end';
    return next;
  }
  return passTurn(next);
}

/** 回合结束诱発的选择完成后，自动继续手牌调整/交回合；同时恢复对应栈与战斗时点（Bug 9/16） */
function maybeResumeEndTurn(gs: GameState): GameState {
  let n = gs;
  if (n.phase === 'end' && !n.prompt) return finishEndTurn(n);
  // 对应链：提示结算完成后继续倒序（后发先至）结算剩余宣言
  if (n.response && n.response.stack.length > 0 && !n.prompt) n = resolveResponse(n);
  // 战斗时点：行动/宣言结算完后时点交给对方（交替）
  if (n.battle && n.battle.active && !n.prompt && n.phase === 'main') {
    n = openBattleTiming(n, (1 - n.battle.timingActor) as PlayerIndex);
  }
  return n;
}

/** 确认破弃（手牌调整），然后换人 */
export function confirmDiscard(gs: GameState, uids: string[]): GameState {
  const next = clone(gs);
  if (next.prompt?.kind !== 'hand-adjust') return gs;
  const p = next.turnPlayer;
  for (const uid of uids) {
    const idx = next.players[p].hand.findIndex((c) => c.uid === uid);
    if (idx >= 0) {
      const inst = next.players[p].hand.splice(idx, 1)[0];
      inst.faceUp = true;
      next.players[p].trash.unshift(inst);
    }
  }
  log(next, `玩家 ${p + 1} 手牌调整：破弃 ${uids.length} 张。`);
  next.prompt = null;
  return passTurn(next);
}

function passTurn(gs: GameState): GameState {
  const next = clone(gs);
  next.turn++;
  next.turnPlayer = (1 - next.turnPlayer) as PlayerIndex;
  next.phase = 'start';
  next.battle = null;
  next.prompt = null;
  log(next, `玩家 ${next.turnPlayer + 1} 的回合（第 ${next.turn} 回合）。请点击「开始回合」。`);
  return next;
}

/* ================= 登场 / 使用（玩家手动选费用卡） ================= */

/** 检查选中的费用卡是否满足费用要求（元素匹配 + EX 点数累计） */
export function validateCostSelection(sel: { elements: string; ex: number }[], cost: string): boolean {
  const groups = parseCost(cost);
  if (groups.length === 0) return true;
  for (const g of groups) {
    const sum = sel
      .filter((c) => g.elem === '無' || (c.elements ?? '').includes(g.elem))
      .reduce((s, c) => s + (c.ex || 0), 0);
    if (sum < g.points) return false;
  }
  return true;
}

/** 选中费用卡对各费用组的覆盖情况（用于界面展示） */
export function selectionCoverage(
  sel: { elements: string; ex: number }[],
  cost: string,
): { elem: string; points: number; got: number; ok: boolean }[] {
  return parseCost(cost).map((g) => {
    const got = sel
      .filter((c) => g.elem === '無' || (c.elements ?? '').includes(g.elem))
      .reduce((s, c) => s + (c.ex || 0), 0);
    return { elem: g.elem, points: g.points, got, ok: got >= g.points };
  });
}

/** 请求登场角色：校验基础条件后弹出费用选择（费用为空则直接登场） */
export function requestPlayCharacter(gs: GameState, uid: string, row: RowName, area: AreaIndex): GameState {
  const next = clone(gs);
  if (next.phase !== 'main' || next.battle) return gs;
  const p = next.turnPlayer;
  const hand = next.players[p].hand;
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx < 0) return gs;
  const inst = hand[idx];
  const card = next.cardsById[inst.cardId];
  if (!card || card.type !== 'character') return gs;
  // 规则 0810：自己的场已有同编号（忽略字母）角色时不能登场（エンゲージ登场破弃的目标格除外）
  if (sameNumberOnField(next, p, inst.cardId, fieldCell(next, p, row, area) && hasEngage(card) ? { row, area } : undefined)) {
    log(next, `「${card.name}」：自己的场已存在同编号的角色，不能重复登场。`);
    return next;
  }
  if (fieldCell(next, p, row, area) && !hasEngage(card)) {
    log(next, '该格子已被占用（エンゲージ角色可破弃己方角色登场）。');
    return next;
  }
  if (!canPlaceAt(next, p, uid, row, area)) {
    log(next, `「${card.name}」不能配置在${row === 'AF' ? '前列' : '后列'}·${['左', '中', '右'][area]}。`);
    return next;
  }
  // 生成费用抵扣
  const restCost = poolAdjustedCost(next, p, card.cost, { kind: 'deploy', card });
  if (restCost && !canPayCost(next, p, restCost, uid) && !canCostPoolCover(next, p, restCost, { kind: 'deploy', card })) {
    log(next, `费用不足：无法登场「${card.name}」（费用 ${card.cost || '无'}）。`);
    return next;
  }
  if (!restCost) {
    // 费用由生成费用抵扣完毕（或无费用）直接登场
    return deployCharacter(next, p, uid, row, area, []);
  }
  next.prompt = {
    kind: 'cost-pay',
    cost: restCost,
    actionLabel: `登场「${card.name}」`,
    owner: p,
    pending: { action: 'deploy', uid, row, area },
    candidates: hand
      .filter((c) => c.uid !== uid)
      .map((c) => ({
        uid: c.uid,
        name: next.cardsById[c.cardId]?.name ?? c.cardId,
        elements: next.cardsById[c.cardId]?.elements ?? '',
        ex: next.cardsById[c.cardId]?.ex ?? 0,
        cardId: c.cardId,
      })),
  };
  return next;
}

/** サプライズ登场（バトル中/对方回合/対応时点，像事件一样宣言）：先选位置再付费用 */
export function requestSurpriseDeploy(gs: GameState, uid: string, owner?: PlayerIndex): GameState {
  const next = clone(gs);
  const p = (owner ?? next.turnPlayer) as PlayerIndex;
  const idx = next.players[p].hand.findIndex((c) => c.uid === uid);
  if (idx < 0) return gs;
  const inst = next.players[p].hand[idx];
  const card = next.cardsById[inst.cardId];
  if (!card || card.type !== 'character' || !(card.basicAbilities ?? '').includes('サプライズ')) return gs;
  const slots = validDeploySlots(next, p, uid);
  if (slots.length === 0) {
    log(next, '场上没有可配置的空格，サプライズ登场失败。');
    return next;
  }
  if (slots.length === 1) {
    return requestSurpriseDeployAt(next, p, uid, slots[0].row, slots[0].area);
  }
  next.prompt = {
    kind: 'slot-pick',
    owner: p,
    title: `サプライズ登场「${card.name}」：选择位置`,
    uid,
    slots,
    purpose: 'surpriseDeploy',
    pending: null,
  };
  return next;
}

/** サプライズ登场：位置已定 → 费用选择（登场宣言可被对应） */
function requestSurpriseDeployAt(gs: GameState, p: PlayerIndex, uid: string, row: RowName, area: AreaIndex): GameState {
  const next = clone(gs);
  const inst = findInst(next, uid);
  if (!inst) return gs;
  const card = next.cardsById[inst.cardId];
  if (!card) return gs;
  // 规则 0810：自己的场已有同编号角色时不能登场
  if (sameNumberOnField(next, p, inst.cardId)) {
    log(next, `「${card.name}」：自己的场已存在同编号的角色，不能重复登场。`);
    return next;
  }
  const restCost = poolAdjustedCost(next, p, card.cost, { kind: 'deploy', card });
  if (restCost && !canPayCost(next, p, restCost, uid) && !canCostPoolCover(next, p, restCost, { kind: 'deploy', card })) {
    log(next, `费用不足：无法サプライズ登场「${card.name}」（费用 ${card.cost || '无'}）。`);
    return next;
  }
  if (!restCost) {
    return openResponse(next, p, `サプライズ登场「${card.name}」`, 'deploy', { action: 'deploy', uid, row, area });
  }
  next.prompt = {
    kind: 'cost-pay',
    cost: restCost,
    actionLabel: `サプライズ登场「${card.name}」`,
    owner: p,
    pending: { action: 'deploy', uid, row, area },
    candidates: next.players[p].hand
      .filter((c) => c.uid !== uid)
      .map((c) => ({
        uid: c.uid,
        name: next.cardsById[c.cardId]?.name ?? c.cardId,
        elements: next.cardsById[c.cardId]?.elements ?? '',
        ex: next.cardsById[c.cardId]?.ex ?? 0,
        cardId: c.cardId,
      })),
  };
  return next;
}

/** 请求使用事件卡 */
export function requestPlayEvent(gs: GameState, uid: string): GameState {
  const next = clone(gs);
  if (next.phase !== 'main' || next.battle) return gs;
  const p = next.turnPlayer;
  const hand = next.players[p].hand;
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx < 0) return gs;
  const inst = hand[idx];
  const card = next.cardsById[inst.cardId];
  if (!card || card.type !== 'event') return gs;
  // 卡面时点限制
  const timing = cardTiming(next, card.id, 'event');
  if (!timingOk(timing, { inBattle: false, hasDefender: false, isResponse: false, ownTurn: true })) {
    log(next, `「${card.name}」无法在当前时点使用（卡面时点限制）。`);
    return next;
  }
  const restCost = poolAdjustedCost(next, p, card.cost, { kind: 'event', card });
  if (restCost && !canPayCost(next, p, restCost, uid) && !canCostPoolCover(next, p, restCost, { kind: 'event', card })) {
    log(next, `费用不足：无法使用「${card.name}」。`);
    return next;
  }
  if (!restCost) {
    return playEventNow(next, p, uid, []);
  }
  next.prompt = {
    kind: 'cost-pay',
    cost: restCost,
    actionLabel: `使用事件「${card.name}」`,
    owner: p,
    pending: { action: 'event', uid },
    candidates: hand
      .filter((c) => c.uid !== uid)
      .map((c) => ({
        uid: c.uid,
        name: next.cardsById[c.cardId]?.name ?? c.cardId,
        elements: next.cardsById[c.cardId]?.elements ?? '',
        ex: next.cardsById[c.cardId]?.ex ?? 0,
        cardId: c.cardId,
      })),
  };
  return next;
}

/** 请求装备道具（先选目标角色，再付费用） */
export function requestEquipItem(gs: GameState, itemUid: string, charUid: string): GameState {
  const next = clone(gs);
  if (next.phase !== 'main' || next.battle) return gs;
  const p = next.turnPlayer;
  const hand = next.players[p].hand;
  const idx = hand.findIndex((c) => c.uid === itemUid);
  if (idx < 0) return gs;
  const inst = hand[idx];
  const card = next.cardsById[inst.cardId];
  if (!card || card.type !== 'item') return gs;
  const charInst = findInst(next, charUid);
  if (!charInst) return gs;
  const charLoc = findLoc(next, charUid);
  if (!charLoc || charLoc.zone !== 'field' || charLoc.player !== p) return gs;
  if (charInst.equip) {
    log(next, '该角色已装备道具。');
    return next;
  }
  const restCost = poolAdjustedCost(next, p, card.cost, { kind: 'equip', card });
  if (restCost && !canPayCost(next, p, restCost, itemUid) && !canCostPoolCover(next, p, restCost, { kind: 'equip', card })) {
    log(next, `费用不足：无法装备「${card.name}」。`);
    return next;
  }
  if (!restCost) {
    return equipNow(next, p, itemUid, charUid, []);
  }
  next.prompt = {
    kind: 'cost-pay',
    cost: restCost,
    actionLabel: `装备「${card.name}」到「${cardName(next, charUid)}」`,
    owner: p,
    pending: { action: 'equip', itemUid, charUid },
    candidates: hand
      .filter((c) => c.uid !== itemUid)
      .map((c) => ({
        uid: c.uid,
        name: next.cardsById[c.cardId]?.name ?? c.cardId,
        elements: next.cardsById[c.cardId]?.elements ?? '',
        ex: next.cardsById[c.cardId]?.ex ?? 0,
        cardId: c.cardId,
      })),
  };
  return next;
}

/** 确认支付费用并执行待办动作（paidUids 为玩家手动选中的手牌） */
export function confirmCostPay(gs: GameState, paidUids: string[]): GameState {
  const next = clone(gs);
  const prompt = next.prompt;
  if (!prompt || prompt.kind !== 'cost-pay') return gs;
  const p = prompt.owner as PlayerIndex;
  const hand = next.players[p].hand;
  // 校验：选中的卡在手牌中
  const selected: CardInstance[] = [];
  for (const uid of paidUids) {
    const c = hand.find((x) => x.uid === uid);
    if (!c) {
      log(next, '费用选择无效（卡不在手牌），操作取消。');
      next.prompt = null;
      return next;
    }
    selected.push(c);
  }
  const selData = selected.map((c) => ({
    elements: next.cardsById[c.cardId]?.elements ?? '',
    ex: next.cardsById[c.cardId]?.ex ?? 0,
        cardId: c.cardId,
  }));
  if (!validateCostSelection(selData, prompt.cost)) {
    log(next, `所选费用卡不满足「${prompt.actionLabel}」的费用要求，操作取消。`);
    next.prompt = null;
    return next;
  }
  // 执行支付：手牌 → ゴミ箱
  for (const inst of selected) {
    const i = next.players[p].hand.indexOf(inst);
    if (i >= 0) {
      next.players[p].hand.splice(i, 1);
      inst.faceUp = true;
      next.players[p].trash.unshift(inst);
    }
  }
  const paidNames = selected.map((c) => cardName(next, c.uid)).join('、');
  next.prompt = null;
  const pend = prompt.pending;
  // 记录：使用了自己的道具/エリア/手札宣言/サプライズ3点以上キャラ（支付1点以上费用）→ 6961/6963 エリア诱発
  if (selected.length >= 1) {
    const recCard = (uid: string) => next.cardsById[findInst(next, uid)?.cardId ?? ''] ?? undefined;
    let rec: GameState['lastAreaEvent'] = null;
    if (pend.action === 'equip') {
      const c3 = recCard(pend.itemUid);
      if (c3) rec = { kind: 'ownUsed', owner: p, cardId: c3.id, paid: selected.length, usedFrom: 'item' };
    } else if (pend.action === 'area') {
      const c3 = recCard(pend.uid);
      if (c3) rec = { kind: 'ownUsed', owner: p, cardId: c3.id, paid: selected.length, usedFrom: 'area' };
    } else if (pend.action === 'deploy') {
      const c3 = recCard(pend.uid);
      if (c3 && (c3.basicAbilities ?? '').includes('サプライズ') && (c3.cost ?? '').length >= 3) {
        rec = { kind: 'ownUsed', owner: p, cardId: c3.id, paid: selected.length, usedFrom: 'surpriseChar' };
      }
    } else if (pend.action === 'declare' && pend.tag === '手札宣言') {
      const c3 = recCard(pend.uid);
      if (c3) rec = { kind: 'ownUsed', owner: p, cardId: c3.id, paid: selected.length, usedFrom: 'handDeclare' };
    } else if (pend.action === 'equipSelfToTargetPay' || pend.action === 'searchEquipPay') {
      // 效果装备（6955/6957 手札宣言装备、6887 检索装备）：支付道具费用 → 6961/6963 エリア诱発
      const c3 = pend.itemCardId ? next.cardsById[pend.itemCardId] : undefined;
      if (c3) rec = { kind: 'ownUsed', owner: p, cardId: c3.id, paid: selected.length, usedFrom: 'item' };
    }
    if (rec) next.lastAreaEvent = rec;
  }
  if (pend.action === 'deploy') return openResponse(next, p, `登场「${cardName(next, pend.uid)}」`, 'deploy', pend);
  if (pend.action === 'event') {
    if (next.response) {
      // 対応链中的事件：宣言入栈，等待倒序结算
      return openResponse(next, p, `事件「${cardName(next, pend.uid)}」`, 'event', pend);
    }
    return openResponse(next, p, `使用事件「${cardName(next, pend.uid)}」`, 'event', pend);
  }
  if (pend.action === 'equip') return openResponse(next, p, `装备「${cardName(next, pend.itemUid)}」`, 'equip', pend);
  if (pend.action === 'area') {
    if (next.response) return next;
    // 配置到选中的フィールド（规则 0310）
    let r: RowName = 'AF';
    let a: AreaIndex = 0;
    if (pend.row !== undefined && pend.area !== undefined) {
      r = pend.row;
      a = pend.area;
    } else {
      const s = validAreaSlots(next, p)[0];
      if (!s) {
        log(next, '没有可配置エリア的フィールド，配置失败。');
        return next;
      }
      r = s.row;
      a = s.area;
    }
    const hand2 = next.players[p].hand;
    const idx2 = hand2.findIndex((c) => c.uid === pend.uid);
    if (idx2 < 0) return next;
    const moved2 = hand2.splice(idx2, 1)[0];
    moved2.faceUp = true;
    moved2.deployedTurn = next.turn;
    next.players[p].fieldAreas[r === 'AF' ? 0 : 1][a] = moved2;
    pushVoice(next, p, 'area'); // 语音：地板（エリア）配置
    log(next, `玩家 ${p + 1} 配置エリア「${next.cardsById[moved2.cardId]?.name ?? moved2.cardId}」到${r === 'AF' ? '前列' : '后列'}·${['左', '中', '右'][a]}（费用：破弃 ${paidNames}）。`);
    return eng.runAreaDeployChain(next, p, moved2.uid);
  }
  if (pend.action === 'declare') {
    // 宣言/手札宣言的元素费用已由所选卡支付 → 继续选项/目标选择
    return proceedDeclaredOptions(next, p, pend.uid, pend.tag, pend.declIdx);
  }
  if (pend.action === 'searchDeployPay') {
    return finishSearchDeployPay(next, p, pend.uid, pend.effectPending);
  }
  if (pend.action === 'equipSelfToTargetPay' || pend.action === 'searchEquipPay') {
    // 效果装备费用已支付 → 恢复效果链继续装备（Bug ⑧⑨⑩）
    const eff = pend.effectPending as PendingEffect | null;
    if (eff) {
      eff.equipPaid = true;
      const resumed = eng.finalizeActions(next, eff);
      if (resumed.response && resumed.response.stack.length === 0) resumed.response = null;
      if (resumed.battle && resumed.battle.active && !resumed.prompt && resumed.phase === 'main') {
        return openBattleTiming(resumed, (1 - resumed.battle.timingActor) as PlayerIndex);
      }
      return resumed;
    }
    return next;
  }
  if (pend.action === 'supporterCost') {
    // サポーター费用已由玩家选卡支付 → 支援（保持未行动；一回合一次）（Bug ③）
    const afterSup = applySupporterSupport(next, p, pend.supporterUid);
    if (afterSup.response && afterSup.response.stack.length === 0) afterSup.response = null;
    if (afterSup.battle && afterSup.battle.active && !afterSup.prompt && afterSup.phase === 'main') {
      return openBattleTiming(afterSup, (1 - afterSup.battle.timingActor) as PlayerIndex);
    }
    return afterSup;
  }
  return next;
}

/** 检索登场费用支付完成 → 实际登场并继续效果链 */
function finishSearchDeployPay(gs: GameState, owner: PlayerIndex, uid: string, effectPending: PendingEffect | null): GameState {
  const st = gs.players[owner];
  let inst: CardInstance | null = null;
  let zone: 'deck' | 'trash' = 'deck';
  let zoneIdx = -1;
  const di = st.deck.findIndex((c) => c.uid === uid);
  if (di >= 0) {
    inst = st.deck[di];
    zone = 'deck';
    zoneIdx = di;
  } else {
    const ti = st.trash.findIndex((c) => c.uid === uid);
    if (ti >= 0) {
      inst = st.trash[ti];
      zone = 'trash';
      zoneIdx = ti;
    }
  }
  if (!inst || zoneIdx < 0) return gs;
  const card = gs.cardsById[inst.cardId];
  if (!card) return gs;
  // 规则：登场位置由玩家选择（卡保留在原区域，chooseSlot 时再移除）
  const slots = validDeploySlots(gs, owner, inst.uid);
  if (slots.length === 0) {
    log(gs, `没有可登场的位置，「${card.name}」未能登场。`);
    if (effectPending) {
      effectPending.searchDone = true;
      return maybeResumeEndTurn(eng.finalizeActions(gs, effectPending));
    }
    return gs;
  }
  gs.prompt = {
    kind: 'slot-pick',
    owner,
    title: `选择「${card.name}」的登场位置`,
    uid: inst.uid,
    slots,
    purpose: 'searchDeploy',
    pending: effectPending,
  };
  return gs;
}

/** 请求配置エリア（手札 → 特殊置场；1 场 1 张） */
export function requestPlayArea(gs: GameState, uid: string): GameState {
  const next = clone(gs);
  if (next.phase !== 'main' || next.battle) return gs;
  const p = next.turnPlayer;
  const hand = next.players[p].hand;
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx < 0) return gs;
  const inst = hand[idx];
  const card = next.cardsById[inst.cardId];
  if (!card || card.type !== 'area') return gs;
  // 规则 0310：エリア配置到没有エリア的フィールド，位置由玩家选择
  const slots = validAreaSlots(next, p);
  if (slots.length === 0) {
    log(next, `没有可配置エリア的フィールド，无法配置「${card.name}」。`);
    return next;
  }
  next.prompt = {
    kind: 'slot-pick',
    owner: p,
    title: `选择「${card.name}」的配置位置（フィールド）`,
    uid,
    slots,
    purpose: 'areaPlaceHand',
    pending: null,
  };
  return next;
}

/** 配置エリア到指定フィールド（从手牌/牌堆/ゴミ箱移除后放入 fieldAreas） */
function placeAreaTo(gs: GameState, p: PlayerIndex, uid: string, row: RowName, area: AreaIndex, fromHand: boolean): GameState {
  const st = gs.players[p];
  const arr = fromHand ? st.hand : st.deck;
  const idx = arr.findIndex((c) => c.uid === uid);
  if (idx < 0) return gs;
  const moved = arr.splice(idx, 1)[0];
  moved.faceUp = true;
  moved.deployedTurn = gs.turn;
  st.fieldAreas[row === 'AF' ? 0 : 1][area] = moved;
  log(gs, `玩家 ${p + 1} 配置エリア「${gs.cardsById[moved.cardId]?.name ?? moved.cardId}」到${row === 'AF' ? '前列' : '后列'}·${['左', '中', '右'][area]}。`);
  return eng.runAreaDeployChain(gs, p, moved.uid);
}

/** 取消费用支付 */
export function cancelCostPay(gs: GameState): GameState {
  const next = clone(gs);
  if (next.prompt?.kind !== 'cost-pay') return gs;
  next.prompt = null;
  log(next, '已取消费用支付。');
  return maybeResumeResponse(next);
}

/** 请求装备：先弹出选择目标（随后进入费用选择） */
export function requestEquipTarget(gs: GameState, itemUid: string): GameState {
  const next = clone(gs);
  if (next.phase !== 'main' || next.battle) return gs;
  if (next.prompt) return gs;
  const p = next.turnPlayer;
  const inst = next.players[p].hand.find((c) => c.uid === itemUid);
  if (!inst) return gs;
  const card = next.cardsById[inst.cardId];
  if (!card || card.type !== 'item') return gs;
  const targets: { uid: string; name: string }[] = [];
  for (let r = 0; r < 2; r++) {
    for (let a = 0; a < 3; a++) {
      const c = next.players[p].field[r][a];
      if (c) targets.push({ uid: c.uid, name: next.cardsById[c.cardId]?.name ?? c.cardId });
    }
  }
  if (targets.length === 0) {
    log(next, '场上没有可装备的角色。');
    return next;
  }
  next.prompt = { kind: 'equip-target', itemUid, targets };
  return next;
}

/** 取消当前提示（通用） */
export function cancelPrompt(gs: GameState): GameState {
  const next = clone(gs);
  // 效果链中的选择被取消 → 继续效果链（放弃检索/放弃使用手札宣言）
  if (next.prompt?.kind === 'effect-choice' && next.prompt.pending) {
    const pend = next.prompt.pending;
    const cancelledOwner = next.prompt.owner;
    const firstOptionId = next.prompt.options[0]?.id;
    next.prompt = null;
    // 顺序选择取消 → 按默认顺序处理第一个（Bug 5）
    if (pend.trigger === '__triggerPick' && firstOptionId) {
      return chooseEffectOption(next, [firstOptionId]);
    }
    if (pend.trigger === '__useDeclare') {
      pend.trigger = null;
      pend.searchDone = true;
      return maybeResumeEndTurn(eng.finalizeActions(next, pend));
    }
    if (pend.trigger === '__useDeclareOpt') {
      const rp = pend.resumePending ? structuredClone(pend.resumePending) : null;
      if (rp) {
        rp.searchDone = true;
        return maybeResumeEndTurn(eng.finalizeActions(next, rp));
      }
      next.prompt = null;
      return maybeResumeResponse(next);
    }
    // 对应链中：响应方选择宣言/选项时取消 → 回到对应窗口（Bug 13：不结算链）
    if (next.response && cancelledOwner === next.response.awaiting && pend.declIdx >= 0 && !pend.optionId) {
      return openResponsePrompt(next, next.response.awaiting);
    }
    if (pend.searchDone === false && pend.trigger !== '__clause' && pend.trigger !== '__event') {
      // 检索/选卡类效果链取消 → 标记完成并继续
      pend.searchDone = true;
      return maybeResumeEndTurn(eng.finalizeActions(next, pend));
    }
    // 触发类效果选择取消（等于放弃该触发）→ 跳过该触发继续扫描
    if (pend.trigger && !pend.trigger.startsWith('__')) {
      const skipKey = eng.trigChainKey(pend, next.turn);
      return maybeResumeEndTurn(eng.continueTriggerChain(next, pend.trigger, pend.owner, pend.sourceUid, skipKey));
    }
    // 宣言能力块选择（__clause）取消 → 回到上一步（对应链中则恢复对应窗口）
    return maybeResumeResponse(next);
  }
  if (next.prompt?.kind === 'card-pick') {
    const cp = next.prompt;
    // 登场充能取消 = 不充能，继续登场链
    if (cp.purpose === 'charge' && !cp.pending) {
      next.prompt = null;
      return maybeResumeEndTurn(eng.runDeployChainResume(next, cp.sourceUid ?? '', cp.owner));
    }
    // 效果链内的选卡取消（手牌/下方合计破弃 6848 等）→ 跳过当前动作继续结算，避免再次弹同一选卡（Bug ④）
    if (cp.pending) {
      const pend = cp.pending;
      pend.skipCurrent = true;
      pend.extraUids = [];
      next.prompt = null;
      log(next, '取消选择：放弃当前效果段，继续结算。');
      return maybeResumeEndTurn(eng.finalizeActions(next, pend));
    }
    return chooseCardPick(next, []);
  }
  next.prompt = null;
  return maybeResumeResponse(next);
}

/** 若处于对应链中且无新提示 → 恢复对应窗口（回到上一步，避免双方卡死） */
function maybeResumeResponse(gs: GameState): GameState {
  if (gs.response && !gs.prompt) return openResponsePrompt(gs, gs.response.awaiting);
  return gs;
}

/* ================= 手札宣言 / 宣言效果 / 基本能力移动 ================= */

/** 手札宣言：从手牌使用手札宣言能力（费用 → 目标/选项 → 结算，卡保留在手牌） */
export function requestHandDeclare(gs: GameState, uid: string): GameState {
  const next = clone(gs);
  if (next.phase !== 'main' || next.battle) return gs;
  let owner: PlayerIndex | null = null;
  let inst: CardInstance | null = null;
  for (const p of [0, 1] as PlayerIndex[]) {
    const c = next.players[p].hand.find((x) => x.uid === uid);
    if (c) {
      owner = p;
      inst = c;
      break;
    }
  }
  if (!inst || owner === null) return gs;
  // 规则：主阶段只有回合玩家持有优先权，非回合玩家通过対応/自由时点行动
  if (owner !== next.turnPlayer && !next.response && !next.battle) {
    log(next, '非回合玩家只能在対応或自由时点使用手札宣言。');
    return next;
  }
  const card = next.cardsById[inst.cardId];
  if (!card || !hasHandDeclare(card)) return gs;
  // 卡面时点限制：主阶段正常使用也校验
  const timing = cardTiming(next, card.id, '手札宣言');
  if (!timingOk(timing, { inBattle: false, hasDefender: false, isResponse: false, ownTurn: owner === next.turnPlayer })) {
    log(next, `「${card.name}」无法在当前时点使用（卡面时点限制）。`);
    return next;
  }
  return openDeclared(next, owner, uid, '手札宣言', { inBattle: false, hasDefender: false, isResponse: false, ownTurn: owner === next.turnPlayer });
}

/** 宣言效果：场上角色/道具/エリア的 [宣言] 能力（回合玩家使用） */
export function requestDeclare(gs: GameState, uid: string): GameState {
  const next = clone(gs);
  if (next.phase !== 'main' || next.battle) return gs;
  const loc = findLoc(next, uid);
  if (!loc || (loc.zone !== 'field' && loc.zone !== 'special' && loc.zone !== 'equip' && loc.zone !== 'area')) return gs;
  const p = loc.player;
  if (p !== next.turnPlayer) return gs;
  const inst = findInst(next, uid);
  if (!inst) return gs;
  const card = next.cardsById[inst.cardId];
  if (!card || !hasDeclare(card)) return gs;
  // 卡面时点限制
  const timing = cardTiming(next, card.id, '宣言');
  if (!timingOk(timing, { inBattle: false, hasDefender: false, isResponse: false, ownTurn: true })) {
    log(next, `「${card.name}」无法在当前时点使用（卡面时点限制）。`);
    return next;
  }
  return openDeclared(next, p, uid, '宣言', { inBattle: false, hasDefender: false, isResponse: false, ownTurn: p === next.turnPlayer });
}

/** 打开宣言：多个宣言块 → 先选块；否则直接进入费用（ctx 提供时按卡面时点过滤可用块，Bug ③：6907 等自ターン中宣言不能在对应/战斗时点/对方回合用） */
function openDeclared(gs: GameState, owner: PlayerIndex, uid: string, tag: '宣言' | '手札宣言', ctx?: TimingCtx): GameState {
  const inst = findInst(gs, uid);
  if (!inst) return gs;
  const card = gs.cardsById[inst.cardId];
  if (!card) return gs;
  const parsed = getParsed(card);
  const usable: { c: (typeof parsed.declared)[number]; i: number }[] = [];
  parsed.declared.forEach((c, i) => {
    if (c.tag !== tag) return;
    // 窗口时点过滤：対応/战斗/回合等窗口内，按各宣言块自己的时机（Bug ③）
    if (ctx && !timingOk(c.timing, ctx)) return;
    // 「Ｎ枚以下の自分のデッキ」使用前提（切札 6958/6961/6962/6963）：牌堆不足 N 张不能使用
    if (c.deckMax !== undefined && gs.players[owner].deck.length > c.deckMax) {
      log(gs, `「${card.name}」使用前提不满足：自己的牌堆需在 ${c.deckMax} 张以下（当前 ${gs.players[owner].deck.length} 张）。`);
      return;
    }
    // [T] 费用：已行动或登场ターン制限中的角色无法支付 → 该能力块不可选（アグレッシブ可无视）
    if (c.cost === 'T' && (inst.tapped || (inst.deployedTurn !== null && !eng.hasAggressive(gs, uid)))) return;
    usable.push({ c, i });
  });
  if (usable.length === 0) {
    log(gs, `「${card.name}」当前没有可用的${tag}能力（已行动/登场ターン制限等）。`);
    return gs;
  }
  if (usable.length === 1) {
    return proceedDeclared(gs, owner, uid, tag, usable[0].i, null);
  }
  gs.prompt = {
    kind: 'effect-choice',
    owner,
    title: `「${card.name}」${tag === '宣言' ? '宣言' : '手札宣言'}：选择使用哪个能力`,
    multi: false,
    max: 1,
    options: usable.map(({ c, i }) => ({ id: String(i), label: `${c.trump ? '【切札】' : ''}[${c.cost}] ${clauseSummary(c)}`, cardId: card.id })),
    pending: { sourceUid: uid, owner, declIdx: -1, trigIdx: -1, tag, optionId: '', optionLabel: '', trigger: '__clause', stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true },
  };
  return gs;
}

function clauseSummary(c: { options: EffOption[] }): string {
  return c.options.map((o) => o.label).join(' / ');
}

/** 进入宣言：先支付费用 */
function proceedDeclared(
  gs: GameState,
  owner: PlayerIndex,
  uid: string,
  tag: '宣言' | '手札宣言',
  declIdx: number,
  targetUid: string | null,
): GameState {
  const inst = findInst(gs, uid);
  const card = inst ? gs.cardsById[inst.cardId] : undefined;
  if (!inst || !card) return gs;
  const parsed = getParsed(card);
  const clause = parsed.declared[declIdx];
  if (!clause || clause.tag !== tag) return gs;
  if (inst.lost.includes(`decl${declIdx}`)) {
    log(gs, `「${card.name}」该能力已失去。`);
    return gs;
  }
  // 配置ターン中を除く：配置回合不能使用该宣言（Bug 4）
  if (clause.timing.notDeployTurn && inst.deployedTurn === gs.turn) {
    log(gs, `「${card.name}」配置回合中无法使用该宣言（配置ターン中を除く）。`);
    return gs;
  }
  if (clause.trump) {
    // 规则：切札はゲーム中に１回のみ処理可能（カード番号に関わらず）
    if (gs.trumpUsed) {
      log(gs, `「${card.name}」切札本局已使用过（切札全游戏仅 1 回）。`);
      return gs;
    }
    gs.trumpUsed = true;
    gs.trumpSignal = { owner: owner as PlayerIndex, turn: gs.turn }; // 战歌播放信号（双方端据此播放）
    pushVoice(gs, owner as PlayerIndex, 'trump'); // 语音：切札
    log(gs, `「${card.name}」使用切札（本局后续切札效果无法再使用）。`);
  } else {
    // 语音：宣言 / 手札宣言（効果発動）
    pushVoice(gs, owner as PlayerIndex, 'declare');
  }
  // 规则：宣言/手札宣言无特殊描述时每回合只能使用 1 次
  const declKey = `decl:${uid}:${declIdx}:${gs.turn}`;
  const declUsed = gs.players[owner].perTurn[declKey] ?? 0;
  if (declUsed >= (clause.perTurn ?? 1)) {
    log(gs, `「${card.name}」该宣言本回合已使用 ${declUsed} 次（上限 ${clause.perTurn ?? 1}）。`);
    return gs;
  }
  gs.players[owner].perTurn[declKey] = declUsed + 1;
  // 使用条件前置检查（全部选项带条件且不满足 → 不支付费用直接提示）
  if (clause.options.length > 0 && clause.options.every((o) => o.cond)) {
    const probe: PendingEffect = {
      sourceUid: uid,
      owner,
      declIdx,
      trigIdx: -1,
      optionId: clause.options[0].id,
      optionLabel: '',
      trigger: null,
      stage: 0,
      targetUid: null,
      forceTarget: null,
      extraUids: [],
      searchDone: false,
      paidCost: true,
    };
    const fail = eng.optionCondFails(gs, probe);
    if (fail) {
      log(gs, `「${card.name}」条件未满足（${fail}），效果不发动。`);
      return gs;
    }
  }
  const cost = clause.cost;
  // 支付费用
  if (cost === 'T') {
    // 规则 1431-1436：登场ターン制限期间不能支付 [T]（アグレッシブ可无视）；已行动也无法支付
    if (inst.deployedTurn !== null && !eng.hasAggressive(gs, uid)) {
      log(gs, `「${card.name}」登场ターン制限中，无法支付 [T] 费用（アグレッシブ可无视）。`);
      gs.prompt = null;
      return gs;
    }
    if (inst.tapped) {
      log(gs, `「${card.name}」已行动，无法支付 [T] 费用。`);
      gs.prompt = null;
      return gs;
    }
    inst.tapped = true;
  } else if (/^D\d/.test(cost)) {
    const n = parseInt(cost.slice(1), 10) || 1;
    const st = gs.players[owner];
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      if (st.deck.length === 0) break;
      const top = st.deck.pop()!;
      top.faceUp = true;
      st.trash.unshift(top);
      cnt++;
    }
    log(gs, `支付费用：破弃牌堆 ${cnt} 张。`);
  } else if (/^C\d/.test(cost)) {
    const n = parseInt(cost.slice(1), 10) || 1;
    if (inst.charge.length < n) {
      log(gs, `「${card.name}」充能不足：无法支付 [C${n}] 费用（宣言）。`);
      return gs;
    }
    // 规则：由玩家选择要破弃的充能
    gs.prompt = {
      kind: 'card-pick',
      owner,
      title: `支付 [C${n}] 费用：选择要破弃的 ${n} 张充能（「${card.name}」）`,
      max: n,
      candidates: inst.charge.map((c) => ({ uid: c.uid, name: gs.cardsById[c.cardId]?.name ?? c.cardId, cardId: c.cardId })),
      zone: 'charge',
      sourceUid: uid,
      purpose: 'discardChargeCost',
      param: cost,
      pending: { sourceUid: uid, owner, declIdx, trigIdx: -1, tag, optionId: '', optionLabel: '', trigger: null, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true },
    };
    return gs;
  } else if (cost !== '0' && cost !== '') {
    // 元素费用：生成费用抵扣后仍不足 → 手牌支付
    const rest = poolAdjustedCost(gs, owner, cost, { kind: 'declare', card });
    if (rest) {
      const exclude = gs.players[owner].hand.some((c) => c.uid === uid) ? uid : undefined;
      if (!canPayCost(gs, owner, rest, exclude) && !canCostPoolCover(gs, owner, rest, { kind: 'declare', card })) {
        log(gs, `费用不足：无法使用「${card.name}」的${tag}（费用 ${cost}）。`);
        return gs;
      }
      const hand = gs.players[owner].hand;
      gs.prompt = {
        kind: 'cost-pay',
        cost: rest,
        actionLabel: `${tag}「${card.name}」（[${cost}]）`,
        owner,
        pending: { action: 'declare', uid, tag, declIdx, targetUid },
        candidates: hand
          .filter((c) => c.uid !== uid)
          .map((c) => ({
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
  return proceedDeclaredOptions(gs, owner, uid, tag, declIdx);
}

/** 费用已支付 → 选项/目标选择 */
function proceedDeclaredOptions(gs: GameState, owner: PlayerIndex, uid: string, tag: '宣言' | '手札宣言', declIdx: number): GameState {
  const inst = findInst(gs, uid);
  const card = inst ? gs.cardsById[inst.cardId] : undefined;
  if (!inst || !card) return gs;
  const parsed = getParsed(card);
  const clause = parsed.declared[declIdx];
  if (!clause || clause.tag !== tag) return gs;
  const options = clause.options;
  // 规则：手札宣言能力使用后，卡进入ゴミ箱（如同事件卡，不留在手札）
  if (tag === '手札宣言') {
    const hIdx = gs.players[owner].hand.findIndex((c) => c.uid === uid);
    if (hIdx >= 0) {
      const c = gs.players[owner].hand.splice(hIdx, 1)[0];
      c.faceUp = true;
      gs.players[owner].trash.unshift(c);
      log(gs, `「${card.name}」手札宣言使用后进入ゴミ箱。`);
    }
  }
  if (options.length === 0) {
    gs.prompt = { kind: 'manual-effect', title: `${tag}「${card.name}」`, text: clause.raw, owner };
    return gs;
  }
  // 过滤条件不满足的选项（Bug ②：6893「不做上述时」需要本角色充能≥1）
  const probeBase: PendingEffect = { sourceUid: uid, owner, declIdx, trigIdx: -1, optionId: '', optionLabel: '', trigger: null, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true };
  const usable = options.filter((o) => {
    if (!o.cond) return true;
    return !eng.optionCondFails(gs, { ...probeBase, optionId: o.id });
  });
  if (usable.length === 0) {
    log(gs, `「${card.name}」：当前没有满足条件的效果选项。`);
    return gs;
  }
  if (usable.length === 1) {
    return startDeclaredOption(gs, owner, uid, declIdx, usable[0].id);
  }
  gs.prompt = {
    kind: 'effect-choice',
    owner,
    title: `「${card.name}」${tag}：请选择效果`,
    multi: false,
    max: 1,
    options: usable.map((o) => ({ id: o.id, label: o.label + (o.parsed ? '' : '（含手动部分）') })),
    pending: { sourceUid: uid, owner, declIdx, trigIdx: -1, optionId: '', optionLabel: '', trigger: null, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true },
  };
  return gs;
}

/** 已选定选项 → 需要目标则提示，否则执行 */
function startDeclaredOption(gs: GameState, owner: PlayerIndex, uid: string, declIdx: number, optionId: string): GameState {
  const inst = findInst(gs, uid);
  const card = inst ? gs.cardsById[inst.cardId] : undefined;
  if (!inst || !card) return gs;
  const parsed = getParsed(card);
  const option = parsed.declared[declIdx]?.options.find((o) => o.id === optionId);
  if (!option) return gs;
  const pending: PendingEffect = { sourceUid: uid, owner, declIdx, trigIdx: -1, optionId, optionLabel: option.label, trigger: null, stage: 0, targetUid: null, extraUids: [], searchDone: false, forceTarget: null, paidCost: true };
  if (option.actions.length === 0) {
    gs.prompt = { kind: 'manual-effect', title: `「${card.name}」效果`, text: option.partialRaw ?? clauseRaw(parsed, declIdx) ?? option.label, owner };
    return gs;
  }
  // 需要目标的动作
  const tAct = option.actions.find((a) => eng.actionNeedsTarget(a) && a.target !== 'self');
  if (tAct) {
    const cands = eng.targetCandidates(gs, owner, tAct);
    if (cands.length === 0) {
      log(gs, `「${card.name}」没有可指定的目标，效果落空。`);
      return gs;
    }
    gs.prompt = {
      kind: 'declare-target',
      uid,
      tag: parsed.declared[declIdx].tag,
      owner,
      actionLabel: `「${card.name}」：选择目标（${tAct.label ?? ''}）`,
      candidates: cands,
      pending,
    };
    return gs;
  }
  // 宣言 → 对手対応窗口（战斗时点直接结算；対応链中入栈待倒序结算）
  if (gs.battle) {
    return eng.finalizeActions(gs, pending);
  }
  return openResponse(gs, owner, `${parsed.declared[declIdx].tag}「${card.name}」`, 'declare', undefined, pending);
}

function clauseRaw(parsed: ReturnType<typeof getParsed>, declIdx: number): string | null {
  return parsed.declared[declIdx]?.raw ?? null;
}

/** 选择宣言目标后结算 */
export function chooseDeclareTarget(gs: GameState, targetUid: string | null): GameState {
  const next = clone(gs);
  const prompt = next.prompt;
  if (!prompt || prompt.kind !== 'declare-target') return gs;
  next.prompt = null;
  if (prompt.pending) {
    // 若当前待选动作是强制防御 → 设置 forceTarget；否则设置普通目标
    const pend = prompt.pending;
    const srcInst = findInst(next, pend.sourceUid);
    const srcCard = srcInst ? next.cardsById[srcInst.cardId] : undefined;
    const pp = srcCard ? getParsed(srcCard) : undefined;
    const opt = pp
      ? pend.declIdx >= 0
        ? pp.declared[pend.declIdx]?.options.find((o) => o.id === pend.optionId)
        : pend.trigIdx >= 0
          ? pp.triggers[pend.trigIdx]?.options.find((o) => o.id === pend.optionId)
          : undefined
      : undefined;
    const curAct = opt?.actions[pend.stage];
    if (curAct?.t === 'forceDefend') {
      pend.forceTarget = targetUid;
      return finishPrompt(eng.finalizeActions(next, pend));
    }
    pend.targetUid = targetUid;
    // エンゲージ括弧效果的目标选择 → 应用效果后继续（エンゲージ诱発 → 登场诱発）
    if (pend.trigger === '__engage') {
      const srcInst2 = findInst(next, pend.sourceUid);
      const srcCard2 = srcInst2 ? next.cardsById[srcInst2.cardId] : undefined;
      if (srcCard2) {
        const val = eng.basicAbilityValue(srcCard2, 'エンゲージ');
        const acts: EffAction[] = [];
        eng.parseActionListPublic(val, acts);
        for (const a of acts) {
          const r = eng.applySingleAction(next, pend, a, false);
          if (r.prompt) return finishPrompt(next);
          log(next, `「${srcCard2.name}」エンゲージ：${r.msg}`);
        }
      }
      const afterE = eng.continueTriggerChain(next, 'engageDiscard', prompt.owner, pend.sourceUid);
      if (afterE.prompt) return finishPrompt(afterE);
      return finishPrompt(eng.continueTriggerChain(afterE, 'deploy', prompt.owner, pend.sourceUid));
    }
    // 宣言 → 对手対応窗口（战斗时点直接结算；対応链中入栈）
    if (next.battle) {
      return finishPrompt(eng.finalizeActions(next, pend));
    }
    const card = next.cardsById[pend.sourceUid];
    const tagLabel = prompt.tag === '手札宣言' ? '手札宣言' : '宣言';
    return openResponse(next, prompt.owner, `${tagLabel}「${card?.name ?? ''}」`, 'declare', undefined, pend);
  }
  return next;
}

/** 效果选项选择（宣言块选择 / 效果选项 / 手牌破弃选择 / 多目标选择） */
export function chooseEffectOption(gs: GameState, ids: string[]): GameState {
  const next = clone(gs);
  const prompt = next.prompt;
  if (!prompt || prompt.kind !== 'effect-choice') return gs;
  next.prompt = null;
  const pending = prompt.pending;
  // 可选诱発「不处理」→ 跳过该触发继续扫描（Bug 14/7）
  if (ids[0] === '__skip' && pending.trigger && !pending.trigger.startsWith('__')) {
    const skipKey = eng.trigChainKey(pending, next.turn);
    return maybeResumeEndTurn(eng.continueTriggerChain(next, pending.trigger, pending.owner, pending.sourceUid, skipKey));
  }
  // 多个诱発同时触发：玩家选择先处理的（Bug 5）
  if (pending.trigger === '__triggerPick') {
    const parts = (ids[0] ?? '').split('|');
    const suid = parts[0];
    const ti = parseInt(parts[1] ?? '-1', 10);
    const key = parts[2] ?? '';
    const trig = pending.scanTrigger ?? '';
    if (!suid || !Number.isFinite(ti) || !trig) return gs;
    // 只触发选中的那张；forceScanAll 保持全局扫描，剩余诱発继续让玩家选顺序
    return maybeResumeEndTurn(eng.continueTriggerChain(next, trig, pending.owner, suid, undefined, true, key));
  }
  if (pending.trigger === '__clause') {
    const declIdx = parseInt(ids[0] ?? '', 10);
    if (!Number.isFinite(declIdx)) return gs;
    return proceedDeclared(next, pending.owner, pending.sourceUid, pending.tag ?? '宣言', declIdx, null);
  }
  // 登场充能：先破弃牌堆（0~N）→ 再从ゴミ箱选 0~N 充能（Bug 2）
  if (pending.trigger === '__chargeMill') {
    const k = parseInt(ids[0] ?? '0', 10) || 0;
    const st0 = next.players[pending.owner];
    let milled = 0;
    for (let i = 0; i < k; i++) {
      if (st0.deck.length === 0) break;
      const top = st0.deck.pop()!;
      top.faceUp = true;
      st0.trash.unshift(top);
      milled++;
    }
    if (milled > 0) log(next, `充能：破弃牌堆 ${milled} 张。`);
    const srcInst0 = findInst(next, pending.sourceUid);
    const srcCard0 = srcInst0 ? next.cardsById[srcInst0.cardId] : undefined;
    const bas0 = srcCard0 ? parseBasicAbilities(srcCard0.basicAbilities ?? '') : [];
    const n0 = parseInt((bas0.find((a) => a.tag === 'チャージ')?.value ?? '1').replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d))), 10) || 1;
    next.prompt = {
      kind: 'card-pick',
      owner: pending.owner,
      title: `「${cardName(next, pending.sourceUid)}」登场充能：从ゴミ箱选择放入充能的卡（最多 ${n0} 张，可少选或不选）`,
      max: n0,
      candidates: st0.trash.map((c) => ({ uid: c.uid, name: next.cardsById[c.cardId]?.name ?? c.cardId, cardId: c.cardId })),
      zone: 'trash',
      sourceUid: pending.sourceUid,
      purpose: 'charge',
      pending: null,
    };
    return next;
  }
  // 检索后使用手札宣言能力（6862 家族）：选择具体子句 → 执行（不付费用，卡留在原区域）
  if (pending.trigger === '__useDeclare') {
    const [suid, sIdx] = (ids[0] ?? '').split('|');
    const idx = parseInt(sIdx ?? '', 10);
    const srcInst3 = findInst(next, suid);
    const srcCard3 = srcInst3 ? next.cardsById[srcInst3.cardId] : undefined;
    if (!srcInst3 || !srcCard3 || !Number.isFinite(idx)) return gs;
    const pp3 = getParsed(srcCard3);
    const clause3 = pp3.declared[idx];
    if (!clause3 || clause3.tag !== '手札宣言') return gs;
    const chainPend: PendingEffect = { ...pending, trigger: null, resumePending: undefined };
    if (clause3.options.length === 1) {
      const pend2: PendingEffect = {
        sourceUid: suid,
        owner: pending.owner,
        declIdx: idx,
        trigIdx: -1,
        tag: '手札宣言',
        optionId: clause3.options[0].id,
        optionLabel: clause3.options[0].label,
        trigger: '__event',
        stage: 0,
        targetUid: null,
        extraUids: [],
        searchDone: false,
        forceTarget: null,
        paidCost: true,
        resumePending: chainPend,
      };
      return maybeResumeEndTurn(eng.finalizeActions(next, pend2));
    }
    next.prompt = {
      kind: 'effect-choice',
      owner: pending.owner,
      title: `「${srcCard3.name}」手札宣言：请选择效果`,
      multi: false,
      max: 1,
      options: clause3.options.map((o) => ({ id: o.id, label: o.label + (o.parsed ? '' : '（含手动部分）') })),
      pending: {
        sourceUid: suid,
        owner: pending.owner,
        declIdx: idx,
        trigIdx: -1,
        tag: '手札宣言',
        optionId: '',
        optionLabel: '',
        trigger: '__useDeclareOpt',
        stage: 0,
        targetUid: null,
        extraUids: [],
        searchDone: false,
        forceTarget: null,
        paidCost: true,
        resumePending: chainPend,
      },
    };
    return next;
  }
  if (pending.trigger === '__useDeclareOpt') {
    const pend3: PendingEffect = { ...pending, optionId: ids[0] ?? '', optionLabel: '', trigger: '__event' };
    return maybeResumeEndTurn(eng.finalizeActions(next, pend3));
  }
  if (pending.trigger === '__event') {
    pending.optionId = ids[0] ?? pending.optionId;
    pending.targetUid = ids[0] && ids[0] !== pending.optionId ? ids[0] : pending.targetUid;
    return maybeResumeEndTurn(eng.finalizeActions(next, pending));
  }
  // 当前动作是否需要补充选择（手牌破弃 / 多目标 DMG0）
  const src = findInst(next, pending.sourceUid);
  const card = src ? next.cardsById[src.cardId] : undefined;
  if (card) {
    const p = getParsed(card);
    let opt: EffOption | undefined;
    if (pending.declIdx >= 0) opt = p.declared[pending.declIdx]?.options.find((o) => o.id === pending.optionId);
    if (pending.trigIdx >= 0) opt = p.triggers[pending.trigIdx]?.options.find((o) => o.id === pending.optionId);
    if (pending.optionId === 'evt' || (!opt && pending.trigIdx < 0 && pending.declIdx < 0)) {
      // 事件流程：ids 是目标 uid
      pending.targetUid = ids[0] ?? null;
      return maybeResumeEndTurn(eng.finalizeActions(next, pending));
    }
    const act = opt?.actions[pending.stage];
    if (act && (act.t === 'discardHand' || act.t === 'supportAsDp' || (act.t === 'dmgZero' && (act.n ?? 1) > 1))) {
      pending.extraUids = ids;
      return maybeResumeEndTurn(eng.finalizeActions(next, pending));
    }
  }
  if (ids.length === 0) return gs;
  pending.optionId = ids[0];
  // 找选项 → 目标/执行
  const inst2 = findInst(next, pending.sourceUid);
  const card2 = inst2 ? next.cardsById[inst2.cardId] : undefined;
  if (!card2) return gs;
  const parsed2 = getParsed(card2);
  let option: EffOption | undefined;
  if (pending.declIdx >= 0) option = parsed2.declared[pending.declIdx]?.options.find((o) => o.id === pending.optionId);
  if (pending.trigIdx >= 0) option = parsed2.triggers[pending.trigIdx]?.options.find((o) => o.id === pending.optionId);
  if (!option) return gs;
  // 宣言/手札宣言的选项：走标准流程（目标选择 + 进対応链），保证后发先至（Bug 9）
  if (pending.declIdx >= 0) {
    return startDeclaredOption(next, pending.owner, pending.sourceUid, pending.declIdx, pending.optionId);
  }
  if (option.actions.length === 0) {
    next.prompt = {
      kind: 'manual-effect',
      title: `「${card2.name}」效果`,
      text: option.partialRaw ?? option.label,
      owner: pending.owner,
    };
    return next;
  }
  const tAct = option.actions.find((a) => eng.actionNeedsTarget(a) && a.target !== 'self');
  if (tAct) {
    const cands = eng.targetCandidates(next, pending.owner, tAct);
    if (cands.length === 0) {
      log(next, `「${card2.name}」没有可指定的目标。`);
      return next;
    }
    if (cands.length === 1) {
      pending.targetUid = cands[0].uid;
      return maybeResumeEndTurn(eng.finalizeActions(next, pending));
    }
    next.prompt = {
      kind: 'declare-target',
      uid: pending.sourceUid,
      tag: pending.declIdx >= 0 ? (parsed2.declared[pending.declIdx]?.tag ?? '宣言') : '诱発',
      owner: pending.owner,
      actionLabel: `「${card2.name}」：选择目标（${tAct.label ?? ''}）`,
      candidates: cands,
      pending,
    };
    return next;
  }
  return maybeResumeEndTurn(eng.finalizeActions(next, pending));
}

/** 卡片选择（充能/エリア下方/置き場 的放置或破弃）→ 由玩家指定具体卡 */
export function chooseCardPick(gs: GameState, uids: string[]): GameState {
  const next = clone(gs);
  const prompt = next.prompt;
  if (!prompt || prompt.kind !== 'card-pick') return gs;
  next.prompt = null;
  const owner = prompt.owner;
  const st = next.players[owner];
  const src = prompt.sourceUid ? findInst(next, prompt.sourceUid) : null;
  // 效果链内的放置/破弃 → 把选择交给效果链执行（store/storeUnder/discardCharge）
  if (prompt.purpose === 'store' || prompt.purpose === 'storeUnder' || prompt.purpose === 'discardCharge') {
    if (!prompt.pending) return next;
    prompt.pending.extraUids = uids;
    return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
  }
  if (prompt.purpose === 'handUnder' || prompt.purpose === 'discardOppChar') {
    // 手牌/「X」下方合计破弃、破弃对方角色（N 体まで）→ 效果链继续
    if (!prompt.pending) return next;
    prompt.pending.extraUids = uids;
    return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
  }
  if (prompt.purpose === 'healDeck') {
    // 规则 1530：デッキ回復 = 玩家从ゴミ箱选卡放回牌组底（实际移动由效果链 applySingleAction 执行）
    if (!prompt.pending) return next;
    prompt.pending.extraUids = uids;
    return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
  }
  if (prompt.purpose === 'charge' && prompt.pending) {
    // 效果链内的充能（如 6940 エンゲージ诱発 / 宣言效果）→ 交给效果链执行
    prompt.pending.extraUids = uids;
    return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
  }
  if (prompt.purpose === 'charge') {
    // 登场充能：玩家选择ゴミ箱卡（pending 为 null）
    if (src) {
      let n = 0;
      for (const uid of uids) {
        if (n >= prompt.max) break;
        const idx = st.trash.findIndex((c) => c.uid === uid);
        if (idx >= 0) {
          const c = st.trash.splice(idx, 1)[0];
          c.faceUp = true;
          src.charge.push(c);
          n++;
        }
      }
      log(next, `「${cardName(next, src.uid)}」登场充能 ${n} 张。`);
    }
    return eng.runDeployChainResume(next, prompt.sourceUid ?? '', owner);
  }
  if (prompt.purpose === 'discardChargeCost') {
    if (src) {
      let n = 0;
      for (const uid of uids) {
        if (n >= prompt.max) break;
        const idx = src.charge.findIndex((c) => c.uid === uid);
        if (idx >= 0) {
          const c = src.charge.splice(idx, 1)[0];
          c.faceUp = true;
          st.trash.unshift(c);
          n++;
        }
      }
      log(next, `支付费用：破弃充能 ${n} 张。`);
    }
    const pend = prompt.pending;
    if (pend && pend.declIdx >= 0) return proceedDeclaredOptions(next, owner, pend.sourceUid, pend.tag ?? '宣言', pend.declIdx);
    return next;
  }
  if (prompt.purpose === 'costUnder') {
    if (src) {
      let n = 0;
      for (const uid of uids) {
        if (n >= prompt.max) break;
        const idx = src.under.findIndex((c) => c.uid === uid);
        if (idx >= 0) {
          const c = src.under.splice(idx, 1)[0];
          c.faceUp = true;
          st.trash.unshift(c);
          n++;
        }
      }
      log(next, `破弃エリア下方卡 ${n} 张。`);
    }
    return finishCostAbility(next, owner, prompt.sourceUid ?? '');
  }
  if (prompt.purpose === 'costUnderInPay') {
    // 付费时使用 [コスト] 能力：破弃エリア下方卡 → 回到费用支付
    if (src) {
      let n = 0;
      for (const uid of uids) {
        if (n >= prompt.max) break;
        const idx = src.under.findIndex((c) => c.uid === uid);
        if (idx >= 0) {
          const c = src.under.splice(idx, 1)[0];
          c.faceUp = true;
          st.trash.unshift(c);
          n++;
        }
      }
      log(next, `破弃エリア下方卡 ${n} 张。`);
    }
    if (!prompt.resumePrompt) return next;
    return finishCostAbilityInPay(next, owner, prompt.sourceUid ?? '', prompt.resumePrompt);
  }
  return next;
}

/** 选择登场位置（检索登场 / 复活登场） */
export function chooseSlot(gs: GameState, row: RowName, area: AreaIndex): GameState {
  const next = clone(gs);
  const prompt = next.prompt;
  if (!prompt || prompt.kind !== 'slot-pick') return gs;
  if (!prompt.slots.some((s) => s.row === row && s.area === area)) return gs;
  next.prompt = null;
  const owner = prompt.owner;
  const st = next.players[owner];
  const place = (inst: CardInstance, tapped: boolean, label: string) => {
    inst.faceUp = true;
    inst.tapped = tapped;
    inst.deployedTurn = next.turn;
    st.field[row === 'AF' ? 0 : 1][area] = inst;
    log(next, `${label}「${next.cardsById[inst.cardId]?.name ?? inst.cardId}」${row === 'AF' ? '前列' : '后列'}·${['左', '中', '右'][area]}。`);
  };
  if (prompt.purpose === 'searchDeploy') {
    let inst: CardInstance | null = null;
    let zone: 'deck' | 'trash' = 'deck';
    let idx = -1;
    const di = st.deck.findIndex((c) => c.uid === prompt.uid);
    if (di >= 0) {
      inst = st.deck[di];
      idx = di;
    } else {
      const ti = st.trash.findIndex((c) => c.uid === prompt.uid);
      if (ti >= 0) {
        inst = st.trash[ti];
        zone = 'trash';
        idx = ti;
      }
    }
    if (!inst || idx < 0) return next;
    if (zone === 'deck') st.deck.splice(idx, 1);
    else st.trash.splice(idx, 1);
    place(inst, false, '检索登场');
    // 规则 0810：检索登场同样触发登场诱发/ターンリカバリー等；效果链内等诱发链结束后恢复外层链
    if (prompt.pending) {
      inst.pendingResumeChain = prompt.pending;
    }
    return eng.runDeployChain(next, inst.uid, owner);
  }
  if (prompt.purpose === 'surpriseDeploy') {
    // サプライズ登场：位置已选 → 费用选择（登场宣言可被对应）
    return requestSurpriseDeployAt(next, owner, prompt.uid, row, area);
  }
  if (prompt.purpose === 'areaPlace') {
    // エリア配置（规则 0310）：放到选中的フィールド（与角色可同格共存）
    const di = st.deck.findIndex((c) => c.uid === prompt.uid);
    let inst: CardInstance | null = null;
    let zone: 'deck' | 'trash' = 'deck';
    let idx = -1;
    if (di >= 0) {
      inst = st.deck[di];
      idx = di;
    } else {
      const ti = st.trash.findIndex((c) => c.uid === prompt.uid);
      if (ti >= 0) {
        inst = st.trash[ti];
        zone = 'trash';
        idx = ti;
      }
    }
    if (!inst || idx < 0) return next;
    if (zone === 'deck') st.deck.splice(idx, 1);
    else st.trash.splice(idx, 1);
    inst.faceUp = true;
    inst.deployedTurn = next.turn;
    st.fieldAreas[row === 'AF' ? 0 : 1][area] = inst;
    // 由「玉樹桜」的能力配置 → 标记（6958 自毁条件；bug 修复：检查 name 字段）
    const srcLoc0 = prompt.pending ? findInst(next, prompt.pending.sourceUid) : null;
    const srcCard0 = srcLoc0 ? next.cardsById[srcLoc0.cardId] : undefined;
    if (srcCard0 && (srcCard0.name ?? '').replace(/\s/g, '').includes('玉樹桜')) inst.placedByYushu = true;
    log(next, `「${next.cardsById[inst.cardId]?.name ?? inst.cardId}」配置到${row === 'AF' ? '前列' : '后列'}·${['左', '中', '右'][area]}。`);
    if (prompt.pending) {
      // 记录本选项内检索配置的エリア（后续「そのエリアの下に置ける」指向它，6960 触发）
      prompt.pending.placedAreaUid = inst.uid;
      inst.pendingResumeChain = prompt.pending;
    }
    return eng.runAreaDeployChain(next, owner, inst.uid);
  }
  if (prompt.purpose === 'areaPlaceHand') {
    // 手牌配置エリア：位置已选 → 费用选择后配置（配置宣言可被对应，进対応链）
    const inst2 = findInst(next, prompt.uid);
    if (!inst2) return next;
    const card2 = next.cardsById[inst2.cardId];
    if (!card2) return next;
    const restCost = poolAdjustedCost(next, owner, card2.cost, { kind: 'deploy', card: card2 });
    if (restCost && !canPayCost(next, owner, restCost, prompt.uid) && !canCostPoolCover(next, owner, restCost, { kind: 'deploy', card: card2 })) {
      log(next, `费用不足：无法配置「${card2.name}」（费用 ${card2.cost || '无'}）。`);
      return next;
    }
    if (!restCost) {
      return openResponse(next, owner, `配置エリア「${card2.name}」`, 'area', { action: 'area', uid: prompt.uid, row, area });
    }
    next.prompt = {
      kind: 'cost-pay',
      cost: restCost,
      actionLabel: `配置エリア「${card2.name}」`,
      owner,
      pending: { action: 'area', uid: prompt.uid, row, area },
      candidates: next.players[owner].hand
        .filter((c) => c.uid !== prompt.uid)
        .map((c) => ({
          uid: c.uid,
          name: next.cardsById[c.cardId]?.name ?? c.cardId,
          elements: next.cardsById[c.cardId]?.elements ?? '',
          ex: next.cardsById[c.cardId]?.ex ?? 0,
        cardId: c.cardId,
        })),
    };
    return next;
  }
  // revive：从ゴミ箱取同名卡
  const srcInst = findInst(next, prompt.uid);
  const srcCard = srcInst ? next.cardsById[srcInst.cardId] : undefined;
  const idx = st.trash.findIndex((c) => srcCard && c.cardId === srcCard.id);
  if (idx < 0) return next;
  const c = st.trash.splice(idx, 1)[0];
  place(c, !!prompt.tapped, '复活登场');
  if (prompt.pending) {
    prompt.pending.extraUids = ['placed'];
    return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
  }
  return next;
}

/** 使用 [コスト] 能力：横置并生成费用（含装备中的道具——角色获得该效果） */
export function useCostAbility(gs: GameState, uid: string): GameState {
  const next = clone(gs);
  if (next.phase !== 'main' || next.battle) return gs;
  const loc = findLoc(next, uid);
  if (!loc || (loc.zone !== 'field' && loc.zone !== 'special' && loc.zone !== 'equip' && loc.zone !== 'area')) return gs;
  const p = loc.player;
  if (p !== next.turnPlayer) return gs;
  const inst = findInst(next, uid);
  if (!inst) return gs;
  const card = next.cardsById[inst.cardId];
  if (!card) return gs;
  const parsed = getParsed(card);
  if (parsed.costAbilities.length === 0) return gs;
  // 规则：使用 [コスト] 能力不会让角色变为已行动（除非该能力自身代偿含 [T]；本卡池无此情况）
  const ab = parsed.costAbilities[0];
  if (ab.lose && inst.lost.includes('cost')) {
    log(next, '该 [コスト] 能力已失去。');
    return next;
  }
  const key = `cost:${uid}:${next.turn}`;
  if ((next.players[p].perTurn[key] ?? 0) >= ab.perTurn) {
    log(next, `该 [コスト] 能力本回合已使用 ${ab.perTurn} 次。`);
    return next;
  }
  if (ab.noDeployTurn && inst.deployedTurn === next.turn) {
    log(next, '配置回合中无法使用该 [コスト] 能力。');
    return next;
  }
  if (ab.underCost > 0) {
    if (inst.under.length < ab.underCost) {
      log(next, `置场卡不足：需要破弃 ${ab.underCost} 张。`);
      return next;
    }
    // 规则：由玩家选择要破弃的エリア下方卡
    next.prompt = {
      kind: 'card-pick',
      owner: p,
      title: `「${card.name}」[コスト]：选择要破弃的 ${ab.underCost} 张エリア下方卡`,
      max: ab.underCost,
      candidates: inst.under.map((c) => ({ uid: c.uid, name: next.cardsById[c.cardId]?.name ?? c.cardId, cardId: c.cardId })),
      zone: 'under',
      sourceUid: uid,
      purpose: 'costUnder',
      param: '0',
      pending: null,
    };
    return next;
  }
  return finishCostAbility(next, p, uid);
}

/** [コスト] 能力：破弃置场卡选择完成后执行 */
function finishCostAbility(gs: GameState, p: PlayerIndex, uid: string): GameState {
  const loc = findLoc(gs, uid);
  if (!loc || (loc.zone !== 'field' && loc.zone !== 'special' && loc.zone !== 'equip' && loc.zone !== 'area')) return gs;
  const inst = findInst(gs, uid);
  if (!inst) return gs;
  const card = gs.cardsById[inst.cardId];
  if (!card) return gs;
  const parsed = getParsed(card);
  if (parsed.costAbilities.length === 0) return gs;
  const ab = parsed.costAbilities[0];
  const key = `cost:${uid}:${gs.turn}`;
  if ((gs.players[p].perTurn[key] ?? 0) >= ab.perTurn) return gs;
  // 规则：使用 [コスト] 能力不横置（本卡池无 [T] 代偿的コスト能力）
  if (ab.lose) inst.lost.push('cost');
  gs.players[p].perTurn[key] = (gs.players[p].perTurn[key] ?? 0) + 1;
  gs.players[p].exPool.push({ elem: ab.generate[0] ?? '無', points: ab.generate.length, tag: ab.tag });
  log(gs, `「${card.name}」使用 [コスト] 能力：生成 [${ab.generate}] 费用（${ab.tag === '' ? '无限制' : '有限制'}）。`);
  return gs;
}

/* ============ 付费时使用 [コスト] 能力（Bug 8：费用支付时除了手牌还提供可用 cost 效果） ============ */

/** 从费用支付提示推导完整费用与抵扣上下文（[コスト]能力使用后重算剩余费用） */
function pendingCostInfo(gs: GameState, pending: PendingAction): { full: string; ctx: CostContext } {
  const cardOf = (uid: string) => {
    const inst = findInst(gs, uid);
    return inst ? gs.cardsById[inst.cardId] : undefined;
  };
  switch (pending.action) {
    case 'deploy':
    case 'area': {
      const card = cardOf(pending.uid);
      return { full: card?.cost ?? '', ctx: { kind: 'deploy', card } };
    }
    case 'event': {
      const card = cardOf(pending.uid);
      return { full: card?.cost ?? '', ctx: { kind: 'event', card } };
    }
    case 'equip': {
      const card = cardOf(pending.itemUid);
      return { full: card?.cost ?? '', ctx: { kind: 'equip', card } };
    }
    case 'equipSelfToTargetPay':
    case 'searchEquipPay': {
      // 效果装备（6955/6957 手札宣言装备、6887 检索装备）的费用：道具本身的 cost（Bug ④：可用 [コスト] 能力产费）
      const card = cardOf(pending.uid);
      return { full: card?.cost ?? '', ctx: { kind: 'equip', card } };
    }
    case 'supporterCost': {
      // サポーター支援费用（Bug ③）：从支援角色的基本能力取 [サポーター:费用]
      const card = cardOf(pending.supporterUid);
      const hasSupporter = !!card && (card.basicAbilities ?? '').includes('サポーター');
      const cost = hasSupporter ? (parseBasicAbilities(card.basicAbilities ?? '').find((x) => x.tag === 'サポーター')?.value ?? '') : '';
      return { full: cost, ctx: { kind: 'support', card } };
    }
    case 'declare': {
      const card = cardOf(pending.uid);
      const clause = card ? getParsed(card).declared[pending.declIdx] : undefined;
      return { full: clause?.cost ?? '', ctx: { kind: 'declare', card } };
    }
    case 'searchDeployPay': {
      const card = cardOf(pending.uid);
      return { full: card?.cost ?? '', ctx: { kind: 'deploy', card } };
    }
    default:
      return { full: '', ctx: { kind: 'declare', card: undefined } };
  }
}

/** 付费时使用 [コスト] 能力：生成费用后重新打开费用支付提示 */
export function useCostAbilityInPay(gs: GameState, uid: string): GameState {
  const next = clone(gs);
  const prompt = next.prompt;
  if (!prompt || prompt.kind !== 'cost-pay') return gs;
  const p = prompt.owner as PlayerIndex;
  const loc = findLoc(next, uid);
  if (!loc || loc.player !== p) return gs;
  const inst = findInst(next, uid);
  if (!inst) return gs;
  const card = next.cardsById[inst.cardId];
  if (!card) return gs;
  const parsed = getParsed(card);
  if (parsed.costAbilities.length === 0) return gs;
  const ab = parsed.costAbilities[0];
  if (ab.lose && inst.lost.includes('cost')) {
    log(next, '该 [コスト] 能力已失去。');
    return next;
  }
  const key = `cost:${uid}:${next.turn}`;
  if ((next.players[p].perTurn[key] ?? 0) >= ab.perTurn) {
    log(next, `该 [コスト] 能力本回合已使用 ${ab.perTurn} 次。`);
    return next;
  }
  if (ab.noDeployTurn && inst.deployedTurn === next.turn) {
    log(next, '配置回合中无法使用该 [コスト] 能力。');
    return next;
  }
  if (ab.underCost > 0) {
    if (inst.under.length < ab.underCost) {
      log(next, `置场卡不足：需要破弃 ${ab.underCost} 张。`);
      return next;
    }
    // 先选择要破弃的エリア下方卡 → 完成后回到费用支付
    next.prompt = {
      kind: 'card-pick',
      owner: p,
      title: `「${card.name}」[コスト]：选择要破弃的 ${ab.underCost} 张エリア下方卡`,
      max: ab.underCost,
      candidates: inst.under.map((c) => ({ uid: c.uid, name: next.cardsById[c.cardId]?.name ?? c.cardId, cardId: c.cardId })),
      zone: 'under',
      sourceUid: uid,
      purpose: 'costUnderInPay',
      param: '0',
      pending: null,
      resumePrompt: prompt,
    };
    return next;
  }
  return finishCostAbilityInPay(next, p, uid, prompt);
}

/** [コスト] 能力（付费时）：实际生成费用并重新打开费用支付 */
function finishCostAbilityInPay(gs: GameState, p: PlayerIndex, uid: string, prompt: Extract<PromptState, { kind: 'cost-pay' }>): GameState {
  const next = clone(gs);
  const loc = findLoc(next, uid);
  const inst = loc ? findInst(next, uid) : null;
  const card = inst ? next.cardsById[inst.cardId] : undefined;
  if (!inst || !card) return next;
  const parsed = getParsed(card);
  if (parsed.costAbilities.length === 0) return next;
  const ab = parsed.costAbilities[0];
  const key = `cost:${uid}:${next.turn}`;
  if ((next.players[p].perTurn[key] ?? 0) >= ab.perTurn) return next;
  if (ab.lose) inst.lost.push('cost');
  next.players[p].perTurn[key] = (next.players[p].perTurn[key] ?? 0) + 1;
  next.players[p].exPool.push({ elem: ab.generate[0] ?? '無', points: ab.generate.length, tag: ab.tag });
  log(next, `「${card.name}」使用 [コスト] 能力：生成 [${ab.generate}] 费用（${ab.tag === '' ? '无限制' : '有限制'}）。`);
  // 重算剩余费用并重新打开支付提示（Bug ⑥：按「当前缺口」而非全额重算，多次产费才能累计抵扣）
  const { full, ctx } = pendingCostInfo(next, prompt.pending);
  const base = prompt.cost || full;
  const rest = poolAdjustedCost(next, p, base, ctx);
  next.prompt = {
    kind: 'cost-pay',
    cost: rest,
    actionLabel: prompt.actionLabel,
    owner: p,
    pending: prompt.pending,
    candidates: prompt.candidates,
  };
  return next;
}

/** 基本能力移动：把角色移动到目标空格（若目标空且符合配置限制） */
/** 相邻フィールド格（左右/前后各一格） */
function adjacentSlots(gs: GameState, player: PlayerIndex, row: RowName, area: AreaIndex): { row: RowName; area: AreaIndex }[] {
  const out: { row: RowName; area: AreaIndex }[] = [];
  const push = (r: RowName, a: number) => {
    if (a >= 0 && a < 3) out.push({ row: r, area: a as AreaIndex });
  };
  push(row, area - 1); // 左
  push(row, area + 1); // 右
  push(row === 'AF' ? 'DF' : 'AF', area); // 前/后（同列）
  return out;
}

/** 该角色可移动的目标（基本能力）：规则 1100 —— 相邻一格、空位、未行动、自ターン、バトル外、1回合1次 */
export function validMoveTargets(gs: GameState, uid: string): { row: RowName; area: AreaIndex }[] {
  const p = gs.turnPlayer;
  if (gs.phase !== 'main' || gs.battle) return [];
  const loc = findLoc(gs, uid);
  if (!loc || loc.zone !== 'field' || loc.player !== p) return [];
  const inst = findInst(gs, uid);
  const card = inst ? gs.cardsById[inst.cardId] : undefined;
  if (!inst || !card || !hasMoveAbility(card)) return [];
  if (inst.tapped) return [];
  const key = `mv:${uid}:${gs.turn}`;
  if ((gs.players[p].perTurn[key] ?? 0) >= 1) return [];
  const tag = moveAbilityTags(card)[0];
  const adj = adjacentSlots(gs, p, loc.row ?? 'AF', loc.area ?? 0);
  const out: { row: RowName; area: AreaIndex }[] = [];
  for (const s of adj) {
    if (tag === 'サイドステップ' && s.row !== loc.row) continue; // 左右のみ
    if (tag === 'オーダーステップ' && s.area !== loc.area) continue; // 前後のみ
    if (tag === 'オーダーチェンジ') {
      const cell = fieldCell(gs, p, s.row, s.area);
      if (cell && cell.uid !== uid && s.row !== loc.row && s.area === loc.area) out.push(s); // 前后相邻的味方角色（交换）
      continue;
    }
    // ステップ/ジャンプ/サイドステップ/オーダーステップ：空位
    if (!fieldCell(gs, p, s.row, s.area) && canPlaceAt(gs, p, uid, s.row, s.area)) out.push(s);
  }
  return out;
}

/** 移动宣言（基本能力）：检查后进対応窗口（规则 0602：基本能力可被对应），结算时执行移动 */
export function moveCharacter(gs: GameState, uid: string, row: RowName, area: AreaIndex): GameState {
  const next = clone(gs);
  const p = next.turnPlayer;
  if (next.phase !== 'main' || next.battle) return gs;
  const loc = findLoc(next, uid);
  if (!loc || loc.zone !== 'field' || loc.player !== p) return gs;
  const inst = findInst(next, uid);
  const card = inst ? next.cardsById[inst.cardId] : undefined;
  if (!inst || !card || !hasMoveAbility(card)) return gs;
  if (inst.tapped) {
    log(next, '已行动的角色无法使用移动类基本能力。');
    return next;
  }
  if (inst.deployedTurn !== null && !eng.hasAggressive(next, uid)) {
    log(next, '登场ターン制限中，无法使用移动类基本能力。');
    return next;
  }
  const key = `mv:${uid}:${next.turn}`;
  if ((next.players[p].perTurn[key] ?? 0) >= 1) {
    log(next, '该基本能力本回合已使用（1 回合 1 次）。');
    return next;
  }
  const valid = validMoveTargets(next, uid).some((s) => s.row === row && s.area === area);
  if (!valid) {
    log(next, '移动目标无效（只能移动到相邻的空位）。');
    return next;
  }
  const tag = moveAbilityTags(card)[0];
  return openResponse(next, p, `基本能力「${tag}」（移动「${card.name}」）`, 'move', { action: 'move', uid, row, area });
}

/** 结算移动（対応链倒序结算时执行）：移动一格 / オーダーチェンジ交换 */
function resolveMove(gs: GameState, pend: PendingAction & { action: 'move' }): GameState {
  const next = clone(gs);
  const owner = next.turnPlayer;
  const uid = pend.uid;
  const loc = findLoc(next, uid);
  const inst = findInst(next, uid);
  const card = inst ? next.cardsById[inst.cardId] : undefined;
  if (!loc || loc.zone !== 'field' || !inst || !card) return next;
  const tag = moveAbilityTags(card)[0];
  const key = `mv:${uid}:${next.turn}`;
  next.players[owner].perTurn[key] = (next.players[owner].perTurn[key] ?? 0) + 1;
  // 语音：四种移动类基本能力各有台词
  const MOVE_VOICE: Record<string, string> = {
    ステップ: 'moveStep',
    サイドステップ: 'moveSide',
    オーダーステップ: 'moveOrder',
    ジャンプ: 'jump',
  };
  if (MOVE_VOICE[tag]) pushVoice(next, owner, MOVE_VOICE[tag]);
  const fromRow = loc.row === 'AF' ? 0 : 1;
  if (tag === 'オーダーチェンジ') {
    const target = fieldCell(next, owner, pend.row, pend.area);
    if (!target) return next;
    next.players[owner].field[fromRow][loc.area!] = target;
    next.players[owner].field[pend.row === 'AF' ? 0 : 1][pend.area] = inst;
    log(next, `玩家 ${owner + 1} 使用基本能力「${tag}」：交换「${card.name}」与「${cardName(next, target.uid)}」。`);
  } else {
    next.players[owner].field[fromRow][loc.area!] = null;
    next.players[owner].field[pend.row === 'AF' ? 0 : 1][pend.area] = inst;
    log(next, `玩家 ${owner + 1} 使用基本能力「${tag}」移动「${card.name}」到${pend.row === 'AF' ? '前列' : '后列'}·${['左', '中', '右'][pend.area]}。`);
  }
  return next;
}

/* ================= 手动结算（无法自动执行的效果） ================= */

/** 提取 [宣言]/[手札宣言] 块的文本（供手动结算面板显示） */
function declaredBlockText(card: Card, tag: string): string {
  const a = formatAbilityText(card.ability || '');
  const re = new RegExp(`\\[${tag}\\][^[]*(?:\\[[^\\]]+\\])?[^[]*`);
  const m = re.exec(a);
  return m ? m[0].trim() : a.slice(0, 100);
}

/** 手动结算：抽 n 张 */
export function manualDraw(gs: GameState, n: number): GameState {
  const next = clone(gs);
  if (next.prompt?.kind !== 'manual-effect') return gs;
  const p = next.prompt.owner;
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const st = next.players[p];
    if (st.deck.length === 0) break;
    const top = st.deck.pop()!;
    top.faceUp = true;
    st.hand.push(top);
    drawn++;
  }
  log(next, `手动结算：抽 ${drawn} 张。`);
  if (drawn > 0) pushVoice(next, p, 'draw'); // 语音：抽卡
  return next;
}

/** 手动结算：对指定角色应用临时数值修正 */
export function manualStat(gs: GameState, uid: string, stat: string, amount: number): GameState {
  const next = clone(gs);
  const inst = findInst(next, uid);
  if (inst && (stat === 'ap' || stat === 'dp' || stat === 'sp' || stat === 'dmg')) {
    inst.tempMods[stat] += amount;
    log(next, `手动结算：${cardName(next, uid)} 的 ${stat.toUpperCase()} ${amount > 0 ? `+${amount}` : amount}（到回合结束）。`);
  }
  return next;
}

/** 手动结算：破弃牌堆顶 n 张 */
export function manualDeckDiscard(gs: GameState, n: number): GameState {
  const next = clone(gs);
  if (next.prompt?.kind !== 'manual-effect') return gs;
  const p = next.prompt.owner;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const st = next.players[p];
    if (st.deck.length === 0) break;
    const top = st.deck.pop()!;
    top.faceUp = true;
    st.trash.unshift(top);
    cnt++;
  }
  log(next, `手动结算：破弃牌堆顶 ${cnt} 张。`);
  return next;
}

/** 手动结算：完成 */
export function manualDone(gs: GameState): GameState {
  const next = clone(gs);
  if (next.prompt?.kind === 'manual-effect') {
    next.prompt = null;
    log(next, '手动结算完成。');
  }
  return next;
}

/* ================= 检索登场 ================= */

/** 选择检索到的卡并处理（登场/配置/加入手牌/充能/装备；支持效果链 pending） */
export function chooseSearchDeploy(gs: GameState, targetUid: string | null, alt = false): GameState {
  const next = clone(gs);
  const prompt = next.prompt;
  if (!prompt || prompt.kind !== 'search-deploy') return gs;
  next.prompt = null;
  const owner = prompt.owner;
  const st = next.players[owner];
  const mode = prompt.mode ?? (prompt.placeMode ? 'place' : 'deploy');
  if (targetUid === null) {
    // 放弃检索 → 效果链继续
    if (prompt.pending) {
      prompt.pending.searchDone = true;
      return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
    }
    log(next, '放弃检索。');
    return next;
  }
  // 找到实例（牌堆/ゴミ箱）
  let inst: CardInstance | null = null;
  let zone: 'deck' | 'trash' = 'deck';
  let zoneIdx = -1;
  const di = st.deck.findIndex((c) => c.uid === targetUid);
  if (di >= 0) {
    inst = st.deck[di];
    zone = 'deck';
    zoneIdx = di;
  } else {
    const ti = st.trash.findIndex((c) => c.uid === targetUid);
    if (ti >= 0) {
      inst = st.trash[ti];
      zone = 'trash';
      zoneIdx = ti;
    }
  }
  if (!inst || zoneIdx < 0) {
    if (prompt.pending) return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
    return gs;
  }
  const card = next.cardsById[inst.cardId];
  if (!card) return gs;
  const useMode = alt && prompt.altMode ? prompt.altMode : mode;
  const zoneLabel = zone === 'deck' ? '牌堆' : 'ゴミ箱';
  // 登场模式：先检查费用（实例还在原区域），再让玩家选择登场位置
  let slot: { row: RowName; area: AreaIndex } | null = null;
  if (useMode === 'deploy') {
    // 规则 0810：自己的场已有同编号角色时不能登场
    if (sameNumberOnField(next, owner, inst.cardId)) {
      log(next, `「${card.name}」：自己的场已存在同编号的角色，不能重复登场。`);
      if (prompt.pending) {
        prompt.pending.searchDone = true;
        return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
      }
      return next;
    }
    // 规则：检索登场除非写「無償で」否则正常支付登场费用（效果链内，free 由解析器明确标注）
    if (prompt.pending && prompt.free === false && card.cost) {
      const rest = poolAdjustedCost(next, owner, card.cost, { kind: 'deploy', card });
      if (rest && !canPayCost(next, owner, rest) && !canCostPoolCover(next, owner, rest, { kind: 'deploy', card })) {
        log(next, `费用不足：无法为检索登场的「${card.name}」支付费用（${card.cost}），效果落空。`);
        if (prompt.pending) {
          prompt.pending.searchDone = true;
          return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
        }
        return next;
      }
      next.prompt = {
        kind: 'cost-pay',
        cost: rest,
        actionLabel: `为检索登场的「${card.name}」支付费用`,
        owner,
        pending: { action: 'searchDeployPay', uid: inst.uid, effectPending: prompt.pending },
        candidates: next.players[owner].hand.map((c) => ({
          uid: c.uid,
          name: next.cardsById[c.cardId]?.name ?? c.cardId,
          elements: next.cardsById[c.cardId]?.elements ?? '',
          ex: next.cardsById[c.cardId]?.ex ?? 0,
        cardId: c.cardId,
        })),
      };
      return next;
    }
    const slots = validDeploySlots(next, owner, inst.uid);
    if (slots.length === 0) {
      log(next, `没有可登场的位置，「${card.name}」未能登场。`);
      if (prompt.pending) {
        prompt.pending.searchDone = true;
        return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
      }
      return next;
    }
    // 规则：登场位置由玩家选择（bug 修复：即使只剩 1 个空位也确认一次）
    next.prompt = {
      kind: 'slot-pick',
      owner,
      title: `选择「${card.name}」的登场位置`,
      uid: inst.uid,
      slots,
      purpose: 'searchDeploy',
      pending: prompt.pending,
    };
    return next;
  }
  // 配置（place）模式：卡保留在原区域，等 chooseSlot 选好位置后再移除
  // 装备（equip）模式：卡也保留在原区域，等效果链中目标确定后由 applySearchEquip 取出
  if (useMode !== 'place' && useMode !== 'equip') {
    if (zone === 'deck') st.deck.splice(zoneIdx, 1);
    else st.trash.splice(zoneIdx, 1);
    inst.faceUp = true;
  }

  if (useMode === 'hand') {
    st.hand.push(inst);
    log(next, `「${card.name}」从${zoneLabel}公开加入手牌。`);
  } else if (useMode === 'charge') {
    const srcLoc = prompt.pending ? findLoc(next, prompt.pending.sourceUid) : null;
    if (srcLoc && srcLoc.zone === 'field') {
      const holder = fieldCell(next, srcLoc.player, srcLoc.row ?? 'AF', srcLoc.area ?? 0);
      if (holder) {
        holder.charge.push(inst);
        log(next, `「${card.name}」从${zoneLabel}作为充能放置。`);
      } else {
        st.trash.unshift(inst);
      }
    } else {
      st.trash.unshift(inst);
    }
  } else if (useMode === 'place') {
    // 规则 0310：エリア配置到没有エリア的フィールド，位置由玩家选择
    const slots = validAreaSlots(next, owner);
    if (slots.length === 0) {
      if (zone === 'deck') st.deck.splice(zoneIdx, 0, inst);
      else st.trash.splice(zoneIdx, 0, inst);
      log(next, `没有可配置エリア的フィールド，「${card.name}」未能配置。`);
      if (prompt.pending) {
        prompt.pending.searchDone = true;
        return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
      }
      return next;
    }
    next.prompt = {
      kind: 'slot-pick',
      owner,
      title: `选择「${card.name}」的配置位置（フィールド）`,
      uid: inst.uid,
      slots,
      purpose: 'areaPlace',
      pending: prompt.pending,
    };
    return next;
  } else if (useMode === 'equip') {
    if (prompt.pending) {
      // 装备目标已在效果链中（后续动作处理目标）→ 记录待装备道具（6887 检索装备）
      next.prompt = {
        kind: 'declare-target',
        uid: prompt.pending.sourceUid,
        tag: '宣言',
        owner,
        actionLabel: `将「${card.name}」装备到哪个味方角色？`,
        candidates: (() => {
          const out: { uid: string; name: string; cardId: string }[] = [];
          for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) {
            const c = next.players[owner].field[r][a];
            if (c && !c.equip) out.push({ uid: c.uid, name: next.cardsById[c.cardId]?.name ?? c.cardId, cardId: c.cardId });
          }
          return out;
        })(),
        pending: { ...prompt.pending, extraUids: [...prompt.pending.extraUids, inst.uid], searchDone: true, searchEquip: { itemUid: inst.uid, free: prompt.free ?? false } },
      };
      return next;
    }
    // 无效果链（罕见）：道具留在原区域，仅提示
    log(next, `「${card.name}」未装备（无效果链上下文），保留在原区域。`);
    return next;
  } else {
    // 登场（slot 已算好）
    inst.tapped = false;
    inst.deployedTurn = next.turn;
    next.players[owner].field[slot!.row === 'AF' ? 0 : 1][slot!.area] = inst;
    log(next, `「${card.name}」从${zoneLabel}免费登场${slot!.row === 'AF' ? '前列' : '后列'}·${['左', '中', '右'][slot!.area]}（本回合不能攻击）。`);
    if (prompt.pending) {
      prompt.pending.searchDone = true;
      return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
    }
    return eng.runDeployChain(next, inst.uid, owner);
  }
  // 其余情况：效果链继续
  if (prompt.pending) {
    prompt.pending.searchDone = true;
    return maybeResumeEndTurn(eng.finalizeActions(next, prompt.pending));
  }
  return next;
}

function deployCharacter(
  gs: GameState,
  p: PlayerIndex,
  uid: string,
  row: RowName,
  area: AreaIndex,
  paid: CardInstance[],
  paidNames = paid.map((c) => cardName(gs, c.uid)).join('、'),
): GameState {
  const hand = gs.players[p].hand;
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx < 0) return gs;
  const inst = hand[idx];
  const card = gs.cardsById[inst.cardId];
  if (!card) return gs;
  // 规则 0810：自己的场已有同编号（忽略字母）角色时不能登场（エンゲージ登场破弃的目标格除外）
  if (card.type === 'character' && sameNumberOnField(gs, p, inst.cardId, fieldCell(gs, p, row, area) && hasEngage(card) ? { row, area } : undefined)) {
    log(gs, `「${card.name}」：自己的场已存在同编号的角色，不能重复登场。`);
    return gs;
  }
  const occupant = fieldCell(gs, p, row, area);
  if (occupant && !hasEngage(card)) {
    log(gs, '登场位置无效。');
    return gs;
  }
  if (!canPlaceAt(gs, p, uid, row, area)) {
    log(gs, '登场位置无效（配置限制）。');
    return gs;
  }
  const moved = gs.players[p].hand.splice(idx, 1)[0];
  // エンゲージ登场：破弃己方场上的角色
  if (occupant) {
    const occEquip = occupant.equip;
    gs.players[p].field[row === 'AF' ? 0 : 1][area] = null;
    occupant.faceUp = true;
    gs.players[p].trash.unshift(occupant);
    if (occEquip) {
      occEquip.faceUp = true;
      gs.players[p].trash.unshift(occEquip);
    }
    gs.lastEngageDiscard = {
      cardId: occupant.cardId,
      dmg: gs.cardsById[occupant.cardId]?.dmg ?? 0,
      name: gs.cardsById[occupant.cardId]?.name ?? occupant.cardId,
    };
    moved.pendingEngage = { discardedUid: occupant.uid };
    log(gs, `玩家 ${p + 1} エンゲージ登场「${card.name}」：破弃己方「${gs.cardsById[occupant.cardId]?.name ?? '?'}」${paid.length ? `（费用：破弃 ${paidNames}）` : ''}。`);
    // 被破弃角色的ペナルティ / 装备道具离场
    gs = eng.runPenaltyChain(gs, p, occupant.uid);
    if (occEquip) gs = eng.continueTriggerChain(gs, 'itemLeaves', p, occEquip.uid);
  } else {
    log(gs, `玩家 ${p + 1} 登场「${card.name}」${row === 'AF' ? '前列' : '后列'}·${['左', '中', '右'][area]}${paid.length ? `（费用：破弃 ${paidNames}）` : ''}（本回合不能攻击）。`);
  }
  moved.faceUp = true;
  moved.tapped = false;
  moved.deployedTurn = gs.turn;
  gs.players[p].field[row === 'AF' ? 0 : 1][area] = moved;
  pushVoice(gs, p, 'deploy'); // 语音：角色登场
  // 登场流程：充能 + 回合回复 + エンゲージ结算 + 登场诱発（效果引擎）
  return eng.runDeployChain(gs, uid, p);
}

function playEventNow(gs: GameState, p: PlayerIndex, uid: string, paid: CardInstance[], paidNames = paid.map((c) => cardName(gs, c.uid)).join('、')): GameState {
  const hand = gs.players[p].hand;
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx < 0) return gs;
  const inst = hand[idx];
  const card = gs.cardsById[inst.cardId];
  if (!card) return gs;
  const moved = gs.players[p].hand.splice(idx, 1)[0];
  moved.faceUp = true;
  gs.players[p].trash.unshift(moved);
  log(gs, `玩家 ${p + 1} 使用事件「${card.name}」${paid.length ? `（费用：破弃 ${paidNames}）` : ''}。`);
  // 事件效果（效果引擎解析执行；未解析部分弹手动面板）
  return eng.runEventChain(gs, p, moved.uid);
}

function equipNow(gs: GameState, p: PlayerIndex, itemUid: string, charUid: string, paid: CardInstance[], paidNames = paid.map((c) => cardName(gs, c.uid)).join('、')): GameState {
  const hand = gs.players[p].hand;
  const idx = hand.findIndex((c) => c.uid === itemUid);
  if (idx < 0) return gs;
  const inst = hand[idx];
  const card = gs.cardsById[inst.cardId];
  const charInst = findInst(gs, charUid);
  if (!card || !charInst || charInst.equip) return gs;
  // 装备限制：元のＤＭＧが３以下のキャラ
  if (/元のＤＭＧが３以下のキャラ/.test(card.ability ?? '')) {
    const baseDmg = gs.cardsById[charInst.cardId]?.dmg ?? 0;
    if (baseDmg > 3) {
      log(gs, `「${card.name}」只能装备给原 DMG≤3 的角色。`);
      return gs;
    }
  }
  const moved = gs.players[p].hand.splice(idx, 1)[0];
  moved.faceUp = true;
  charInst.equip = moved;
  pushVoice(gs, p, 'equip'); // 语音：道具装备
  log(gs, `玩家 ${p + 1} 将「${card.name}」装备到「${cardName(gs, charUid)}」${paid.length ? `（费用：破弃 ${paidNames}）` : ''}。`);
  return eng.runEquipChain(gs, p, moved.uid);
}

function findLoc(
  gs: GameState,
  uid: string,
): { player: PlayerIndex; zone: string; row?: RowName; area?: AreaIndex; inst: CardInstance } | null {
  for (const p of [0, 1] as PlayerIndex[]) {
    const st = gs.players[p];
    const zones = st as unknown as Record<string, CardInstance[]>;
    for (const z of ['deck', 'hand', 'trash', 'shield', 'special', 'removed']) {
      const idx = zones[z].findIndex((c) => c.uid === uid);
      if (idx >= 0) return { player: p, zone: z, inst: zones[z][idx] };
    }
    for (let r = 0; r < 2; r++) {
      for (let a = 0; a < 3; a++) {
        if (st.field[r][a]?.uid === uid)
          return { player: p, zone: 'field', row: r === 0 ? 'AF' : 'DF', area: a as AreaIndex, inst: st.field[r][a]! };
        if (st.field[r][a]?.equip?.uid === uid)
          return { player: p, zone: 'equip', row: r === 0 ? 'AF' : 'DF', area: a as AreaIndex, inst: st.field[r][a]!.equip! };
        if (st.fieldAreas[r][a]?.uid === uid)
          return { player: p, zone: 'area', row: r === 0 ? 'AF' : 'DF', area: a as AreaIndex, inst: st.fieldAreas[r][a]! };
      }
    }
  }
  return null;
}

/* ================= 战斗 ================= */

/** 角色能否攻击：己方 AF、未行动、无登场回合限制（アグレッシブ可无视） */
export function canAttack(gs: GameState, uid: string): boolean {
  if (gs.phase !== 'main' || gs.battle) return false;
  const loc = findLoc(gs, uid);
  if (!loc || loc.zone !== 'field' || loc.row !== 'AF') return false;
  if (loc.player !== gs.turnPlayer) return false;
  const inst = findInst(gs, uid);
  if (!inst || inst.tapped) return false;
  // 登场ターン制限：登场后到下一个自ターン开始前（跨对手回合），不能攻击（アグレッシブ可无视）
  if (inst.deployedTurn !== null && !eng.hasAggressive(gs, uid)) return false;
  // エリア限制：登场回合角色不能造成伤害
  if (inst.deployedTurn !== null && eng.blocksFirstTurnDamage(gs, gs.turnPlayer)) return false;
  return true;
}

/** 攻击宣言 → 支援选择 → 防御选择 */
export function declareAttack(gs: GameState, uid: string): GameState {
  const next = clone(gs);
  if (gs.phase !== 'main' || gs.battle) return gs;
  const loc = findLoc(next, uid);
  if (!loc || loc.zone !== 'field' || loc.row !== 'AF' || loc.player !== gs.turnPlayer) return gs;
  const inst = findInst(next, uid);
  if (!inst || inst.tapped) return gs;
  if (inst.deployedTurn !== null && !eng.hasAggressive(next, uid)) {
    log(next, '本回合登场的角色不能攻击（登场ターン制限）。');
    return next;
  }
  if (inst.deployedTurn === gs.turn && eng.blocksFirstTurnDamage(next, gs.turnPlayer)) {
    log(next, 'エリア效果：登场回合的角色不能造成伤害。');
    return next;
  }
  inst.tapped = true;
  pushVoice(next, gs.turnPlayer, 'attack'); // 语音：攻击宣言
  log(next, `玩家 ${gs.turnPlayer + 1} 攻击宣言：「${cardName(next, uid)}」攻击${['左', '中', '右'][loc.area!]}列。`);
  return openResponse(next, gs.turnPlayer, `攻击宣言「${cardName(next, uid)}」`, 'attack', { action: 'attack', uid });
}

/** 选择支援角色（旧流程保留，战斗支援已移入バトル中宣言タイミング） */
export function chooseSupport(gs: GameState, supporterUid: string | null): GameState {
  return gs;
}

/** 进入防御选择提示（含强制防御指定 6857） */
function openDefensePrompt(gs: GameState): GameState {
  const next = clone(gs);
  if (!next.battle) return next;
  const aInst = findInst(next, next.battle.attackerUid);
  const fd = aInst?.tempForceDefend;
  const defender = (1 - next.battle.attackerPlayer) as PlayerIndex;
  if (fd && fd.turn === next.turn) {
    const fLoc = fd.targetUid ? findLoc(next, fd.targetUid) : null;
    if (fLoc && fLoc.zone === 'field' && fLoc.player === defender) {
      const fInst = findInst(next, fd.targetUid)!;
      fInst.tapped = true;
      next.battle.defenderUid = fd.targetUid;
      log(next, `强制防御：玩家 ${defender + 1} 必须用「${cardName(next, fd.targetUid)}」防御（行动済み或AF也可防御）。`);
      return openBattleTiming(next, next.battle.attackerPlayer);
    }
  }
  const area = findLoc(next, next.battle.attackerUid)?.area ?? 0;
  const candidates: { uid: string; name: string }[] = [];
  const dChar = next.players[defender].field[1][area];
  if (dChar && !dChar.tapped) candidates.push({ uid: dChar.uid, name: cardName(next, dChar.uid) });
  next.prompt = { kind: 'defense', attackerUid: next.battle.attackerUid, attackerName: cardName(next, next.battle.attackerUid), candidates };
  return next;
}

/** 选择防御者（uid=null 表示不防御）→ 指定后进入バトル中宣言タイミング */
export function chooseDefense(gs: GameState, defenderUid: string | null): GameState {
  const next = clone(gs);
  if (next.prompt?.kind !== 'defense') return gs;
  if (!next.battle) return gs;
  next.prompt = null;
  if (defenderUid) {
    const inst = findInst(next, defenderUid);
    if (!inst) return gs;
    inst.tapped = true;
    next.battle.defenderUid = defenderUid;
    pushVoice(next, (1 - next.battle.attackerPlayer) as PlayerIndex, 'defense'); // 语音：防御
    log(next, `玩家 ${(1 - next.battle.attackerPlayer) + 1} 以「${cardName(next, defenderUid)}」防御。`);
  } else {
    log(next, '不防御：バトル結果将对牌堆造成伤害。');
  }
  return openBattleTiming(next, next.battle.attackerPlayer);
}

/** 交战判定与处理（含ボーナス/ペナルティ/倒下诱発/防御角色离场诱発） */
function resolveBattle(gs: GameState): GameState {
  if (!gs.battle) return gs;
  // 结算开始即标记不活跃：中途触发离场/倒下诱発提示时，不再重开战斗时点
  gs.battle.active = false;
  const aUid = gs.battle.attackerUid;
  const dUid = gs.battle.defenderUid;
  // バトル中断：无防御 → 直接牌堆伤害；参战角色离场 → 中断
  if (!dUid) {
    return deckDamageStep(gs);
  }
  const aInst = findInst(gs, aUid);
  const dInst = dUid ? findInst(gs, dUid) : null;
  if (!aInst || !dInst) {
    log(gs, 'バトル中断：参战角色已离场。');
    gs.battle = null;
    return gs;
  }
  const aCard = gs.cardsById[aInst.cardId];
  const dCard = gs.cardsById[dInst.cardId];
  // 使用含常时加成的有效数值
  const aEff = effectiveStats(gs, aUid);
  const dEff = effectiveStats(gs, dUid as string);
  const attAP = aEff.ap, attDP = aEff.dp, defAP = dEff.ap, defDP = dEff.dp;
  // 攻击方 AP vs 防御方 DP → 防御方被打倒；防御方 AP vs 攻击方 DP → 攻击方被打倒
  const defenderDown = attAP > defDP;
  const attackerDown = defAP > attDP;
  log(gs, `判定：攻击方 AP ${attAP} vs 防御方 DP ${defDP}${defenderDown ? ' → 防御方被打倒' : ''}；防御方 AP ${defAP} vs 攻击方 DP ${attDP}${attackerDown ? ' → 攻击方被打倒' : ''}。`);
  const aLoc = findLoc(gs, aUid);
  const dLoc = dUid ? findLoc(gs, dUid) : null;
  const attOwner = gs.battle.attackerPlayer;
  const defOwner = (1 - attOwner) as PlayerIndex;
  if (defenderDown && dLoc && dLoc.zone === 'field') {
    const eqUid = gs.players[defOwner].field[dLoc.row === 'AF' ? 0 : 1][dLoc.area!]?.equip?.uid ?? null;
    discardFromField(gs, dLoc.player, dLoc.row!, dLoc.area!);
    log(gs, `「${dCard.name}」被打倒，进入ゴミ箱。`);
    gs = eng.runPenaltyChain(gs, defOwner, dUid as string);
    gs = eng.runDownChain(gs, defOwner, dUid as string);
    if (eqUid) gs = eng.continueTriggerChain(gs, 'itemLeaves', defOwner, eqUid);
    // 6963：对方バトル参加キャラ离场 → 攻击方エリア诱発；味方乙女こころ离场 → 防御方エリア诱発
    gs.lastAreaEvent = { kind: 'oppBattleCharLeft', owner: attOwner };
    const dFull = `${dCard.abilityName ?? ''}${dCard.name ?? ''}`.replace(/\s/g, '');
    if (dFull.includes('理想の恋愛に憧れる乙女')) gs.lastAreaEvent = { kind: 'friendlyNamedLeft', owner: defOwner, name: dFull };
  }
  if (attackerDown && aLoc && aLoc.zone === 'field') {
    const eqUid2 = gs.players[attOwner].field[aLoc.row === 'AF' ? 0 : 1][aLoc.area!]?.equip?.uid ?? null;
    discardFromField(gs, aLoc.player, aLoc.row!, aLoc.area!);
    log(gs, `「${aCard.name}」被打倒，进入ゴミ箱。`);
    gs = eng.runPenaltyChain(gs, attOwner, aUid);
    gs = eng.runDownChain(gs, attOwner, aUid);
    if (eqUid2) gs = eng.continueTriggerChain(gs, 'itemLeaves', attOwner, eqUid2);
    // 6963：对方バトル参加キャラ离场 → 防御方エリア诱発；味方乙女こころ离场 → 攻击方エリア诱発
    gs.lastAreaEvent = { kind: 'oppBattleCharLeft', owner: defOwner };
    const aFull = `${aCard.abilityName ?? ''}${aCard.name ?? ''}`.replace(/\s/g, '');
    if (aFull.includes('理想の恋愛に憧れる乙女')) gs.lastAreaEvent = { kind: 'friendlyNamedLeft', owner: attOwner, name: aFull };
  }
  if (gs.prompt) return gs; // 离场/倒下诱発需要选择 → 先处理（支援/奖励等后置）
  const attackerAlive = findLoc(gs, aUid)?.zone === 'field';
  // 规则：支援修正只持续到バトル終了時
  const battleRec = gs.battle;
  if (battleRec && attackerAlive && battleRec.supportAP > 0) {
    const a = findInst(gs, aUid);
    if (a) a.tempMods.ap -= battleRec.supportAP;
  }
  if (battleRec && dUid && findLoc(gs, dUid)?.zone === 'field' && battleRec.supportDP > 0) {
    const d = findInst(gs, dUid);
    if (d) d.tempMods.dp -= battleRec.supportDP;
  }
  gs.battle = null;
  if (defenderDown) {
    if (attackerAlive) {
      gs = eng.runBonusChain(gs, attOwner, aUid);
    }
    gs = eng.runDefenderLeavesChain(gs, attOwner);
  }
  if (gs.prompt) return gs;
  return gs;
}

/** 无防御：牌堆伤害（DMG），护盾可选替代 */
function deckDamageStep(gs: GameState): GameState {
  if (!gs.battle) return gs;
  const aUid = gs.battle.attackerUid;
  const aInst = findInst(gs, aUid);
  const defender = (1 - gs.battle.attackerPlayer) as PlayerIndex;
  const dmg = aInst ? effectiveStats(gs, aUid).dmg : 0;
  const shieldCount = gs.players[defender].shield.length;
  if (dmg <= 0) {
    log(gs, `攻击方 DMG 为 0，无牌堆伤害。`);
    gs.battle = null;
    return gs;
  }
  log(gs, `攻击方 DMG ${dmg}：防御方牌堆将受到 ${dmg} 点伤害。`);
  if (shieldCount > 0) {
    gs.prompt = { kind: 'shield', attackerUid: aUid, dmg, shieldCount };
  } else {
    gs = applyDeckDamage(gs, defender, dmg, false);
  }
  return gs;
}

/** 选择是否用护盾 */
export function chooseShield(gs: GameState, useShield: boolean): GameState {
  let next = clone(gs);
  if (next.prompt?.kind !== 'shield') return gs;
  if (!next.battle) return gs;
  const defender = (1 - next.battle.attackerPlayer) as PlayerIndex;
  const attackerUid = next.battle.attackerUid;
  const attOwner = next.battle.attackerPlayer;
  const { dmg } = next.prompt;
  next.prompt = null;
  next = applyDeckDamage(next, defender, dmg, useShield);
  // 用护盾抵挡（无牌堆伤害）→ 直接处理被支援角色造成伤害诱発；未用护盾 → 掉血弹窗确认后再处理
  if (useShield) {
    next = eng.runDealtDamageChain(next, attOwner, attackerUid);
  }
  return next;
}

function applyDeckDamage(gs: GameState, defender: PlayerIndex, dmg: number, useShield: boolean): GameState {
  const st = gs.players[defender];
  const attOwner = gs.battle?.attackerPlayer ?? ((1 - defender) as PlayerIndex);
  const attackerUid = gs.battle?.attackerUid ?? '';
  if (useShield && st.shield.length > 0) {
    const s = st.shield.shift()!;
    st.trash.unshift(s);
    log(gs, `玩家 ${defender + 1} 用护盾抵挡伤害（护盾进入ゴミ箱）。`);
  } else {
    const count = Math.min(dmg, st.deck.length);
    for (let i = 0; i < count; i++) {
      const top = st.deck.pop()!;
      top.faceUp = true;
      st.trash.unshift(top);
    }
    log(gs, `玩家 ${defender + 1} 牌堆受到 ${count} 点伤害（破弃 ${count} 张）。`);
    if (count > 0) pushVoice(gs, defender, 'damage'); // 语音：受伤（真的掉到血才播）
    // 掉血弹窗提示（Bug ③）：确认后再继续（含被支援角色造成伤害诱発）
    gs.prompt = { kind: 'damage', defender, dmg, broken: count, attackerUid, attOwner };
  }
  if (gs.battle) gs.battle = null;
  checkDeckZero(gs, defender);
  return gs;
}

/** 确认“掉血”弹窗，继续后续流程 */
export function confirmDamage(gs: GameState): GameState {
  const next = clone(gs);
  if (next.prompt?.kind !== 'damage') return gs;
  const { attackerUid, attOwner } = next.prompt;
  next.prompt = null;
  if (next.phase === 'gameover') return next;
  // 被支援角色造成伤害诱発
  if (attackerUid) return eng.runDealtDamageChain(next, attOwner, attackerUid);
  return next;
}

/** 从场上破弃角色（连带装备进ゴミ箱） */
function discardFromField(gs: GameState, player: PlayerIndex, row: RowName, area: AreaIndex): void {
  const st = gs.players[player];
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

/** 牌堆归零 → 对方胜利 */
function checkDeckZero(gs: GameState, player: PlayerIndex): void {
  if (gs.players[player].deck.length === 0) {
    const winner = (1 - player) as PlayerIndex;
    gs.winner = winner;
    gs.phase = 'gameover';
    gs.battle = null;
    gs.prompt = { kind: 'gameover', winner };
    log(gs, `玩家 ${player + 1} 牌堆归零！玩家 ${winner + 1} 获胜！`);
  }
}

/* ================= 対応系统与时点（0602/0850 判例 + 规则书） ================= */

/** 卡片效果是否写有「相手はこの宣言に対応して宣言できない」 */
function hasResponseBlock(gs: GameState, cardId: string): boolean {
  const card = gs.cardsById[cardId];
  return !!card && formatAbilityText(card.ability ?? '').includes('相手はこの宣言に対応して宣言できない');
}

function pendCardUid(pend: PendingAction): string | null {
  switch (pend.action) {
    case 'deploy':
    case 'event':
    case 'area':
    case 'attack':
    case 'declare':
    case 'move':
    case 'searchDeployPay':
      return pend.uid;
    case 'equip':
      return pend.itemUid;
    default:
      return null;
  }
}

function responseItemCard(gs: GameState, item: ResponseItem): string | null {
  if (item.pend) {
    // pend 里存的是实例 uid，需要解析成卡号（修复：登场/事件/装备等宣言不显示卡图）
    const uid = pendCardUid(item.pend);
    if (!uid) return null;
    const inst = findInst(gs, uid);
    return inst ? (gs.cardsById[inst.cardId]?.id ?? null) : null;
  }
  if (item.eff) {
    const inst = findInst(gs, item.eff.sourceUid);
    return inst ? gs.cardsById[inst.cardId]?.id ?? null : null;
  }
  return null;
}

/** 时点上下文（窗口过滤用） */
interface TimingCtx {
  inBattle: boolean;
  hasDefender: boolean;
  isResponse: boolean;
  ownTurn: boolean;
}

/** 卡牌时点条件是否满足当前窗口 */
function timingOk(t: { response: boolean; battle: string; noDefender: boolean; turn: string; notDeployTurn?: boolean }, ctx: TimingCtx): boolean {
  if (ctx.isResponse && !t.response) return false;
  if (t.battle === 'only' && !ctx.inBattle) return false;
  if (t.battle === 'no' && ctx.inBattle) return false;
  if (t.noDefender && ctx.hasDefender) return false;
  if (t.noDefender && !ctx.inBattle) return false;
  if (t.turn === 'self' && !ctx.ownTurn) return false;
  if (t.turn === 'opponent' && ctx.ownTurn) return false;
  return true;
}

/** 取一张卡首个手札宣言/宣言块的时点 */
function cardTiming(gs: GameState, cardId: string, tag: '手札宣言' | '宣言' | 'event'): { response: boolean; battle: string; noDefender: boolean; turn: string; notDeployTurn?: boolean } {
  const card = gs.cardsById[cardId];
  if (!card) return { response: true, battle: 'any', noDefender: false, turn: 'any' };
  if (tag === 'event') return parseTiming(formatAbilityText(card.ability ?? ''));
  const d = getParsed(card).declared.find((x) => x.tag === tag);
  return d ? d.timing : { response: true, battle: 'any', noDefender: false, turn: 'any' };
}

/** 行动者可用的事件/手札宣言/场宣言选项（按卡面时点过滤；供対応/战斗时点/回合结束窗口用） */
function buildDeclareOptions(gs: GameState, player: PlayerIndex, ctx: TimingCtx, includeSupport: boolean, battleUid?: string): { id: string; label: string; cardId?: string }[] {
  const out: { id: string; label: string; cardId?: string }[] = [];
  const st = gs.players[player];
  const push = (id: string, label: string, cardId: string, tag: '手札宣言' | '宣言' | 'event', inst?: CardInstance) => {
    const timing = cardTiming(gs, cardId, tag);
    // 配置ターン中を除く：配置回合不能使用该宣言（Bug 4）
    if (timing.notDeployTurn && inst && inst.deployedTurn === gs.turn) return;
    if (timingOk(timing, ctx)) out.push({ id, label, cardId });
  };
  for (const c of st.hand) {
    const card = gs.cardsById[c.cardId];
    if (card && card.type === 'event') push(`evt:${c.uid}`, `事件「${card.name}」`, card.id, 'event');
  }
  for (const c of st.hand) {
    const card = gs.cardsById[c.cardId];
    if (card && hasHandDeclare(card)) push(`hd:${c.uid}`, `手札宣言「${card.name}」`, card.id, '手札宣言');
  }
  // サプライズ：登场宣言可像事件一样在バトル中/对方回合/対応时点进行
  for (const c of st.hand) {
    const card = gs.cardsById[c.cardId];
    if (card && (card.basicAbilities ?? '').includes('サプライズ')) {
      out.push({ id: `sdp:${c.uid}`, label: `サプライズ登场「${card.name}」`, cardId: card.id });
    }
  }
  for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) {
    const cell = gs.players[player].field[r][a];
    if (!cell) continue;
    const card = gs.cardsById[cell.cardId];
    if (card && hasDeclare(card)) push(`fd:${cell.uid}`, `宣言「${card.name}」`, card.id, '宣言', cell);
    if (cell.equip) {
      const eq = gs.cardsById[cell.equip.cardId];
      if (eq && hasDeclare(eq)) push(`fd:${cell.equip.uid}`, `道具宣言「${eq.name}」`, eq.id, '宣言', cell);
    }
  }
  for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) {
    const ar = gs.players[player].fieldAreas[r][a];
    if (!ar) continue;
    const card = gs.cardsById[ar.cardId];
    if (card && hasDeclare(card)) push(`fd:${ar.uid}`, `エリア宣言「${card.name}」`, card.id, '宣言', ar);
  }
  if (includeSupport && battleUid) {
    const bLoc = findLoc(gs, battleUid);
    if (bLoc && bLoc.player === player) {
      const area = bLoc.area ?? 0;
      const isAF = bLoc.row === 'AF';
      // 6962 常时「相手ターン中」：仅当己方在对方回合支援（防御）时可支援非相邻角色
      const anyRange = eng.playerSupportAnyRange(gs, player) && player !== gs.turnPlayer;
      const ban0Cost = eng.playerBanZeroCostSupporter(gs, player); // 6962 常时：禁止 0 费サポーター
      for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) {
        const c = gs.players[player].field[r][a];
        if (!c || c.uid === battleUid) continue;
        const adjacent = isAF ? (r === 1 && a === area) || (r === 0 && (a === area - 1 || a === area + 1)) : (r === 0 && a === area) || (r === 1 && (a === area - 1 || a === area + 1));
        // 6962 常时：相手ターン中可支援非相邻角色；否则仅相邻可支援
        if (!anyRange && !adjacent) continue;
        const cCard = gs.cardsById[c.cardId];
        if (!cCard) continue;
        const sp = eng.effectiveStats(gs, c.uid).sp;
        const hasSupporter = (cCard.basicAbilities ?? '').includes('サポーター');
        const cost = hasSupporter ? (parseBasicAbilities(cCard.basicAbilities ?? '').find((x) => x.tag === 'サポーター')?.value ?? '') : '';
        // 6962 常时：不能宣言费用 0 点以下的[サポーター]
        const ban0 = ban0Cost && hasSupporter && (cost === '' || cost === '0');
        // SP 0 也可以宣言支援（Bug 11：不因 SP=0 过滤掉选项）
        // ① 支援（需未行动；支援后行动済み）
        if (!c.tapped) {
          out.push({ id: `sup:${c.uid}`, label: `支援「${cCard.name}」（SP ${sp}）`, cardId: cCard.id });
        }
        // ② [サポーター]（需未行动；支付费用代替行动済み；基本能力一回合一次）
        if (hasSupporter && cost && !c.tapped && !ban0) {
          const key = `supporter:${c.uid}:${gs.turn}`;
          const used = (gs.players[player].perTurn[key] ?? 0) >= 1;
          if (!used) out.push({ id: `supC:${c.uid}`, label: `サポーター「${cCard.name}」（费用[${cost}]）`, cardId: cCard.id });
        }
      }
    }
  }
  return out;
}

/** 宣言入栈并打开对应窗口（0602 判例）；対応禁止则直接结算 */
export function openResponse(gs: GameState, owner: PlayerIndex, label: string, kind: ResponseItem['kind'], pend?: PendingAction, eff?: PendingEffect): GameState {
  const next = clone(gs);
  const item: ResponseItem = { owner, label, kind, pend, eff };
  const cardId = responseItemCard(next, item);
  if (cardId && hasResponseBlock(next, cardId)) {
    log(next, `「${label}」対応禁止：对手无法对应宣言，直接结算。`);
    next.response = { stack: [item], awaiting: (1 - owner) as PlayerIndex };
    return resolveResponse(next);
  }
  if (!next.response) next.response = { stack: [], awaiting: (1 - owner) as PlayerIndex };
  next.response.stack.push(item);
  return openResponsePrompt(next, (1 - owner) as PlayerIndex);
}

/** 重新打开对应窗口（取消/回退时恢复；不新推入宣言） */
function openResponsePrompt(gs: GameState, awaiting: PlayerIndex): GameState {
  if (!gs.response) return gs;
  gs.response.awaiting = awaiting;
  const top = gs.response.stack[gs.response.stack.length - 1];
  // 宣言/手札宣言：解析出具体效果（哪一条能力）
  let effectLabel: string | null = null;
  if (top && top.kind === 'declare' && top.eff && top.eff.declIdx >= 0) {
    const src = top.eff.sourceUid ? findInst(gs, top.eff.sourceUid) : null;
    const card = src ? gs.cardsById[src.cardId] : undefined;
    if (card) {
      const parsed = eng.getParsed(card);
      const clause = parsed.declared[top.eff.declIdx];
      if (clause) {
        const opt = clause.options.find((o) => o.id === (top.eff?.optionId ?? ''));
        effectLabel = opt ? opt.label : clause.options.map((o) => o.label).join(' / ');
      }
    }
  }
  gs.prompt = {
    kind: 'response',
    owner: awaiting,
    title: `${top?.label ?? ''}：对方可以对应宣言（或放弃后倒序结算）`,
    cardId: top ? (responseItemCard(gs, top) ?? undefined) : undefined,
    effectLabel: effectLabel ?? undefined,
    options: [
      { id: 'pass', label: '放弃（倒序结算）' },
      ...buildDeclareOptions(gs, awaiting, { inBattle: false, hasDefender: false, isResponse: true, ownTurn: awaiting === gs.turnPlayer }, false),
    ],
  };
  return gs;
}

/** 倒序（后发先至）结算对应栈：pop 最后一条并执行；若产生提示则停下 */
export function resolveResponse(gs: GameState): GameState {
  let next = gs;
  while (next.response && next.response.stack.length > 0) {
    const item = next.response.stack.pop()!;
    let r: GameState = next;
    if (item.kind === 'deploy' && item.pend?.action === 'deploy') r = deployCharacter(next, item.owner, item.pend.uid, item.pend.row, item.pend.area, []);
    else if (item.kind === 'event' && item.pend?.action === 'event') r = playEventNow(next, item.owner, item.pend.uid, []);
    else if (item.kind === 'area' && item.pend?.action === 'area') {
      const st = next.players[item.owner];
      const uid = item.pend.uid;
      const idx = st.hand.findIndex((c) => c.uid === uid);
      if (idx >= 0) {
        // 配置到选中的フィールド（规则 0310；无位置时放第一个空位）
        let rr: RowName = item.pend.row ?? 'AF';
        let aa: AreaIndex = item.pend.area ?? 0;
        if (item.pend.row === undefined || item.pend.area === undefined) {
          const s = validAreaSlots(next, item.owner)[0];
          if (!s) {
            log(next, '没有可配置エリア的フィールド，配置失败。');
            r = next;
          } else {
            rr = s.row;
            aa = s.area;
          }
        }
        const moved = st.hand.splice(idx, 1)[0];
        moved.faceUp = true;
        moved.deployedTurn = next.turn;
        st.fieldAreas[rr === 'AF' ? 0 : 1][aa] = moved;
        log(next, `玩家 ${item.owner + 1} 配置エリア「${next.cardsById[moved.cardId]?.name ?? ''}」到${rr === 'AF' ? '前列' : '后列'}·${['左', '中', '右'][aa]}。`);
        r = eng.runAreaDeployChain(next, item.owner, moved.uid);
      }
    } else if (item.kind === 'equip' && item.pend?.action === 'equip') r = equipNow(next, item.owner, item.pend.itemUid, item.pend.charUid, []);
    else if (item.kind === 'attack' && item.pend?.action === 'attack') r = beginBattleFromAttack(next, item.owner, item.pend.uid);
    else if (item.kind === 'move' && item.pend?.action === 'move') r = resolveMove(next, item.pend);
    else if (item.kind === 'declare' && item.eff) r = eng.finalizeActions(next, item.eff);
    next = r;
    if (next.prompt || next.battle && !next.response) {
      // 效果结算产生了新提示（如检索/选卡/诱发），或战斗已开始
      if (next.prompt) return next;
    }
  }
  if (next.response && next.response.stack.length === 0) next.response = null;
  next.prompt = null;
  // 对应链结算完后若战斗仍在进行（如サプライズ登场后）→ 恢复战斗时点（轮到对方）
  if (next.battle && next.battle.active && next.phase === 'main') {
    return openBattleTiming(next, (1 - next.battle.timingActor) as PlayerIndex);
  }
  return next;
}

/** 攻击宣言结算后开始战斗：防御指定 → バトル中宣言タイミング */
function beginBattleFromAttack(gs: GameState, owner: PlayerIndex, uid: string): GameState {
  gs.battle = { attackerUid: uid, attackerPlayer: owner, defenderUid: null, active: true, supportAP: 0, supportDP: 0, timingActor: owner, lastPass: false, lastSupport: null };
  log(gs, `攻击宣言结算：バトル开始！`);
  return openDefensePrompt(gs);
}

/** 対応窗口：放弃（倒序结算）或选择行动 */
export function respond(gs: GameState, optId: string): GameState {
  const next = clone(gs);
  const prompt = next.prompt;
  if (!prompt || prompt.kind !== 'response' || !next.response) return gs;
  next.prompt = null;
  const owner = next.response.awaiting;
  if (optId === 'pass') {
    log(next, `玩家 ${owner + 1} 放弃对应，对应链倒序结算（后发先至）。`);
    return resolveResponse(next);
  }
  pushVoice(next, owner, 'respond'); // 语音：对应宣言（放弃对应不算）
  return startWindowAction(next, owner, optId, true);
}

/** 执行窗口行动（対応/战斗时点/回合结束转移共用；isResponse=true 时宣言入栈待倒序结算） */
function startWindowAction(gs: GameState, owner: PlayerIndex, optId: string, isResponse: boolean): GameState {
  const [kind, uid] = optId.split(':');
  if (kind === 'evt') {
    const next = clone(gs);
    const hand = next.players[owner].hand;
    const idx = hand.findIndex((c) => c.uid === uid);
    if (idx < 0) return next;
    const inst = hand[idx];
    const card = next.cardsById[inst.cardId];
    if (!card || card.type !== 'event') return next;
    // 窗口时点校验（Bug ③）：直发事件也要符合卡面时机（如対応できない事件不能在対応中发）
    const evTiming = cardTiming(next, card.id, 'event');
    if (!timingOk(evTiming, { inBattle: !!(next.battle && next.battle.active), hasDefender: !!next.battle?.defenderUid, isResponse, ownTurn: owner === next.turnPlayer })) {
      log(next, `「${card.name}」无法在当前时点使用（卡面时点限制）。`);
      return next;
    }
    const restCost = poolAdjustedCost(next, owner, card.cost, { kind: 'event', card });
    if (restCost && !canPayCost(next, owner, restCost, uid) && !canCostPoolCover(next, owner, restCost, { kind: 'event', card })) {
      log(next, `费用不足：无法使用「${card.name}」。`);
      return next;
    }
    if (!restCost) {
      if (isResponse) return openResponse(next, owner, `事件「${card.name}」`, 'event', { action: 'event', uid });
      const r = playEventNow(next, owner, uid, []);
      return finishPrompt(r);
    }
    next.prompt = {
      kind: 'cost-pay',
      cost: restCost,
      actionLabel: `使用事件「${card.name}」（対応/时点）`,
      owner,
      pending: { action: 'event', uid },
      candidates: hand.filter((c) => c.uid !== uid).map((c) => ({
        uid: c.uid,
        name: next.cardsById[c.cardId]?.name ?? c.cardId,
        elements: next.cardsById[c.cardId]?.elements ?? '',
        ex: next.cardsById[c.cardId]?.ex ?? 0,
        cardId: c.cardId,
      })),
    };
    return next;
  }
  if (kind === 'hd') {
    const loc = findLoc(gs, uid);
    if (!loc || loc.zone !== 'hand') return gs;
    const card = gs.cardsById[loc.inst.cardId];
    if (!card || !hasHandDeclare(card)) return gs;
    return openDeclared(gs, loc.player, uid, '手札宣言', { inBattle: !!(gs.battle && gs.battle.active), hasDefender: !!gs.battle?.defenderUid, isResponse, ownTurn: owner === gs.turnPlayer });
  }
  if (kind === 'fd') {
    const loc = findLoc(gs, uid);
    if (!loc || (loc.zone !== 'field' && loc.zone !== 'special' && loc.zone !== 'equip' && loc.zone !== 'area')) return gs;
    const card = gs.cardsById[loc.inst.cardId];
    if (!card || !hasDeclare(card)) return gs;
    return openDeclared(gs, loc.player, uid, '宣言', { inBattle: !!(gs.battle && gs.battle.active), hasDefender: !!gs.battle?.defenderUid, isResponse, ownTurn: owner === gs.turnPlayer });
  }
  if (kind === 'sup' && isResponse === false) {
    return doSupportInBattle(gs, owner, uid, false);
  }
  if (kind === 'supC' && isResponse === false) {
    // [サポーター]：支付费用代替行动済み的支援
    return doSupportInBattle(gs, owner, uid, true);
  }
  if (kind === 'sdp') {
    // サプライズ登场（対応时点 / 结束转移自由时点）
    const next = clone(gs);
    return requestSurpriseDeploy(next, uid, owner);
  }
  return gs;
}

/** 提示结算后的统一收尾：对应栈继续倒序 + 回合结束恢复 + 战斗时点恢复（Bug 16：行动后时点交给对方） */
function finishPrompt(gs: GameState): GameState {
  let n = maybeResumeEndTurn(gs);
  if (n.battle && n.battle.active && !n.prompt && n.phase === 'main') {
    n = openBattleTiming(n, (1 - n.battle.timingActor) as PlayerIndex);
  }
  return n;
}

/* ================= バトル中宣言タイミング（0850 判例） ================= */

/** 打开バトル中宣言タイミング窗口 */
export function openBattleTiming(gs: GameState, player: PlayerIndex): GameState {
  const next = clone(gs);
  if (!next.battle) return next;
  next.battle.timingActor = player;
  const target = player === next.battle.attackerPlayer ? next.battle.attackerUid : (next.battle.defenderUid ?? '');
  next.prompt = {
    kind: 'battle-timing',
    owner: player,
    attackerUid: next.battle.attackerUid,
    defenderUid: next.battle.defenderUid,
    options: [
      { id: 'end', label: '结束宣言时机（轮到对方）' },
      ...buildDeclareOptions(next, player, { inBattle: true, hasDefender: !!next.battle.defenderUid, isResponse: false, ownTurn: player === next.turnPlayer }, true, target || undefined),
    ],
  };
  return next;
}

/** バトル中宣言タイミング行动 */
export function battleTimingAction(gs: GameState, optId: string): GameState {
  let next = clone(gs);
  const prompt = next.prompt;
  if (!prompt || prompt.kind !== 'battle-timing' || !next.battle) return gs;
  next.prompt = null;
  const player = prompt.owner;
  if (optId === 'end') {
    // 双方连续放弃才结算战斗（Bug 16）
    if (next.battle.lastPass) {
      log(next, '双方放弃宣言时机，进行バトル結果。');
      // 战斗结果判定必须是最后一步：先按后发先至结算完对应链，再判定攻防与结果
      if (next.response && next.response.stack.length > 0) {
        const rr = resolveResponse(next);
        if (rr.prompt) return finishPrompt(rr);
        next = rr;
      }
      return resolveBattle(next);
    }
    next.battle.lastPass = true;
    return openBattleTiming(next, (1 - player) as PlayerIndex);
  }
  if (optId.startsWith('sdp:')) {
    // サプライズ登场（バトル中时点，像事件一样宣言）
    next.battle.lastPass = false;
    return requestSurpriseDeploy(next, optId.slice(4), player);
  }
  next.battle.lastPass = false;
  const r = startWindowAction(next, player, optId, false);
  return finishPrompt(r);
}

/** 战斗时点支援：SP 加入攻击者 AP / 防御者 DP。useSupporterCost=true 表示用[サポーター]（支付费用而不变为行动済み） */
function doSupportInBattle(gs: GameState, owner: PlayerIndex, supporterUid: string, useSupporterCost = false): GameState {
  const next = clone(gs);
  if (!next.battle) return next;
  const sLoc = findLoc(next, supporterUid);
  const sInst = sLoc ? findInst(next, supporterUid) : null;
  if (!sInst || !sLoc || sLoc.zone !== 'field' || sLoc.player !== owner) return next;
  const sCard = next.cardsById[sInst.cardId];
  if (!sCard) return next;
  const hasSupporter = (sCard.basicAbilities ?? '').includes('サポーター');
  const cost = hasSupporter ? (parseBasicAbilities(sCard.basicAbilities ?? '').find((x) => x.tag === 'サポーター')?.value ?? '') : '';
  // 支援与サポーター都要求角色未行动
  if (sInst.tapped) {
    log(next, `「${sCard.name}」已行动，无法支援/使用サポーター。`);
    return next;
  }
  if (useSupporterCost) {
    // [サポーター]：支付费用代替变为行动済み；基本能力，一回合仅一次（需未行动）
    if (!hasSupporter || !cost) {
      log(next, `「${sCard.name}」没有サポーター能力。`);
      return next;
    }
    const key = `supporter:${supporterUid}:${next.turn}`;
    if ((next.players[owner].perTurn[key] ?? 0) >= 1) {
      log(next, `「${sCard.name}」サポーター本回合已使用（基本能力一回合一次）。`);
      return next;
    }
    const rest = poolAdjustedCost(next, owner, cost, { kind: 'support', card: sCard });
    // 规则：费用由玩家手动选择手牌支付（Bug ③）；面板上也可先用场上 [コスト] 能力产费
    if (rest) {
      next.prompt = {
        kind: 'cost-pay',
        cost: rest,
        actionLabel: `サポーター「${sCard.name}」支援（费用 [${cost}]）`,
        owner,
        pending: { action: 'supporterCost', supporterUid },
        candidates: next.players[owner].hand
          .filter((c) => c.uid !== supporterUid)
          .map((c) => ({
            uid: c.uid,
            name: next.cardsById[c.cardId]?.name ?? c.cardId,
            elements: next.cardsById[c.cardId]?.elements ?? '',
            ex: next.cardsById[c.cardId]?.ex ?? 0,
            cardId: c.cardId,
          })),
      };
      return next;
    }
    // 费用已由 [コスト] 产费/0 费抵扣 → 直接支援（不再行动済み）
    return applySupporterSupport(next, owner, supporterUid);
  }
  return applySupportEffect(next, owner, supporterUid, false);
}

/** [サポーター]费用支付完成后的支援执行：标记本回合已用 → 支援（保持未行动） */
function applySupporterSupport(gs: GameState, owner: PlayerIndex, supporterUid: string): GameState {
  const next = clone(gs);
  const sInst = findInst(next, supporterUid);
  if (!sInst) return next;
  next.players[owner].perTurn[`supporter:${supporterUid}:${next.turn}`] = (next.players[owner].perTurn[`supporter:${supporterUid}:${next.turn}`] ?? 0) + 1;
  return applySupportEffect(next, owner, supporterUid, true);
}

/** 支援效果：SP 加入目标 AP/DP（サポーター：保持未行动；普通支援：行动済み）→ 支援诱発链 */
function applySupportEffect(gs: GameState, owner: PlayerIndex, supporterUid: string, useSupporterCost: boolean): GameState {
  const next = clone(gs);
  const sLoc = findLoc(next, supporterUid);
  const sInst = sLoc ? findInst(next, supporterUid) : null;
  if (!sInst || !sLoc || sLoc.zone !== 'field' || sLoc.player !== owner || !next.battle) return next;
  const sCard = next.cardsById[sInst.cardId];
  const hasSupporter = !!sCard && (sCard.basicAbilities ?? '').includes('サポーター');
  const cost = hasSupporter ? (parseBasicAbilities(sCard.basicAbilities ?? '').find((x) => x.tag === 'サポーター')?.value ?? '') : '';
  const attackerSide = owner === next.battle.attackerPlayer;
  const targetUid = attackerSide ? next.battle.attackerUid : (next.battle.defenderUid ?? '');
  const tInst = targetUid ? findInst(next, targetUid) : null;
  if (!tInst) return next;
  const sp = eng.effectiveStats(next, supporterUid).sp;
  if (attackerSide) {
    tInst.tempMods.ap += sp;
    next.battle.supportAP += sp;
  } else {
    tInst.tempMods.dp += sp;
    next.battle.supportDP += sp;
  }
  // 普通支援 → 行动済み；サポーター → 保持未行动（用后可再正常支援）
  sInst.tapped = !useSupporterCost;
  sInst.supports = { attackerUid: targetUid, battleTurn: next.turn };
  next.battle.lastSupport = { supporterUid, targetUid, sp, attackerSide };
  pushVoice(next, owner, 'support'); // 语音：支援
  log(next, `「${cardName(next, supporterUid)}」${useSupporterCost ? `用サポーター（${cost}）` : ''}支援「${cardName(next, targetUid)}」：${attackerSide ? 'AP' : 'DP'} +${sp}。`);
  // 「支援宣言したとき」诱发：一次全局扫描己方全部卡（支援者自身 + 味方エリア如 6962 夢見がちなお嬢様）
  // 之前先扫支援者、无弹窗再特判エリア → 支援者自身有诱发弹窗时 6962 会被跳过（Bug：サポーター等场景 6962 不触发）
  return eng.continueTriggerChain(next, 'supportUsed', owner, null);
}

/** 判断某角色当前能否对战斗目标进行支援；返回可用的支援选项（① 支援 / ② サポーター） */
export function canSupportInBattle(gs: GameState, supporterUid: string): { options: { id: string; label: string }[] } {
  if (!gs.battle) return { options: [] };
  const sLoc = findLoc(gs, supporterUid);
  const sInst = sLoc ? findInst(gs, supporterUid) : null;
  if (!sInst || !sLoc || sLoc.zone !== 'field') return { options: [] };
  const p = sLoc.player;
  if (p !== gs.battle.attackerPlayer && p !== (1 - gs.battle.attackerPlayer) as PlayerIndex) return { options: [] };
  const targetUid = p === gs.battle.attackerPlayer ? gs.battle.attackerUid : (gs.battle.defenderUid ?? '');
  if (!targetUid || targetUid === supporterUid) return { options: [] };
  const tLoc = findLoc(gs, targetUid);
  if (!tLoc || tLoc.zone !== 'field' || tLoc.player !== p) return { options: [] };
  // 相邻判断（相对战斗目标）
  const isAF = tLoc.row === 'AF';
  const ta = tLoc.area ?? 0;
  const sa = sLoc.area ?? 0;
  const sRow = sLoc.row === 'AF' ? 0 : 1;
  const tRow = tLoc.row === 'AF' ? 0 : 1;
  const adjacent = isAF
    ? (sRow === 1 && sa === ta) || (sRow === 0 && (sa === ta - 1 || sa === ta + 1))
    : (sRow === 0 && sa === ta) || (sRow === 1 && (sa === ta - 1 || sa === ta + 1));
  // 6962 常时：对方回合中可支援非相邻角色
  const anyRange = eng.playerSupportAnyRange(gs, p) && p !== gs.turnPlayer;
  if (!adjacent && !anyRange) return { options: [] };
  // 可支援：需未行动；或两者皆可。① 支援（行动済み）② [サポーター]（支付费用代替行动済み，一回合一次）
  const sCard = gs.cardsById[sInst.cardId];
  const hasSupporter = !!sCard && (sCard.basicAbilities ?? '').includes('サポーター');
  const cost = hasSupporter ? (parseBasicAbilities(sCard.basicAbilities ?? '').find((x) => x.tag === 'サポーター')?.value ?? '') : '';
  const sp = eng.effectiveStats(gs, supporterUid).sp;
  const name = sCard?.name ?? '';
  const opts: { id: string; label: string }[] = [];
  if (!sInst.tapped) opts.push({ id: 'sup', label: `支援「${name}」（SP ${sp}）` });
  if (hasSupporter && cost && !sInst.tapped) {
    const key = `supporter:${supporterUid}:${gs.turn}`;
    const used = (gs.players[p].perTurn[key] ?? 0) >= 1;
    const ban0 = eng.playerBanZeroCostSupporter(gs, p) && (cost === '' || cost === '0');
    if (!used && !ban0) opts.push({ id: 'supC', label: `サポーター「${name}」（费用[${cost}]）` });
  }
  return { options: opts };
}

/* ================= 回合结束优先权转移 ================= */

/** 回合玩家宣言结束 → 对手自由时点（同意结束 / 行动） */
function openEndMainWindow(gs: GameState): GameState {
  const next = clone(gs);
  const other = (1 - next.turnPlayer) as PlayerIndex;
  next.prompt = {
    kind: 'end-main',
    owner: other,
    options: [
      { id: 'end', label: '同意结束（进入结束阶段）' },
      ...buildDeclareOptions(next, other, { inBattle: false, hasDefender: false, isResponse: false, ownTurn: other === next.turnPlayer }, false),
    ],
  };
  return next;
}

/** 回合结束转移行动 */
export function endMainAction(gs: GameState, optId: string): GameState {
  const next = clone(gs);
  const prompt = next.prompt;
  if (!prompt || prompt.kind !== 'end-main') return gs;
  next.prompt = null;
  const player = prompt.owner;
  if (optId === 'end') {
    log(next, `玩家 ${player + 1} 同意结束主阶段。`);
    return finishEndTurn(next);
  }
  const r = startWindowAction(next, player, optId, false);
  return finishPrompt(r);
}

/** 回合玩家取消“结束主阶段”宣言，继续主阶段（end-main 小窗的“取消”按钮） */
export function endMainCancel(gs: GameState): GameState {
  const next = clone(gs);
  if (!next.prompt || next.prompt.kind !== 'end-main') return gs;
  next.prompt = null;
  next.phase = 'main';
  next.battle = null;
  log(next, `玩家 ${next.turnPlayer + 1} 取消结束主阶段，继续主阶段。`);
  return next;
}

/** 登场/使用/攻击等操作的前置校验提示 */
export function phaseHint(gs: GameState): string | null {
  if (gs.phase === 'gameover') return '对局已结束';
  if (gs.battle) return '战斗中，请先完成战斗操作';
  if (gs.phase === 'start') return '请点击「开始回合」';
  if (gs.phase === 'end') return '请完成手牌调整';
  return null;
}
