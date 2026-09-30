// Lycee Overture 联机中继服务器（大厅 + 房间 + 消息中转）
// 用法：node server/index.js [端口]（默认 9600）
// 房主仍是"游戏主机"（规则运算在房主客户端），本服务器只负责：
//   · 房间列表（开房/加入）
//   · 房间内消息中转（房主广播 ↔ 客机操作）
// 房间内 cid 约定：房主 = -1（与客户端 room.ts 的 HOST_CID 一致），其他成员从 1 递增。
const { WebSocketServer } = require('ws');

const HOST_CID = -1;

function startRelay(port = 9600) {
  /** roomId -> { id, name, hostName, meta:{phase,players,spectators}, members: Map<cid, ws>, nextCid } */
  const rooms = new Map();
  let nextRoomId = 1;

  const wss = new WebSocketServer({ port });

  const send = (ws, obj) => {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch {
      /* 忽略 */
    }
  };

  const roomList = () =>
    [...rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      host: r.hostName,
      players: r.meta.players,
      spectators: r.meta.spectators,
      phase: r.meta.phase,
      full: r.meta.players >= 2,
    }));

  const hostWsOf = (r) => r.members.get(HOST_CID) ?? null;

  const broadcastRoom = (r, obj, exceptCid) => {
    for (const [cid, ws] of r.members) {
      if (exceptCid !== undefined && cid === exceptCid) continue;
      send(ws, obj);
    }
  };

  const leaveRoom = (ws) => {
    if (!ws.roomId) return;
    const r = rooms.get(ws.roomId);
    ws.roomId = null;
    ws.cid = null;
    if (!r) return;
    const cid = ws.cidOfRoom;
    r.members.delete(cid);
    ws.cidOfRoom = null;
    if (cid === HOST_CID) {
      // 房主离开 = 房间关闭
      broadcastRoom(r, { t: 'room-closed' });
      rooms.delete(r.id);
      console.log(`[relay] room ${r.id} closed (host left)`);
      return;
    }
    const hw = hostWsOf(r);
    if (hw) send(hw, { t: 'peer-left', cid });
    // 房主 meta 人数由房主自己上报，这里仅在无人时兜底
    if (r.members.size === 0) rooms.delete(r.id);
  };

  const handle = (ws, m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'list') {
      send(ws, { t: 'rooms', rooms: roomList() });
      return;
    }
    if (m.t === 'create') {
      if (ws.roomId) leaveRoom(ws);
      const id = String(nextRoomId++);
      const r = {
        id,
        name: (m.name || '').trim() || `房间 ${id}`,
        hostName: (m.playerName || '').trim() || '房主',
        meta: { phase: 'lobby', players: 1, spectators: 0 },
        members: new Map(),
        nextCid: 1,
      };
      r.members.set(HOST_CID, ws);
      rooms.set(id, r);
      ws.roomId = id;
      ws.cidOfRoom = HOST_CID;
      send(ws, { t: 'joined', roomId: id, cid: HOST_CID, isHost: true, name: r.name });
      console.log(`[relay] room ${id} created by ${r.hostName}`);
      return;
    }
    if (m.t === 'join') {
      const r = rooms.get(String(m.roomId ?? ''));
      if (!r) {
        send(ws, { t: 'error', message: '房间不存在或已关闭' });
        return;
      }
      if (ws.roomId) leaveRoom(ws);
      const cid = r.nextCid++;
      r.members.set(cid, ws);
      ws.roomId = r.id;
      ws.cidOfRoom = cid;
      ws.playerName = (m.playerName || '').trim() || `玩家${cid}`;
      send(ws, { t: 'joined', roomId: r.id, cid, isHost: false, name: r.name, hostCid: HOST_CID });
      const hw = hostWsOf(r);
      if (hw) send(hw, { t: 'peer-joined', cid, name: ws.playerName });
      console.log(`[relay] client ${cid} joined room ${r.id}`);
      return;
    }
    if (m.t === 'relay') {
      const r = rooms.get(ws.roomId);
      if (!r) return;
      const payload = { t: 'relay', from: ws.cidOfRoom, msg: m.msg };
      if (m.to !== undefined && m.to !== null) {
        const tw = r.members.get(m.to);
        if (tw) send(tw, payload);
      } else {
        broadcastRoom(r, payload, ws.cidOfRoom);
      }
      return;
    }
    if (m.t === 'meta') {
      const r = rooms.get(ws.roomId);
      if (!r || ws.cidOfRoom !== HOST_CID) return;
      r.meta = {
        phase: m.phase ?? r.meta.phase,
        players: typeof m.players === 'number' ? m.players : r.meta.players,
        spectators: typeof m.spectators === 'number' ? m.spectators : r.meta.spectators,
      };
      if (typeof m.name === 'string' && m.name.trim()) r.name = m.name.trim();
      return;
    }
    if (m.t === 'leave') {
      leaveRoom(ws);
      return;
    }
  };

  wss.on('connection', (ws) => {
    ws.roomId = null;
    ws.cidOfRoom = null;
    ws.playerName = '玩家';
    ws.on('message', (data) => {
      try {
        handle(ws, JSON.parse(data.toString()));
      } catch {
        /* 忽略坏消息 */
      }
    });
    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => {
      /* 忽略单个连接错误 */
    });
    // 心跳：清理死连接
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* 忽略 */
      }
    }
  }, 30000);
  wss.on('close', () => clearInterval(heartbeat));

  return {
    wss,
    rooms,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

module.exports = { startRelay, HOST_CID };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 9600);
  startRelay(port);
  console.log(`[relay] Lycee 中继服务器已启动：ws://0.0.0.0:${port}`);
}
