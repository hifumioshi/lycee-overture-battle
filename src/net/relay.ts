// 联机中继客户端（渲染进程直接连公网/本地中继服务器）
// 房主与客机都通过这里收发：房主 broadcast/sendTo，客机定向发给房主（cid = -1 = HOST_CID）
import { HOST_CID } from '../core/room';

/** 联机服务器地址（内置默认；自建服务器请在程序目录放 data/relay.txt，写一行 ip:port） */
export const DEFAULT_RELAY_URL = '62.234.140.123:9600';
/** 备用地址：都连不上时依次尝试（本地调试时双击「启动中继服务器.bat」走这里） */
export const RELAY_FALLBACKS = ['127.0.0.1:9600'];

/** 候选地址：自定义（data/relay.txt）→ 内置默认 → 本机兜底 */
export async function relayCandidates(): Promise<string[]> {
  const list: string[] = [];
  try {
    const api = (window as { lyceeRelay?: { url(): Promise<string> } }).lyceeRelay;
    const custom = api ? (await api.url()).trim() : '';
    if (custom) list.push(custom);
  } catch {
    /* 忽略（非 Electron 环境没有这个接口） */
  }
  list.push(DEFAULT_RELAY_URL, ...RELAY_FALLBACKS);
  return list;
}

/** 依次尝试候选地址，返回连接成功的那个地址 */
export async function connectAuto(): Promise<string> {
  const list = await relayCandidates();
  let lastErr: unknown = null;
  for (const u of list) {
    try {
      await connect(u);
      return u;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('无法连接服务器');
}

export interface RelayRoom {
  id: string;
  name: string;
  host: string;
  players: number;
  spectators: number;
  phase: string;
  full: boolean;
}

type Msg = Record<string, unknown>;
type Handler<T> = (v: T) => void;

const listeners = {
  message: new Set<(from: number, msg: string) => void>(),
  peerJoined: new Set<(cid: number, name: string) => void>(),
  peerLeft: new Set<(cid: number) => void>(),
  closed: new Set<() => void>(),
};

let ws: WebSocket | null = null;
let myCid: number | null = null;
let roomId: string | null = null;
let isHost = false;
let url = '';

function raw(o: Msg) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
  } catch {
    /* 忽略 */
  }
}

/** 连接中继服务器（已连接则直接复用） */
export function connect(targetUrl: string): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN && url === targetUrl) return Promise.resolve();
  url = targetUrl;
  return new Promise((resolve, reject) => {
    try {
      ws?.close();
    } catch {
      /* 忽略 */
    }
    const sock = new WebSocket(`ws://${targetUrl}`);
    ws = sock;
    const timer = setTimeout(() => reject(new Error('连接超时（服务器地址是否正确？）')), 8000);
    sock.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    sock.onerror = () => {
      clearTimeout(timer);
      reject(new Error('无法连接服务器'));
    };
    sock.onclose = () => {
      for (const cb of listeners.closed) cb();
    };
    sock.onmessage = (e) => {
      let m: Msg | null = null;
      try {
        m = JSON.parse(String(e.data)) as Msg;
      } catch {
        return;
      }
      const t = m.t as string;
      if (t === 'relay') {
        const from = m.from as number;
        const msg = m.msg as string;
        for (const cb of listeners.message) cb(from, msg);
      } else if (t === 'peer-joined') {
        for (const cb of listeners.peerJoined) cb(m.cid as number, (m.name as string) ?? '');
      } else if (t === 'peer-left') {
        for (const cb of listeners.peerLeft) cb(m.cid as number);
      }
    };
  });
}

/** 拉取房间列表 */
export function listRooms(): Promise<RelayRoom[]> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve([]);
      return;
    }
    const handler = (e: MessageEvent) => {
      try {
        const m = JSON.parse(String(e.data)) as Msg;
        if (m.t === 'rooms') {
          ws?.removeEventListener('message', handler);
          resolve((m.rooms as RelayRoom[]) ?? []);
        }
      } catch {
        /* 忽略 */
      }
    };
    ws.addEventListener('message', handler);
    raw({ t: 'list' });
    setTimeout(() => {
      ws?.removeEventListener('message', handler);
      resolve([]);
    }, 4000);
  });
}

function waitJoined(): Promise<{ roomId: string; cid: number; isHost: boolean; name: string }> {
  return new Promise((resolve, reject) => {
    if (!ws) {
      reject(new Error('未连接服务器'));
      return;
    }
    const handler = (e: MessageEvent) => {
      try {
        const m = JSON.parse(String(e.data)) as Msg;
        if (m.t === 'joined') {
          ws?.removeEventListener('message', handler);
          resolve({ roomId: m.roomId as string, cid: m.cid as number, isHost: !!m.isHost, name: (m.name as string) ?? '' });
        } else if (m.t === 'error') {
          ws?.removeEventListener('message', handler);
          reject(new Error((m.message as string) ?? '服务器错误'));
        }
      } catch {
        /* 忽略 */
      }
    };
    ws.addEventListener('message', handler);
    setTimeout(() => {
      ws?.removeEventListener('message', handler);
      reject(new Error('服务器无响应'));
    }, 8000);
  });
}

/** 创建房间（自己成为房主） */
export async function createRoom(roomName: string, playerName: string) {
  if (!ws) throw new Error('未连接服务器');
  raw({ t: 'create', name: roomName, playerName });
  const r = await waitJoined();
  myCid = r.cid;
  roomId = r.roomId;
  isHost = r.isHost;
  return r;
}

/** 加入已有房间 */
export async function joinRoom(targetRoomId: string, playerName: string) {
  if (!ws) throw new Error('未连接服务器');
  raw({ t: 'join', roomId: targetRoomId, playerName });
  const r = await waitJoined();
  myCid = r.cid;
  roomId = r.roomId;
  isHost = r.isHost;
  return r;
}

/** 房主 → 广播给房内其他人（不含自己） */
export function broadcast(obj: unknown) {
  raw({ t: 'relay', msg: JSON.stringify(obj) });
}

/** 定向发送（客机通常发给房主 HOST_CID） */
export function sendTo(cid: number, obj: unknown) {
  raw({ t: 'relay', to: cid, msg: JSON.stringify(obj) });
}

/** 房主上报房间元信息（供房间列表显示人数/状态） */
export function reportMeta(meta: { phase?: string; players?: number; spectators?: number; name?: string }) {
  raw({ t: 'meta', ...meta });
}

export function onMessage(cb: (from: number, msg: string) => void): () => void {
  listeners.message.add(cb);
  return () => listeners.message.delete(cb);
}
export function onPeerJoined(cb: (cid: number, name: string) => void): () => void {
  listeners.peerJoined.add(cb);
  return () => listeners.peerJoined.delete(cb);
}
export function onPeerLeft(cb: (cid: number) => void): () => void {
  listeners.peerLeft.add(cb);
  return () => listeners.peerLeft.delete(cb);
}
export function onClosed(cb: () => void): () => void {
  listeners.closed.add(cb);
  return () => listeners.closed.delete(cb);
}

export function leave() {
  raw({ t: 'leave' });
  myCid = null;
  roomId = null;
  isHost = false;
}

export function close() {
  try {
    ws?.close();
  } catch {
    /* 忽略 */
  }
  ws = null;
  myCid = null;
  roomId = null;
  isHost = false;
}

export function status() {
  return { myCid, roomId, isHost, url, open: !!ws && ws.readyState === WebSocket.OPEN };
}

export { HOST_CID };
