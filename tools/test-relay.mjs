// 中继服务器协议端到端测试（运行：npx tsx tools/test-relay.mjs）
import { startRelay } from '../server/index.js';
import WebSocket from 'ws';

const PORT = 9701;
const relay = startRelay(PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = () =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on('open', () => resolve(ws));
  });
const send = (ws, o) => ws.send(JSON.stringify(o));
const once = (ws, t, ms = 3000) =>
  new Promise((resolve) => {
    const h = (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === t) {
        ws.off('message', h);
        resolve(m);
      }
    };
    ws.on('message', h);
    setTimeout(() => resolve(null), ms);
  });

let pass = 0;
let fail = 0;
const check = (n, c, extra = '') => {
  if (c) {
    pass++;
    console.log(`✓ ${n}`);
  } else {
    fail++;
    console.log(`✗ ${n} ${extra}`);
  }
};

const host = await connect();
const guest = await connect();
const spec = await connect();

// 1. 创建房间
send(host, { t: 'create', name: '测试房间', playerName: '房主A' });
const created = await once(host, 'joined');
check('创建房间：房主 cid=-1、有 roomId', !!created && created.cid === -1 && !!created.roomId, JSON.stringify(created));

// 2. 房间列表
send(spec, { t: 'list' });
const list1 = await once(spec, 'rooms');
check('房间列表包含新房间', (list1?.rooms ?? []).some((r) => r.id === created.roomId && r.name === '测试房间'), JSON.stringify(list1));

// 3. 观战者加入
send(spec, { t: 'join', roomId: created.roomId, playerName: '观战C' });
const joinedSpec = await once(spec, 'joined');
check('观战者加入房间（cid=1）', !!joinedSpec && joinedSpec.cid === 1, JSON.stringify(joinedSpec));

// 4. 玩家加入
send(guest, { t: 'join', roomId: created.roomId, playerName: '玩家B' });
const joined = await once(guest, 'joined');
check('玩家加入房间（cid=2）', !!joined && joined.cid === 2, JSON.stringify(joined));
const peer = await once(host, 'peer-joined');
check('房主收到 peer-joined', !!peer && peer.cid === 2, JSON.stringify(peer));

// 5. 客机 → 房主 定向消息（action）
const relayedP = once(host, 'relay');
send(guest, { t: 'relay', to: -1, msg: JSON.stringify({ type: 'action', action: 'x' }) });
const relayed = await relayedP;
check('客机 action 到达房主（from=2）', !!relayed && relayed.from === 2 && relayed.msg.includes('action'), JSON.stringify(relayed));

// 6. 房主 → 广播（房内其他人：客机 + 观战者都能收到）
const bGuestP = once(guest, 'relay');
const bSpecP = once(spec, 'relay');
send(host, { t: 'relay', msg: JSON.stringify({ type: 'state', gs: 1 }) });
const [bGuest, bSpec] = await Promise.all([bGuestP, bSpecP]);
check('房主广播到达客机与观战者', !!bGuest && !!bSpec && bGuest.from === -1, JSON.stringify({ g: !!bGuest, s: !!bSpec }));

// 7. meta 上报 → 房间列表人数
send(host, { t: 'meta', phase: 'lobby', players: 2, spectators: 1 });
await sleep(150);
send(spec, { t: 'list' });
const list2 = await once(spec, 'rooms');
const room2 = (list2?.rooms ?? []).find((r) => r.id === created.roomId);
check('meta 上报后列表显示 玩家2/观战1', !!room2 && room2.players === 2 && room2.spectators === 1, JSON.stringify(room2));

// 8. 客机断开 → 房主收到 peer-left
const leftP = once(host, 'peer-left');
guest.close();
const left = await leftP;
check('客机断开 → 房主收到 peer-left', !!left && left.cid === 2, JSON.stringify(left));

// 9. 房主离开 → 房间关闭
const closedP = once(spec, 'room-closed');
host.close();
const closed = await closedP;
check('房主离开 → 房内收到房间关闭', !!closed, JSON.stringify(closed));
await sleep(150);
send(spec, { t: 'list' });
const list3 = await once(spec, 'rooms');
check('房间已从列表移除', !(list3?.rooms ?? []).some((r) => r.id === created.roomId), JSON.stringify(list3));

spec.close();
await relay.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
