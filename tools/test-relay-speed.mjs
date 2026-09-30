// 中继链路速度探测：node tools/test-relay-speed.mjs [host:port]
// 测：小消息往返延迟（RTT）+ 不同大小消息的实际吞吐
import WebSocket from 'ws';

const target = process.argv[2] ?? '62.234.140.123:9600';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mk = () => {
  const c = { ws: new WebSocket(`ws://${target}`), cid: null, inbox: [] };
  c.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'joined') c.cid = m.cid;
    c.inbox.push({ t: Date.now(), raw: d.toString() });
  });
  return c;
};
const send = (c, o) => c.ws.send(JSON.stringify(o));
const waitFor = async (c, pred, ms = 30000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const hit = c.inbox.find(pred);
    if (hit) return hit;
    await sleep(20);
  }
  return null;
};

console.log(`链路探测 → ws://${target}\n`);

// RTT：连上后立刻 list，测 rooms 回来要多久
const rtts = [];
for (let i = 0; i < 5; i++) {
  const c = mk();
  await new Promise((r) => c.ws.on('open', r));
  const t = Date.now();
  send(c, { t: 'list' });
  await waitFor(c, (m) => m.raw.includes('"t":"rooms"'));
  rtts.push(Date.now() - t);
  c.ws.close();
  await sleep(150);
}
console.log(`小消息往返延迟（RTT，5 次）：${rtts.join(' / ')} ms   平均 ${Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)} ms`);

// 吞吐：H 建房，A 加入，H 发不同大小的消息，测 A 收到要多久
const H = mk();
await new Promise((r) => H.ws.on('open', r));
send(H, { t: 'create', name: 'speed', playerName: 'H' });
await sleep(400);
const A = mk();
await new Promise((r) => A.ws.on('open', r));
send(A, { t: 'list' });
const roomsMsg = await waitFor(A, (m) => m.raw.includes('"t":"rooms"'));
const rooms = JSON.parse(roomsMsg.raw).rooms;
send(A, { t: 'join', roomId: rooms[0].id, playerName: 'A' });
await sleep(600);
console.log(`A 已加入房间 ${rooms[0].id}（cid=${A.cid}）\n`);

for (const kb of [1, 16, 64, 160, 320]) {
  A.inbox.length = 0;
  const payload = JSON.stringify({ type: 'state', pad: 'X'.repeat(kb * 1024) });
  const t = Date.now();
  send(H, { t: 'relay', to: A.cid, msg: payload });
  const hit = await waitFor(A, (m) => m.raw.length >= payload.length, 40000);
  const ms = hit ? hit.t - t : -1;
  if (ms < 0) console.log(`  ${kb} KB → 超时（40 秒内没收到）`);
  else console.log(`  ${kb} KB → ${ms} ms   （约 ${Math.round((kb * 1024) / (ms / 1000) / 1024)} KB/s）`);
  await sleep(600);
}

// 反向：A → H
A.inbox.length = 0;
H.inbox.length = 0;
const payload = JSON.stringify({ type: 'hello', pad: 'Y'.repeat(160 * 1024) });
const t = Date.now();
send(A, { t: 'relay', to: -1, msg: payload });
const hit = await waitFor(H, (m) => m.raw.length >= payload.length, 40000);
const ms = hit ? hit.t - t : -1;
console.log(`\n反向（客户端 → 房主）160 KB → ${ms < 0 ? '超时' : ms + ' ms   （约 ' + Math.round(160 / (ms / 1000)) + ' KB/s）'}`);

H.ws.close();
A.ws.close();
process.exit(0);
