// 对局状态「增量同步」+「校验码（分车检测）」：房主只发改动的部分，客机本地拼回去并校验。
//
// 为什么要增量：原来每次状态变化都广播整份 GameState（实测约 126KB，其中绝大部分是 cardsById
// 的卡牌资料 + 全部卡实例），公网链路上要好几秒才传完，排在后面的小消息会被堵十几秒
// —— 表现为"观战者收不到房间信息""对局中卡顿"。
//
// 为什么要校验码：网络抖动/漏包会让客机画面停在旧的时刻（表现为"AP 修正留着""手牌消失"），
// 只靠版本号不一定能立刻发现。所以每个包带一个"整份状态的校验码"（类似魔兽争霸自定义地图的
// 不同步检测）：客机应用后自己算一遍比对 —— 对不上就说明这次数据有问题，自动重对齐；
// 重对齐后仍对不上 = 真·分车，再进一步算出**是哪些字段不一致**，两边界面都会红字提示。
//
// 做法：
// 1. cardsById 不传（双方本地都有同样的卡牌资料，收到后按 cardId 就地补齐）；
// 2. 状态按"槽位"逐项比较，只发改动的槽位；
// 3. log 只发新增行（悔棋回退时自动改发整份）；
// 4. 每个包带 rev/base（漏包检测）、seq（发包序号）、hash（校验码）。
import type { Card } from '../core/cards';
import type { GameState, PlayerState } from '../core/game';

/** 状态包：full = 整份（首次/重连/定期兜底）；patch = 增量 */
export interface StatePacket {
  kind: 'full' | 'patch';
  rev: number; // 应用本包后到达的版本号
  base: number; // patch 基于的版本号（full 时为 -1）
  seq: number; // 发包序号（每发一次 +1，用于发现跳号）
  hash: number; // 整份状态的校验码（房主算的，客机比对）
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

/* ===================== 校验码（哈希） ===================== */

/** 规范化字符串化：对象键排序，保证两边算出的字符串一致（与键的插入顺序无关） */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canon(o[k]))
      .join(',') +
    '}'
  );
}

/** FNV-1a 32 位哈希 */
export function fnv1a(str: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 槽位列表的规范化字符串（按路径排序 → 与对象构造顺序无关） */
function slotStrings(gs: GameState): [string, string][] {
  const out = slotsOf(gs).map(([p, v]) => [p, canon(v)] as [string, string]);
  out.push(['log', canon(gs.log ?? [])]);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

function hashOfSlots(pairs: [string, string][]): number {
  let h = 2166136261;
  for (const [p, s] of pairs) h = fnv1a(p + '=' + s + '\n', h);
  return h >>> 0;
}

/** 整份状态的校验码（不含 cardsById：那是两边各自本地加载的卡牌资料） */
export function stateHash(gs: GameState): number {
  return hashOfSlots(slotStrings(gs));
}

/** 逐槽位校验值（分车排查：找出到底哪个字段不一致） */
export function stateSlotHashes(gs: GameState): [string, number][] {
  return slotStrings(gs).map(([p, s]) => [p, fnv1a(p + '=' + s)]);
}

/** 校验码的十六进制显示（8 位） */
export function hashHex(h: number): string {
  return (h >>> 0)
    .toString(16)
    .toUpperCase()
    .padStart(8, '0');
}

/** 比对两边的逐槽位校验值，返回不一致的字段名 */
export function divergentSlots(host: [string, number][], guest: [string, number][]): string[] {
  const g = new Map(guest);
  const out: string[] = [];
  for (const [p, h] of host) if (g.get(p) !== h) out.push(p);
  const hPaths = new Set(host.map(([p]) => p));
  for (const [p] of guest) if (!hPaths.has(p)) out.push(p);
  return [...new Set(out)];
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

function valueOfPath(gs: GameState, path: string): unknown {
  if (path === 'log') return gs.log;
  const parts = path.split('.');
  if (parts[0] === 'players' && parts.length === 3) {
    const p = Number(parts[1]) === 1 ? 1 : 0;
    return (gs.players[p] as unknown as AnyRec)[parts[2]];
  }
  return (gs as unknown as AnyRec)[path];
}

/* ===================== 发送端（房主） ===================== */

let snap: [string, string][] | null = null; // 上一次「发给全体」的状态快照（增量基准）
let snapLog = '';
let rev = 0;
let seq = 0;

/** 重开一局/换房间时清空基线 */
export function resetEncode() {
  snap = null;
  snapLog = '';
  rev = 0;
  seq = 0;
}

/**
 * 把当前状态编码成数据包。
 * @param full         强制整份（新加入的玩家 / 请求重同步 / 定期心跳兜底）
 * @param perRecipient 只发给某一个人（例如给新进来的观战者补发整份）。
 *                     这种包**不能**更新全体的增量基准，否则之后算出的增量会漏掉变化。
 */
export function encodeState(gs: GameState, opts: { full?: boolean; perRecipient?: boolean } = {}): StatePacket {
  const cur = slotStrings(gs);
  const logStr = canon(gs.log ?? []);
  const hash = hashOfSlots(cur);
  seq += 1;

  if (opts.full || !snap) {
    const pkt: StatePacket = { kind: 'full', rev, base: -1, seq, hash, gs: strip(gs) };
    if (!opts.perRecipient) {
      snap = cur;
      snapLog = logStr;
    }
    return pkt;
  }

  const prev = new Map(snap);
  const changes: [string, unknown][] = [];
  for (const [path, s] of cur) if (prev.get(path) !== s) changes.push([path, valueOfPath(gs, path)]);

  const pkt: StatePacket = { kind: 'patch', rev: rev + 1, base: rev, seq, hash, changes };

  if (snapLog !== logStr) {
    // 纯追加 → 只发新行；否则（悔棋回退等）发整份日志
    const before = JSON.parse(snapLog) as string[];
    const after = gs.log ?? [];
    let same = before.length <= after.length;
    for (let i = 0; same && i < before.length; i++) if (before[i] !== after[i]) same = false;
    if (same) {
      pkt.logFrom = before.length;
      pkt.logAdd = after.slice(before.length);
    } else {
      pkt.changes = [...(pkt.changes ?? []), ['log', after]];
    }
  }

  snap = cur;
  snapLog = logStr;
  rev += 1;
  return pkt;
}

/** 当前版本号 / 发包序号（诊断面板用） */
export function currentRev(): number {
  return rev;
}
export function currentSeq(): number {
  return seq;
}

/* ===================== 接收端（客机/观战者） ===================== */

let myRev = -1;

export function resetDecode() {
  myRev = -1;
}

export function currentDecodeRev(): number {
  return myRev;
}

export interface DecodeResult {
  gs: GameState | null;
  needResync: boolean; // 版本基线对不上（漏包/首次）→ 请房主发整份
  hashOk: boolean; // 本地算出的校验码是否与包内一致
  localHash: number;
}

/** 应用数据包并校验 */
export function decodeState(prev: GameState | null, pkt: StatePacket, cards: Card[]): DecodeResult {
  if (!pkt) return { gs: null, needResync: true, hashOk: false, localHash: 0 };
  if (pkt.kind === 'full') {
    if (!pkt.gs) return { gs: null, needResync: true, hashOk: false, localHash: 0 };
    myRev = pkt.rev;
    const gs = rehydrate(pkt.gs, cards);
    const localHash = stateHash(gs);
    return { gs, needResync: false, hashOk: localHash === pkt.hash, localHash };
  }
  if (!prev || myRev !== pkt.base) return { gs: null, needResync: true, hashOk: false, localHash: 0 };
  let next = prev;
  for (const [path, value] of pkt.changes ?? []) next = setSlot(next, path, value);
  if (pkt.logAdd) {
    const from = pkt.logFrom ?? next.log.length;
    next = { ...next, log: [...next.log.slice(0, from), ...pkt.logAdd] };
  }
  myRev = pkt.rev;
  const localHash = stateHash(next);
  return { gs: next, needResync: false, hashOk: localHash === pkt.hash, localHash };
}

/* ===================== 体积统计（自检/日志用） ===================== */

export function packetSize(pkt: StatePacket): number {
  return JSON.stringify(pkt).length;
}

export function fullSize(gs: GameState): number {
  return JSON.stringify(gs).length;
}
