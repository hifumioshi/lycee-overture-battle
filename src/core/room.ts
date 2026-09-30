// 房间状态纯逻辑（可测试）：对战桌 + 观战席 + 准备/开始
// 房主客户端用 cid = HOST_CID 表示（它不经过 WS 服务器，是特殊客户端）

export const HOST_CID = -1;

export interface SeatInfo {
  cid: number; // 客户端 id（房主 = HOST_CID）
  name: string;
  ready: boolean;
  deckCount: number; // 已选卡组张数（0 = 未选 / 随机）
  deckName?: string; // 已选卡组名（'随机测试牌组' = 随机；undefined = 还没选）
}

export interface SpectatorInfo {
  cid: number;
  name: string;
}

export interface RoomState {
  phase: 'lobby' | 'playing';
  gameNum: number; // 第几局（再来一局 +1）
  seat1: SeatInfo | null;
  seat2: SeatInfo | null;
  spectators: SpectatorInfo[];
}

export function createRoom(hostName: string): RoomState {
  return {
    phase: 'lobby',
    gameNum: 1,
    seat1: { cid: HOST_CID, name: hostName || '房主', ready: false, deckCount: 0 },
    seat2: null,
    spectators: [],
  };
}

/** 新客户端连接 → 进观战席 */
export function roomAddClient(room: RoomState, cid: number, name: string): RoomState {
  if (room.seat1?.cid === cid || room.seat2?.cid === cid) return room;
  if (room.spectators.some((s) => s.cid === cid)) return room;
  return { ...room, spectators: [...room.spectators, { cid, name: name || `观战者${cid + 1}` }] };
}

/** 客户端断开 → 清座位/观战席 */
export function roomRemoveClient(room: RoomState, cid: number): RoomState {
  if (cid === HOST_CID) return room; // 房主断开 = 房间关闭（由上层处理）
  return {
    ...room,
    seat1: room.seat1?.cid === cid ? null : room.seat1,
    seat2: room.seat2?.cid === cid ? null : room.seat2,
    spectators: room.spectators.filter((s) => s.cid !== cid),
  };
}

/** 观战者上桌：坐到空座位（优先座位1，其次座位2；都满则不变） */
export function roomSit(room: RoomState, cid: number): RoomState {
  const spec = room.spectators.find((s) => s.cid === cid);
  if (!spec) return room; // 不在观战席（可能已上桌）
  const others = room.spectators.filter((s) => s.cid !== cid);
  const seat: SeatInfo = { cid, name: spec.name, ready: false, deckCount: 0 };
  if (!room.seat1) return { ...room, seat1: seat, spectators: others };
  if (!room.seat2) return { ...room, seat2: seat, spectators: others };
  return room; // 座位满了
}

/** 上桌玩家起立 → 回观战席 */
export function roomStand(room: RoomState, cid: number): RoomState {
  if (room.seat1?.cid === cid || room.seat2?.cid === cid) {
    const name = (room.seat1?.cid === cid ? room.seat1 : room.seat2)?.name ?? `玩家${cid + 1}`;
    return {
      ...room,
      seat1: room.seat1?.cid === cid ? null : room.seat1,
      seat2: room.seat2?.cid === cid ? null : room.seat2,
      spectators: [...room.spectators, { cid, name }],
    };
  }
  return room;
}

/** 上桌玩家准备（带上卡组张数）；不在座位上则忽略 */
export function roomReady(room: RoomState, cid: number, deckCount: number): RoomState {
  const set = (s: SeatInfo | null): SeatInfo | null =>
    s?.cid === cid ? { ...s, ready: true, deckCount: Math.max(s.deckCount, deckCount) } : s;
  return { ...room, seat1: set(room.seat1), seat2: set(room.seat2) };
}

/** 座位上的人选好卡组（房内选择；换卡组会取消准备） */
export function roomSetDeck(room: RoomState, cid: number, deckName: string, deckCount: number): RoomState {
  const set = (s: SeatInfo | null): SeatInfo | null =>
    s?.cid === cid ? { ...s, deckName, deckCount, ready: false } : s;
  return { ...room, seat1: set(room.seat1), seat2: set(room.seat2) };
}

/** 座位上的人是否已选卡组 */
export function seatDeckChosen(room: RoomState, cid: number): boolean {
  const s = room.seat1?.cid === cid ? room.seat1 : room.seat2?.cid === cid ? room.seat2 : null;
  return !!s?.deckName;
}

export function roomUnready(room: RoomState, cid: number): RoomState {
  const set = (s: SeatInfo | null): SeatInfo | null => (s?.cid === cid ? { ...s, ready: false } : s);
  return { ...room, seat1: set(room.seat1), seat2: set(room.seat2) };
}

/** 两个座位都有人且都已准备 → 可以开始 */
export function bothReady(room: RoomState): boolean {
  return !!room.seat1 && !!room.seat2 && room.seat1.ready && room.seat2.ready;
}

export function roomStartGame(room: RoomState): RoomState {
  return { ...room, phase: 'playing' };
}

/** 再来一局：回到大厅，座位保留，准备清空 */
export function roomRematch(room: RoomState): RoomState {
  const reset = (s: SeatInfo | null): SeatInfo | null => (s ? { ...s, ready: false } : s);
  return { ...room, phase: 'lobby', gameNum: room.gameNum + 1, seat1: reset(room.seat1), seat2: reset(room.seat2) };
}

/** 座位占用查询 */
export function seatOf(room: RoomState, cid: number): 'seat1' | 'seat2' | null {
  if (room.seat1?.cid === cid) return 'seat1';
  if (room.seat2?.cid === cid) return 'seat2';
  return null;
}

/** 我方在房间里的角色描述（供 UI 显示） */
export type MyRoomRole = 'seat1' | 'seat2' | 'spectator';
export function myRole(room: RoomState, cid: number): MyRoomRole {
  return seatOf(room, cid) ?? 'spectator';
}

/** 卡组是否已选（张数 > 0） */
export function hasDeck(room: RoomState, cid: number): boolean {
  const s = room.seat1?.cid === cid ? room.seat1 : room.seat2?.cid === cid ? room.seat2 : null;
  return !!s && s.deckCount > 0;
}
