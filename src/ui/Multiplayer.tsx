import { useEffect, useState } from 'react';
import { connectAuto, listRooms, createRoom, joinRoom, RelayRoom } from '../net/relay';

/** 多人游戏：自动连接内置服务器 → 房间列表 → 开房间 / 加入房间（网游式） */
export default function Multiplayer({
  playerName,
  onEnter,
  onBack,
}: {
  playerName: string;
  onEnter: (role: 'host' | 'guest', roomLabel: string) => void;
  onBack: () => void;
}) {
  const [conn, setConn] = useState<'connecting' | 'on' | 'err'>('connecting');
  const [err, setErr] = useState('');
  const [rooms, setRooms] = useState<RelayRoom[]>([]);
  const [roomName, setRoomName] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const list = await listRooms();
    setRooms(list);
  };

  const doConnect = async () => {
    setConn('connecting');
    setErr('');
    try {
      await connectAuto();
      setConn('on');
      await refresh();
    } catch (e) {
      setConn('err');
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void doConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 已连接 → 每 3 秒刷新房间列表
  useEffect(() => {
    if (conn !== 'on') return;
    const t = setInterval(() => {
      void refresh();
    }, 3000);
    return () => clearInterval(t);
  }, [conn]);

  const doCreate = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      if (conn !== 'on') await doConnect();
      const r = await createRoom(roomName.trim(), playerName);
      onEnter('host', r.name || `房间 ${r.roomId}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doJoin = async (room: RelayRoom) => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      if (conn !== 'on') await doConnect();
      const r = await joinRoom(room.id, playerName);
      onEnter('guest', r.name || room.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="multi-page">
      <h1>🌐 多人游戏</h1>

      <div className="multi-me">👤 我的ID：<b>{playerName}</b>（回主菜单右上角可改）</div>

      <div className="multi-statusbar">
        <span className={`multi-status ${conn === 'on' ? 'on' : conn === 'err' ? 'err' : ''}`}>
          {conn === 'on' ? '● 已连接服务器' : conn === 'connecting' ? '○ 正在连接服务器…' : '✕ 无法连接服务器'}
        </span>
        {conn === 'err' && (
          <button className="multi-retry" onClick={() => void doConnect()}>
            🔄 重试连接
          </button>
        )}
      </div>
      {err && <div className="multi-error">⚠️ {err}</div>}

      <div className="multi-create">
        <input
          className="net-input multi-room-name"
          value={roomName}
          onChange={(e) => setRoomName(e.target.value)}
          placeholder="房间名（可留空）"
        />
        <button className="primary" onClick={() => void doCreate()} disabled={busy}>
          ➕ 创建房间
        </button>
      </div>

      <div className="multi-list-head">
        <span>房间列表（{rooms.length}）</span>
        <button onClick={() => void refresh()}>🔄 刷新</button>
      </div>
      <div className="multi-list">
        {rooms.length === 0 && (
          <div className="multi-empty">
            {conn === 'on' ? '当前没有房间，可以自己创建一个。' : '尚未连接到服务器。'}
          </div>
        )}
        {rooms.map((r) => (
          <div key={r.id} className="multi-room">
            <div className="multi-room-main">
              <div className="multi-room-name">
                {r.name} <span className="multi-room-id">#{r.id}</span>
              </div>
              <div className="multi-room-meta">
                房主：{r.host} · 对局玩家 {r.players}/2 · 观战 {r.spectators} ·{' '}
                {r.phase === 'playing' ? '对局中' : '等待中'}
              </div>
            </div>
            <button onClick={() => void doJoin(r)} disabled={busy}>
              {r.phase === 'playing' ? '👁 观战' : '加入'}
            </button>
          </div>
        ))}
      </div>

      <div className="multi-actions">
        <button onClick={onBack}>← 返回主菜单</button>
        <span className="multi-hint">
          提示：先选好卡组再进来；创建房间后你就是房主。房主离开房间会自动关闭。
        </span>
      </div>
    </div>
  );
}
