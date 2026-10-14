/*
 * 开发端对局 harness（只在 tools/ 下，绝不进 dist / dist-electron，因此不会打包给玩家）
 *
 * 提供：
 *   · 确定性运行（种子化 Math.random 与 Date.now，保证同一种子每次结果一样）
 *   · 建一局（洗牌 → 就位 → 猜拳 → 起手 → 第一回合）
 *   · 枚举"当前状态下的所有候选动作"（含提示窗口内的选择）
 *   · 应用动作并判断"是否真的生效"（结构对比，忽略战报日志与语音队列）
 *   · 卡牌守恒 / 计数器非负 / 日志增量 等不变量用的辅助
 */
import { readFileSync } from 'node:fs';
import type { Card } from '../../src/core/cards';
import type { GameState, PlayerIndex, CardInstance } from '../../src/core/game';
import { startGame } from '../../src/core/sampleDeck';
import { hasDeclare, hasHandDeclare, hasMoveAbility } from '../../src/core/abilities';
import * as rules from '../../src/core/rules';
import { applyAction, promptOwner } from '../../src/net/protocol';

export const cards: Card[] = JSON.parse(readFileSync('data/cards/range.json', 'utf-8'));
export const byId = new Map(cards.map((c) => [c.id, c]));

/** 一条候选动作（与联机协议同名同参，走的就是游戏用的那条派发路径） */
export type Op = { action: string; args: unknown[]; label: string };

/* ---------------- 确定性 ---------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng: () => number = Math.random; // 机器人自己抽签用
let engineRng: () => number = Math.random; // 装给引擎（洗牌/猜拳等），与机器人抽签分流

/**
 * 装好确定性随机源；返回还原函数。
 * 注意：引擎用的随机流与机器人抽签用的随机流分开，否则"回放时不再抽签"会让两条流错位，
 * 造成假的"不确定"告警。
 */
export function installDeterminism(seed: number): () => void {
  const realRandom = Math.random;
  const realNow = Date.now;
  rng = mulberry32(seed ^ 0x9e3779b9);
  engineRng = mulberry32(seed);
  let clock = 1700000000000; // 固定起点，newUid 里的时间戳也变确定
  Math.random = () => engineRng();
  Date.now = () => clock++;
  return () => {
    Math.random = realRandom;
    Date.now = realNow;
  };
}

export const rand = (): number => rng();
export const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
export const chance = (p: number): boolean => rng() < p;

/* ---------------- 建局 ---------------- */

/** 一局的标准起手流程（和界面上的顺序一致） */
export function newMatch(seed: number): GameState {
  void seed;
  let gs = startGame(cards);
  gs = rules.markReady(gs);
  let guard = 0;
  while (gs.prompt?.kind === 'rps' && guard++ < 8) {
    const who: PlayerIndex = gs.rps?.p0 === null ? 0 : 1;
    gs = rules.chooseRps(gs, who, pick(['rock', 'paper', 'scissors'] as const));
  }
  guard = 0;
  while (guard++ < 12) {
    const pr = gs.prompt;
    if (!pr) break;
    if (pr.kind === 'rps-result') gs = rules.confirmRpsResult(gs);
    else if (pr.kind === 'mulligan') gs = rules.chooseMulligan(gs, chance(0.15));
    else if (pr.kind === 'response') gs = rules.respond(gs, 'pass');
    else if (pr.kind === 'battle-timing') gs = rules.battleTimingAction(gs, 'end');
    else if (pr.kind === 'end-main') gs = rules.endMainAction(gs, 'end');
    else break;
  }
  gs = rules.beginTurn(gs);
  return gs;
}

/** 当前该谁动：有提示就看提示归谁，否则看回合玩家 */
export function actorOf(gs: GameState): PlayerIndex {
  if (gs.prompt) {
    const o = promptOwner(gs);
    if (o !== null && o !== undefined) return o as PlayerIndex;
  }
  return gs.turnPlayer;
}

/* ---------------- 枚举候选动作 ---------------- */

export function candidates(gs: GameState): Op[] {
  const p = actorOf(gs);
  const pr = gs.prompt;
  const out: Op[] = [];
  const own = gs.players[p];
  const opp: PlayerIndex = p === 0 ? 1 : 0;

  if (pr) {
    switch (pr.kind) {
      case 'rps': {
        const who: PlayerIndex = gs.rps?.p0 === null ? 0 : 1;
        for (const c of ['rock', 'paper', 'scissors'] as const) out.push({ action: 'chooseRps', args: [who, c], label: `猜拳 ${c}` });
        break;
      }
      case 'rps-result':
        out.push({ action: 'confirmRpsResult', args: [], label: '确认先攻' });
        break;
      case 'mulligan':
        out.push({ action: 'chooseMulligan', args: [false], label: '保留起手' });
        out.push({ action: 'chooseMulligan', args: [true], label: '重抽起手' });
        break;
      case 'defense':
        for (const c of pr.candidates) out.push({ action: 'chooseDefense', args: [c.uid], label: `防御 ${c.name}` });
        out.push({ action: 'chooseDefense', args: [null], label: '不防御' });
        break;
      case 'shield':
        out.push({ action: 'chooseShield', args: [true], label: '使用护盾' });
        out.push({ action: 'chooseShield', args: [false], label: '不使用护盾' });
        break;
      case 'hand-adjust': {
        const hand = own.hand;
        out.push({ action: 'confirmDiscard', args: [hand.slice(0, pr.need).map((c) => c.uid)], label: `破弃 ${pr.need} 张` });
        out.push({ action: 'confirmDiscard', args: [hand.slice(-pr.need).map((c) => c.uid)], label: `破弃 ${pr.need} 张（另一组）` });
        break;
      }
      case 'equip-target':
        for (const t of pr.targets) out.push({ action: 'requestEquipItem', args: [pr.itemUid, t.uid], label: `装备给 ${t.name}` });
        break;
      case 'cost-pay': {
        const cands = pr.candidates;
        if (cands.length > 0) out.push({ action: 'confirmCostPay', args: [[cands[0].uid]], label: `付费（1 张 ${cands[0].name}）` });
        if (cands.length > 1) out.push({ action: 'confirmCostPay', args: [cands.map((c) => c.uid)], label: `付费（全部 ${cands.length} 张）` });
        // 注意：这里不盲试 useCostAbilityInPay。界面（Battlefield.tsx 的 pushCostAbility）只在卡确实有
        // [コスト]能力、且未用过/未失去/满足 underCost 等条件时才显示按钮；
        // 盲试每个候选会产生大量"静默失败"假报告。要精确镜像该判定留到第二期（复用界面的解析结果）。
        out.push({ action: 'cancelCostPay', args: [], label: '取消付费' });
        break;
      }
      case 'declare-target':
        for (const c of pr.candidates) out.push({ action: 'chooseDeclareTarget', args: [c.uid], label: `目标 ${c.name}` });
        out.push({ action: 'chooseDeclareTarget', args: [null], label: '不选目标' });
        break;
      case 'manual-effect': {
        out.push({ action: 'manualDone', args: [], label: '手动结算完成' });
        out.push({ action: 'manualDraw', args: [1], label: '手动抽 1' });
        out.push({ action: 'manualDeckDiscard', args: [1], label: '手动破弃卡组 1' });
        const chars = [...own.field.flat(), ...gs.players[opp].field.flat()].filter(Boolean) as CardInstance[];
        for (const c of chars.slice(0, 3)) out.push({ action: 'manualStat', args: [c.uid, 'ap', 1], label: '手动 +1AP' });
        break;
      }
      case 'search-deploy':
        for (const c of pr.candidates) out.push({ action: 'chooseSearchDeploy', args: [c.uid], label: `登场 ${c.name}` });
        out.push({ action: 'chooseSearchDeploy', args: [null], label: '放弃登场' });
        if (pr.altMode) out.push({ action: 'chooseSearchDeploy', args: [null, true], label: '改用替代处理' });
        break;
      case 'card-pick': {
        const cands = pr.candidates;
        const k = Math.max(1, Math.min(pr.max, cands.length));
        if (cands.length > 0) {
          out.push({ action: 'chooseCardPick', args: [cands.slice(0, k).map((c) => c.uid)], label: `选卡 ${k} 张` });
          if (cands.length > k) out.push({ action: 'chooseCardPick', args: [cands.slice(-k).map((c) => c.uid)], label: `选卡 ${k} 张（另一组）` });
        }
        out.push({ action: 'chooseCardPick', args: [[]], label: '一张都不选' });
        break;
      }
      case 'damage':
        out.push({ action: 'confirmDamage', args: [], label: '确认伤害' });
        break;
      case 'slot-pick':
        for (const s of pr.slots) out.push({ action: 'chooseSlot', args: [s.row, s.area], label: `选位置 ${s.row}/${s.area}` });
        break;
      case 'response':
        for (const o of pr.options) out.push({ action: 'respond', args: [o.id], label: `对应：${o.label}` });
        break;
      case 'battle-timing':
        for (const o of pr.options) out.push({ action: 'battleTimingAction', args: [o.id], label: `战斗时点：${o.label}` });
        break;
      case 'end-main':
        for (const o of pr.options) out.push({ action: 'endMainAction', args: [o.id], label: `结束优先权：${o.label}` });
        out.push({ action: 'endMainCancel', args: [], label: '取消结束回合' });
        break;
      case 'effect-choice': {
        const opts = pr.options;
        const n = Math.max(1, Math.min(pr.multi ? pr.max : 1, opts.length));
        if (opts.length > 0) {
          out.push({ action: 'chooseEffectOption', args: [opts.slice(0, n).map((o) => o.id)], label: `选效果选项（前 ${n} 个）` });
          if (opts.length > 1) out.push({ action: 'chooseEffectOption', args: [opts.slice(-n).map((o) => o.id)], label: `选效果选项（后 ${n} 个）` });
        }
        break;
      }
      case 'support':
        for (const c of pr.candidates) out.push({ action: 'chooseSupport', args: [c.uid], label: `支援 ${c.name}` });
        out.push({ action: 'chooseSupport', args: [null], label: '不支援' });
        break;
      case 'gameover':
        break;
    }
    return out;
  }

  // 开始阶段：界面上只有一个「▶ 开始回合」按钮（对应 beginTurn）
  if (gs.phase === 'start') {
    out.push({ action: 'beginTurn', args: [], label: '开始回合' });
    return out;
  }
  // 主阶段（无提示）—— 只枚举"界面上真的会给出按钮"的动作，
  // 依据 src/ui/Battlefield.tsx 里的可用性判定（canDeploy / canPlayEvent / canPlayArea /
  // canEquip / canDeclare / canItemDeclare / canAttackNow / canMove / canHandDeclare）。
  // 界面根本不会提供的动作（比如拿事件卡去"登场"）如果被引擎静默拒绝，那不是用户能看到的问题。
  const mainPhase = gs.phase === 'main' && !gs.prompt;
  const cardOf = (c: CardInstance) => byId.get(c.cardId);
  const handUids = own.hand.map((c) => c.uid);
  for (const uid of handUids) {
    const inst = own.hand.find((c) => c.uid === uid)!;
    const card = cardOf(inst);
    if (!card) continue;
    if (mainPhase && card.type === 'character') {
      for (const s of rules.validDeploySlots(gs, p, uid)) out.push({ action: 'requestPlayCharacter', args: [uid, s.row, s.area], label: `登场 ${card.name}` });
    }
    if (mainPhase && card.type === 'event') out.push({ action: 'requestPlayEvent', args: [uid], label: `使用事件 ${card.name}` });
    if (mainPhase && card.type === 'area') out.push({ action: 'requestPlayArea', args: [uid], label: `配置エリア ${card.name}` });
    if (mainPhase && card.type === 'item') {
      for (const ch of own.field.flat().filter(Boolean) as CardInstance[]) {
        out.push({ action: 'requestEquipItem', args: [uid, ch.uid], label: `装备 ${card.name}` });
      }
    }
    // 手札宣言：界面要求 主阶段 + 非战斗 + 无提示
    if (gs.phase === 'main' && !gs.battle && !gs.prompt && hasHandDeclare(card)) {
      out.push({ action: 'requestHandDeclare', args: [uid], label: `手札宣言 ${card.name}` });
    }
  }
  for (const ch of own.field.flat().filter(Boolean) as CardInstance[]) {
    const card = cardOf(ch);
    if (!card) continue;
    if (mainPhase && hasDeclare(card)) out.push({ action: 'requestDeclare', args: [ch.uid], label: `宣言 ${card.name}` });
    if (mainPhase && ch.equip) {
      const ec = byId.get(ch.equip.cardId);
      if (ec && hasDeclare(ec)) out.push({ action: 'requestDeclare', args: [ch.equip.uid], label: `道具宣言 ${ec.name}` });
    }
    if (rules.canAttack(gs, ch.uid)) out.push({ action: 'declareAttack', args: [ch.uid], label: `攻击 ${card.name}` });
    if (mainPhase && hasMoveAbility(card)) {
      for (const t of rules.validMoveTargets(gs, ch.uid)) out.push({ action: 'moveCharacter', args: [ch.uid, t.row, t.area], label: `移动 ${card.name}` });
    }
  }
  // 「结束回合」按钮只在主阶段出现（开始阶段是「开始回合」，结束阶段不提供）
  if (gs.phase === 'main') out.push({ action: 'endTurn', args: [], label: '结束回合' });
  return out;
}

export function applyOp(gs: GameState, op: Op): GameState {
  return applyAction(gs, op.action, op.args);
}

/* ---------------- 结构对比 / 不变量辅助 ---------------- */

/** 稳定序列化：对象键排序；去掉静态卡表与只影响显示的字段（战报日志、语音队列） */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => k !== 'log' && k !== 'voiceQueue' && k !== 'cardsById')
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
}

/** 卡牌实例 uid 的形状（c<计数>_<时间36>） */
const UID_RE = /c[0-9a-z]{1,8}_[0-9a-z]{1,10}/g;

/**
 * 结构指纹：uid 按"首次出现顺序"归一化成 #0 #1 …（因为 uid 计数器是模块级全局的，
 * 重放时从不同的计数开始，不归一化会出现假的"不可复现"）。
 */
export function structuralKey(gs: GameState): string {
  const json = stableJson(gs);
  const map = new Map<string, string>();
  return json.replace(UID_RE, (m) => {
    let v = map.get(m);
    if (!v) {
      v = '#' + map.size;
      map.set(m, v);
    }
    return v;
  });
}

/** 这一步是否真的改变了游戏状态（忽略日志/语音） */
export function changed(before: GameState, after: GameState): boolean {
  return structuralKey(before) !== structuralKey(after);
}

/**
 * 与 uid 无关的投影（用于"可复现"检查）。
 * 只比卡号级别的分布 + 关键标量：uid 计数器是模块级全局的，重放时起始值不同，
 * 若直接比结构指纹会把"uid 顺序变化"误报成不可复现。
 */
export function projectKey(gs: GameState): string {
  const zoneIds = (list: (CardInstance | null)[]) =>
    list
      .filter(Boolean)
      .map((c) => (c as CardInstance).cardId)
      .sort();
  const player = (p: PlayerIndex) => {
    const pl = gs.players[p];
    const nested = (c: CardInstance) => ({
      cardId: c.cardId,
      charge: c.charge.map((x) => x.cardId).sort(),
      under: c.under.map((x) => x.cardId).sort(),
      lost: c.lost.map((x) => x.cardId).sort(),
      equip: c.equip ? c.equip.cardId : null,
      tapped: !!c.tapped,
      mods: c.tempMods,
    });
    const field = pl.field.flat().map((c) => (c ? nested(c) : null));
    const areas = pl.fieldAreas.flat().map((c) => (c ? c.cardId : null));
    return {
      deck: pl.deck.map((c) => c.cardId),
      hand: pl.hand.map((c) => c.cardId).sort(),
      trash: zoneIds(pl.trash),
      shield: zoneIds(pl.shield),
      special: zoneIds(pl.special),
      removed: zoneIds(pl.removed),
      field,
      areas,
      storage: Object.keys(pl.storage)
        .map((k) => zoneIds(pl.storage[k]).join(','))
        .sort(),
      perTurnKeys: Object.keys(pl.perTurn).length,
      counters: pl.turnCounters,
    };
  };
  return JSON.stringify({
    turn: gs.turn,
    turnPlayer: gs.turnPlayer,
    phase: gs.phase,
    winner: gs.winner,
    prompt: gs.prompt ? gs.prompt.kind : null,
    trumpUsed: gs.trumpUsed,
    p0: player(0),
    p1: player(1),
  });
}

/** 新增的战报文字 */
export function logDelta(before: GameState, after: GameState): string[] {
  const a = before.log ?? [];
  const b = after.log ?? [];
  return b.length > a.length ? b.slice(a.length) : [];
}

/** 某玩家当前所有卡牌实例的 uid 集合（含嵌套区域） */
export function uidsOf(gs: GameState, p: PlayerIndex): string[] {
  const out: string[] = [];
  collectUids(gs.players[p], out);
  return out;
}

/** 收集卡牌实例的 uid（含嵌套：充能/垫卡/失去/装备） */
function collectUids(v: unknown, out: string[]): void {
  if (v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) collectUids(x, out);
    return;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.uid === 'string' && typeof o.cardId === 'string') out.push(o.uid);
  for (const k of Object.keys(o)) {
    if (k === 'log' || k === 'voiceQueue' || k === 'cardsById') continue;
    collectUids(o[k], out);
  }
}

/** uid 的创建顺序（uid 形如 c<counter36>_<time36>），用于跨局/跨进程对齐"同一张卡" */
export function uidOrder(gs: GameState): string[] {
  const uids = [...uidsOf(gs, 0), ...uidsOf(gs, 1)];
  const num = (u: string) => {
    const m = /^c([0-9a-z]+)_/.exec(u);
    return m ? parseInt(m[1], 36) : 0;
  };
  return uids.sort((a, b) => num(a) - num(b));
}

/** 把动作参数里的 uid 换成"第几张卡"（#i）：流水因此与 uid 计数器无关，可跨进程复现 */
export function normalizeOp(op: Op, order: string[]): Op {
  const table = new Map<string, string>();
  order.forEach((u, i) => table.set(u, '#' + i));
  const conv = (v: unknown): unknown =>
    typeof v === 'string' ? (table.get(v) ?? v) : Array.isArray(v) ? v.map(conv) : v;
  return { action: op.action, args: op.args.map(conv), label: op.label };
}

/** 回放时把 #i 还原成当前局面里第 i 张卡的 uid */
export function denormalizeOp(op: Op, order: string[]): Op {
  const conv = (v: unknown): unknown =>
    typeof v === 'string' && /^#\d+$/.test(v)
      ? (order[Number(v.slice(1))] ?? v)
      : Array.isArray(v)
        ? v.map(conv)
        : v;
  return { action: op.action, args: op.args.map(conv), label: op.label };
}

/** 动作参数里涉及的卡号（用于统计卡牌覆盖度） */
export function ownCardIdOfArgs(gs: GameState, op: Op): string | null {
  for (const a of op.args) {
    if (typeof a !== 'string') continue;
    const found = findCardId(gs, a);
    if (found) return found;
  }
  return null;
}

function findCardId(v: unknown, uid: string): string | null {
  if (v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findCardId(x, uid);
      if (r) return r;
    }
    return null;
  }
  const o = v as Record<string, unknown>;
  if (o.uid === uid && typeof o.cardId === 'string') return o.cardId;
  for (const k of Object.keys(o)) {
    if (k === 'cardsById') continue;
    const r = findCardId(o[k], uid);
    if (r) return r;
  }
  return null;
}

/** 计数器为负等"数值不可能"的情况 */
export function negativeCounters(gs: GameState): string[] {
  const bad: string[] = [];
  for (const p of [0, 1] as PlayerIndex[]) {
    const pl = gs.players[p];
    for (const e of pl.exPool) if (e.points < 0) bad.push(`玩家${p + 1} exPool ${e.elem}=${e.points}`);
    for (const [k, v] of Object.entries(pl.perTurn)) if (v < 0) bad.push(`玩家${p + 1} perTurn[${k}]=${v}`);
    for (const [k, v] of Object.entries(pl.turnCounters)) if (v < 0) bad.push(`玩家${p + 1} turnCounters[${k}]=${v}`);
    const chars = pl.field.flat().filter(Boolean) as CardInstance[];
    for (const c of chars) {
      const m = c.tempMods;
      if (m && (m.ap < -99 || m.dp < -99)) bad.push(`角色 ${c.cardId} tempMods=${JSON.stringify(m)}`);
    }
  }
  return bad;
}

/** 用于报告的状态摘要 */
export function summarize(gs: GameState): string {
  const pr = gs.prompt ? `${gs.prompt.kind}${'title' in gs.prompt ? `(${(gs.prompt as { title?: string }).title ?? ''})` : ''}` : '无提示';
  const field = (p: PlayerIndex) =>
    [0, 1].map((r) => gs.players[p].field[r].map((c) => (c ? c.cardId : '·')).join(',')).join(' | ');
  return [
    `回合 ${gs.turn} / ${gs.turnPlayer === 0 ? '玩家1' : '玩家2'} / 阶段 ${gs.phase} / 提示 ${pr}`,
    `手牌 ${gs.players[0].hand.length}-${gs.players[1].hand.length} 卡组 ${gs.players[0].deck.length}-${gs.players[1].deck.length} 弃牌 ${gs.players[0].trash.length}-${gs.players[1].trash.length}`,
    `P1 场上 ${field(0)}`,
    `P2 场上 ${field(1)}`,
  ].join('\n  ');
}
