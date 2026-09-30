// 远端（公网）中继服务器协议测试：node tools/test-relay-remote.mjs [host:port]
// 只连服务器、不开游戏，验证：建房/房间列表/多名客户端加入/peer-joined/消息中转/房主离开关房
import WebSocket from 'ws';

const target = process.argv[2] ?? '62.234.140.123:9600';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (n, c, extra = '') => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n}${extra ? '  → ' + extra : ''}`);
  }
};

function mk(name) {
  const c = { name, ws: new WebSocket(`ws://${target}`), cid: null, roomId: null, msgs: [], open: false };
  c.ws.on('open', () => {
    c.open = true;
  });
  c.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    c.msgs.push(m);
    if (m.t === 'joined') {
      c.cid = m.cid;
      c.roomId = m.roomId;
    }
  });
  c.ws.on('error', (e) => {
    c.err = String(e.message);
  });
  return c;
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
const recv = (c, t) => c.msgs.filter((m) => m.t === t);
const wait = async (fn, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(100);
  }
  return !!fn();
};

console.log(`\n远端中继测试 → ws://${target}\n`);

const H = mk('房主');
await wait(() => H.open, 8000);
check('1. 能连上公网服务器', H.open, H.err ?? '');

send(H, { t: 'create', name: '远端测试房', playerName: '房主' });
await wait(() => H.cid !== null);
check('2. 创建房间成功（房主 cid = -1）', H.cid === -1, `cid=${H.cid}`);

const L = mk('列表');
await wait(() => L.open);
send(L, { t: 'list' });
await wait(() => recv(L, 'rooms').length > 0);
const rooms = recv(L, 'rooms')[0]?.rooms ?? [];
check('3. 房间出现在列表里', rooms.some((r) => r.id === H.roomId && r.name === '远端测试房'), JSON.stringify(rooms));

const A = mk('A');
await wait(() => A.open);
send(A, { t: 'join', roomId: H.roomId, playerName: '小明' });
await wait(() => A.cid !== null);
check('4. 客户端A加入房间（cid ≥ 1）', typeof A.cid === 'number' && A.cid >= 1, `cid=${A.cid}`);
check('5. 房主收到 A 的 peer-joined', await wait(() => recv(H, 'peer-joined').some((m) => m.cid === A.cid)), JSON.stringify(recv(H, 'peer-joined')));

send(A, { t: 'relay', to: -1, msg: JSON.stringify({ type: 'sit' }) });
check(
  '6. A→房主 定向消息送达',
  await wait(() => recv(H, 'relay').some((m) => m.from === A.cid && JSON.parse(m.msg).type === 'sit')),
  JSON.stringify(recv(H, 'relay')),
);

send(H, { t: 'relay', msg: JSON.stringify({ type: 'room', room: { seat1: '房主', seat2: '小明' } }) });
check(
  '7. 房主→全体 广播送达 A',
  await wait(() => recv(A, 'relay').some((m) => JSON.parse(m.msg).type === 'room')),
);

const B = mk('B');
await wait(() => B.open);
send(B, { t: 'join', roomId: H.roomId, playerName: '小红' });
await wait(() => B.cid !== null);
check('8. 客户端B加入同一房间', typeof B.cid === 'number' && B.cid >= 1 && B.cid !== A.cid, `cid=${B.cid}`);
check(
  '9. 房主收到 B 的 peer-joined',
  await wait(() => recv(H, 'peer-joined').some((m) => m.cid === B.cid)),
  JSON.stringify(recv(H, 'peer-joined')),
);
send(B, { t: 'relay', to: -1, msg: JSON.stringify({ type: 'hello', name: '小红' }) });
check(
  '10. B→房主 定向消息送达',
  await wait(() => recv(H, 'relay').some((m) => m.from === B.cid && JSON.parse(m.msg).type === 'hello')),
  JSON.stringify(recv(H, 'relay').map((m) => m.from)),
);
send(H, { t: 'relay', msg: JSON.stringify({ type: 'room', room: { seat2: '小明', spectators: ['小红'] } }) });
check(
  '11. 第二条广播（含观战者）送达 B',
  await wait(() => recv(B, 'relay').some((m) => JSON.parse(m.msg).room?.spectators?.includes('小红'))),
  JSON.stringify(recv(B, 'relay').length),
);
send(H, { t: 'meta', phase: 'playing', players: 2, spectators: 1 });
await sleep(300);
send(L, { t: 'list' });
await wait(() => recv(L, 'rooms').length >= 2);
const meta = (recv(L, 'rooms').at(-1)?.rooms ?? []).find((r) => r.id === H.roomId);
check('12. 房主 meta 上报生效（人数/状态）', meta?.phase === 'playing' && meta?.spectators === 1, JSON.stringify(meta));

A.ws.close();
await sleep(500);
check('13. A 断开 → 房主收到 peer-left', await wait(() => recv(H, 'peer-left').some((m) => m.cid === A.cid)), JSON.stringify(recv(H, 'peer-left')));

H.ws.close();
await wait(() => recv(B, 'room-closed').length > 0);
check('14. 房主断线 → 房间关闭通知到 B', recv(B, 'room-closed').length > 0);
await wait(() => L.open && (send(L, { t: 'list' }), recv(L, 'rooms').length >= 3), 4000);
const after = recv(L, 'rooms').at(-1)?.rooms ?? [];
check('15. 关房后房间从列表移除', !after.some((r) => r.id === H.roomId), JSON.stringify(after.map((r) => r.id)));

B.ws.close();
L.ws.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
