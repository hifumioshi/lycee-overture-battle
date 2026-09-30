// 中继负载测试：node tools/test-relay-load.mjs [host:port]
// 验证「大消息（对局状态 ~160KB）」是否会把后面的小消息（房间广播）挤住/弄丢
import WebSocket from 'ws';

const target = process.argv[2] ?? '62.234.140.123:9600';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => Date.now() - t0;

const mk = (name) => {
  const c = { name, ws: new WebSocket(`ws://${target}`), cid: null, room: null, log: [] };
  c.ws.on('open', () => c.log.push(`${stamp()} open`));
  c.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'joined') c.cid = m.cid;
    if (m.t === 'relay') {
      const inner = JSON.parse(m.msg);
      c.log.push(`${stamp()} recv ${inner.type} ${m.msg.length}B`);
    }
  });
  return c;
};
const send = (c, o) => c.ws.send(JSON.stringify(o));

const H = mk('H');
await sleep(600);
send(H, { t: 'create', name: 'load', playerName: 'H' });
await sleep(400);
const A = mk('A');
await sleep(600);
send(A, { t: 'join', roomId: H.room || '1', playerName: 'A' });
// 用房间列表拿房间号（H.room 可能为空，这里直接取最新房间）
send(A, { t: 'list' });
await new Promise((r) => {
  A.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'rooms' && m.rooms.length) {
      A.room = m.rooms[0].id;
      r();
    }
  });
  setTimeout(r, 1500);
});
send(A, { t: 'join', roomId: A.room, playerName: 'A' });
await sleep(500);

const big = JSON.stringify({ type: 'state', gs: 'X'.repeat(160000) });
const small = (n) => JSON.stringify({ type: 'room', room: { tag: 'room' + n } });

console.log(`目标服务器 ws://${target}\n`);
console.log('—— 第 1 轮：先发 3 条 160KB 大消息，再发 2 条小房间消息 ——');
for (let i = 1; i <= 3; i++) send(H, { t: 'relay', to: A.cid, msg: big });
const s1 = stamp();
send(H, { t: 'relay', msg: small(1) });
send(H, { t: 'relay', msg: small(2) });
console.log(`H 在 ${s1}ms 发出 2 条小消息（约 320B）`);
await sleep(12000);
console.log('A 收到的时间线：');
for (const l of A.log) console.log('   ' + l);

console.log('\n—— 第 2 轮：只发 2 条小房间消息（无大消息干扰）——');
A.log.length = 0;
send(H, { t: 'relay', msg: small(3) });
send(H, { t: 'relay', msg: small(4) });
await sleep(4000);
console.log('A 收到的时间线：');
for (const l of A.log) console.log('   ' + l);

H.ws.close();
A.ws.close();
process.exit(0);
