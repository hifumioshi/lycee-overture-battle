import { RoomState, myRole, HOST_CID } from '../core/room';

/** 房间大厅：对战桌（两个座位）+ 观战席 + 选卡组/准备/上桌操作 */
export default function RoomLobby({
  room,
  myCid,
  myDeckName,
  netStatus,
  onSit,
  onStand,
  onPickDeck,
  onReady,
  onUnready,
  onLeave,
}: {
  room: RoomState;
  myCid: number;
  myDeckName?: string;
  netStatus: string;
  onSit: () => void;
  onStand: () => void;
  onPickDeck: () => void;
  onReady: () => void;
  onUnready: () => void;
  onLeave: () => void;
}) {
  const role = myRole(room, myCid);
  const meSeated = role === 'seat1' || role === 'seat2';
  const mySeat = room.seat1?.cid === myCid ? room.seat1 : room.seat2?.cid === myCid ? room.seat2 : null;
  const myReady = mySeat?.ready ?? false;
  const myDeckPicked = !!mySeat?.deckName;
  const bothSeatsFull = !!room.seat1 && !!room.seat2;

  const SeatCard = ({ title, seat, isMe }: { title: string; seat: RoomState['seat1']; isMe: boolean }) => (
    <div className={`room-seat${seat ? ' occupied' : ''}${isMe ? ' me' : ''}`}>
      <div className="room-seat-title">{title}</div>
      {seat ? (
        <>
          <div className="room-seat-name">
            {seat.name}
            {isMe && <em>（我）</em>}
          </div>
          <div className={`room-seat-deck${seat.deckName ? '' : ' none'}`}>
            {seat.deckName
              ? `🃏 ${seat.deckName}${seat.deckCount > 0 ? `（${seat.deckCount} 张）` : ''}`
              : '🃏 还没选卡组'}
          </div>
          <div className={`room-seat-ready${seat.ready ? ' yes' : ''}`}>{seat.ready ? '✓ 已准备' : '未准备'}</div>
        </>
      ) : (
        <div className="room-seat-empty">空位</div>
      )}
    </div>
  );

  return (
    <div className="room-lobby">
      <header className="room-lobby-header">
        <h1>🏠 房间大厅</h1>
        <span className="room-status">{netStatus}</span>
        <div className="room-lobby-actions">
          <button className="danger" onClick={onLeave}>
            {myCid === HOST_CID ? '关闭房间' : '离开房间'}
          </button>
        </div>
      </header>

      <div className="room-table-area">
        <div className="room-table">
          <div className="room-table-title">对 战 桌</div>
          <div className="room-seats">
            <SeatCard title="座位 1（玩家1）" seat={room.seat1} isMe={room.seat1?.cid === myCid} />
            <div className="room-vs">VS</div>
            <SeatCard title="座位 2（玩家2）" seat={room.seat2} isMe={room.seat2?.cid === myCid} />
          </div>
          {room.phase === 'playing' && <div className="room-playing-note">⚔ 对局进行中…</div>}
          {room.phase === 'lobby' && <div className="room-hint">双方都选好卡组并点「准备」后自动开始对局（第 {room.gameNum} 局）</div>}
        </div>

        <div className="room-controls">
          {meSeated ? (
            <>
              <div className={`room-mydeck${myDeckPicked ? '' : ' none'}`}>
                我的卡组：{mySeat?.deckName ?? '还没选择'}
                {mySeat?.deckName && mySeat.deckCount > 0 ? `（${mySeat.deckCount} 张）` : ''}
              </div>
              <button className="primary" onClick={onPickDeck}>
                🃏 {myDeckPicked ? '更换卡组' : '选择卡组'}
              </button>
              {myReady ? (
                <button className="primary" onClick={onUnready}>
                  取消准备
                </button>
              ) : (
                <button className="primary" onClick={onReady} disabled={!myDeckPicked}>
                  ✓ 准备{myDeckPicked ? '' : '（请先选卡组）'}
                </button>
              )}
              <button onClick={onStand}>起立（回观战席）</button>
            </>
          ) : (
            <>
              <button className="primary" onClick={onSit} disabled={bothSeatsFull}>
                🪑 参与上桌
              </button>
              {bothSeatsFull && <div className="room-note">两个座位都满了，只能观战</div>}
              <div className="room-note">上桌后先选卡组，再点「准备」，双方都准备好后自动开始对局</div>
            </>
          )}
          {myDeckName && <div className="room-note">（本机上次用的卡组：{myDeckName}）</div>}
        </div>
      </div>

      <div className="room-spectators">
        <div className="room-spectators-title">👁 观战席（{room.spectators.length} 人）</div>
        {room.spectators.length === 0 && <div className="room-spectators-empty">（暂无观战者）</div>}
        <div className="room-spectators-list">
          {room.spectators.map((s) => (
            <span key={s.cid} className={`room-spectator${s.cid === myCid ? ' me' : ''}`}>
              {s.cid === myCid ? `${s.name}（我）` : s.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
