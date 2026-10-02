// 联机权限（越权防护）自检：npx tsx tools/test-perms.ts
// 背景：从"端口映射直连"换成"公网服务器联机"后，客户端不再互相信任 ——
// 房主必须自己校验"这个操作/这张卡是不是行动方的"，否则客机能操作对手的卡。
// 这组断言就是为了让这类 bug 不会像以前那样"修好又被改回去还无人发现"。
import { readFileSync } from 'node:fs';
import type { Card } from '../src/core/cards';
import { createEmptyGame, newInstance, PlayerIndex, GameState } from '../src/core/game';
import * as rules from '../src/core/rules';
import { guestActDenied, canGuestAct } from '../src/net/protocol';

const cards: Card[] = JSON.parse(readFileSync('data/cards/range.json', 'utf-8'));

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

/** 玩家0=房主，玩家1=客机；把状态做成"轮到玩家1"的可操作局面 */
const mkGame = () => {
  const gs = createEmptyGame(cards);
  gs.turnPlayer = 1;
  gs.phase = 'main';
  gs.turn = 3;
  gs.ready = true;
  gs.players[0].deck = Array.from({ length: 20 }, () => newInstance('LO-6845'));
  gs.players[1].deck = Array.from({ length: 20 }, () => newInstance('LO-6845'));
  return gs;
};
const putField = (gs: GameState, p: PlayerIndex, cardId: string, row: 0 | 1, area: 0 | 1 | 2) => {
  const inst = newInstance(cardId);
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[p].field[row][area] = inst;
  return inst;
};
const putHand = (gs: GameState, p: PlayerIndex, cardId: string) => {
  const inst = newInstance(cardId);
  inst.faceUp = true;
  gs.players[p].hand.push(inst);
  return inst;
};
const lastLog = (g: GameState) => g.log[g.log.length - 1] ?? '';
const unchanged = (before: GameState, after: GameState) => JSON.stringify(rulesState(before)) === JSON.stringify(rulesState(after));
/** 取"对局实质状态"（忽略日志与语音队列）用于比较是否被改动 */
const rulesState = (g: GameState) => {
  const { log, voiceQueue, ...rest } = g;
  void log;
  void voiceQueue;
  return rest;
};

const hasDeclareCard = cards.find((c) => (c.ability ?? '').includes('[宣言]') && c.type === 'character')!;
const hasHandDeclareCard = cards.find((c) => (c.ability ?? '').includes('[手札宣言]'))!;
const hasMoveCard = cards.find((c) => (c.basicAbilities ?? '').includes('サイドステップ'))!;

console.log('\n① 客机不能操作对手的卡（房主侧校验 guestActDenied）');
{
  const gs = mkGame();
  const hostField = putField(gs, 0, hasDeclareCard.id, 1, 0);
  const hostHand = putHand(gs, 0, hasHandDeclareCard.id);
  const hostItem = putHand(gs, 0, cards.find((c) => c.type === 'item')!.id);
  const guestField = putField(gs, 1, 'LO-6846', 0, 0);
  const guestHand = putHand(gs, 1, hasHandDeclareCard.id);

  const cases: [string, string, unknown[]][] = [
    ['发动对手场上角色的宣言', 'requestDeclare', [hostField.uid]],
    ['用对手的手牌宣言', 'requestHandDeclare', [hostHand.uid]],
    ['用对手的道具装备', 'requestEquipItem', [hostItem.uid, guestField.uid]],
    ['把道具装到对手的角色上', 'requestEquipItem', [guestHand.uid, hostField.uid]],
    ['移动对手的角色', 'moveCharacter', [hostField.uid, 'AF', 1]],
    ['攻击用对手的角色', 'declareAttack', [hostField.uid]],
    ['用对手的卡产费', 'useCostAbility', [hostField.uid]],
  ];
  for (const [label, action, args] of cases) {
    check(`${label} → 被拒绝`, guestActDenied(gs, action, args, 1) !== null, String(guestActDenied(gs, action, args, 1)));
  }
  check('（对照）客机用自己场上的角色宣言 → 允许', guestActDenied(gs, 'requestDeclare', [guestField.uid], 1) === null);
  check('（对照）客机用自己的手牌宣言 → 允许', guestActDenied(gs, 'requestHandDeclare', [guestHand.uid], 1) === null);
  check('（对照）原来那个粗粒度 canGuestAct 仍为真（说明新校验是额外一层）', canGuestAct(gs, 'requestDeclare', 1) === true);
}

console.log('\n② 即使绕过客户端校验，规则层也必须拒绝（越权直发）');
{
  // 对应/战斗时点窗口：hd / fd 以前用"卡的持有者"当行为者 → 客机能发动对手的卡
  const gs = mkGame();
  const hostHand = putHand(gs, 0, hasHandDeclareCard.id);
  gs.response = { stack: [], awaiting: 1 } as unknown as GameState['response'];
  gs.prompt = { kind: 'response', owner: 1 } as unknown as GameState['prompt'];
  const before = structuredClone(gs);
  const after = rules.respond(gs, `hd:${hostHand.uid}`);
  check('时点窗口：客机用对手手牌宣言 → 不产生效果（日志有拒绝原因）', lastLog(after).includes('越权'), lastLog(after));
  check('  且窗口没有被清掉（玩家可以重选/放弃，不会卡住整局）', after.prompt?.kind === 'response', JSON.stringify(after.prompt?.kind));
  void before;
}
{
  const gs = mkGame();
  const hostField = putField(gs, 0, hasDeclareCard.id, 1, 0);
  gs.response = { stack: [], awaiting: 1 } as unknown as GameState['response'];
  gs.prompt = { kind: 'response', owner: 1 } as unknown as GameState['prompt'];
  const after = rules.respond(gs, `fd:${hostField.uid}`);
  check('时点窗口：客机发动对手场上角色能力 → 被拒绝', lastLog(after).includes('越权'), lastLog(after));
  check('  且窗口保留（可重选）', after.prompt?.kind === 'response', JSON.stringify(after.prompt?.kind));
}
{
  // 主阶段（无对应链）：非回合玩家不能借用别人的手牌宣言（两种拒绝理由都算拦截成功）
  const gs = mkGame();
  const hostHand = putHand(gs, 0, hasHandDeclareCard.id);
  gs.turnPlayer = 1;
  const before = structuredClone(gs);
  const after = rules.requestHandDeclare(gs, hostHand.uid);
  check('非回合玩家用对手手牌宣言 → 状态未变', unchanged(before, after), lastLog(after));
}

console.log('\n③ 移动/宣言等本来就有归属校验的入口仍然拦得住');
{
  const gs = mkGame();
  const hostMove = putField(gs, 0, hasMoveCard.id, 0, 1);
  const before = structuredClone(gs);
  const after = rules.moveCharacter(gs, hostMove.uid, 'DF', 1);
  check('移动对手的角色 → 状态未变', unchanged(before, after));
  const after2 = rules.requestDeclare(gs, hostMove.uid);
  check('对回合外的对手角色宣言 → 状态未变', unchanged(before, after2));
}

console.log('\n④ 正当操作不受影响（不能过度拦截）');
{
  const gs = mkGame();
  const myChar = putHand(gs, 1, cards.find((c) => c.type === 'character')!.id);
  // 客机登场自己的角色（无费用卡则走费用面板，这里只验证"没有被权限拦下"）
  const after = rules.requestPlayCharacter(gs, myChar.uid, 'DF', 0);
  check('客机登场自己的手牌：不是"越权"拒绝', !lastLog(after).includes('越权'), lastLog(after));
  const gs2 = mkGame();
  const own = putField(gs2, 1, 'LO-6846', 0, 0);
  const after2 = rules.declareAttack(gs2, own.uid);
  check('客机用自己 AF 角色攻击宣言：正常进入对应链', after2.prompt?.kind === 'response' || after2.battle !== null, JSON.stringify(after2.prompt?.kind));
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
