// 增量同步自检：npx tsx tools/test-gssync.ts
// 逐包把「房主状态」编成增量包并在一份客机副本上还原，验证：
//   ① 还原后的状态与房主完全一致（含日志、含 cardsById 补齐）
//   ② 增量包体积远小于整份（对比 full）
//   ③ 漏包 → needResync；补发整份后恢复正常
//   ④ 悔棋（日志回退）也能正确同步
import { readFileSync } from 'node:fs';
import type { Card } from '../src/core/cards';
import { createEmptyGame, newInstance, pushLog, PlayerIndex } from '../src/core/game';
import * as rules from '../src/core/rules';
import { startGame } from '../src/core/sampleDeck';
import { resetEncode, resetDecode, encodeState, decodeState, packetSize, fullSize, slotsOf } from '../src/net/gsSync';

const cards: Card[] = JSON.parse(readFileSync('data/cards/range.json', 'utf-8'));
const byId = new Map(cards.map((c) => [c.id, c]));

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`);
  }
};

// 用固定顺序的牌组，保证可复现
const deckA = ['LO-6845', 'LO-6846', 'LO-6847', 'LO-6848', 'LO-6849', 'LO-6850', 'LO-6851', 'LO-6852', 'LO-6853', 'LO-6854'];
const deckB = ['LO-6855', 'LO-6856', 'LO-6857', 'LO-6858', 'LO-6859', 'LO-6860', 'LO-6861', 'LO-6862', 'LO-6863', 'LO-6864'];

console.log('\n① 增量同步正确性（跑一局，逐步比对房主/客机状态）');

let gs = startGame(cards, deckA, deckB);
gs.players[0].name = '阿尔';
gs.players[1].name = '小明';
resetEncode();
resetDecode();

let guest = null as ReturnType<typeof decodeState>['gs'];
let mismatch = 0;
let firstMismatch = '';
let patchBytes = 0;
let fullBytes = 0;
let packets = 0;
let largest = 0;

const step = (label: string, next: typeof gs) => {
  gs = next;
  const pkt = encodeState(gs);
  const size = packetSize(pkt);
  const full = fullSize(gs);
  packets++;
  patchBytes += size;
  fullBytes += full;
  largest = Math.max(largest, pkt.kind === 'patch' ? size : 0);
  const res = decodeState(guest, pkt, cards);
  if (res.needResync || !res.gs) {
    mismatch++;
    if (!firstMismatch) firstMismatch = `${label}: needResync`;
    return;
  }
  guest = res.gs;
  const a = JSON.stringify(gs);
  const b = JSON.stringify(guest);
  if (a !== b) {
    mismatch++;
    if (!firstMismatch) firstMismatch = `${label}: 状态不一致`;
  }
};

// 开局：整份
step('开局整份', gs);

// 真实的规则动作
step('双方就位', rules.markReady(gs));
step('玩家1 出拳', rules.chooseRps(gs, 0, 'rock'));
step('玩家2 出拳', rules.chooseRps(gs, 1, 'scissors'));
step('确认先后攻', rules.confirmRpsResult(gs));
step('玩家1 换牌', rules.chooseMulligan(gs, true));
step('玩家2 换牌', rules.chooseMulligan(gs, false));
step('开始回合', rules.beginTurn(gs));
step('抽 1 张', rules.manualDraw(gs, 0));
step('抽 3 张', rules.manualDraw(gs, 0));
step('弃牌堆顶 2 张', rules.manualDeckDiscard(gs, 0));
step('结束回合', rules.endTurn(gs));

// 手工制造更多变化：场上角色、费用池、置き場、tempMods、装备等
const putField = (g: typeof gs, p: PlayerIndex, cardId: string, row: 0 | 1, area: 0 | 1 | 2, opts: { tap?: boolean; equip?: string; under?: string; charge?: string } = {}) => {
  const inst = newInstance(cardId);
  inst.faceUp = true;
  if (opts.tap) inst.tapped = true;
  if (opts.equip) {
    const e = newInstance(opts.equip);
    e.faceUp = true;
    inst.equip = e;
  }
  if (opts.under) inst.under = [newInstance(opts.under)];
  if (opts.charge) inst.charge = [newInstance(opts.charge)];
  g.players[p].field[row][area] = inst;
  return g;
};

step('玩家1 登场角色', putField(gs, 0, 'LO-6845', 0, 1, { equip: 'LO-6846', under: 'LO-6847', charge: 'LO-6848' }));
step('玩家2 登场角色', putField(gs, 1, 'LO-6855', 1, 0, { tap: true }));
step('产费', rules.useCostAbility({ ...gs, players: [{ ...gs.players[0], field: gs.players[0].field }, gs.players[1]] } as typeof gs, (gs.players[0].field[0][1] as { uid: string }).uid));
step('置き場写入', (() => {
  const n = { ...gs, players: [{ ...gs.players[0] }, { ...gs.players[1] }] } as typeof gs;
  n.players[0].storage = { ...n.players[0].storage, 青春カウント: [newInstance('LO-6849')] };
  n.players[1].exPool = [{ elem: '月', points: 2, tag: 't1' }];
  n.players[0].perTurn = { ...n.players[0].perTurn, 'x:1': 2 };
  n.players[0].turnCounters = { oppDiscarded: 1 };
  return n;
})());
step('手动加日志', pushLog(gs, '测试：一条很长的日志内容，用于验证 log 只发增量而不是整份日志数组。'));
step('再加一条日志', pushLog(gs, '测试：第二条日志。'));
step('再来一条日志', pushLog(gs, '测试：第三条日志。'));

// 悔棋式回退：日志被截断 → 应改发整份日志
const shrunk = { ...gs, log: gs.log.slice(0, 2) };
step('悔棋（日志回退）', shrunk);

check('全程每一步客机状态与房主一致', mismatch === 0, firstMismatch);
check('发送 ≥ 15 个包', packets >= 15, `实际 ${packets}`);
check(
  `增量包平均体积远小于整份（平均 ${Math.round(patchBytes / packets)}B vs 整份 ${Math.round(fullBytes / packets)}B）`,
  patchBytes / packets < fullBytes / packets / 5,
  `压缩比 ${(fullBytes / patchBytes).toFixed(1)}×`,
);
check(`单个增量包最大 ${largest}B（不含开局整份）`, largest < 40000);

console.log('\n② 体积实测（本局）');
console.log(`     整份状态合计：${fullBytes} B（平均 ${Math.round(fullBytes / packets)} B/次）`);
console.log(`     增量同步合计：${patchBytes} B（平均 ${Math.round(patchBytes / packets)} B/次，最大单包 ${largest} B）`);
console.log(`     节省：${(100 - (patchBytes / fullBytes) * 100).toFixed(1)}%`);

console.log('\n③ 漏包检测与重同步');
resetEncode();
resetDecode();
let g2 = startGame(cards, deckA, deckB);
const p0 = encodeState(g2, { full: true });
const r0 = decodeState(null, p0, cards);
check('首次整份包可直接建立基线', !r0.needResync && !!r0.gs);
g2 = pushLog(g2, '第一条');
const p1 = encodeState(g2);
g2 = pushLog(g2, '第二条');
const p2 = encodeState(g2);
// 故意跳过 p1，直接应用 p2 → 应要求重同步
const rSkip = decodeState(r0.gs, p2, cards);
check('漏掉中间包 → 触发重同步', rSkip.needResync);
// 房主补发整份（版本号沿用当前）→ 客机恢复，且后续增量可继续应用
const pFull = encodeState(g2, { full: true });
const rFull = decodeState(r0.gs, pFull, cards);
check('补发整份后恢复一致', !rFull.needResync && !!rFull.gs && JSON.stringify(rFull.gs) === JSON.stringify(g2));
const g3 = pushLog(g2, '第三条');
const p3 = encodeState(g3);
const r3 = decodeState(rFull.gs, p3, cards);
check('恢复后继续应用增量', !r3.needResync && JSON.stringify(r3.gs) === JSON.stringify(g3));

console.log('\n④ cardsById 不传输但能补齐');
const anyCard = (r3.gs as NonNullable<typeof r3.gs>).cardsById['LO-6845'];
check('客机本地补齐了卡牌资料', !!anyCard && anyCard.id === 'LO-6845');
const slots = slotsOf(g2);
check('槽位不含 cardsById', !slots.some(([p]) => p === 'cardsById'));
check('槽位覆盖每个玩家的每个字段', slots.some(([p]) => p === 'players.0.hand') && slots.some(([p]) => p === 'players.1.deck'));

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
