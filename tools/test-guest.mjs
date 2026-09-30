// 客机端到端测试脚本（容忍式）：模拟玩家 2 连接房主，验证联机协议
// 用法：node tools/test-guest.mjs
// 需与房主（electron + SHOT_TEST）同时启动
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

const URL = process.env.GUEST_URL || 'ws://127.0.0.1:9527';
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.log(`✗ ${name} ${extra ?? ''}`);
  }
}

function connectWithRetry() {
  return new Promise((resolve) => {
    const attempt = () => {
      const ws = new WebSocket(URL);
      // 成功连接后清掉重连处理器，避免泄漏多余连接
      ws.once('open', () => {
        ws.removeAllListeners('error');
        ws.removeAllListeners('close');
        resolve(ws);
      });
      ws.once('error', () => {
        ws.close();
        setTimeout(attempt, 500);
      });
      ws.once('close', () => setTimeout(attempt, 500));
    };
    attempt();
  });
}

function send(ws, action, ...args) {
  console.log(`[guest→host] action=${action}`);
  ws.send(JSON.stringify({ type: 'action', action, args }));
}

/** 等待满足条件的下一个状态（记录收到的全部状态供调试） */
function makeStateWatcher(ws) {
  let latest = null;
  const seen = [];
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (m.type === 'state') {
        latest = m.gs;
        seen.push(m.gs);
        const last = m.gs.log[m.gs.log.length - 1];
        console.log(`[host→guest] state turn=${m.gs.turnPlayer} phase=${m.gs.phase} lastLog=${last}`);
      }
    } catch {
      /* ignore */
    }
  });
  return {
    get latest() {
      return latest;
    },
    seen,
    async waitFor(predicate, timeoutMs, label) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (latest && predicate(latest)) return latest;
        await new Promise((r) => setTimeout(r, 100));
      }
      console.log(`⏰ 等待超时: ${label}`);
      return null;
    },
  };
}

const ws = await connectWithRetry();
console.log('✓ 客机已连接到', URL);
const watcher = makeStateWatcher(ws);

// 1. 收到任意状态
const anyState = await watcher.waitFor(() => true, 25000, '任意状态');
ok('收到房主的状态快照', !!anyState);
ok('状态含双方玩家与牌堆', anyState?.players?.length === 2 && anyState?.cardsById && Object.keys(anyState.cardsById).length > 0);

// 2. 等房主开始回合（turnPlayer=0, phase=main）
const hostMain = await watcher.waitFor((g) => g.turnPlayer === 0 && g.phase === 'main', 30000, '房主开始回合');
ok('房主开始回合（玩家1 主阶段）', !!hostMain);

// 3. 客机（玩家2）在房主回合越权「开始回合」→ 应被拒绝
send(ws, 'beginTurn');
const rejected = await watcher.waitFor((g) => g.log.some((l) => l.includes('被拒绝')), 10000, '越权被拒');
ok('客机越权操作被房主拒绝', !!rejected);

// 4. 等房主结束回合（turnPlayer=1, phase=start）
const guestTurn = await watcher.waitFor((g) => g.turnPlayer === 1 && g.phase === 'start', 30000, '房主结束回合');
ok('回合交给客机（玩家2 开始阶段）', !!guestTurn);

// 5. 客机合法「开始回合」→ 生效
send(ws, 'beginTurn');
const guestMain = await watcher.waitFor((g) => g.turnPlayer === 1 && g.phase === 'main', 10000, '客机开始回合');
ok('客机「开始回合」生效', !!guestMain);
ok('客机抽牌后手牌 ≥7', (guestMain?.players[1].hand.length ?? 0) >= 7);

// 6. 客机结束回合 → 交回房主（发送前确认是自己回合，可能触发手牌调整）
if (watcher.latest?.turnPlayer === 1 && watcher.latest?.phase === 'main') {
  send(ws, 'endTurn');
}
let backToHost = await watcher.waitFor((g) => g.turnPlayer === 0 && g.phase === 'start', 8000, '客机结束回合');
if (!backToHost) {
  // 可能弹出手牌调整（抽 2 后手牌 >8）
  const adjust = await watcher.waitFor((g) => g.prompt?.kind === 'hand-adjust', 8000, '手牌调整');
  ok('结束回合触发手牌调整（超 8 张）', !!adjust);
  if (adjust) {
    const need = adjust.prompt.need;
    const hand = adjust.players[adjust.turnPlayer].hand;
    send(ws, 'confirmDiscard', hand.slice(0, need).map((c) => c.uid));
    backToHost = await watcher.waitFor((g) => g.turnPlayer === 0 && g.phase === 'start', 8000, '调整后交回房主');
  }
}
ok('客机结束回合，回合交回房主', !!backToHost);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
try {
  ws.close();
} catch {
  /* ignore */
}
process.exit(fail > 0 ? 1 : 0);
