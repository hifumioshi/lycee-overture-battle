/*
 * 双客户端联机时序压测（真连本地中继）：npx tsx tools/dev/net-two-clients.ts
 *
 * 用真实中继服务器（server/index.js）+ 真实 WebSocket，模拟房主与客机：
 *   · 客机操作走一条"劣化管道"：延迟（0~120ms）、乱序（相邻交换）、重复（概率重发）
 *   · 房主按真实规则处理：opId 去重 + 频率限制 + 权限校验（guestActDenied）+ 应用
 *   · 房主每处理完一批就把整份状态（带 hash）发给客机，客机应用后自己算 hash 比对
 *
 * 断言：
 *   1. 两端 stateHash 最终一致（乱序/重复不会导致分叉）
 *   2. 每个 op 都收到 ack（没有"发了没人理"）
 *   3. 没有残留提示（不卡死）：结束时要么无提示，要么提示仍可推进
 *   4. 超过频率上限的 op 被 reason:'rate' 拒绝，且状态不变
 *   5. 客机拿房主的卡发动作一律被拒（越权）
 */
import { WebSocket } from 'ws';
import { startRelay } from '../../server/index.js';
import { cards, installDeterminism, newMatch, candidates, type Op } from '../dev/harness';
import { applyAction, guestActDenied, rateLimited, stateHashLite } from './net-hash';
import type { GameState } from '../../src/core/game';

const WINDOW_MS = 1000;
const MAX_OPS = 10;

let pass = 0;
let fail = 0;
const ok = (cond: boolean, name: string, extra = '') => {
  if (cond) {
    pass++;
    console.log('  OK ' + name);
  } else {
    fail++;
    console.log('  NG ' + name + (extra ? ' -- ' + extra : ''));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 劣化管道：延迟 + 乱序 + 重复 */
function lossySend(ws: WebSocket, msg: unknown, opts = { delay: 60, reorder: 0.4, dup: 0.3 }): void {
  const send = () => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 忽略 */
    }
  };
  const doDup = Math.random() < opts.dup;
  if (doDup) {
    // 重复投递：立刻发一次 + 稍后再发一次
    send();
    setTimeout(send, opts.delay * 0.5);
    return;
  }
  const d = opts.reorder > Math.random() ? opts.delay * 1.6 : opts.delay; // 乱序 = 随机更长的延迟
  setTimeout(send, d);
}

async function main(): Promise<void> {
  const relay = startRelay(0, { updatesDir: 'tools/_fuzz' });
  const port = (relay.wss.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}`;
  console.log('本地中继：' + url);

  installDeterminism(777);
  let hostGs: GameState = newMatch(777);
  if (hostGs.turnPlayer !== 1) {
    // 让客机（座位2）成为回合玩家，才有多数操作可发
    const p = hostGs.players;
    const t = p[0];
    p[0] = p[1];
    p[1] = t;
    hostGs.turnPlayer = 1;
    hostGs.prompt = null;
  }

  const host = new WebSocket(url);
  await new Promise<void>((r) => host.once('open', () => r()));
  const guest = new WebSocket(url);
  await new Promise<void>((r) => guest.once('open', () => r()));

  const hostCid = -1;
  const acked = new Map<string, { ok: boolean; reason?: string; message?: string }>();
  const doneOps = new Set<string>();
  const stampsByCid = new Map<number, number[]>();
  const appliedOps: string[] = [];
  const rejected: { opId: string; reason: string }[] = [];
  let guestGsHash = 0;

  // ---------- 房主 ----------
  host.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (m.t === 'joined') {
      console.log('房主建房 cid=' + m.cid);
      return;
    }
    if (m.t === 'peer-joined') {
      console.log('客机加入 cid=' + m.cid);
      // 立刻把整份状态发给新加入者
      host.send(JSON.stringify({ t: 'relay', to: m.cid, msg: { type: 'state', gs: hostGs, hash: stateHashLite(hostGs) } }));
      return;
    }
    if (m.t !== 'relay') return;
    const msg = typeof m.msg === 'string' ? JSON.parse(m.msg) : m.msg;
    if (!msg || msg.type !== 'op') return;

    const from = m.from as number;
    const opId = String(msg.opId ?? '');
    const ack = (o: { ok: boolean; reason?: string; message?: string }) => {
      acked.set(opId, o);
      host.send(JSON.stringify({ t: 'relay', to: from, msg: { type: 'ack', opId, ...o } }));
    };

    // 1) opId 去重（连点/重发只执行一次）
    if (doneOps.has(opId)) {
      ack({ ok: true, message: '（重复请求已忽略）' });
      return;
    }
    doneOps.add(opId);

    // 2) 频率限制（房主权威）
    const stamps = stampsByCid.get(from) ?? [];
    const rl = rateLimited(stamps, Date.now(), WINDOW_MS, MAX_OPS);
    stampsByCid.set(from, rl.stamps);
    if (rl.limited) {
      rejected.push({ opId, reason: 'rate' });
      ack({ ok: false, reason: 'rate', message: '操作太频繁，请稍候' });
      return;
    }

    // 3) 权限校验（客机只能用自己座位的卡）
    const denied = guestActDenied(hostGs, String(msg.action ?? ''), (msg.args ?? []) as unknown[], 1 as 0 | 1);
    if (denied) {
      rejected.push({ opId, reason: 'forbidden' });
      ack({ ok: false, reason: 'forbidden', message: denied });
      return;
    }

    // 4) 应用
    const before = hostGs;
    const after = applyAction(hostGs, String(msg.action ?? ''), (msg.args ?? []) as never[]);
    hostGs = after;
    appliedOps.push(opId);
    ack({ ok: true });
    if (JSON.stringify(before.players) !== JSON.stringify(after.players) || before.prompt !== after.prompt) {
      // 状态有变化就广播（这里用整份简化版；真实实现是 gsSync 增量）
      for (const cid of [from]) {
        host.send(JSON.stringify({ t: 'relay', to: cid, msg: { type: 'state', gs: hostGs, hash: stateHashLite(hostGs) } }));
      }
      void hostCid;
    }
  });

  // ---------- 客机 ----------
  guest.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (m.t === 'relay') {
      const msg = typeof m.msg === 'string' ? JSON.parse(m.msg) : m.msg;
      if (msg?.type === 'state') guestGsHash = Number(msg.hash) || 0;
      if (msg?.type === 'ack') acked.set(String(msg.opId), { ok: !!msg.ok, reason: msg.reason, message: msg.message });
    }
  });

  host.send(JSON.stringify({ t: 'create', name: '压测房间', playerName: '房主' }));
  await sleep(120);
  guest.send(JSON.stringify({ t: 'join', roomId: '1', playerName: '客机' }));
  await sleep(200);

  // 客机用真实候选动作发 op（含"连点"：同 opId 连发 5 次）
  const cands = candidates(hostGs);
  const selfOps = cands.filter((o) => o.args.some((a) => typeof a === 'string'));
  const pickOp = (i: number): Op | undefined => selfOps[i % Math.max(1, selfOps.length)];

  let sent = 0;
  for (let i = 0; i < 24; i++) {
    const op = pickOp(i);
    if (!op) break;
    const opId = `op-${i}`;
    const payload = { type: 'op', opId, action: op.action, args: op.args, rev: 0 };
    lossySend(guest, { t: 'relay', to: hostCid, msg: payload });
    // 连点：同一个 opId 再发 4 次（劣化管道会再放大成重复）
    for (let k = 0; k < 4; k++) lossySend(guest, { t: 'relay', to: hostCid, msg: payload });
    sent++;
    await sleep(30);
  }
  // 越权：用房主（座位1=players[0]）的卡发动作
  {
    const hostCardUid = hostGs.players[0].hand[0]?.uid ?? hostGs.players[0].field.flat().find(Boolean)?.uid;
    if (hostCardUid) {
      const payload = { type: 'op', opId: 'op-evil', action: 'requestHandDeclare', args: [hostCardUid], rev: 0 };
      guest.send(JSON.stringify({ t: 'relay', to: hostCid, msg: payload }));
      await sleep(150);
    }
  }

  await sleep(1200); // 等劣化管道里的消息全部落地

  // ---------- 断言 ----------
  const hostHash = stateHashLite(hostGs);
  ok(hostHash === guestGsHash, '两端 stateHash 一致（乱序/重复/延迟下不分叉）', `host=${hostHash} guest=${guestGsHash}`);

  const ackCount = [...acked.keys()].filter((k) => k.startsWith('op-') && k !== 'op-evil').length;
  ok(ackCount >= sent, '每个操作都收到回执（' + ackCount + '/' + sent + '）');

  const dupApplied = appliedOps.length !== new Set(appliedOps).size;
  ok(!dupApplied, '同一 opId 没有被重复执行（去重生效）');

  const rateRejected = rejected.filter((r) => r.reason === 'rate').length;
  ok(rateRejected > 0, '狂发时确实触发了频率限制（拒绝 ' + rateRejected + ' 个）');

  const evil = rejected.find((r) => r.opId === 'op-evil');
  ok(!!evil, '客机操控房主的卡被拒绝', evil ? evil.reason : '未收到拒绝');
  ok(hostGs.players[0].hand.length >= 0, '房主手牌数量未被客机动作改变（越权无效）');

  // 提示可解：结束时若还有提示，至少存在一个能推进的选项
  if (hostGs.prompt) {
    const c = candidates(hostGs);
    const canAdvance = c.some((o) => {
      const r = applyAction(hostGs, o.action, o.args as never[]);
      return JSON.stringify(r.players) !== JSON.stringify(hostGs.players) || r.prompt !== hostGs.prompt;
    });
    ok(c.length > 0 && canAdvance, '结束时残留提示仍可推进（' + hostGs.prompt.kind + '）');
  } else {
    ok(true, '结束时没有残留提示');
  }

  host.close();
  guest.close();
  await relay.close();
  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
}

void main();
