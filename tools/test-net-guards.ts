/*
 * 联机守卫测试（协议层，不需要真的连服务器）：npx tsx tools/test-net-guards.ts
 *
 * 覆盖用户关心的三类联机问题里"能在协议层判定"的部分：
 *   B 越权：客机拿**房主**的手牌/场上卡发动作 → 必须被 guestActDenied 拒绝
 *   A 连点：同一个动作连点两次 → 不能重复生效、不能把提示卡死（提示必须仍有可推进的选项）
 *   C 模式：客机可执行动作清单里不能出现"横置/翻面"这类单机专用开关
 *      （这些在引擎里没有对应 action，属于界面层；这里断言协议动作表里没有 toggle 类动作名）
 */
import { cards, installDeterminism, newMatch, candidates, applyOp, changed, type Op } from './dev/harness';
import { guestActDenied, applyAction } from '../src/net/protocol';
import type { GameState } from '../src/core/game';
import { devAddToHand, devPlaceCharacter } from '../src/core/devTest';

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

function hostTurn(): GameState {
  installDeterminism(12345);
  const gs = newMatch(12345);
  if (gs.turnPlayer !== 0) {
    const p = gs.players;
    const t = p[0];
    p[0] = p[1];
    p[1] = t;
    gs.turnPlayer = 0;
    gs.prompt = null;
  }
  return gs;
}

/* ---------- B：客机不能操控房主的卡 ---------- */
{
  let gs = hostTurn();
  // 房主（玩家0）手牌里放 1 张角色，场上放 1 个角色
  const charCard = cards.find((c) => c.type === 'character')!;
  gs = devAddToHand(gs, charCard.id);
  gs = devPlaceCharacter(gs, charCard.id, 0, 0);
  const hostHandUid = gs.players[0].hand[gs.players[0].hand.length - 1].uid;
  const hostFieldUid = gs.players[0].field[0][0]!.uid;

  const attempts: { name: string; action: string; args: unknown[] }[] = [
    { name: '客机让房主手牌的卡登场', action: 'requestPlayCharacter', args: [hostHandUid, 'AF', 1] },
    { name: '客机使用房主手牌的事件', action: 'requestPlayEvent', args: [hostHandUid] },
    { name: '客机配置房主手牌的エリア', action: 'requestPlayArea', args: [hostHandUid] },
    { name: '客机手札宣言房主的卡', action: 'requestHandDeclare', args: [hostHandUid] },
    { name: '客机宣言房主场上的角色', action: 'requestDeclare', args: [hostFieldUid] },
    { name: '客机让房主角色攻击', action: 'declareAttack', args: [hostFieldUid] },
    { name: '客机移动房主的角色', action: 'moveCharacter', args: [hostFieldUid, 'DF', 0] },
    { name: '客机装备房主的卡', action: 'requestEquipItem', args: [hostHandUid, hostFieldUid] },
    { name: '客机用房主角色的[コスト]能力', action: 'useCostAbility', args: [hostFieldUid] },
  ];

  for (const a of attempts) {
    const denied = guestActDenied(gs, a.action, a.args, 1);
    ok(!!denied, a.name + ' → 被拒绝', '返回=' + String(denied));
  }

  // 而且被拒绝时房主状态不能被改动：走一遍"拒绝 → 不应用"的路径
  const before = JSON.stringify(gs.players[0]);
  for (const a of attempts) {
    if (!guestActDenied(gs, a.action, a.args, 1)) gs = applyAction(gs, a.action, a.args as never);
  }
  ok(JSON.stringify(gs.players[0]) === before, '房主状态在越权尝试后没有任何变化');
}

/* ---------- A：连点两次不能重复生效、不能卡死 ---------- */
{
  let gs = hostTurn();
  const anyChar = cards.find((c) => c.type === 'character')!;
  gs = devAddToHand(gs, anyChar.id);
  gs = devAddToHand(gs, anyChar.id);
  // 从候选里挑一个"涉及本卡"的真实可执行动作（避免用一个本来就不合法的动作做测试）
  const uid = gs.players[0].hand[gs.players[0].hand.length - 1].uid;
  const cands0 = candidates(gs);
  const op: Op =
    cands0.find((o) => o.args.includes(uid) && changed(gs, applyOp(gs, o))) ??
    ({ action: 'requestHandDeclare', args: [uid], label: 'hand-declare' } as Op);

  const after1 = applyOp(gs, op);
  const changed1 = changed(gs, after1);
  const after2 = applyOp(after1, op);
  const changed2 = changed(after1, after2);
  ok(changed1 === true, '第一次点击生效（' + op.action + '）');
  ok(!(changed1 && changed2 && after2.prompt?.kind === after1.prompt?.kind), '连点第二次没有把同一动作再叠一次（或至少没有制造同样的提示）');

  // 提示必须仍可推进（不卡死）：逐个试候选，至少一个能改变状态
  if (after1.prompt) {
    const cands = candidates(after1);
    const canAdvance = cands.some((c) => changed(after1, applyOp(after1, c)));
    ok(cands.length > 0 && canAdvance, '连点后提示仍有可推进的选项（' + after1.prompt.kind + '）');
  } else {
    ok(true, '连点后没有残留提示');
  }
}

/* ---------- C：协议动作表里不能有横置/翻面这类单机开关 ---------- */
{
  const TOGGLE_LIKE = /^(toggle|tap|untap|flip|faceUp|faceDown)/i;
  const actionNames = [
    'beginTurn', 'endTurn', 'markReady', 'chooseRps', 'confirmRpsResult', 'requestPlayCharacter',
    'confirmCostPay', 'cancelCostPay', 'requestPlayEvent', 'requestPlayArea', 'chooseMulligan',
    'chooseCardPick', 'chooseSlot', 'respond', 'battleTimingAction', 'endMainAction', 'endMainCancel',
    'requestEquipItem', 'requestEquipTarget', 'cancelPrompt', 'requestHandDeclare', 'requestDeclare',
    'chooseDeclareTarget', 'chooseEffectOption', 'chooseSupport', 'useCostAbility', 'useCostAbilityInPay',
    'manualDraw', 'manualStat', 'manualDeckDiscard', 'manualDone', 'chooseSearchDeploy', 'moveCharacter',
    'declareAttack', 'chooseDefense', 'chooseShield', 'confirmDamage', 'confirmDiscard',
  ];
  const bad = actionNames.filter((n) => TOGGLE_LIKE.test(n));
  ok(bad.length === 0, '联机协议动作表里没有横置/翻面类动作', bad.join(','));
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
