// 对局状态「增量同步」：房主只发改动的部分，客机/观战者在本地拼回去。
//
// 为什么要做：原来每次状态变化都广播整份 GameState（实测约 160KB，其中绝大部分是 cardsById
// 里的卡牌资料 + 全部卡实例），在公网链路上要好几秒才传完，排在后面的小消息（房间成员信息等）
// 会被堵住十几秒 —— 表现为"观战者收不到房间信息""对局中卡顿"。
//
// 做法：
// 1. cardsById 完全不传（双方本地都有一模一样的卡牌资料，收到后按 cardId 就地补齐）；
// 2. 状态按"槽位"（每个玩家的每个字段、每个顶层字段）逐项比较，只发改动的槽位；
// 3. log 只发新增的行（悔棋导致日志回退时自动改发整份）；
// 4. 每个包带版本号 rev / base：客机发现 base 对不上（漏包）就发 resync 请求整份。
import type { Card } from '../core/cards';
import type { GameState, PlayerState } from '../core/game';

/** 状态包：full = 整份（首次/重连）；patch = 增量 */
export interface StatePacket {
  kind: 'full' | 'patch';
  rev: number; // 应用本包后到达的版本号
  base: number; // patch 基于的版本号（full 时为 -1）
  gs?: GameState; // kind = 'full'：整份状态（cardsById 为空，接收方本地补齐）
  changes?: [string, unknown][]; // kind = 'patch'：变化的槽位（路径 → 新值）
  logFrom?: number; // log 增量起点（纯追加时）
  logAdd?: string[]; // log 新增行
}

/* ===================== 槽位（可同步的最小单位） ===================== */

type AnyRec = Record<string, unknown>;

/** 把一个状态拆成「路径 → 值」的槽位列表（用 Object.keys 扫描，新增字段自动覆盖） */
export function slotsOf(gs: GameState): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const k of Object.keys(gs)) {
    if (k === 'cardsById' || k === 'log' || k === 'players') continue;
    out.push([k, (gs as unknown as AnyRec)[k]]);
  }
  const players = gs.players as unknown as AnyRec[];
  for (const i of [0, 1]) {
    for (const k of Object.keys(players[i])) out.push([`players.${i}.${k}`, players[i][k]]);
  }
  return out;
}

/** 按路径写回一个槽位（只做必要的浅拷贝，不修改原对象） */
export function setSlot(gs: GameState, path: string, value: unknown): GameState {
  const parts = path.split('.');
  if (parts[0] === 'players' && parts.length === 3) {
    const idx = Number(parts[1]) === 1 ? 1 : 0;
    const players: [PlayerState, PlayerState] = [gs.players[0], gs.players[1]];
    players[idx] = { ...players[idx], [parts[2]]: value } as PlayerState;
    return { ...gs, players };
  }
  return { ...gs, [path]: value } as GameState;
}

/** 去掉 cardsById（接收方本地补齐） */
function strip(gs: GameState): GameState {
  return { ...gs, cardsById: {} };
}

function rehydrate(gs: GameState, cards: Card[]): GameState {
  const map: Record<string, Card> = {};
  for (const c of cards) map[c.id] = c;
  return { ...gs, cardsById: map };
}

/* ===================== 发送端（房主） ===================== */

let lastSnap: Map<string, string> | null = null;
let lastLog: string[] = [];
let rev = 0;

/** 重开一局/换房间时清空基线 */
export function resetEncode() {
  lastSnap = null;
  lastLog = [];
  rev = 0;
}

function json(v: unknown): string {
  return JSON.stringify(v ?? null) ?? 'null';
}

/**
 * 把当前状态编码成数据包。
 * @param full 强制整份（新加入的玩家/请求重同步时用）；默认产生增量包
 */
export function encodeState(gs: GameState, opts: { full?: boolean } = {}): StatePacket {
  const snap = new Map<string, string>();
  for (const [path, value] of slotsOf(gs)) snap.set(path, json(value));

  if (opts.full || !lastSnap) {
    lastSnap = snap;
    lastLog = gs.log.slice();
    return { kind: 'full', rev, base: -1, gs: strip(gs) };
  }

  const changes: [string, unknown][] = [];
  for (const [path, value] of slotsOf(gs)) {
    if (lastSnap.get(path) !== snap.get(path)) changes.push([path, value]);
  }

  const pkt: StatePacket = { kind: 'patch', rev: rev + 1, base: rev, changes };
  const prevLog = lastLog;
  if (json(prevLog) !== json(gs.log)) {
    // 纯追加 → 只发新行；否则（悔棋回退等）发整份日志
    let same = prevLog.length <= gs.log.length;
    for (let i = 0; same && i < prevLog.length; i++) if (prevLog[i] !== gs.log[i]) same = false;
    if (same) {
      pkt.logFrom = prevLog.length;
      pkt.logAdd = gs.log.slice(prevLog.length);
    } else {
      pkt.changes = [...(pkt.changes ?? []), ['log', gs.log]];
    }
  }

  lastSnap = snap;
  lastLog = gs.log.slice();
  rev += 1;
  return pkt;
}

/** 当前版本号（调试/显示用） */
export function currentRev(): number {
  return rev;
}

/* ===================== 接收端（客机/观战者） ===================== */

let myRev = -1;

export function resetDecode() {
  myRev = -1;
}

/**
 * 应用数据包。
 * 返回 needResync = true 表示本地基线对不上（漏包/首次），调用方应向房主请求整份状态。
 */
export function decodeState(
  prev: GameState | null,
  pkt: StatePacket,
  cards: Card[],
): { gs: GameState | null; needResync: boolean } {
  if (!pkt) return { gs: null, needResync: true };
  if (pkt.kind === 'full') {
    if (!pkt.gs) return { gs: null, needResync: true };
    myRev = pkt.rev;
    return { gs: rehydrate(pkt.gs, cards), needResync: false };
  }
  if (!prev || myRev !== pkt.base) return { gs: null, needResync: true };
  let next = prev;
  for (const [path, value] of pkt.changes ?? []) next = setSlot(next, path, value);
  if (pkt.logAdd) {
    const from = pkt.logFrom ?? next.log.length;
    next = { ...next, log: [...next.log.slice(0, from), ...pkt.logAdd] };
  }
  myRev = pkt.rev;
  return { gs: next, needResync: false };
}

/* ===================== 体积统计（自检/日志用） ===================== */

/** 数据包线上一共多少字节（JSON 后的长度） */
export function packetSize(pkt: StatePacket): number {
  return JSON.stringify(pkt).length;
}

/** 整份状态若直接发送会有多大（用来对比省了多少） */
export function fullSize(gs: GameState): number {
  return JSON.stringify(gs).length;
}
