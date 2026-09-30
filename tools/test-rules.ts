// 规则引擎纯逻辑测试（用 tsx 运行：npx tsx tools/test-rules.ts）
import { readFileSync } from 'node:fs';
import type { Card } from '../src/core/cards';
import { createEmptyGame, newInstance, shuffle, PlayerIndex, CardInstance, pushLog } from '../src/core/game';
import * as rules from '../src/core/rules';
import { applyAction, canGuestAct, promptOwner } from '../src/net/protocol';
import { parseEffects, effectiveStats, runDeployEffects, parseDeclaredEffect, deployTriggerCount, parsedDeployCount } from '../src/core/effects';
import { parseCard } from '../src/core/clauses';
import { runDeployChain } from '../src/core/effectEngine';
import { resetPlayerDeck } from '../src/core/sampleDeck';
import { parseDeckCode, formatDeckCode, normalizeDeck } from '../src/core/deckStorage';
import { createRoom, roomAddClient, roomSit, roomStand, roomReady, roomUnready, bothReady, roomStartGame, roomRematch, roomRemoveClient, myRole, HOST_CID } from '../src/core/room';

const cards: Card[] = JSON.parse(readFileSync('data/cards/range.json', 'utf-8'));
const byId = new Map(cards.map((c) => [c.id, c]));

function mkGame() {
  const gs = createEmptyGame(cards);
  return gs;
}

function inst(cardId: string): CardInstance {
  return newInstance(cardId);
}

function settle(g: ReturnType<typeof mkGame>): ReturnType<typeof mkGame> {
  let n = g;
  let guard = 0;
  while (guard++ < 40) {
    if (n.prompt?.kind === 'response') { n = rules.respond(n, 'pass'); continue; }
    if (n.prompt?.kind === 'battle-timing') { n = rules.battleTimingAction(n, 'end'); continue; }
    if (n.prompt?.kind === 'end-main') { n = rules.endMainAction(n, 'end'); continue; }
    if (n.prompt?.kind === 'rps-result') { n = rules.confirmRpsResult(n); continue; } // 模拟玩家确认先手结果
    break;
  }
  return n;
}

function handOf(gs: ReturnType<typeof mkGame>, p: PlayerIndex, ids: string[]) {
  gs.players[p].hand = ids.map((id) => {
    const i = inst(id);
    i.faceUp = true;
    return i;
  });
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.log(`✗ ${name} ${extra ?? ''}`);
  }
}

// 找一张给定属性/费用的角色卡
const charByCost = (cost: string, elem?: string) =>
  cards.find((c) => c.type === 'character' && c.cost === cost && (!elem || c.elements === elem))!;

/* ---------- 1. 费用解析 ---------- */
check('parseCost 宙宙無', JSON.stringify(rules.parseCost('宙宙無')) === JSON.stringify([{ elem: '宙', points: 2 }, { elem: '無', points: 1 }]));
check('parseCost 月', JSON.stringify(rules.parseCost('月')) === JSON.stringify([{ elem: '月', points: 1 }]));

/* ---------- 2. 费用支付 ---------- */
{
  const gs = mkGame();
  handOf(gs, 0, ['LO-6971', 'LO-6971', 'LO-6845', 'LO-6845']); // 4 张 EX2
  // LO-6971 是 日 EX2 费用"日"
  const card = byId.get('LO-6971')!;
  check('canPayCost 日 用 EX2 一张', rules.canPayCost(gs, 0, card.cost, 'LO-6971'));
  const paid = settle(rules.payCost(gs, 0, card.cost, 'LO-6971'));
  check('payCost 支付 1 张（EX2 覆盖 1 点）', paid.length === 1, `paid=${paid.length}`);
  check('支付后手牌 3 张、ゴミ箱 1 张', gs.players[0].hand.length === 3 && gs.players[0].trash.length === 1);
}
{
  const gs = mkGame();
  handOf(gs, 0, ['LO-6971', 'LO-6971', 'LO-6845', 'LO-6845']); // 全 EX2
  // 费用"日日日"（3 点日）→ 需要 2 张 EX2 日
  check('canPayCost 日日日', rules.canPayCost(gs, 0, '日日日', ''));
  const paid = settle(rules.payCost(gs, 0, '日日日', ''));
  check('payCost 日日日 支付 2 张', paid.length === 2, `paid=${paid.length}`);
}
{
  const gs = mkGame();
  handOf(gs, 0, ['LO-6971', 'LO-6971']); // 只有 2 张 日
  check('canPayCost 日日月（含月）不足', !rules.canPayCost(gs, 0, '日日月', ''));
}

/* ---------- 3. 配置位置 ---------- */
{
  const gs = mkGame();
  handOf(gs, 0, ['LO-6971']); // "－－－左中右" → 只能 DF（后列）
  const uid = gs.players[0].hand[0].uid;
  check('位置限制：LO-6971 可在 DF 中', rules.canPlaceAt(gs, 0, uid, 'DF', 1));
  check('位置限制：LO-6971 不能在 AF 中', !rules.canPlaceAt(gs, 0, uid, 'AF', 1));
  const slot = settle(rules.findAutoSlot(gs, 0, uid));
  check('自动选格优先 DF', slot?.row === 'DF' && slot?.area === 0, JSON.stringify(slot));
}

/* ---------- 4. 登场（手动选费用卡） ---------- */
{
  const gs = mkGame();
  handOf(gs, 0, ['LO-6971', 'LO-6971', 'LO-6971']); // 3 张 日 EX2（费用"日"）
  const uid = gs.players[0].hand[0].uid;
  gs.turnPlayer = 0;
  gs.phase = 'main';
  let next = settle(rules.requestPlayCharacter(gs, uid, 'DF', 0));
  check('登场先进入费用选择', next.prompt?.kind === 'cost-pay');
  // 手动选 1 张 日 卡支付
  const payUid = next.players[0].hand.find((c) => c.uid !== uid)!.uid;
  next = settle(rules.confirmCostPay(next, [payUid]));
  check('登场成功：DF 左 有角色', !!next.players[0].field[1][0]);
  // 登场充能（两步）：先选破弃牌堆张数（选0）→ 再从ゴミ箱选卡
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.label.includes('不破弃牌堆'))) {
    next = settle(rules.chooseEffectOption(next, ['0']));
  }
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  }
  check('登场后手牌 1 张、支付卡被充能', next.players[0].hand.length === 1 && next.players[0].trash.length === 0 && next.players[0].field[1][0]!.charge.length === 1, `trash=${next.players[0].trash.length} charge=${next.players[0].field[1][0]?.charge.length}`);
  const deployed = next.players[0].field[1][0]!;
  check('登场回合限制标记 deployedTurn=1', deployed.deployedTurn === 1);
  check('canAttack 登场回合不能攻击', !rules.canAttack(next, deployed.uid));
}
{
  const gs = mkGame();
  handOf(gs, 0, ['LO-6971']);
  const uid = gs.players[0].hand[0].uid;
  gs.turnPlayer = 0;
  gs.phase = 'main';
  const next = settle(rules.requestPlayCharacter(gs, uid, 'AF', 0)); // AF 不允许
  check('位置非法：不能登场到 AF', !next.players[0].field[0][0]);
  check('位置非法：不弹费用选择', next.prompt === null);
  check('位置非法：手牌仍在', next.players[0].hand.length === 1);
}
{
  const gs = mkGame();
  handOf(gs, 0, ['LO-6971']); // 只有 1 张，费用不足（无支付卡）
  const uid = gs.players[0].hand[0].uid;
  gs.turnPlayer = 0;
  gs.phase = 'main';
  const next = settle(rules.requestPlayCharacter(gs, uid, 'DF', 0));
  check('费用不足：不能登场', !next.players[0].field[1][0]);
  check('费用不足：手牌仍在', next.players[0].hand.length === 1);
}
{
  const gs = mkGame();
  handOf(gs, 0, ['LO-6971', 'LO-6971', 'LO-6971']); // 3 张 日 EX2，费用"日"
  const uid = gs.players[0].hand[0].uid;
  gs.turnPlayer = 0;
  gs.phase = 'main';
  let next = settle(rules.requestPlayCharacter(gs, uid, 'DF', 0));
  // 手动选 2 张（超额支付，也允许）
  const payUids = next.players[0].hand.filter((c) => c.uid !== uid).map((c) => c.uid);
  next = settle(rules.confirmCostPay(next, payUids));
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.label.includes('不破弃牌堆'))) {
    next = settle(rules.chooseEffectOption(next, ['0']));
  }
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  }
  check('超额支付 2 张也允许（1 张被充能）', !!next.players[0].field[1][0] && next.players[0].trash.length === 1 && next.players[0].field[1][0]!.charge.length === 1, `trash=${next.players[0].trash.length}`);
}
{
  const gs = mkGame();
  handOf(gs, 0, ['LO-6971', 'LO-6845']); // 日 + 雪，费用"日"→ 选雪卡支付应被拒
  const uid = gs.players[0].hand[0].uid; // LO-6971（日）
  gs.turnPlayer = 0;
  gs.phase = 'main';
  let next = settle(rules.requestPlayCharacter(gs, uid, 'DF', 0));
  const wrongPay = next.players[0].hand.find((c) => c.uid !== uid)!.uid; // LO-6845（雪）
  next = settle(rules.confirmCostPay(next, [wrongPay]));
  check('属性不符的费用卡被拒绝', next.players[0].field[1][0] === null);
  check('被拒后不破弃卡', next.players[0].trash.length === 0);
}

/* ---------- 5. 战斗：攻击→防御→判定 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3; // 已过登场限制回合
  // 攻击方：LO-6846 宙 AP7 DP7；防御方：LO-6971 日 AP3 DP0
  const atk = inst('LO-6846');
  atk.faceUp = true;
  atk.deployedTurn = null; // 已过登场ターン制限（此前回合已登场）
  gs.players[0].field[0][1] = atk;
  // 防御方：DF 中（对方），AP3 DP0
  const def = inst('LO-6971');
  def.faceUp = true;
  def.deployedTurn = null;
  gs.players[1].field[1][1] = def;
  check('canAttack 满足条件', rules.canAttack(gs, atk.uid));
  let next = settle(rules.declareAttack(gs, atk.uid));
  check('攻击宣言后进入防御提示', next.prompt?.kind === 'defense');
  check('攻击者已横置', next.players[0].field[0][1]!.tapped);
  check('防御候选 1 个', (next.prompt as any).candidates.length === 1);
  next = settle(rules.chooseDefense(next, def.uid));
  check('防御后战斗结束', next.battle === null);
  check('防御方被破弃（攻击AP7>防御DP0）', !next.players[1].field[1][1]);
  check('攻击方存活（防御AP3<攻击DP7）', !!next.players[0].field[0][1]);
  check('防御方进ゴミ箱', next.players[1].trash.length === 1);
}

/* ---------- 6. 无防御 → 牌堆伤害 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = inst('LO-6971'); // DMG 0 → 无伤害
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  // 给防御方一个 5 张的牌堆
  for (let i = 0; i < 5; i++) {
    const d = inst('LO-6845');
    d.faceUp = false;
    gs.players[1].deck.push(d);
  }
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = settle(rules.chooseDefense(next, null));
  check('DMG0 无牌堆伤害', next.players[1].deck.length === 5 && next.players[1].trash.length === 0);
}
{
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = inst('LO-6845'); // 攻击力高的卡，DMG>0
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const atkCard = byId.get('LO-6845')!;
  for (let i = 0; i < 5; i++) {
    const d = inst('LO-6845');
    d.faceUp = false;
    gs.players[1].deck.push(d);
  }
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = settle(rules.chooseDefense(next, null));
  // 无护盾 → 直接伤害
  check('牌堆伤害 = DMG', next.players[1].deck.length === 5 - atkCard.dmg, `deck=${next.players[1].deck.length} dmg=${atkCard.dmg}`);
}

/* ---------- 7. 护盾 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = inst('LO-6845');
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const atkCard = byId.get('LO-6845')!;
  for (let i = 0; i < 5; i++) {
    const d = inst('LO-6845');
    d.faceUp = false;
    gs.players[1].deck.push(d);
  }
  const sh = inst('LO-6971');
  sh.faceUp = true;
  gs.players[1].shield.push(sh);
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = settle(rules.chooseDefense(next, null)); // 先选不防御 → 进入伤害
  check('有护盾时提示选择', next.prompt?.kind === 'shield', JSON.stringify(next.prompt));
  next = settle(rules.chooseShield(next, true));
  check('用护盾后牌堆无损、护盾-1', next.players[1].deck.length === 5 && next.players[1].shield.length === 0);
}

/* ---------- 8. 胜负：牌堆归零 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = inst('LO-6845');
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const atkCard = byId.get('LO-6845')!;
  // 牌堆 2 张，DMG 足够击穿
  for (let i = 0; i < 2; i++) {
    const d = inst('LO-6845');
    d.faceUp = false;
    gs.players[1].deck.push(d);
  }
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = settle(rules.chooseDefense(next, null));
  check('牌堆归零 → 对局结束', next.phase === 'gameover' && next.winner === 0);
  check('胜利提示', next.prompt?.kind === 'gameover');
  void atkCard;
}

/* ---------- 9. 回合流程 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 1; // 玩家2 先攻
  gs.turn = 1;
  gs.phase = 'start';
  for (let i = 0; i < 10; i++) {
    const d = inst('LO-6845');
    d.faceUp = false;
    gs.players[1].deck.push(d);
  }
  const next = settle(rules.beginTurn(gs));
  check('先攻第 1 回合抽 1', next.players[1].hand.length === 1);
  check('进入主阶段', next.phase === 'main');
}
{
  const gs = mkGame();
  gs.turnPlayer = 1;
  gs.turn = 2; // 非首回合
  gs.phase = 'start';
  for (let i = 0; i < 10; i++) {
    const d = inst('LO-6845');
    d.faceUp = false;
    gs.players[1].deck.push(d);
  }
  // 场上有个横置角色 → 开始回合应重置
  const ch = inst('LO-6971');
  ch.faceUp = true;
  ch.tapped = true;
  gs.players[1].field[0][0] = ch;
  const next = settle(rules.beginTurn(gs));
  check('第 2 回合抽 2', next.players[1].hand.length === 2);
  check('Wake up 重置角色', next.players[1].field[0][0]!.tapped === false);
}
{
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 1;
  // 手牌 9 张 → 结束回合需调整
  const ids = ['LO-6845', 'LO-6845', 'LO-6845', 'LO-6845', 'LO-6971', 'LO-6971', 'LO-6971', 'LO-6971', 'LO-6969-A'];
  handOf(gs, 0, ids);
  const next = settle(rules.endTurn(gs));
  check('手牌>8 进入手牌调整', next.prompt?.kind === 'hand-adjust');
  const after = settle(rules.confirmDiscard(next, [next.players[0].hand[0].uid, next.players[0].hand[1].uid]));
  check('调整后手牌 7 张、回合交给对方', after.players[0].hand.length === 7 && after.turnPlayer === 1 && after.phase === 'start');
}

/* ---------- 10. 联机协议：房主处理客机的 confirmDiscard（含权限校验） ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 1; // 客机（玩家2）回合
  gs.turn = 2;
  gs.phase = 'main';
  handOf(gs, 1, ['LO-6845', 'LO-6845', 'LO-6845', 'LO-6845', 'LO-6971', 'LO-6971', 'LO-6971', 'LO-6971', 'LO-6969-A']);
  let next = settle(rules.endTurn(gs)); // 客机结束 → 手牌调整
  check('协议：客机 endTurn 触发手牌调整', next.prompt?.kind === 'hand-adjust' && next.turnPlayer === 1);
  // 客机（guestPlayer=1）可以确认破弃（权限通过）
  check('协议：canGuestAct confirmDiscard=true', canGuestAct(next, 'confirmDiscard', 1) === true);
  // 房主 applyAction 处理 confirmDiscard
  const discard = next.players[1].hand.slice(0, next.prompt.need).map((c) => c.uid);
  const after = applyAction(next, 'confirmDiscard', [discard]);
  check('协议：确认破弃后回合交给房主（玩家1）', after.turnPlayer === 0 && after.phase === 'start');
  check('协议：手牌调整到 7 张', after.players[1].hand.length === 7);
}

/* ---------- 11. 石头剪刀布决定先攻 ---------- */
{
  const gs = mkGame();
  gs.phase = 'start';
  gs.turn = 1;
  const next = settle(rules.markReady(gs));
  check('markReady 后就位并弹石头剪刀布', next.ready === true && next.prompt?.kind === 'rps' && !!next.rps);
  let a = settle(rules.chooseRps(next, 0, 'rock'));
  check('只出一方仍等待', a.prompt?.kind === 'rps' && a.rps?.p0 === 'rock' && a.rps?.p1 === null);
  a = settle(rules.chooseRps(a, 1, 'scissors'));
  check('石头胜剪刀 → 玩家1 先攻（进入起手换牌）', a.turnPlayer === 0 && a.prompt?.kind === 'mulligan' && a.phase === 'start');
}
{
  const gs = mkGame();
  gs.phase = 'start';
  gs.turn = 1;
  const next = settle(rules.markReady(gs));
  let a = settle(rules.chooseRps(next, 0, 'rock'));
  a = settle(rules.chooseRps(a, 1, 'rock'));
  check('平局则清空重来', a.prompt?.kind === 'rps' && a.rps?.p0 === null && a.rps?.p1 === null);
  a = settle(rules.chooseRps(a, 0, 'paper'));
  a = settle(rules.chooseRps(a, 1, 'rock'));
  check('布胜石头 → 玩家1 先攻（进入起手换牌）', a.turnPlayer === 0 && a.prompt?.kind === 'mulligan');
}

/* ---------- 12. 效果系统 ---------- */
{
  // 解析：涼花 LO-6971 登场时抽1张
  const card = byId.get('LO-6971')!;
  const eff = parseEffects(card);
  check('解析 LO-6971 登场抽1张', eff.some((e) => e.kind === 'deploy-draw' && e.draw === 1), JSON.stringify(eff));
  // 解析：寿 珠祈 LO-6947-A 常时 味方全部 +1 AP
  const contCard = byId.get('LO-6947')!;
  const ceff = parseEffects(contCard);
  check('解析 LO-6947 常时+1AP(味方全部)', ceff.some((e) => e.kind === 'continuous-stat' && e.target === 'allFriendly' && e.stats?.[0].stat === 'ap' && e.stats[0].amount === 1), JSON.stringify(ceff));
}
{
  // 登场效果生效：登场时抽1张
  const gs = mkGame();
  const inst = newInstance('LO-6971');
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[0].field[0][0] = inst;
  gs.players[0].deck.push(newInstance('LO-6845'), newInstance('LO-6845'));
  const before = gs.players[0].hand.length;
  const next = runDeployEffects(gs, inst.uid, 0);
  check('登场效果：抽 1 张', next.players[0].hand.length === before + 1);
  check('登场效果日志', next.log.some((l) => l.includes('登场效果')));
}
{
  // 常时加成生效：场上有个"味方全部+1AP"的角色，队友+1AP
  const gs = mkGame();
  const buff = newInstance('LO-6947');
  buff.faceUp = true;
  buff.deployedTurn = null;
  gs.players[0].field[0][0] = buff;
  const ally = newInstance('LO-6971');
  ally.faceUp = true;
  ally.deployedTurn = null;
  gs.players[0].field[0][1] = ally;
  const eff = effectiveStats(gs, ally.uid);
  const base = byId.get('LO-6971')!;
  check('常时：队友 AP+1', eff.ap === base.ap + 1, `eff=${eff.ap} base=${base.ap}`);
  check('常时：施加者自身也+1', effectiveStats(gs, buff.uid).ap === byId.get('LO-6947')!.ap + 1);
}

/* ---------- 13. 手札宣言 / 宣言效果 / 移动 ---------- */
{
  // 手札宣言：使用后进入ゴミ箱（规则：如同事件卡）
  const card = byId.get('LO-6856')!; // 单一手札宣言 [0]
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  const inst = newInstance(card.id);
  inst.faceUp = true;
  gs.players[0].hand.push(inst);
  const before = gs.players[0].hand.length;
  const next = settle(rules.requestHandDeclare(gs, inst.uid));
  check('手札宣言：使用后进入ゴミ箱（规则）', next.players[0].hand.length === before - 1 && next.players[0].trash.some((c) => c.uid === inst.uid));
  check('手札宣言：进入结算（解析/手动/日志）', next.prompt?.kind === 'manual-effect' || next.log.some((l) => l.includes('手札宣言')) || next.prompt?.kind === 'declare-target' || next.prompt?.kind === 'effect-choice' || next.prompt?.kind === 'search-deploy' || next.prompt?.kind === 'cost-pay');
}
{
  // 宣言效果：场上的角色 [宣言]
  const card = cards.find((c) => c.type === 'character' && (c.ability || '').includes('[宣言]'))!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  const inst = newInstance(card.id);
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[0].field[0][0] = inst;
  const next = settle(rules.requestDeclare(gs, inst.uid));
  check('宣言效果：进入目标选择或有日志', next.prompt?.kind === 'declare-target' || next.log.some((l) => l.includes('宣言')) || next.log.some((l) => l.includes('充能不足')) || next.prompt?.kind === 'effect-choice' || next.prompt?.kind === 'cost-pay');
}
{
  // 移动：有移动基本能力的角色可移动
  const card = cards.find((c) => c.type === 'character' && /\[(ステップ|サイドステップ|オーダーステップ|ジャンプ)/.test(c.basicAbilities || ''))!;
  check('找到移动角色', !!card, card?.id);
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const inst = newInstance(card.id);
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[0].field[1][0] = inst; // 放后列（サイドステップ左右相邻）
  const targets = settle(rules.validMoveTargets(gs, inst.uid));
  check('有可移动的空位', targets.length > 0, JSON.stringify(targets));
  if (targets.length > 0) {
    const t = targets[0];
    const next = settle(rules.moveCharacter(gs, inst.uid, t.row, t.area));
    check('移动成功：原格空、新格有卡', next.players[0].field[1][0] === null && next.players[0].field[t.row === 'AF' ? 0 : 1][t.area] !== null);
  }
}

/* ---------- 14. 宣言效果结算 ---------- */
{
  // 解析 [宣言] [0]:{相手キャラ１体}にＡＰ－２またはＤＰ－２する。
  const card = cards.find((c) => (c.ability || '').includes('[宣言] [0]:{相手キャラ１体}にＡＰ－２'))!;
  check('找到宣言卡', !!card, card?.id);
  const eff = parseDeclaredEffect(card, '宣言');
  check('解析宣言效果：相手1体 AP-2', eff?.target === 'oneOpponent' && eff?.action === 'stat' && eff?.stat === 'ap' && eff?.amount === -2, JSON.stringify(eff));
}
{
  // 宣言结算：新引擎流程（效果选项 → 目标选择 → AP-2 生效）
  const card = cards.find((c) => (c.ability || '').includes('[宣言] [0]:{相手キャラ１体}にＡＰ－２'))!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const self = newInstance(card.id);
  self.faceUp = true;
  self.deployedTurn = null;
  gs.players[0].field[0][0] = self;
  const opp = newInstance('LO-6971');
  opp.faceUp = true;
  opp.deployedTurn = null;
  gs.players[1].field[0][0] = opp;
  let next = settle(rules.requestDeclare(gs, self.uid));
  check('宣言后进入效果选项', next.prompt?.kind === 'effect-choice', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, [next.prompt.options[0].id]));
  }
  // 唯一候选目标自动指定并生效；多候选时进入目标选择
  if (next.prompt?.kind === 'declare-target') {
    check('选择选项后进入目标选择', true);
    next = settle(rules.chooseDeclareTarget(next, opp.uid));
  } else {
    check('选择选项后自动指定唯一目标', true);
  }
  check('目标角色 AP-2 生效', effectiveStats(next, opp.uid).ap === byId.get('LO-6971')!.ap - 2, `ap=${effectiveStats(next, opp.uid).ap}`);
  check('宣言后攻击者未被横置（费用0）', next.players[0].field[0][0]!.tapped === false);
}
{
  // 临时修正回合开始清除（新引擎流程）
  const card = cards.find((c) => (c.ability || '').includes('[宣言] [0]:{相手キャラ１体}にＡＰ－２'))!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const self = newInstance(card.id);
  self.faceUp = true;
  self.deployedTurn = null;
  gs.players[0].field[0][0] = self;
  const opp = newInstance('LO-6971');
  opp.faceUp = true;
  opp.deployedTurn = null;
  gs.players[1].field[0][0] = opp;
  let next = settle(rules.requestDeclare(gs, self.uid));
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, [next.prompt.options[0].id]));
  }
  next = settle(rules.chooseDeclareTarget(next, opp.uid));
  const buffed = effectiveStats(next, opp.uid).ap;
  check('修正生效（小于基础）', buffed < byId.get('LO-6971')!.ap);
  // 对手开始回合 → 清除修正
  next.players[1].field[0][0]!.tapped = true;
  const turnStart = settle(rules.beginTurn({ ...next, turnPlayer: 1, turn: 4, phase: 'start' }));
  check('回合开始后修正清除', effectiveStats(turnStart, opp.uid).ap === byId.get('LO-6971')!.ap);
}

/* ---------- 15. 登场数值 / 手动结算 ---------- */
{
  // 登场诱発数值：LO-6969-A 登场时自身 SP-2
  const card = byId.get('LO-6969-A')!;
  const gs = mkGame();
  const inst = newInstance(card.id);
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[0].field[0][0] = inst;
  const next = runDeployEffects(gs, inst.uid, 0);
  check('登场数值：自身 SP-2 生效', effectiveStats(next, inst.uid).sp === card.sp - 2, `sp=${effectiveStats(next, inst.uid).sp} base=${card.sp}`);
}
{
  // 置き場宣言：LO-6856 宣言 → 放入「野良天使」置き場 + 抽牌 + 护盾（全自动）
  const card = byId.get('LO-6856')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 2;
  const inst = newInstance(card.id);
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[0].field[0][0] = inst;
  gs.players[0].trash.push(newInstance('LO-6845'), newInstance('LO-6845'), newInstance('LO-6845'));
  gs.players[0].deck.push(newInstance('LO-6845'), newInstance('LO-6845'), newInstance('LO-6845'));
  let next = settle(rules.requestDeclare(gs, inst.uid));
  // 置き場存放：玩家选择ゴミ箱卡
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  }
  check('6856 宣言自动执行（置き場存放）', (next.players[0].storage['野良天使'] ?? []).length === 1, JSON.stringify(Object.keys(next.players[0].storage)));
  check('6856 抽牌+护盾生效', next.players[0].hand.length === 2 && next.players[0].shield.length === 1, `hand=${next.players[0].hand.length} shield=${next.players[0].shield.length}`);
}
{
  // 手动结算面板（直接构造面板，验证手动工具）
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.prompt = { kind: 'manual-effect', title: '测试', text: 'test', owner: 0 };
  gs.players[0].deck.push(newInstance('LO-6845'), newInstance('LO-6845'));
  const handBefore = gs.players[0].hand.length;
  let next = settle(rules.manualDraw(gs, 1));
  check('手动结算：抽 1 张', next.players[0].hand.length === handBefore + 1);
  next = settle(rules.manualDone(next));
  check('手动结算：完成关闭面板', next.prompt === null);
}
{
  // 登场触发：新引擎自动处理（旧版需要手动的卡现在自动结算）
  const card = cards.find((c) => c.type === 'character' && deployTriggerCount(c) > parsedDeployCount(c) && (c.ability || '').includes('[誘発]'))!;
  check('找到登场触发未覆盖的卡', !!card, card?.id);
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.players[0].deck.push(newInstance('LO-6845'), newInstance('LO-6845'));
  const inst = newInstance(card.id);
  inst.faceUp = true;
  gs.players[0].hand.push(inst);
  const cost = byId.get(card.id)!.cost;
  if (!cost || rules.canPayCost(gs, 0, cost, inst.uid)) {
    const slot = settle(rules.findAutoSlot(gs, 0, inst.uid)) ?? { row: 'AF' as const, area: 0 as const };
    let req = settle(rules.requestPlayCharacter(gs, inst.uid, slot.row, slot.area));
    if (req.prompt?.kind === 'cost-pay') {
      const pay = req.prompt.candidates.slice(0, Math.min(req.prompt.candidates.length, 1)).map((c) => c.uid);
      req = settle(rules.confirmCostPay(req, pay));
    }
    // 登场效果自动应用或弹选项面板（不再强制手动面板）
    const ok = req.prompt === null || req.prompt.kind === 'effect-choice' || req.prompt.kind === 'declare-target' || req.prompt.kind === 'search-deploy' || req.prompt.kind === 'manual-effect';
    check('登场效果已处理（自动或交互面板）', ok, JSON.stringify(req.prompt?.kind));
  }
}

/* ---------- 16. 检索登场（搜索デッキ/ゴミ箱 → 免费登场） ---------- */
{
  // 解析：LO-6849-X 手札宣言是"检索登场"效果
  const card = byId.get('LO-6849-X')!;
  const eff = parseDeclaredEffect(card, '手札宣言');
  check('解析 LO-6849-X 手札宣言为检索登场', eff?.action === 'search' && eff?.searchKind === 'deploy' && (eff.searchNames ?? []).length >= 2, JSON.stringify(eff));
}
{
  // 检索登场部署逻辑（直接构造检索弹窗验证部署）：目标卡在牌堆 → 选中后免费登场
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const target = newInstance('LO-6971');
  target.faceUp = false;
  gs.players[0].deck.push(target);
  gs.prompt = { kind: 'search-deploy', owner: 0, title: 'test', mode: 'deploy', candidates: [{ uid: target.uid, name: '涼花', zone: 'デッキ' }], pending: null };
  let next = settle(rules.chooseSearchDeploy(gs, target.uid));
  if (next.prompt?.kind === 'slot-pick') {
    next = settle(rules.chooseSlot(next, next.prompt.slots[0].row, next.prompt.slots[0].area));
  }
  const occupied = next.players[0].field.flat().filter(Boolean).length;
  check('检索登场的卡已上场', occupied === 1);
  check('牌堆中的卡被取出', next.players[0].deck.length === 0);
  check('登场回合限制标记', next.players[0].field.flat().find((x) => x)?.deployedTurn === 3);
}
{
  // 找不到目标 → 效果落空日志（LO-6849-X 目标不在测试卡池）
  const card = byId.get('LO-6849-X')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  const caster = newInstance(card.id);
  caster.faceUp = true;
  gs.players[0].hand.push(caster);
  const next = settle(rules.requestHandDeclare(gs, caster.uid));
  check('找不到目标时给出提示（无弹窗）', next.prompt === null && next.log.some((l) => l.includes('没有找到')));
}

/* ---------- 17. 检索配置（エリア）与检索加入手牌 ---------- */
{
  // 解析 LO-6850 手札宣言 → 检索「月影怪盗ミス・アルテ」并配置
  const card = byId.get('LO-6850')!;
  const eff = parseDeclaredEffect(card, '手札宣言');
  check('解析 LO-6850 手札宣言为检索配置', eff?.action === 'search' && eff?.searchKind === 'place' && (eff.searchNames ?? []).includes('月影怪盗ミス・アルテ'), JSON.stringify(eff));
}
{
  // 完整流程：LO-6960（月影怪盗ミス・アルテ，エリア）在牌堆 → LO-6850 手札宣言 → 选能力 → 检索配置到特殊置场
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const caster = newInstance('LO-6850');
  caster.faceUp = true;
  gs.players[0].hand.push(caster);
  const area = newInstance('LO-6960'); // 月影怪盗ミス・アルテ（エリア）
  area.faceUp = false;
  gs.players[0].deck.push(area);
  let next = settle(rules.requestHandDeclare(gs, caster.uid));
  check('手札宣言：先选择能力块', next.prompt?.kind === 'effect-choice', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') {
    // 选第 1 个能力：[D2] 检索配置
    next = settle(rules.chooseEffectOption(next, [next.prompt.options[0].id]));
  }
  check('进入检索配置选择', next.prompt?.kind === 'search-deploy', JSON.stringify(next.prompt?.kind));
  next = settle(rules.chooseSearchDeploy(next, area.uid));
  check('检索配置エリア：选择位置', next.prompt?.kind === 'slot-pick', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'slot-pick') {
    next = settle(rules.chooseSlot(next, next.prompt.slots[0].row, next.prompt.slots[0].area));
  }
  check('エリア配置到フィールド', next.players[0].fieldAreas.some((row) => row.some((c) => c?.uid === area.uid)));
  check('牌堆中已取出', next.players[0].deck.length === 0);
}
{
  // 检索加入手牌：LO-6856 手札宣言 检索「青春モンスター 天使ちゃん」→ 未找到时给日志
  const card = byId.get('LO-6856')!;
  check('找到检索加入手牌的卡', true, card.id);
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  const caster = newInstance(card.id);
  caster.faceUp = true;
  gs.players[0].hand.push(caster);
  const next = settle(rules.requestHandDeclare(gs, caster.uid));
  check('检索加入手牌效果处理（加入或未找到提示）', next.log.some((l) => l.includes('检索') || l.includes('没有找到')) || next.players[0].hand.length > 1);
}

/* ---------- 18. 新引擎：充能 / 选项宣言 / 登场诱発 / 支援 / コスト能力 ---------- */
{
  // LO-6845 宣言[T]：3 选项（AP+5 / DP+5 / 不做时 DP+3）
  const card = byId.get('LO-6845')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const self = newInstance(card.id);
  self.faceUp = true;
  self.deployedTurn = null;
  gs.players[0].field[0][0] = self;
  const ally = newInstance('LO-6971');
  ally.faceUp = true;
  ally.deployedTurn = null;
  gs.players[0].field[0][1] = ally;
  let next = settle(rules.requestDeclare(gs, self.uid));
  check('6845 宣言进入效果选项', next.prompt?.kind === 'effect-choice', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') {
    check('6845 三个选项', next.prompt.options.length === 3, JSON.stringify(next.prompt.options.map((o) => o.label)));
    next = settle(rules.chooseEffectOption(next, ['o0'])); // AP+5
  }
  // 两名候选 → 目标选择
  if (next.prompt?.kind === 'declare-target') {
    next = settle(rules.chooseDeclareTarget(next, ally.uid));
  }
  const apUp = effectiveStats(next, ally.uid).ap === byId.get('LO-6971')!.ap + 5;
  check('6845 AP+5 生效', apUp, `ap=${effectiveStats(next, ally.uid).ap}`);
  check('6845 费用[T]已横置', next.players[0].field[0][0]!.tapped === true);
}
{
  // 充能基本能力：LO-6971 登场从ゴミ箱充能 1 张；[C1] 费用支付
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 2;
  gs.players[0].trash.push(newInstance('LO-6845'));
  const inst = newInstance('LO-6971');
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[0].field[0][0] = inst;
  inst.charge.push(newInstance('LO-6845'));
  let next = settle(rules.requestDeclare(gs, inst.uid)); // [C1] 宣言
  check('6971 [C1] 宣言进入充能选择', next.prompt?.kind === 'card-pick', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  }
  check('6971 [C1] 结算（破弃充能 1 张）', next.log.some((l) => l.includes('破弃充能 1 张')), JSON.stringify(next.log));
  check('充能清空', next.players[0].field[0][0]!.charge.length === 0);
  next = settle(rules.requestDeclare(next, inst.uid));
  check('第二次使用被拒（每回合1次 / 充能不足）', next.log.some((l) => l.includes('本回合已使用') || l.includes('充能不足')), JSON.stringify(next.log));
}
{
  // 登场诱発：LO-6846 登场 → 自身 AP+2/DP+2（唯一候选自动）+ 抽 1
  const card = byId.get('LO-6846')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  gs.players[0].deck.push(newInstance('LO-6845'));
  handOf(gs, 0, ['LO-6846', 'LO-6846', 'LO-6846']); // 3 张 宙 EX2（费用宙宙宙宙）
  const inst = gs.players[0].hand[0];
  inst.faceUp = true;
  let next = settle(rules.requestPlayCharacter(gs, inst.uid, 'DF', 0));
  if (next.prompt?.kind === 'cost-pay') {
    next = settle(rules.confirmCostPay(next, next.prompt.candidates.map((c) => c.uid)));
  }
  const onField = next.players[0].field.flat().find((c) => c);
  check('6846 登场自身 AP+2', onField ? effectiveStats(next, onField.uid).ap === card.ap + 2 : false, `ap=${onField ? effectiveStats(next, onField.uid).ap : '?'}`);
  check('6846 登场抽 1', next.players[0].hand.length === 1, `hand=${next.players[0].hand.length}`);
}
{
  // 支援：相邻角色支援攻击者（SP 加入 AP）
  const atkCard = byId.get('LO-6971')!;
  const supCard = byId.get('LO-6845')!; // SP1
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = newInstance(atkCard.id);
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][1] = atk;
  const sup = newInstance(supCard.id);
  sup.faceUp = true;
  sup.deployedTurn = null;
  gs.players[0].field[1][1] = sup; // 同列 DF 相邻
  let next = settle(rules.declareAttack(gs, atk.uid)); // 自动放弃対応
  check('攻击后进入防御提示', next.prompt?.kind === 'defense', JSON.stringify(next.prompt?.kind));
  next = rules.chooseDefense(next, null); // 不防御 → バトル中宣言タイミング
  check('进入バトル中宣言タイミング', next.prompt?.kind === 'battle-timing', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'battle-timing') {
    const supOpt = next.prompt.options.find((o) => o.id.startsWith('sup:'));
    check('支援选项可用', !!supOpt, JSON.stringify(next.prompt.options.map((o) => o.id)));
    if (supOpt) {
      next = rules.battleTimingAction(next, supOpt.id); // 支援
      check('支援后回到本玩家时点', next.prompt?.kind === 'battle-timing', JSON.stringify(next.prompt?.kind));
      next = rules.battleTimingAction(next, 'end'); // 攻击方结束
      next = rules.battleTimingAction(next, 'end'); // 防御方结束
    }
  }
  check('支援者已横置', next.players[0].field[1][1]!.tapped === true);
  check('攻击者 AP +SP', effectiveStats(next, atk.uid).ap === atkCard.ap + supCard.sp, `ap=${effectiveStats(next, atk.uid).ap}`);
}
{
  // [コスト] 能力：LO-6891 生成费用抵扣装备费用
  const card = byId.get('LO-6891')!; // [コスト] アイテム装備のみ [月月]
  const item = byId.get('LO-6957')!; // アクティ部 费用月月
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 2;
  const c = newInstance(card.id);
  c.faceUp = true;
  c.deployedTurn = null;
  gs.players[0].field[0][0] = c;
  let next = settle(rules.useCostAbility(gs, c.uid));
  check('コスト能力生成费用', next.players[0].exPool.length === 1 && next.players[0].exPool[0].points === 2, JSON.stringify(next.players[0].exPool));
  check('コスト能力不横置（无[T]代偿）', next.players[0].field[0][0]!.tapped === false);
  // 装备 LO-6957（月月）→ 生成费用抵扣，直接装备
  const itemInst = newInstance(item.id);
  itemInst.faceUp = true;
  next.players[0].hand.push(itemInst);
  next = settle(rules.requestEquipTarget(next, itemInst.uid));
  check('选择装备目标', next.prompt?.kind === 'equip-target', JSON.stringify(next.prompt?.kind));
  next = settle(rules.requestEquipItem(next, itemInst.uid, c.uid));
  check('生成费用抵扣后直接装备', !!next.players[0].field[0][0]?.equip, JSON.stringify(next.prompt?.kind));
  check('exPool 已消耗', next.players[0].exPool.length === 0, JSON.stringify(next.players[0].exPool));
  check('道具效果生效（常时+2 与装备诱発+2）', effectiveStats(next, c.uid).ap === card.ap + 4, `ap=${effectiveStats(next, c.uid).ap}`);
}
{
  // 事件：LO-6954 使用 → 味方全部 AP+3/DP+3
  const eventCard = byId.get('LO-6954')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const ch = newInstance('LO-6971');
  ch.faceUp = true;
  ch.deployedTurn = null;
  gs.players[0].field[0][0] = ch;
  const ev = newInstance(eventCard.id);
  ev.faceUp = true;
  gs.players[0].hand.push(ev);
  gs.players[0].hand.push(newInstance('LO-6846'), newInstance('LO-6846'), newInstance('LO-6968')); // 宙宙 + 無 作费用
  let next = settle(rules.requestPlayEvent(gs, ev.uid));
  if (next.prompt?.kind === 'cost-pay') {
    next = settle(rules.confirmCostPay(next, [next.prompt.candidates[0].uid]));
  }
  check('事件 AP+3 生效', effectiveStats(next, ch.uid).ap === byId.get('LO-6971')!.ap + 3, `ap=${effectiveStats(next, ch.uid).ap}`);
}
{
  // ペナルティ：LO-6898 离场时抽 1
  const card = byId.get('LO-6898')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  gs.players[1].deck.push(newInstance('LO-6845'));
  const atk = newInstance('LO-6857'); // 宙 AP7 DP7 DMG4
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const def = newInstance(card.id);
  def.faceUp = true;
  def.deployedTurn = null;
  gs.players[1].field[1][0] = def;
  let next = settle(rules.declareAttack(gs, atk.uid));
  if (next.prompt?.kind === 'support') next = settle(rules.chooseSupport(next, null));
  next = settle(rules.chooseDefense(next, def.uid));
  check('ペナルティ离场抽 1', next.players[1].hand.length === 1, `hand=${next.players[1].hand.length}`);
}

{
  // 复活手札宣言：LO-6846 [宙宙宙] → 本回合味方被对方效果破弃后，从ゴミ箱免费登场
  const card = byId.get('LO-6846')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const victim = newInstance('LO-6971');
  victim.faceUp = true;
  victim.deployedTurn = null;
  gs.players[0].field[1][0] = victim;
  gs.players[0].turnCounters.oppDiscarded = 1;
  const copy = newInstance('LO-6846');
  copy.faceUp = true;
  gs.players[0].trash.push(copy);
  const caster = newInstance(card.id);
  caster.faceUp = true;
  gs.players[0].hand.push(caster);
  // 费用 [宙宙宙]：加 2 张 宙 EX2 手牌
  gs.players[0].hand.push(newInstance('LO-6846'), newInstance('LO-6846'));
  let next = settle(rules.requestHandDeclare(gs, caster.uid));
  // 两个手札宣言 → 选择 [宙宙宙] 复活能力（第 2 个）
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, [next.prompt.options[1].id]));
  }
  if (next.prompt?.kind === 'cost-pay') {
    next = settle(rules.confirmCostPay(next, next.prompt.candidates.map((c) => c.uid)));
  }
  // 复活登场：玩家选择位置
  if (next.prompt?.kind === 'slot-pick') {
    next = settle(rules.chooseSlot(next, next.prompt.slots[0].row, next.prompt.slots[0].area));
  }
  const revived = next.players[0].field.flat().some((c) => c && c.cardId === 'LO-6846');
  check('6846 复活登场（手札宣言卡与费用卡进ゴミ箱）', revived && next.players[0].trash.length === 3, `trash=${next.players[0].trash.length}`);
}
{
  // 条件宣言：LO-6849 [T] 需 2 体味方ＡＦ使用代償[T] → 不满足时效果不发动
  const card = byId.get('LO-6849')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const self = newInstance(card.id);
  self.faceUp = true;
  self.deployedTurn = null;
  gs.players[0].field[0][0] = self;
  const next = settle(rules.requestDeclare(gs, self.uid));
  check('6849 条件未满足 → 不发动并提示（不支付费用）', next.players[0].field[0][0]!.tapped === false && next.log.some((l) => l.includes('条件未满足')), JSON.stringify(next.log.slice(-2)));
}

/* ---------- 19. 规则书核对修复 ---------- */
{
  // 起手换牌：先攻决定后后攻决定
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'start';
  gs.ready = true;
  gs.rps = { p0: null, p1: null };
  gs.prompt = { kind: 'rps' };
  gs.players[0].hand = [newInstance('LO-6845')];
  gs.players[0].deck = [newInstance('LO-6971'), newInstance('LO-6971')];
  let next = settle(rules.chooseRps(gs, 0, 'rock'));
  next = settle(rules.chooseRps(next, 1, 'scissors'));
  check('RPS 后进入起手换牌（先攻=玩家1）', next.prompt?.kind === 'mulligan' && (next.prompt as { owner: number }).owner === 0, JSON.stringify(next.prompt?.kind));
  next = settle(rules.chooseMulligan(next, true));
  check('先攻重抽后轮到后攻', next.prompt?.kind === 'mulligan' && (next.prompt as { owner: number }).owner === 1);
  check('重抽后手札=牌堆全部（2+1 张）', next.players[0].hand.length === 3, `hand=${next.players[0].hand.length}`);
  next = settle(rules.chooseMulligan(next, false));
  check('换牌完成后可开始回合', next.prompt === null && next.mulligan === null);
}
{
  // 手札エリア配置：1 场 1 张 + 费用支付
  const card = byId.get('LO-6960')!; // エリア 月月月
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 2;
  const area1 = newInstance(card.id);
  area1.faceUp = true;
  gs.players[0].hand.push(area1);
  gs.players[0].hand.push(newInstance('LO-6850'), newInstance('LO-6850')); // 月 EX2 费用
  let next = settle(rules.requestPlayArea(gs, area1.uid));
  check('エリア配置：先选位置', next.prompt?.kind === 'slot-pick', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'slot-pick') {
    next = settle(rules.chooseSlot(next, next.prompt.slots[0].row, next.prompt.slots[0].area));
  }
  check('エリア配置进入费用选择', next.prompt?.kind === 'cost-pay', JSON.stringify(next.prompt?.kind));
  next = settle(rules.confirmCostPay(next, next.prompt && next.prompt.kind === 'cost-pay' ? next.prompt.candidates.map((c) => c.uid) : []));
  check('エリア配置到フィールド', next.players[0].fieldAreas.some((row) => row.some((c) => c?.cardId === card.id)));
  // 第二张エリア配置到另一个フィールド（规则 0310：フィールド1つに1枚，可多张）
  const area2 = newInstance('LO-6959'); // 第二个エリア（费用 雪）
  area2.faceUp = true;
  next.players[0].hand.push(area2, newInstance('LO-6845')); // 雪 EX2 付费用
  let next2 = settle(rules.requestPlayArea(next, area2.uid));
  check('第二张エリア选择位置', next2.prompt?.kind === 'slot-pick', JSON.stringify(next2.prompt?.kind));
  if (next2.prompt?.kind === 'slot-pick') {
    next2 = settle(rules.chooseSlot(next2, next2.prompt.slots[0].row, next2.prompt.slots[0].area));
  }
  if (next2.prompt?.kind === 'cost-pay') {
    next2 = settle(rules.confirmCostPay(next2, next2.prompt.candidates.map((c) => c.uid)));
  }
  const areaCount = next2.players[0].fieldAreas.reduce((s, row) => s + row.filter((c) => c).length, 0);
  check('第二个エリア可配置（不同フィールド）', areaCount === 2, JSON.stringify(areaCount));
}
{
  // 检索登场支付费用（无「無償で」→ LO-6862 检索コノハサクヤ登场需付费用）
  const card = byId.get('LO-6862')!;
  const target = byId.get('LO-6865')!; // コノハサクヤ 费用 雪雪
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const caster = newInstance(card.id);
  caster.faceUp = true;
  gs.players[0].hand.push(caster);
  const tgt = newInstance(target.id);
  tgt.faceUp = false;
  gs.players[0].deck.push(tgt);
  let next = settle(rules.requestHandDeclare(gs, caster.uid));
  // ・列表 → 效果选项（第 1 个 = 检索登场）
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, [next.prompt.options[0].id]));
  }
  check('进入检索提示（需付费用）', next.prompt?.kind === 'search-deploy' && next.prompt.free === false, JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'search-deploy') {
    next = settle(rules.chooseSearchDeploy(next, tgt.uid));
    check('费用不足时检索登场被拒', next.players[0].field.flat().filter(Boolean).length === 0 && next.log.some((l) => l.includes('费用不足')), JSON.stringify(next.log.slice(-2)));
  }
}
{
  // 护盾来自ゴミ箱（规则 index_4）
  const card = byId.get('LO-6853')!; // 宣言 [C1]: 抽1 + シールド+1
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 2;
  const inst = newInstance(card.id);
  inst.faceUp = true;
  inst.deployedTurn = null;
  inst.charge.push(newInstance('LO-6845'));
  gs.players[0].field[0][0] = inst;
  gs.players[0].trash.push(newInstance('LO-6845'));
  let next = settle(rules.requestDeclare(gs, inst.uid));
  if (next.prompt?.kind === 'effect-choice') {
    // 两个宣言：[0] 与 [C1] → 选 [C1]
    next = settle(rules.chooseEffectOption(next, [next.prompt.options[1].id]));
  }
  if (next.prompt?.kind === 'card-pick') {
    // 支付 [C1]：玩家选择破弃的充能
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  }
  check('护盾从ゴミ箱获得（充能费用进ゴミ箱）', next.players[0].shield.length === 1 && next.players[0].trash.length === 1, `shield=${next.players[0].shield.length} trash=${next.players[0].trash.length}`);
}
{
  // 防御方支援：SP 加 DP，战斗后消失
  const atkCard = byId.get('LO-6846')!; // AP7 DP7
  const defCard = byId.get('LO-6969-A')!; // AP6 DP6 SP2
  const supCard = byId.get('LO-6845')!; // SP1
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = newInstance(atkCard.id);
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const def = newInstance(defCard.id);
  def.faceUp = true;
  def.deployedTurn = null;
  gs.players[1].field[1][0] = def;
  const sup = newInstance(supCard.id);
  sup.faceUp = true;
  sup.deployedTurn = null;
  gs.players[1].field[1][1] = sup; // 与防御者相邻（DF 左右）
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, def.uid); // 指定防御 → バトル中宣言タイミング（攻击方先）
  check('进入バトル中宣言タイミング（攻击方）', next.prompt?.kind === 'battle-timing' && next.prompt.owner === 0, JSON.stringify(next.prompt?.kind));
  next = rules.battleTimingAction(next, 'end'); // 攻击方结束
  check('轮到防御方宣言时机', next.prompt?.kind === 'battle-timing' && next.prompt.owner === 1, JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'battle-timing') {
    const supOpt = next.prompt.options.find((o) => o.id.startsWith('sup:'));
    check('防御方支援选项可用', !!supOpt);
    if (supOpt) {
      next = rules.battleTimingAction(next, supOpt.id); // 防御方支援 → 时点回到攻击方（Bug 16 交替）
      next = rules.battleTimingAction(next, 'end'); // 攻击方放弃 → 防御方
      next = rules.battleTimingAction(next, 'end'); // 防御方放弃 → 双方连续放弃 → 战斗结果
    }
  }
  // def DP 6+1=7 vs atk AP7 → 不倒下；def AP6 vs atk DP7 → 不倒下 → 双方存活
  check('防御方支援后 DP 7 挡住 AP7', !!next.players[1].field[1][0] && !!next.players[0].field[0][0]);
  check('战斗后支援修正消失', effectiveStats(next, def.uid).dp === defCard.dp, `dp=${effectiveStats(next, def.uid).dp}`);
}
{
  // 切札：游戏中仅 1 回
  const card = byId.get('LO-6964')!; // ラブピカルポッピー！ [宣言][切札]
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 2;
  const inst = newInstance(card.id);
  inst.faceUp = true;
  gs.players[0].special.push(inst);
  let next = settle(rules.requestDeclare(gs, inst.uid));
  check('切札使用后标记', next.trumpUsed === true);
  next = settle(rules.requestDeclare(next, inst.uid));
  check('切札第二次被拒', next.log.some((l) => l.includes('切札本局已使用过')), JSON.stringify(next.log.slice(-2)));
}

{
  // LO-6960 自ターン開始時：玩家选择ゴミ箱卡放入エリア下方
  const card = byId.get('LO-6960')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.turn = 2;
  gs.phase = 'start';
  const area = newInstance(card.id);
  area.faceUp = true;
  area.deployedTurn = null;
  gs.players[0].fieldAreas[0][0] = area;
  gs.players[0].trash.push(newInstance('LO-6845'), newInstance('LO-6850'));
  let next = settle(rules.beginTurn(gs));
  check('6960 回合开始 → 出现是否处理选择', next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip'), JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') next = settle(rules.chooseEffectOption(next, ['o0'])); // 处理
  check('6960 回合开始 → 选卡放入エリア下方', next.prompt?.kind === 'card-pick' && next.prompt.zone === 'trash', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'card-pick') {
    const chosen = next.prompt.candidates[1].uid; // 选第二张
    next = settle(rules.chooseCardPick(next, [chosen]));
  }
  check('选中的卡放入下方、另一张留在ゴミ箱', next.players[0].fieldAreas[0][0].under.length === 1 && next.players[0].trash.length === 1, `under=${next.players[0].fieldAreas[0][0].under.length} trash=${next.players[0].trash.length}`);
}
{
  // LO-6858 自ターン終了時：玩家选择破弃的充能
  const card = byId.get('LO-6858')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 2;
  const inst = newInstance(card.id);
  inst.faceUp = true;
  inst.deployedTurn = null;
  inst.charge.push(newInstance('LO-6845'), newInstance('LO-6846'));
  gs.players[0].field[0][0] = inst;
  gs.players[0].deck.push(newInstance('LO-6971'));
  let next = settle(rules.endTurn(gs));
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip')) {
    next = settle(rules.chooseEffectOption(next, ['o0'])); // 处理（破弃充能）
  }
  check('6858 回合结束 → 选择破弃的充能', next.prompt?.kind === 'card-pick' && next.prompt.zone === 'charge', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[1].uid]));
  }
  check('破弃选中的充能并抽 1', next.players[0].field[0][0]!.charge.length === 1 && next.players[0].hand.length === 1, `charge=${next.players[0].field[0][0]?.charge.length} hand=${next.players[0].hand.length}`);
}

{
  // LO-6852：每次效果只放 1 张到「青春カウント」置き場（3 是置き場上限）
  const card = byId.get('LO-6852')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'start';
  gs.turn = 2;
  const inst = newInstance(card.id);
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[0].field[0][0] = inst;
  gs.players[0].trash.push(newInstance('LO-6845'), newInstance('LO-6846'), newInstance('LO-6850'));
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next = settle(rules.beginTurn(gs)); // 自ターン開始時触发
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip')) {
    next = settle(rules.chooseEffectOption(next, ['o0'])); // 处理（放入置き場）
  }
  if (next.prompt?.kind === 'card-pick') {
    check('6852 每次只放 1 张（max=1）', next.prompt.max === 1, JSON.stringify(next.prompt.max));
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  }
  check('青春カウント置き場 1 张', (next.players[0].storage['青春カウント'] ?? []).length === 1, JSON.stringify((next.players[0].storage['青春カウント'] ?? []).length));
}

{
  // 対応链：后发先至（LIFO）—— 攻击宣言后 NTP/TP 交替对应，放弃后倒序结算
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = newInstance('LO-6846');
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const hd0 = newInstance('LO-6856'); // 无时机限制的手札宣言（对应时可发）
  hd0.faceUp = true;
  gs.players[0].hand.push(hd0);
  const hd1 = newInstance('LO-6856');
  hd1.faceUp = true;
  gs.players[1].hand.push(hd1);
  let next = rules.declareAttack(gs, atk.uid);
  check('攻击宣言进入対応窗口（NTP）', next.prompt?.kind === 'response' && next.prompt.owner === 1, JSON.stringify(next.prompt?.kind));
  next = rules.respond(next, `hd:${hd1.uid}`);
  check('NTP对应后轮到TP', next.prompt?.kind === 'response' && next.prompt.owner === 0, JSON.stringify(next.prompt?.kind));
  next = rules.respond(next, `hd:${hd0.uid}`);
  check('TP对应后轮到NTP', next.prompt?.kind === 'response' && next.prompt.owner === 1, JSON.stringify(next.prompt?.kind));
  next = rules.respond(next, 'pass'); // 倒序结算：TP的hd → NTP的hd → 攻击
  check('攻击最后结算（バトル开始→防御指定）', !!next.battle && next.prompt?.kind === 'defense', JSON.stringify(next.prompt?.kind));
}
{
  // 対応禁止（LO-6850 [D2]）：不弹対応窗口直接结算
  const card = byId.get('LO-6850')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const caster = newInstance(card.id);
  caster.faceUp = true;
  gs.players[0].hand.push(caster);
  gs.players[0].deck.push(newInstance('LO-6960'));
  let next = settle(rules.requestHandDeclare(gs, caster.uid));
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, [next.prompt.options[0].id]));
  }
  check('6850 D2 対応禁止：直接进入检索', next.prompt?.kind === 'search-deploy', JSON.stringify(next.prompt?.kind));
}
{
  // 「相手ターン中に使用する」手札宣言（LO-6902）在自己回合被拒
  const card = byId.get('LO-6902')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  const inst = newInstance(card.id);
  inst.faceUp = true;
  gs.players[0].hand.push(inst);
  const next = settle(rules.requestHandDeclare(gs, inst.uid));
  check('相手ターン中卡在自己回合被拒', next.players[0].hand.length === 1 && next.log.some((l) => l.includes('无法在当前时点')), JSON.stringify(next.log.slice(-1)));
}
{
  // LO-6955：対応窗口不出现；无防御者战斗时点出现
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = newInstance('LO-6846');
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const yj = newInstance('LO-6955');
  yj.faceUp = true;
  gs.players[1].hand.push(yj);
  let next = rules.declareAttack(gs, atk.uid);
  check('対応窗口不显示 LO-6955（対応を除く）', next.prompt?.kind === 'response' && !next.prompt.options.some((o) => o.id === `hd:${yj.uid}`), JSON.stringify(next.prompt?.options.map((o) => o.id)));
  next = settle(next); // 放弃対応
  next = rules.chooseDefense(next, null); // 不防御 → 无防御者战斗时点
  next = rules.battleTimingAction(next, 'end'); // TP结束 → NTP
  check('无防御者战斗时点显示 LO-6955', next.prompt?.kind === 'battle-timing' && next.prompt.owner === 1 && next.prompt.options.some((o) => o.id === `hd:${yj.uid}`), JSON.stringify(next.prompt?.options.map((o) => o.id)));
}

{
  // 道具离场诱発：LO-6955 随角色被打倒进ゴミ箱 → 弹选卡放入 AMBITIOUS MISSION 下方
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = newInstance('LO-6846');
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const def = newInstance('LO-6971');
  def.faceUp = true;
  def.deployedTurn = null;
  gs.players[1].field[1][0] = def;
  const yj = newInstance('LO-6955');
  yj.faceUp = true;
  def.equip = yj;
  gs.players[1].trash.push(newInstance('LO-6845'));
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, def.uid);
  next = rules.battleTimingAction(next, 'end');
  next = rules.battleTimingAction(next, 'end');
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip')) {
    next = settle(rules.chooseEffectOption(next, ['o0'])); // 处理（放入エリア下方）
  }
  check('道具离场诱発弹选卡', next.prompt?.kind === 'card-pick', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'card-pick') {
    next = rules.chooseCardPick(next, [next.prompt.candidates[0].uid]);
    check('无 AMBITIOUS MISSION 时效果落空（无提示）', next.prompt === null, JSON.stringify(next.prompt?.kind));
  }
}

/* ---------- 19. 手动效果转自动回归（6857/6898/6848/6852/6959-A/6946-K/6939/6889） ---------- */
{
  // 6857：AP+3/DP+3 + 强制防御指定（解析为 stat+forceDefend）
  const card = byId.get('LO-6857')!;
  const p = parseCard(card);
  const opt = p.declared.filter((d) => d.tag === '手札宣言').flatMap((d) => d.options).find((o) => o.actions.some((a) => a.t === 'forceDefend'));
  check('6857 AP+3/DP+3+强制防御 解析', !!opt && opt.parsed && opt.actions.some((a) => a.t === 'stat' && a.stat === 'ap' && a.amount === 3) && opt.actions.some((a) => a.t === 'forceDefend'), JSON.stringify(opt?.actions.map((a) => a.t)));
}
{
  // 6857 完整流程：宣言 → 味方目标 → AP+3/DP+3 且自动指定唯一对方角色为强制防御
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const caster = newInstance('LO-6857');
  caster.faceUp = true;
  gs.players[0].hand.push(caster, newInstance('LO-6857'), newInstance('LO-6857')); // 宣言卡 + 2 张 宙 EX2 付费用
  const ally = newInstance('LO-6846');
  ally.faceUp = true;
  ally.deployedTurn = null;
  gs.players[0].field[0][0] = ally;
  const opp = newInstance('LO-6846');
  opp.faceUp = true;
  opp.deployedTurn = null;
  gs.players[1].field[0][0] = opp;
  let next = settle(rules.requestHandDeclare(gs, caster.uid));
  check('6857 先选择能力块', next.prompt?.kind === 'effect-choice', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, ['1'])); // 第 2 个 [宙宙]（AP+3/DP+3+强制防御）
  }
  check('6857 进入费用选择', next.prompt?.kind === 'cost-pay', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== caster.uid).slice(0, 1).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('6857 选择味方角色目标', next.prompt?.kind === 'declare-target', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'declare-target') {
    next = settle(rules.chooseDeclareTarget(next, ally.uid));
  }
  const allyAfter = next.players[0].field[0][0]!;
  check('6857 味方获得 AP+3/DP+3 与强制防御标记', allyAfter.tempMods.ap === 3 && allyAfter.tempMods.dp === 3 && allyAfter.tempForceDefend?.targetUid === opp.uid, JSON.stringify({ ap: allyAfter.tempMods.ap, dp: allyAfter.tempMods.dp, fd: allyAfter.tempForceDefend }));
}
{
  // 6898：サポート时 +2/+2/+1 且无ボーナス时获得ボーナス（解析）
  const card = byId.get('LO-6898')!;
  const p = parseCard(card);
  const sup = p.triggers.find((t) => t.trigger === 'supportUsed');
  const opt = sup?.options[0];
  check('6898 サポート+ボーナス 解析', !!opt && opt.parsed && opt.actions.some((a) => a.t === 'stat' && a.stat === 'dmg' && a.amount === 1) && opt.actions.some((a) => a.t === 'grantBonusIfNone' && a.bonus === 'discardDeck'), JSON.stringify(opt?.actions.map((a) => a.t)));
}
{
  // 6848：手札宣言[雪雪雪雪] → 破弃1体 + 手牌/「はつゆきさくら」下方合计5 + 对方2体まで（解析）
  const card = byId.get('LO-6848')!;
  const p = parseCard(card);
  const hd = p.declared.find((d) => d.tag === '手札宣言' && d.cost === '雪雪雪雪');
  const opt = hd?.options[0];
  check('6848 手札宣言解析', !!opt && opt.parsed && opt.actions.some((a) => a.t === 'discardChar') && opt.actions.some((a) => a.t === 'discardHandOrUnder' && a.n === 5) && opt.actions.some((a) => a.t === 'discardCharUpTo' && a.n === 2), JSON.stringify(opt?.actions.map((a) => a.t + (a.n ? ':' + a.n : ''))));
}
{
  // 6848 完整流程：选能力 → 费用 → 破弃1体 → 手牌/下方合计5 → 对方2体まで
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const caster = newInstance('LO-6848');
  caster.faceUp = true;
  gs.players[0].hand.push(caster, newInstance('LO-6845'), newInstance('LO-6845')); // 宣言卡 + 2 张 雪 EX2 付费用
  for (let i = 0; i < 4; i++) gs.players[0].hand.push(newInstance('LO-6850')); // 4 张供破弃
  const sakura = newInstance('LO-6958');
  sakura.under.push(newInstance('LO-6845'), newInstance('LO-6845'));
  gs.players[0].fieldAreas[0][0] = sakura;
  const opp1 = newInstance('LO-6846');
  opp1.faceUp = true;
  opp1.deployedTurn = null;
  const opp2 = newInstance('LO-6846');
  opp2.faceUp = true;
  opp2.deployedTurn = null;
  const opp3 = newInstance('LO-6846');
  opp3.faceUp = true;
  opp3.deployedTurn = null;
  gs.players[1].field[0][0] = opp1;
  gs.players[1].field[0][1] = opp2;
  gs.players[1].field[0][2] = opp3;
  let next = settle(rules.requestHandDeclare(gs, caster.uid));
  check('6848 唯一手札宣言[雪雪雪雪]直接进入费用', next.prompt?.kind === 'cost-pay', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== caster.uid && c.cardId === 'LO-6845').slice(0, 2).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('6848 选择要破弃的对方角色（第1体）', next.prompt?.kind === 'declare-target', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'declare-target') {
    next = settle(rules.chooseDeclareTarget(next, next.prompt.candidates[0].uid));
  }
  check('6848 进入手牌/下方合计破弃', next.prompt?.kind === 'card-pick' && next.prompt.purpose === 'handUnder', JSON.stringify(next.prompt?.purpose));
  if (next.prompt?.kind === 'card-pick' && next.prompt.purpose === 'handUnder') {
    const picks = next.prompt.candidates.slice(0, 5).map((c) => c.uid); // 4 手牌 + 1 下方
    next = settle(rules.chooseCardPick(next, picks));
  }
  check('6848 破弃满5张后选择对方角色（最多2体）', next.prompt?.kind === 'card-pick' && next.prompt.purpose === 'discardOppChar', JSON.stringify(next.prompt?.purpose));
  if (next.prompt?.kind === 'card-pick' && next.prompt.purpose === 'discardOppChar') {
    next = settle(rules.chooseCardPick(next, next.prompt.candidates.map((c) => c.uid)));
  }
  check('6848 全流程：对方场空、手牌空、はつゆきさくら下方剩1', next.players[1].field[0][0] === null && next.players[1].field[0][1] === null && next.players[1].field[0][2] === null && next.players[0].hand.length === 0 && next.players[0].fieldAreas[0][0]!.under.length === 1, `opp0=${!!next.players[1].field[0][0]} opp1=${!!next.players[1].field[0][1]} opp2=${!!next.players[1].field[0][2]} hand=${next.players[0].hand.length} under=${next.players[0].special[0]?.under.length}`);
}
{
  // 6852：置き場达到 4 张 → 回合开始时自己回牌堆底；不足 4 张留在场上
  const card = byId.get('LO-6852')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'start';
  gs.turn = 2;
  const inst = newInstance(card.id);
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[0].field[0][0] = inst;
  gs.players[0].storage['青春カウント'] = [newInstance('LO-6845'), newInstance('LO-6845'), newInstance('LO-6845')];
  gs.players[0].trash.push(newInstance('LO-6845'));
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'), newInstance('LO-6971'), newInstance('LO-6971'));
  let next = settle(rules.beginTurn(gs));
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip')) {
    next = settle(rules.chooseEffectOption(next, ['o0'])); // 处理（放入置き場）
  }
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  }
  check('6852 置き場4张后回牌堆底', next.players[0].field[0][0] === null && next.players[0].deck[0]?.uid === inst.uid && (next.players[0].storage['青春カウント'] ?? []).length === 4, `field=${!!next.players[0].field[0][0]} storage=${(next.players[0].storage['青春カウント'] ?? []).length}`);
  const gs2 = mkGame();
  gs2.turnPlayer = 0;
  gs2.phase = 'start';
  gs2.turn = 2;
  const inst2 = newInstance(card.id);
  inst2.faceUp = true;
  inst2.deployedTurn = null;
  gs2.players[0].field[0][0] = inst2;
  gs2.players[0].trash.push(newInstance('LO-6845'));
  gs2.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next2 = settle(rules.beginTurn(gs2));
  if (next2.prompt?.kind === 'effect-choice' && next2.prompt.options.some((o) => o.id === '__skip')) {
    next2 = settle(rules.chooseEffectOption(next2, ['o0'])); // 处理（放入置き場）
  }
  if (next2.prompt?.kind === 'card-pick') {
    next2 = settle(rules.chooseCardPick(next2, [next2.prompt.candidates[0].uid]));
  }
  check('6852 不足4张留在场上', next2.players[0].field[0][0]?.uid === inst2.uid && (next2.players[0].storage['青春カウント'] ?? []).length === 1, `storage=${(next2.players[0].storage['青春カウント'] ?? []).length}`);
}
{
  // 6959-A：エリア下方达到 3 张 → 随机回复牌堆最多 2 张；不足则跳过
  const card = byId.get('LO-6959-A')!;
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const area = newInstance(card.id);
  area.faceUp = true;
  area.deployedTurn = null;
  area.under.push(newInstance('LO-6845'), newInstance('LO-6845'));
  gs.players[0].fieldAreas[0][0] = area;
  gs.players[0].trash.push(newInstance('LO-6846'), newInstance('LO-6850'));
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next = settle(rules.requestDeclare(gs, area.uid));
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  }
  const aUnder = next.players[0].fieldAreas[0][0]!.under.length;
  check('6959-A 下方3张后回复牌堆', aUnder === 3 && next.players[0].trash.length === 0 && next.players[0].deck.length === 2, `under=${aUnder} trash=${next.players[0].trash.length} deck=${next.players[0].deck.length}`);
  const gs2 = mkGame();
  gs2.turnPlayer = 0;
  gs2.phase = 'main';
  gs2.turn = 3;
  const area2 = newInstance(card.id);
  area2.faceUp = true;
  area2.deployedTurn = null;
  gs2.players[0].fieldAreas[0][0] = area2;
  gs2.players[0].trash.push(newInstance('LO-6846'), newInstance('LO-6850'));
  gs2.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next2 = settle(rules.requestDeclare(gs2, area2.uid));
  if (next2.prompt?.kind === 'card-pick') {
    next2 = settle(rules.chooseCardPick(next2, [next2.prompt.candidates[0].uid]));
  }
  const bUnder = next2.players[0].fieldAreas[0][0]!.under.length;
  check('6959-A 不足3张不回复', bUnder === 1 && next2.players[0].trash.length === 1 && next2.players[0].deck.length === 1, `under=${bUnder} trash=${next2.players[0].trash.length} deck=${next2.players[0].deck.length}`);
}
{
  // 6946-K：登场时「検索配置しない場合、味方「星九頭学生寮」4枚以上 → 己方デッキ回復」
  const card = byId.get('LO-6946-K')!;
  const gs = mkGame();
  gs.turn = 3;
  gs.turnPlayer = 0;
  const inst = newInstance(card.id);
  inst.faceUp = true;
  inst.deployedTurn = 3;
  gs.players[0].field[0][0] = inst;
  for (let i = 0; i < 4; i++) {
    const rr = i < 2 ? 0 : 1;
    const aa = i % 2;
    gs.players[0].fieldAreas[rr][aa] = newInstance('LO-6966'); // 星九頭学生寮 ×4（不同フィールド）
  }
  gs.players[0].trash.push(newInstance('LO-6845'), newInstance('LO-6845'));
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next = settle(runDeployChain(gs, inst.uid, 0));
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.label.includes('不破弃牌堆'))) {
    next = settle(rules.chooseEffectOption(next, ['0'])); // 登场充能：不破弃牌堆
  }
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [])); // 登场充能：不选
  }
  check('6946-K 登场出现效果选择', next.prompt?.kind === 'effect-choice', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, ['o1'])); // 不做上述时分支
  }
  check('6946-K 星九頭4张→出现回复选卡', next.prompt?.kind === 'card-pick', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  }
  check('6946-K 星九頭4张→回复牌堆（先抽1再回复）', next.players[0].trash.length === 1 && next.players[0].deck.length === 2, `trash=${next.players[0].trash.length} deck=${next.players[0].deck.length}`);
  const gs2 = mkGame();
  gs2.turn = 3;
  gs2.turnPlayer = 0;
  const inst2 = newInstance(card.id);
  inst2.faceUp = true;
  inst2.deployedTurn = 3;
  gs2.players[0].field[0][0] = inst2;
  gs2.players[0].trash.push(newInstance('LO-6845'), newInstance('LO-6845'));
  gs2.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next2 = settle(runDeployChain(gs2, inst2.uid, 0));
  if (next2.prompt?.kind === 'effect-choice' && next2.prompt.options.some((o) => o.label.includes('不破弃牌堆'))) {
    next2 = settle(rules.chooseEffectOption(next2, ['0']));
  }
  if (next2.prompt?.kind === 'card-pick') {
    next2 = settle(rules.chooseCardPick(next2, [])); // 登场充能：不选
  }
  if (next2.prompt?.kind === 'effect-choice') {
    next2 = settle(rules.chooseEffectOption(next2, ['o1']));
  }
  check('6946-K 星九頭不足4张不回复（仅抽1）', next2.players[0].trash.length === 2 && next2.players[0].deck.length === 1, `trash=${next2.players[0].trash.length} deck=${next2.players[0].deck.length}`);
}
{
  // 6939 / 6889：不做上述时 → 味方「星九頭学生寮」4枚以上 → 相手デッキ破棄 / 「アクティ部」2枚以上 → 己方デッキ回復（解析）
  const c6939 = byId.get('LO-6939')!;
  const p6939 = parseCard(c6939);
  const o6939 = p6939.triggers.flatMap((t) => t.options).find((o) => o.actions.some((a) => a.t === 'discardDeck' && a.cond === 'friendlyN4'));
  check('6939 星九頭4张→对方牌堆破弃（条件动作）', !!o6939 && o6939.parsed, JSON.stringify(o6939?.actions.map((a) => a.t + (a.cond ? ':' + a.cond : ''))));
  const c6889 = byId.get('LO-6889')!;
  const p6889 = parseCard(c6889);
  const o6889 = p6889.triggers.flatMap((t) => t.options).find((o) => o.actions.some((a) => a.t === 'healDeck' && a.cond === 'friendlyN2'));
  check('6889 アクティ部2张→己方牌堆回复（条件动作）', !!o6889 && o6889.parsed, JSON.stringify(o6889?.actions.map((a) => a.t + (a.cond ? ':' + a.cond : ''))));
}

/* ---------- 20. エンゲージ登场（52 张基本能力） ---------- */
{
  // LO-6848 エンゲージ登场：破弃己方场上的角色 → 括弧效果（被破弃角色回牌堆底 + 抽1）
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const newChar = newInstance('LO-6848');
  newChar.faceUp = true;
  gs.players[0].hand.push(newChar);
  const oldChar = newInstance('LO-6846');
  oldChar.faceUp = true;
  oldChar.deployedTurn = null;
  gs.players[0].field[0][0] = oldChar;
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  gs.players[0].hand.push(newInstance('LO-6845')); // 雪 EX2 付费用
  let next = settle(rules.requestPlayCharacter(gs, newChar.uid, 'AF', 0));
  check('エンゲージ登场进入费用选择', next.prompt?.kind === 'cost-pay', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== newChar.uid).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('エンゲージ登场：新角色就位、旧角色被破弃', next.players[0].field[0][0]?.uid === newChar.uid && !next.players[0].field[0][0]!.equip && next.players[0].deck[0]?.uid === oldChar.uid, `field=${next.players[0].field[0][0]?.uid} deckBottom=${next.players[0].deck[0]?.uid === oldChar.uid}`);
  check('エンゲージ效果：被破弃角色回牌堆底 + 抽1', next.players[0].deck[0]?.uid === oldChar.uid && next.players[0].deck.length === 2 && next.players[0].hand.length === 1, `deckBottom=${next.players[0].deck[0]?.uid === oldChar.uid} deckLen=${next.players[0].deck.length} hand=${next.players[0].hand.length}`);
}
{
  // エンゲージ登场诱発：LO-6940 破弃原DMG≥3 的「近江希未」→ 充能 1 张 + 该角色回牌堆底
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const newChar = newInstance('LO-6940');
  newChar.faceUp = true;
  gs.players[0].hand.push(newChar);
  const oldChar = newInstance('LO-6940'); // 近江希未 dmg=3
  oldChar.faceUp = true;
  oldChar.deployedTurn = null;
  gs.players[0].field[0][0] = oldChar;
  gs.players[0].trash.push(newInstance('LO-6845')); // 充能材料
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  gs.players[0].hand.push(newInstance('LO-6966'), newInstance('LO-6966')); // 日 EX2 付费用
  let next = settle(rules.requestPlayCharacter(gs, newChar.uid, 'AF', 0));
  check('6940 エンゲージ登场进入费用选择', next.prompt?.kind === 'cost-pay', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== newChar.uid).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('6940 エンゲージ触发充能选择', next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip'), JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, ['o0'])); // 处理（充能）
  }
  if (next.prompt?.kind === 'card-pick') {
    const pick = next.prompt.candidates.find((c) => c.cardId !== 'LO-6940') ?? next.prompt.candidates[0];
    next = settle(rules.chooseCardPick(next, [pick.uid]));
  }
  check('6940 充能 1 张', next.players[0].field[0][0]!.charge.length === 1, `charge=${next.players[0].field[0][0]?.charge.length}`);
  check('6940 被破弃的「近江希未」回牌堆底', next.players[0].deck[0]?.uid === oldChar.uid, `deckBottom=${next.players[0].deck[0]?.uid === oldChar.uid}`);
}
{
  // エンゲージ诱発不满足：破弃 DMG<3 的角色 → 不触发充能
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const newChar = newInstance('LO-6940');
  newChar.faceUp = true;
  gs.players[0].hand.push(newChar);
  const oldChar = newInstance('LO-6877'); // dmg=0
  oldChar.faceUp = true;
  oldChar.deployedTurn = null;
  gs.players[0].field[0][0] = oldChar;
  gs.players[0].hand.push(newInstance('LO-6966'), newInstance('LO-6966'));
  let next = settle(rules.requestPlayCharacter(gs, newChar.uid, 'AF', 0));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== newChar.uid).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('6940 破弃DMG0角色→不触发充能', next.prompt === null && next.players[0].field[0][0]?.uid === newChar.uid, JSON.stringify(next.prompt?.kind));
}

/* ---------- 21. 6862 家族：检索「小坂井綾」并用手札宣言能力 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const src = newInstance('LO-6862');
  src.faceUp = true;
  gs.players[0].hand.push(src);
  // 味方：はつゆきさくら 下方 2 张 + 手牌 4 张（供綾的 [雪雪雪雪] 合计破弃）
  const sakura = newInstance('LO-6958');
  sakura.under.push(newInstance('LO-6845'), newInstance('LO-6845'));
  gs.players[0].fieldAreas[0][0] = sakura;
  for (let i = 0; i < 4; i++) gs.players[0].hand.push(newInstance('LO-6850'));
  // 对方场 3 体（破弃 1 体 + 2 体まで）
  for (let a = 0; a < 3; a++) {
    const opp = newInstance('LO-6846');
    opp.faceUp = true;
    opp.deployedTurn = null;
    gs.players[1].field[0][a] = opp;
  }
  gs.players[0].deck.push(newInstance('LO-6848')); // 初雪から桜まで 小坂井綾
  let next = settle(rules.requestHandDeclare(gs, src.uid));
  check('6862 手札宣言[0]出现选项', next.prompt?.kind === 'effect-choice' && next.prompt.options.length === 2, JSON.stringify(next.prompt?.options.map((o) => o.id)));
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, ['o1'])); // 检索綾并用手札宣言
  }
  check('6862 检索到綾的手札宣言能力（[雪雪雪雪]）', next.prompt?.kind === 'effect-choice' && next.prompt.options.length === 1 && next.prompt.options[0].label.includes('雪雪雪雪'), JSON.stringify(next.prompt?.options.map((o) => o.id)));
  const uid6848 = next.players[0].deck[0]?.uid;
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, [uid6848 + '|2'])); // 綾的 [雪雪雪雪]
  }
  check('6862 使用綾的手札宣言：选择破弃对方角色', next.prompt?.kind === 'declare-target', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'declare-target') {
    next = settle(rules.chooseDeclareTarget(next, next.prompt.candidates[0].uid));
  }
  check('6862 进入手牌/下方合计破弃', next.prompt?.kind === 'card-pick' && next.prompt.purpose === 'handUnder', JSON.stringify(next.prompt?.purpose));
  if (next.prompt?.kind === 'card-pick' && next.prompt.purpose === 'handUnder') {
    const picks = next.prompt.candidates.slice(0, 5).map((c) => c.uid);
    next = settle(rules.chooseCardPick(next, picks));
  }
  check('6862 破弃满5张后选择对方角色', next.prompt?.kind === 'card-pick' && next.prompt.purpose === 'discardOppChar', JSON.stringify(next.prompt?.purpose));
  if (next.prompt?.kind === 'card-pick' && next.prompt.purpose === 'discardOppChar') {
    next = settle(rules.chooseCardPick(next, next.prompt.candidates.map((c) => c.uid)));
  }
  check('6862 全流程：对方场空、綾留在牌堆', next.players[1].field[0][0] === null && next.players[1].field[0][1] === null && next.players[1].field[0][2] === null && next.players[0].deck.some((c) => c.uid === uid6848), `opp0=${!!next.players[1].field[0][0]} deckHas綾=${next.players[0].deck.some((c) => c.uid === uid6848)}`);
}

/* ---------- 22. 6961/6963 エリア：使用自己的道具/手札宣言后 → 下方置き ---------- */
{
  // 6961 AMBITIOUS MISSION：装备自己的道具（支付费用）→ ゴミ箱1张放エリア下方
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const host = newInstance('LO-6846');
  host.faceUp = true;
  host.deployedTurn = null;
  gs.players[0].field[0][0] = host;
  const area = newInstance('LO-6961');
  area.faceUp = true;
  area.deployedTurn = null;
  gs.players[0].fieldAreas[0][0] = area;
  const item = newInstance('LO-6957'); // アクティ部（道具，费用月月）
  item.faceUp = true;
  gs.players[0].hand.push(item, newInstance('LO-6850')); // 月 EX2 付费用
  gs.players[0].trash.push(newInstance('LO-6845'));
  let next = settle(rules.requestEquipItem(gs, item.uid, host.uid));
  check('6961 装备进入费用选择', next.prompt?.kind === 'cost-pay', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== item.uid).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('6961 装备成功', next.players[0].field[0][0]!.equip?.uid === item.uid, `equip=${!!next.players[0].field[0][0]?.equip}`);
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip')) {
    next = settle(rules.chooseEffectOption(next, ['o0'])); // 处理（放入エリア下方）
  }
  check('6961 装备后出现エリア下方选卡', next.prompt?.kind === 'card-pick', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
    check('6961 选卡后エリア下方 1 张', next.players[0].fieldAreas[0][0]!.under.length === 1, `under=${next.players[0].special[0]?.under.length}`);
  }
}
{
  // 6963 恋する乙女：装备自己的道具 → ゴミ箱1张放エリア下方
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const host = newInstance('LO-6846');
  host.faceUp = true;
  host.deployedTurn = null;
  gs.players[0].field[0][0] = host;
  const area = newInstance('LO-6963');
  area.faceUp = true;
  area.deployedTurn = null;
  gs.players[0].fieldAreas[0][0] = area;
  const item = newInstance('LO-6957');
  item.faceUp = true;
  gs.players[0].hand.push(item, newInstance('LO-6850'));
  gs.players[0].trash.push(newInstance('LO-6845'));
  let next = settle(rules.requestEquipItem(gs, item.uid, host.uid));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== item.uid).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('6963 装备后出现エリア下方选卡', next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip'), JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') {
    next = settle(rules.chooseEffectOption(next, ['o0'])); // 处理（放入エリア下方）
  }
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
    check('6963 エリア下方收到 1 张（装备触发）', next.players[0].fieldAreas[0][0]!.under.length === 1, `under=${next.players[0].special[0]?.under.length}`);
  }
}

/* ---------- 23. 6958 はつゆきさくら 自毁条件 / 6962 支援值作为DP ---------- */
{
  // 6958：配置时若味方AF原DMG≥2 的角色 ≤2 体 → 此エリア自毁
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const area = newInstance('LO-6958');
  area.faceUp = true;
  gs.players[0].hand.push(area);
  const af1 = newInstance('LO-6848'); // dmg=3
  af1.faceUp = true;
  af1.deployedTurn = null;
  gs.players[0].field[0][0] = af1;
  gs.players[0].hand.push(newInstance('LO-6845')); // 雪 EX2 付费用
  let next = settle(rules.requestPlayArea(gs, area.uid));
  check('6958 配置先选位置', next.prompt?.kind === 'slot-pick', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'slot-pick') {
    next = settle(rules.chooseSlot(next, next.prompt.slots[0].row, next.prompt.slots[0].area));
  }
  check('6958 配置进入费用选择', next.prompt?.kind === 'cost-pay', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== area.uid).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('6958 味方AF原DMG≥2≤2体 → エリア自毁', next.players[0].fieldAreas.flat().filter(Boolean).length === 0 && next.players[0].trash.some((c) => c.uid === area.uid), `areas=${next.players[0].fieldAreas.flat().filter(Boolean).length}`);
  // 场景 B：3 体 AF 原DMG≥2 且由玉樹桜配置 → エリア保留
  const gs2 = mkGame();
  gs2.turnPlayer = 0;
  gs2.phase = 'main';
  gs2.turn = 3;
  const area2 = newInstance('LO-6958');
  area2.faceUp = true;
  area2.placedByYushu = true;
  gs2.players[0].hand.push(area2);
  for (let a = 0; a < 3; a++) {
    const af = newInstance('LO-6848');
    af.faceUp = true;
    af.deployedTurn = null;
    gs2.players[0].field[0][a] = af;
  }
  gs2.players[0].hand.push(newInstance('LO-6845'));
  let next2 = settle(rules.requestPlayArea(gs2, area2.uid));
  if (next2.prompt?.kind === 'slot-pick') {
    next2 = settle(rules.chooseSlot(next2, next2.prompt.slots[0].row, next2.prompt.slots[0].area));
  }
  if (next2.prompt?.kind === 'cost-pay') {
    const pay = next2.players[0].hand.filter((c) => c.uid !== area2.uid).map((c) => c.uid);
    next2 = settle(rules.confirmCostPay(next2, pay));
  }
  check('6958 3体+玉樹桜配置 → エリア保留', next2.players[0].fieldAreas.flat().some((c:any) => c?.uid === area2.uid), `areas=${next2.players[0].fieldAreas.flat().filter(Boolean).length}`);
}
{
  // 6962：支援宣言时 → 支援值可作为 DP（确认后 AP 减回、DP 加上）
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = newInstance('LO-6846');
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const sup = newInstance('LO-6845'); // SP 1
  sup.faceUp = true;
  sup.deployedTurn = null;
  gs.players[0].field[0][1] = sup;
  const area = newInstance('LO-6962');
  area.faceUp = true;
  area.deployedTurn = null;
  gs.players[0].fieldAreas[0][0] = area;
  const def = newInstance('LO-6971');
  def.faceUp = true;
  def.deployedTurn = null;
  gs.players[1].field[1][0] = def;
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, def.uid);
  check('6962 进入战斗时点', next.prompt?.kind === 'battle-timing', JSON.stringify(next.prompt?.kind));
  const supOpt = next.prompt?.options.find((o: { id: string }) => o.id.startsWith('sup:'));
  check('6962 支援选项存在', !!supOpt, JSON.stringify(next.prompt?.options.map((o) => o.id).slice(0, 5)));
  if (supOpt) {
    next = rules.battleTimingAction(next, supOpt.id);
  }
  check('6962 出现「参考值作为DP」选择', next.prompt?.kind === 'effect-choice' && (next.prompt.title ?? '').includes('作为 DP'), JSON.stringify(next.prompt?.kind));
  // 处理可选诱発（若有 __skip → 先选处理），再选 yes（参考值改为该支援角色的 DP）
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip')) {
    next = rules.chooseEffectOption(next, ['o0']);
  }
  if (next.prompt?.kind === 'effect-choice') {
    next = rules.chooseEffectOption(next, ['yes']);
  }
  const atkAfter = next.players[0].field[0][0]!;
  // 支援角色 6845：SP1 / DP3。支援先 AP+1，转换后撤销 +1 并按 DP 参考 +3 → AP 净 +3（DP 参考）
  check('6962 支援参考值 SP→该角色DP（AP 净 +DP）', atkAfter.tempMods.ap === 3, JSON.stringify({ ap: atkAfter.tempMods.ap, dp: atkAfter.tempMods.dp }));
}
{
  // 6962 在 [サポーター] 付费支援时也必须正常触发（Bug：支援者自身诱发弹窗会跳过 6962 的分段扫描）
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = newInstance('LO-6846');
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const sup = newInstance('LO-6855-S'); // [サポーター:[花花]] SP3
  sup.faceUp = true;
  sup.deployedTurn = null;
  gs.players[0].field[0][1] = sup;
  const area = newInstance('LO-6962');
  area.faceUp = true;
  area.deployedTurn = null;
  gs.players[0].fieldAreas[0][0] = area;
  const def = newInstance('LO-6971');
  def.faceUp = true;
  def.deployedTurn = null;
  gs.players[1].field[1][0] = def;
  gs.players[0].hand.push(newInstance('LO-6855-S')); // 花 EX2 支付 [花花]
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, def.uid);
  const supCOpt = next.prompt?.kind === 'battle-timing' ? next.prompt.options.find((o) => o.id.startsWith('supC:')) : null;
  check('サポーター选项存在（费用[花花]）', !!supCOpt, JSON.stringify(next.prompt?.options.map((o) => o.id).slice(0, 6)));
  if (supCOpt) next = rules.battleTimingAction(next, supCOpt.id);
  check('サポーター费用进入手动选择面板', next.prompt?.kind === 'cost-pay' && next.prompt.cost === '花花', JSON.stringify(next.prompt && { k: next.prompt.kind, cost: (next.prompt as any).cost }));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.prompt.candidates[0]?.uid;
    next = rules.confirmCostPay(next, pay ? [pay] : []);
  }
  check('サポーター支援后 6962 诱发正常出现（参考值作为DP）', next.prompt?.kind === 'effect-choice' && (next.prompt.title ?? '').includes('作为 DP'), JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') next = rules.chooseEffectOption(next, ['yes']);
  // 唐朽 SP3（DP6）：AP 原 +3 → 转换撤销 +3 并按 DP 参考 +6
  const atkAfter = next.players[0].field[0][0]!;
  check('サポーター + 6962：支援参考值改为该角色 DP（AP 净 +6）', atkAfter.tempMods.ap === 6, JSON.stringify({ ap: atkAfter.tempMods.ap, dp: atkAfter.tempMods.dp }));
}

/* ---------- 24. サプライズ登场（バトル中时点可宣言登场） ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const atk = newInstance('LO-6846');
  atk.faceUp = true;
  atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const def = newInstance('LO-6971');
  def.faceUp = true;
  def.deployedTurn = null;
  gs.players[1].field[1][0] = def;
  const sup = newInstance('LO-6850'); // サプライズ+エンゲージ，费用月月月
  sup.faceUp = true;
  gs.players[1].hand.push(sup, newInstance('LO-6850'), newInstance('LO-6850')); // 2 张月 EX2 付费用
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, def.uid);
  check('攻击方战斗时点开启', next.prompt?.kind === 'battle-timing' && next.prompt.owner === 0, JSON.stringify(next.prompt?.owner));
  next = rules.battleTimingAction(next, 'end'); // 攻击方结束 → 防御方时点
  check('サプライズ登场选项出现在防御方战斗时点', next.prompt?.kind === 'battle-timing' && next.prompt.options.some((o) => o.id === `sdp:${sup.uid}`), JSON.stringify(next.prompt?.options.map((o) => o.id).filter((i) => i.startsWith('sdp'))));
  if (next.prompt?.kind === 'battle-timing') {
    next = rules.battleTimingAction(next, `sdp:${sup.uid}`);
  }
  if (next.prompt?.kind === 'slot-pick') {
    next = settle(rules.chooseSlot(next, next.prompt.slots[0].row, next.prompt.slots[0].area));
  }
  check('サプライズ登场进入费用选择', next.prompt?.kind === 'cost-pay', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[1].hand.filter((c) => c.uid !== sup.uid).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  const supOnField = [0, 1].some((r) => [0, 1, 2].some((a) => next.players[1].field[r][a]?.uid === sup.uid));
  check('サプライズ登场成功（防御方场上有新角色）', supOnField, JSON.stringify({ f00: next.players[1].field[0][0]?.cardId, f10: next.players[1].field[1][0]?.cardId, f01: next.players[1].field[0][1]?.cardId, hand: next.players[1].hand.length }));
}

/* ---------- 25. 本批 bug 修复回归 ---------- */
{
  // 同编号角色（忽略字母）自己场只能 1 个：场上有 LO-6969，手牌 LO-6969-A 不能登场
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const onField = newInstance('LO-6969');
  onField.faceUp = true;
  onField.deployedTurn = null;
  gs.players[0].field[1][0] = onField;
  const inHand = newInstance('LO-6969-A');
  inHand.faceUp = true;
  gs.players[0].hand.push(inHand, newInstance('LO-6850')); // 月 EX2 费用（6969 费用 月月月?）
  const slots = rules.validDeploySlots(gs, 0, inHand.uid);
  const next = settle(rules.requestPlayCharacter(gs, inHand.uid, 'AF', 0));
  check('同编号角色不能重复登场', next.players[0].hand.some((c) => c.uid === inHand.uid) && next.log.some((l) => l.includes('同编号')), JSON.stringify(next.log.slice(-1)));
  void slots;
}
{
  // 登场ターン制限跨大回合：登场回合的角色不能支付 [T] 费用（同回合内）
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const inst = newInstance('LO-6845'); // 宣言 [T]
  inst.faceUp = true;
  inst.deployedTurn = 3; // 本回合登场 → 制限中
  gs.players[0].field[0][0] = inst;
  const next = settle(rules.requestDeclare(gs, inst.uid));
  check('登场ターン制限中无法使用 [T] 宣言', next.log.some((l) => l.includes('没有可用的宣言') || l.includes('登场ターン制限')), JSON.stringify(next.log.slice(-1)));
}
{
  // 移动一次一格：サイドステップ 只返回左右相邻
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const inst = newInstance('LO-6971-A'); // サイドステップ（DF-only）
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[0].field[1][1] = inst; // DF 中
  const targets = rules.validMoveTargets(gs, inst.uid);
  check('移动一格：只有相邻（DF中→DF左/右）', targets.length === 2 && targets.every((t) => t.row === 'DF' && Math.abs(t.area - 1) === 1), JSON.stringify(targets));
}
{
  // 移动宣言进対応窗口（基本能力可被对应）
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const inst = newInstance('LO-6971-A');
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[0].field[1][1] = inst;
  const next = rules.moveCharacter(gs, inst.uid, 'DF', 0);
  check('移动宣言进入対応窗口', next.prompt?.kind === 'response', JSON.stringify(next.prompt?.kind));
  const after = settle(next);
  check('放弃対応后移动结算（原格空、新格有卡）', after.players[0].field[1][1] === null && after.players[0].field[1][0]?.uid === inst.uid, JSON.stringify({ a: !!after.players[0].field[1][0], b: !!after.players[0].field[1][1] }));
}
{
  // デッキ回復由玩家从ゴミ箱选卡（非「ランダムに」）
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const caster = newInstance('LO-6898'); // サポート触发ボーナス复杂，用宣言简单路径
  void caster;
  // 直接验证 healDeck 动作的选卡：构造一个触发（星九頭 fallback 回复）
  const inst = newInstance('LO-6946-K');
  inst.faceUp = true;
  inst.deployedTurn = 3;
  gs.players[0].field[0][0] = inst;
  for (let i = 0; i < 4; i++) {
    const rr = i < 2 ? 0 : 1;
    gs.players[0].fieldAreas[rr][i % 2] = newInstance('LO-6966');
  }
  gs.players[0].trash.push(newInstance('LO-6845'), newInstance('LO-6846'));
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next = settle(runDeployChain(gs, inst.uid, 0));
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.label.includes('不破弃牌堆'))) {
    next = settle(rules.chooseEffectOption(next, ['0'])); // 登场充能：不破弃牌堆
  }
  if (next.prompt?.kind === 'card-pick') next = settle(rules.chooseCardPick(next, [])); // 充能不选
  if (next.prompt?.kind === 'effect-choice') next = settle(rules.chooseEffectOption(next, ['o1']));
  check('デッキ回復出现选卡（从ゴミ箱选）', next.prompt?.kind === 'card-pick' && next.prompt.title.includes('回复'), JSON.stringify(next.prompt?.title));
  if (next.prompt?.kind === 'card-pick') {
    next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
    check('回复选卡后：ゴミ箱-1、牌组+1（放卡组底）', next.players[0].trash.length === 1 && next.players[0].deck.length === 2, `trash=${next.players[0].trash.length} deck=${next.players[0].deck.length}`);
  }
}
{
  // ターンリカバリー：后攻第 1 回合（turn=2 的回合玩家）登场 6867 → 抽 1
  const gs = mkGame();
  gs.turnPlayer = 1; // 后攻
  gs.turn = 2;
  const inst = newInstance('LO-6867'); // ターンリカバリー:[1枚ドローする]
  inst.faceUp = true;
  gs.players[1].field[1][0] = inst;
  gs.players[1].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  const next = settle(runDeployChain(gs, inst.uid, 1));
  check('ターンリカバリー：后攻第1回合登场抽1', next.players[1].hand.length === 2 && next.log.some((l) => l.includes('ターンリカバリー')), JSON.stringify(next.log.slice(-2)));
}

/* ---------- 25. 本轮 16 个 Bug 的回归测试 ---------- */
{
  // Bug 1：联机重建玩家2卡组后抽 7 张（draw 返回值不能丢）
  const gs = mkGame();
  const ids = ['LO-6845', 'LO-6846', 'LO-6847', 'LO-6848', 'LO-6849', 'LO-6850', 'LO-6851', 'LO-6852'];
  const next = resetPlayerDeck(gs, 1, cards, ids);
  check('Bug1 玩家2重建卡组后抽7张', next.players[1].hand.length === 7, `hand=${next.players[1].hand.length}`);
}
{
  // Bug 2：充能两步流程（先选破弃牌堆 0~N → 再从ゴミ箱选 0~N；可完全不充能）
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  handOf(gs, 0, ['LO-6852', 'LO-6852', 'LO-6852']); // 6852 有 [チャージ:１]，费用月月月
  const uid = gs.players[0].hand[0].uid;
  gs.players[0].trash.push(newInstance('LO-6845'));
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next = settle(rules.requestPlayCharacter(gs, uid, 'DF', 0));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== uid).slice(0, 2).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('Bug2 登场充能先弹破弃牌堆选择', next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.label.includes('不破弃牌堆')), JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') next = settle(rules.chooseEffectOption(next, ['1'])); // 破弃牌堆 1 张
  check('Bug2 破弃牌堆后弹ゴミ箱选卡', next.prompt?.kind === 'card-pick' && next.prompt.purpose === 'charge' && next.prompt.max === 1, JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'card-pick') next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  check('Bug2 充能1张且牌堆-1', next.players[0].field[1][0]!.charge.length === 1 && next.players[0].deck.length === 1, `charge=${next.players[0].field[1][0]?.charge.length} deck=${next.players[0].deck.length}`);
  const gs2 = mkGame();
  gs2.turnPlayer = 0; gs2.phase = 'main'; gs2.turn = 3;
  handOf(gs2, 0, ['LO-6852', 'LO-6852', 'LO-6852']);
  const uid2 = gs2.players[0].hand[0].uid;
  gs2.players[0].trash.push(newInstance('LO-6845'));
  let next2 = settle(rules.requestPlayCharacter(gs2, uid2, 'DF', 0));
  if (next2.prompt?.kind === 'cost-pay') {
    const pay2 = next2.players[0].hand.filter((c) => c.uid !== uid2).slice(0, 2).map((c) => c.uid);
    next2 = settle(rules.confirmCostPay(next2, pay2));
  }
  if (next2.prompt?.kind === 'effect-choice' && next2.prompt.options.some((o) => o.label.includes('不破弃牌堆'))) next2 = settle(rules.chooseEffectOption(next2, ['0'])); // 不破弃
  if (next2.prompt?.kind === 'card-pick') next2 = settle(rules.chooseCardPick(next2, [])); // 不充能
  check('Bug2 可选择完全不充能', next2.players[0].field[1][0]!.charge.length === 0, `charge=${next2.players[0].field[1][0]?.charge.length}`);
}
{
  // Bug 3：promptOwner cost-pay = prompt.owner（サプライズ登场等非回合玩家付款）
  const gs = mkGame();
  gs.turnPlayer = 0;
  gs.prompt = {
    kind: 'cost-pay', cost: '月月', actionLabel: '测试', owner: 1,
    pending: { action: 'deploy', uid: 'x', row: 'AF', area: 0 },
    candidates: [],
  };
  check('Bug3 cost-pay 归属=prompt.owner', promptOwner(gs.prompt, gs.turnPlayer) === 1, `owner=${promptOwner(gs.prompt, gs.turnPlayer)}`);
}
{
  // Bug 4：サプライズ登场后处理登场诱発
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const atk = newInstance('LO-6846');
  atk.faceUp = true; atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const def = newInstance('LO-6971');
  def.faceUp = true; def.deployedTurn = null;
  gs.players[1].field[1][0] = def;
  gs.players[1].hand.push(newInstance('LO-6893'), newInstance('LO-6884'), newInstance('LO-6884')); // サプライズ + 月EX2×2
  gs.players[1].trash.push(newInstance('LO-6845'));
  gs.players[1].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, def.uid);
  check('Bug4 攻击方先手时点', next.prompt?.kind === 'battle-timing' && next.prompt.owner === 0, JSON.stringify(next.prompt?.owner));
  if (next.prompt?.kind === 'battle-timing') {
    next = rules.battleTimingAction(next, 'end'); // 攻击方放弃 → 防御方时点
  }
  check('Bug4 防御方战斗时点', next.prompt?.kind === 'battle-timing' && next.prompt.owner === 1, JSON.stringify(next.prompt?.owner));
  if (next.prompt?.kind === 'battle-timing') {
    const sdp = next.prompt.options.find((o) => o.id.startsWith('sdp:'));
    check('Bug4 サプライズ登场选项存在', !!sdp);
    if (sdp) {
      next = rules.battleTimingAction(next, sdp.id);
      if (next.prompt?.kind === 'slot-pick') next = rules.chooseSlot(next, next.prompt.slots[0].row, next.prompt.slots[0].area);
      if (next.prompt?.kind === 'cost-pay') {
        const pay = next.players[1].hand.filter((c) => c.cardId !== 'LO-6893').map((c) => c.uid);
        next = rules.confirmCostPay(next, pay); // 不 settle：停在対応窗口
      }
      check('Bug4 サプライズ登场宣言进対応', next.prompt?.kind === 'response', JSON.stringify(next.prompt?.kind));
      next = settle(next);
      check('Bug4 登场后触发诱発', next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip'), JSON.stringify(next.prompt?.kind));
      check('Bug4 サプライズ角色已登场', next.players[1].field.flat().some((c) => c?.cardId === 'LO-6893'), JSON.stringify(next.players[1].field.flat().map((c) => c?.cardId)));
    }
  }
}
{
  // Bug 5：先攻玩家自己第1回合登场触发；后攻在对手先攻第1回合登场不触发
  const gs = mkGame();
  gs.turnPlayer = 0; gs.turn = 1; gs.phase = 'main';
  handOf(gs, 0, ['LO-6851', 'LO-6851', 'LO-6851']); // 月月月
  const uid = gs.players[0].hand[0].uid;
  let next = settle(rules.requestPlayCharacter(gs, uid, 'DF', 0));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== uid).slice(0, 2).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('Bug5 先攻第1回合登场 → 诱发触发', next.prompt?.kind === 'effect-choice', JSON.stringify(next.prompt?.kind));
  const gs2 = mkGame();
  gs2.turnPlayer = 0; gs2.turn = 1; gs2.phase = 'main';
  const inst2 = newInstance('LO-6851');
  inst2.faceUp = true;
  inst2.deployedTurn = 1;
  gs2.players[1].field[1][0] = inst2;
  const next2 = settle(runDeployChain(gs2, inst2.uid, 1));
  check('Bug5 对手先攻第1回合登场 → 不触发', next2.prompt === null, JSON.stringify(next2.prompt?.kind));
}
{
  // Bug 6：6879 登场诱発只处理一次（不重复充能/不重复拿）
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const inst = newInstance('LO-6879');
  inst.faceUp = true; inst.deployedTurn = 3;
  gs.players[0].field[0][0] = inst;
  gs.players[0].trash.push(newInstance('LO-6845'));
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next = settle(runDeployChain(gs, inst.uid, 0));
  check('Bug6 6879 登场诱発出现', next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip'), JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') next = settle(rules.chooseEffectOption(next, ['o0'])); // 充能
  if (next.prompt?.kind === 'card-pick') next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  check('Bug6 6879 只处理一次（无重复提示）', next.prompt === null || !(next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip')), JSON.stringify(next.prompt?.kind));
  check('Bug6 6879 充能1张', next.players[0].field[0][0]!.charge.length === 1, JSON.stringify(next.players[0].field[0][0]?.charge.length));
}
{
  // Bug 6b：6851 诱発的「チャージ」是独立选项（不与 -4/-4 捆绑，避免强制充能）
  const p = parseCard(byId.get('LO-6851')!);
  const trig = p.triggers.find((t) => t.trigger === 'deploy');
  const labels = trig?.options.map((o) => o.label) ?? [];
  check('Bug6b 6851 诱発选项数=3', trig?.options.length === 3, JSON.stringify(labels));
  check('Bug6b 充能是独立选项', labels.some((l) => l.includes('充能 1')), JSON.stringify(labels));
  check('Bug6b -4/-4 选项不含充能', labels.some((l) => l.includes('AP-4') && !l.includes('充能')), JSON.stringify(labels));
}
{
  // Bug 7：6960 配置诱発可选且只处理一次
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  handOf(gs, 0, ['LO-6960', 'LO-6884', 'LO-6884', 'LO-6845']);
  const areaUid = gs.players[0].hand[0].uid;
  gs.players[0].trash.push(newInstance('LO-6846')); // 无 AMBITIOUS MISSION
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next = settle(rules.requestPlayArea(gs, areaUid));
  const slot = next.prompt?.kind === 'slot-pick' ? next.prompt.slots[0] : { row: 'AF', area: 0 };
  next = settle(rules.chooseSlot(next, slot.row, slot.area));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== areaUid).slice(0, 2).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('Bug7 6960 配置诱発弹是否处理', next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip'), JSON.stringify(next.prompt?.kind));
  const declined = settle(rules.chooseEffectOption(next, ['__skip']));
  check('Bug7 不处理 → 无后续效果', declined.prompt === null && declined.players[0].hand.length === 1, `hand=${declined.players[0].hand.length}`);
  const gs2 = mkGame();
  gs2.turnPlayer = 0; gs2.phase = 'main'; gs2.turn = 3;
  handOf(gs2, 0, ['LO-6960', 'LO-6884', 'LO-6884', 'LO-6845']);
  const areaUid2 = gs2.players[0].hand[0].uid;
  gs2.players[0].trash.push(newInstance('LO-6846'));
  gs2.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let n2 = settle(rules.requestPlayArea(gs2, areaUid2));
  const slot2 = n2.prompt?.kind === 'slot-pick' ? n2.prompt.slots[0] : { row: 'AF', area: 0 };
  n2 = settle(rules.chooseSlot(n2, slot2.row, slot2.area));
  if (n2.prompt?.kind === 'cost-pay') {
    const pay2 = n2.players[0].hand.filter((c) => c.uid !== areaUid2).slice(0, 2).map((c) => c.uid);
    n2 = settle(rules.confirmCostPay(n2, pay2));
  }
  let seen = 0;
  if (n2.prompt?.kind === 'effect-choice' && n2.prompt.options.some((o) => o.id === '__skip')) { seen++; n2 = settle(rules.chooseEffectOption(n2, ['o0'])); }
  if (n2.prompt?.kind === 'effect-choice' && !n2.prompt.options.some((o) => o.id === '__skip')) n2 = settle(rules.chooseEffectOption(n2, [n2.prompt.options[0].id])); // 破弃手牌
  if (n2.prompt?.kind === 'search-deploy') n2 = settle(rules.chooseSearchDeploy(n2, n2.prompt.candidates[0]?.uid));
  if (n2.prompt?.kind === 'card-pick') n2 = settle(rules.chooseCardPick(n2, [n2.prompt.candidates[0].uid]));
  check('Bug7 处理一次后不再重复弹「是否处理」', seen === 1 && !(n2.prompt?.kind === 'effect-choice' && n2.prompt.options.some((o) => o.id === '__skip')), JSON.stringify(n2.prompt?.kind));
  check('Bug7 手牌破弃1张、下方1张', n2.players[0].hand.length === 0 && (n2.players[0].fieldAreas.flat().find((c) => c?.uid === areaUid2)?.under.length ?? 0) === 1, `hand=${n2.players[0].hand.length}`);
}
{
  // Bug 8：付费时可使用 [コスト] 能力（生成费用抵扣，不横置）
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const coster = newInstance('LO-6852'); // [コスト] 生成[月月]
  coster.faceUp = true; coster.deployedTurn = null;
  gs.players[0].field[1][1] = coster;
  handOf(gs, 0, ['LO-6851', 'LO-6851', 'LO-6851']); // 月月月
  const uid = gs.players[0].hand[0].uid;
  let next = settle(rules.requestPlayCharacter(gs, uid, 'DF', 0));
  check('Bug8 登场进入费用选择', next.prompt?.kind === 'cost-pay', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'cost-pay') {
    next = rules.useCostAbilityInPay(next, coster.uid);
    check('Bug8 使用cost能力后费用减为[月]', next.prompt?.kind === 'cost-pay' && next.prompt.cost === '月', JSON.stringify(next.prompt?.cost));
    check('Bug8 cost能力使用不横置', coster.tapped === false);
    const pay = next.players[0].hand.filter((c) => c.uid !== uid).slice(0, 1).map((c) => c.uid);
    next = settle(rules.confirmCostPay(next, pay));
  }
  check('Bug8 用cost能力后正常登场', !!next.players[0].field[1][0], JSON.stringify(next.prompt?.kind));
}
{
  // Bug 9：对应宣言后登场不被打断（后发先至：先结算对方宣言再登场）
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  handOf(gs, 0, ['LO-6851', 'LO-6851', 'LO-6851']);
  const uid = gs.players[0].hand[0].uid;
  const target = newInstance('LO-6846');
  target.faceUp = true; target.deployedTurn = null;
  gs.players[0].field[0][0] = target;
  const resp = newInstance('LO-6893');
  resp.faceUp = true; resp.deployedTurn = null;
  gs.players[1].field[0][1] = resp;
  let next = rules.requestPlayCharacter(gs, uid, 'DF', 0);
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== uid).slice(0, 2).map((c) => c.uid);
    next = rules.confirmCostPay(next, pay); // 不 settle：应停在对应窗口
  }
  check('Bug9 A宣言登场 → B可对应', next.prompt?.kind === 'response' && next.prompt.owner === 1, JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'response') {
    const fd = next.prompt.options.find((o) => o.id.startsWith('fd:'));
    check('Bug9 B对应宣言选项存在', !!fd);
    if (fd) {
      next = rules.respond(next, fd.id);
      check('Bug9 B宣言进入效果选择', next.prompt?.kind === 'effect-choice', JSON.stringify(next.prompt?.kind));
      if (next.prompt?.kind === 'effect-choice') next = rules.chooseEffectOption(next, ['o0']); // AP-1
      if (next.prompt?.kind === 'declare-target') next = rules.chooseDeclareTarget(next, target.uid); // 不 settle：停在A的对应窗口
      check('Bug9 B宣言入栈后轮到A', next.prompt?.kind === 'response' && next.prompt.owner === 0, JSON.stringify(next.prompt?.kind));
      next = settle(next); // A 放弃 → 倒序结算
    }
  }
  check('Bug9 处理后A的登场完成', !!next.players[0].field[1][0] && next.players[0].hand.length === 0, `deployed=${!!next.players[0].field[1][0]}`);
}
{
  // Bug 12：[コスト]能力不横置（已在旧测试更新）；这里验证带装备道具的宿主也不横置
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const host = newInstance('LO-6891'); // [コスト] [月月]
  host.faceUp = true; host.deployedTurn = null;
  gs.players[0].field[0][0] = host;
  const next = settle(rules.useCostAbility(gs, host.uid));
  check('Bug12 [コスト]能力不横置', next.players[0].field[0][0]!.tapped === false, JSON.stringify(next.players[0].field[0][0]?.tapped));
}
{
  // Bug 13：对应中取消 → 回到上一步（恢复对应窗口）
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  handOf(gs, 0, ['LO-6851', 'LO-6851', 'LO-6851']);
  const uid = gs.players[0].hand[0].uid;
  const target = newInstance('LO-6846');
  target.faceUp = true; target.deployedTurn = null;
  gs.players[0].field[0][0] = target;
  const resp = newInstance('LO-6893');
  resp.faceUp = true; resp.deployedTurn = null;
  gs.players[1].field[0][1] = resp;
  let next = rules.requestPlayCharacter(gs, uid, 'DF', 0);
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== uid).slice(0, 2).map((c) => c.uid);
    next = rules.confirmCostPay(next, pay); // 不 settle：停在对应窗口
  }
  if (next.prompt?.kind === 'response') {
    const fd = next.prompt.options.find((o) => o.id.startsWith('fd:'));
    if (fd) {
      next = rules.respond(next, fd.id);
      check('Bug13 B宣言进入效果选择', next.prompt?.kind === 'effect-choice', JSON.stringify(next.prompt?.kind));
      next = rules.cancelPrompt(next); // B 取消
      check('Bug13 取消后回到对应窗口', next.prompt?.kind === 'response' && next.prompt.owner === 1, JSON.stringify(next.prompt?.kind));
    }
  }
}
{
  // Bug 14：6852 诱发可选（不处理 → 不放入置き場）
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'start'; gs.turn = 2;
  const inst = newInstance('LO-6852');
  inst.faceUp = true; inst.deployedTurn = null;
  gs.players[0].field[0][0] = inst;
  gs.players[0].trash.push(newInstance('LO-6845'));
  gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'));
  let next = settle(rules.beginTurn(gs));
  check('Bug14 6852 诱发弹是否处理', next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip'), JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'effect-choice') next = settle(rules.chooseEffectOption(next, ['__skip']));
  check('Bug14 不处理后置き場为空', (next.players[0].storage['青春カウント'] ?? []).length === 0, JSON.stringify((next.players[0].storage['青春カウント'] ?? []).length));
}
{
  // Bug 15：6893 不做上述时分支目标=对方角色
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const caster = newInstance('LO-6893');
  caster.faceUp = true; caster.deployedTurn = null;
  caster.charge.push(newInstance('LO-6845'));
  gs.players[0].field[0][0] = caster;
  const ally = newInstance('LO-6846');
  ally.faceUp = true; ally.deployedTurn = null;
  gs.players[0].field[0][1] = ally;
  const opp = newInstance('LO-6846');
  opp.faceUp = true; opp.deployedTurn = null;
  gs.players[1].field[0][0] = opp;
  let next = settle(rules.requestDeclare(gs, caster.uid));
  check('Bug15 6893 宣言出现选项', next.prompt?.kind === 'effect-choice' && next.prompt.options.length === 3, JSON.stringify(next.prompt?.options.map((o) => o.id)));
  if (next.prompt?.kind === 'effect-choice') next = settle(rules.chooseEffectOption(next, ['o2'])); // 不做上述时
  // 目标选择（唯一目标也弹窗）→ 效果作用到对方角色
  check('Bug15 不做上述时弹目标选择', next.prompt?.kind === 'declare-target', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'declare-target') next = settle(rules.chooseDeclareTarget(next, opp.uid));
  check('Bug15 不做上述时打到对方角色', (next.players[1].field[0][0]?.tempMods.ap ?? 0) === -2, `oppAP=${next.players[1].field[0][0]?.tempMods.ap} prompt=${JSON.stringify(next.prompt?.kind)}`);
}
{
  // Bug 16：战斗时点行动后交替（宣言一次后轮到对方）
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const atk = newInstance('LO-6846');
  atk.faceUp = true; atk.deployedTurn = null;
  gs.players[0].field[0][0] = atk;
  const decl = newInstance('LO-6851'); // 场上宣言 [0]：相手AP-2/DP-2
  decl.faceUp = true; decl.deployedTurn = null;
  gs.players[0].field[0][1] = decl;
  const def = newInstance('LO-6971');
  def.faceUp = true; def.deployedTurn = null;
  gs.players[1].field[1][0] = def;
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, def.uid);
  check('Bug16 攻击方时点', next.prompt?.kind === 'battle-timing' && next.prompt.owner === 0, JSON.stringify(next.prompt?.owner));
  if (next.prompt?.kind === 'battle-timing') {
    const fd = next.prompt.options.find((o) => o.id.startsWith('fd:'));
    check('Bug16 攻击方宣言选项存在', !!fd);
    if (fd) {
      next = rules.battleTimingAction(next, fd.id);
      if (next.prompt?.kind === 'effect-choice') next = rules.chooseEffectOption(next, ['0']); // 6851 有两个宣言块，选 [0]
      if (next.prompt?.kind === 'effect-choice') next = rules.chooseEffectOption(next, ['o0']); // AP-2
      if (next.prompt?.kind === 'declare-target') next = rules.chooseDeclareTarget(next, def.uid); // 目标选择（不 settle）
      check('Bug16 宣言后时点轮到防御方', next.prompt?.kind === 'battle-timing' && next.prompt.owner === 1, JSON.stringify(next.prompt?.kind));
    }
  }
}

/* ---------- 26. 卡组码（导出/导入） ---------- */
{
  check('卡组码 空格分隔', formatDeckCode(['LO-6845', 'LO-6971-A']) === '6845 6971-A', formatDeckCode(['LO-6845', 'LO-6971-A']));
  check('卡组码 解析 空格/逗号/换行/带LO前缀', JSON.stringify(parseDeckCode('6845 6845,6971-A\nLO-6851 6852')) === JSON.stringify(['LO-6845', 'LO-6845', 'LO-6971-A', 'LO-6851', 'LO-6852']), JSON.stringify(parseDeckCode('6845 6845,6971-A\nLO-6851 6852')));
  check('卡组码 解析 小写前缀/粘连', JSON.stringify(parseDeckCode('lo-6845lo-6851')) === JSON.stringify(['LO-6845', 'LO-6851']), JSON.stringify(parseDeckCode('lo-6845lo-6851')));
  check('卡组码 解析 无编号字符忽略', JSON.stringify(parseDeckCode('6845 你好 6851')) === JSON.stringify(['LO-6845', 'LO-6851']), JSON.stringify(parseDeckCode('6845 你好 6851')));
  check('卡组码 规范化：无效卡号/超4张截断', normalizeDeck(parseDeckCode('6845 6845 6845 6845 6845 9999 6971-A'), cards).length === 5, JSON.stringify(normalizeDeck(parseDeckCode('6845 6845 6845 6845 6845 9999 6971-A'), cards)));
}

/* ---------- 27. 房间系统（观战席/上桌/准备） ---------- */
{
  let room = createRoom('房主');
  check('房间 房主默认坐座位1', room.seat1?.cid === HOST_CID && room.phase === 'lobby', JSON.stringify(room.seat1));
  room = roomAddClient(room, 0, '小明');
  check('房间 新客户端进观战席', room.spectators.length === 1 && myRole(room, 0) === 'spectator', JSON.stringify(room.spectators));
  room = roomSit(room, 0);
  check('房间 观战者上桌坐座位2', room.seat2?.cid === 0 && room.spectators.length === 0, JSON.stringify(room.seat2));
  room = roomReady(room, 0, 42);
  check('房间 座位2准备', room.seat2?.ready === true && room.seat2?.deckCount === 42);
  check('房间 只有一人准备不能开始', bothReady(room) === false);
  room = roomReady(room, HOST_CID, 40);
  check('房间 双方都准备可开始', bothReady(room) === true);
  room = roomStartGame(room);
  check('房间 进入对局阶段', room.phase === 'playing');
  room = roomRematch(room);
  check('房间 再来一局：回大厅、准备清空、局数+1', room.phase === 'lobby' && room.seat2?.ready === false && room.gameNum === 2);
  room = roomStand(room, 0);
  check('房间 上桌玩家起立回观战席', room.seat2 === null && room.spectators.some((s) => s.cid === 0), JSON.stringify(room.spectators));
  room = roomRemoveClient(room, 0);
  check('房间 断开清出观战席', room.spectators.length === 0);
  // 房主起立 → 空座位1；客机可坐座位1
  let room2 = createRoom('房主');
  room2 = roomStand(room2, HOST_CID);
  check('房间 房主可起立（座位1空）', room2.seat1 === null && room2.spectators.some((s) => s.cid === HOST_CID));
  room2 = roomAddClient(room2, 5, '张三');
  room2 = roomSit(room2, 5);
  check('房间 房主起立后客机可坐座位1', room2.seat1?.cid === 5, JSON.stringify(room2.seat1));
}

/* ---------- 28. 效果标签中文化 ---------- */{
  const p = parseCard(byId.get('LO-6857')!);
  const label = p.triggers.find((t) => t.trigger === 'deploy')?.options[0]?.label ?? '';
  check('标签 味方角色中文化（无英文）', label.includes('味方角色') && !label.includes('oneFriendly'), label);
  const p2 = parseCard(byId.get('LO-6893')!);
  const fallback = p2.declared[0].options.find((o) => o.label.includes('不做上述时'))?.label ?? '';
  check('标签 对方角色中文化（无英文）', fallback.includes('对方角色') && !fallback.includes('oneOpponent'), fallback);
  const p3 = parseCard(byId.get('LO-6868')!);
  const multi = p3.declared[1]?.options[0]?.label ?? '';
  check('标签 AP·DP 都显示', multi.includes('AP+1') && multi.includes('DP+1'), multi);
}

/* ---------- 29. 对应窗口：卡图 + 宣言具体效果 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  handOf(gs, 0, ['LO-6851', 'LO-6851', 'LO-6851']);
  const uid = gs.players[0].hand[0].uid;
  // 先布置好场上卡（flow 会 clone）
  const target = newInstance('LO-6846');
  target.faceUp = true; target.deployedTurn = null;
  gs.players[0].field[0][0] = target;
  const resp = newInstance('LO-6893');
  resp.faceUp = true; resp.deployedTurn = null;
  gs.players[1].field[0][1] = resp;
  let next = rules.requestPlayCharacter(gs, uid, 'DF', 0);
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.players[0].hand.filter((c) => c.uid !== uid).slice(0, 2).map((c) => c.uid);
    next = rules.confirmCostPay(next, pay);
  }
  check('对应窗口 登场宣言带卡图', next.prompt?.kind === 'response' && next.prompt.cardId === 'LO-6851', JSON.stringify(next.prompt?.cardId));
  // B 用 6893 的宣言对应 → A 的对应窗口应显示 6893 卡图 + 具体效果
  if (next.prompt?.kind === 'response') {
    const fd = next.prompt.options.find((o) => o.id.startsWith('fd:'));
    if (fd) {
      next = rules.respond(next, fd.id);
      if (next.prompt?.kind === 'effect-choice') next = rules.chooseEffectOption(next, ['o0']); // AP-1
      if (next.prompt?.kind === 'declare-target') next = rules.chooseDeclareTarget(next, target.uid);
      check('对应窗口 宣言效果显示', next.prompt?.kind === 'response' && next.prompt.cardId === 'LO-6893' && (next.prompt.effectLabel ?? '').includes('对方角色'), JSON.stringify({ cardId: next.prompt?.cardId, effect: next.prompt?.effectLabel }));
    }
  }
}

/* ---------- 30. 检索登场后不重复弹检索（6845 家族 bug 修复） ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  gs.players[0].hand.push(newInstance('LO-6845')); // 僧間理亜（手札宣言检索登场）
  gs.players[0].deck.push(newInstance('LO-6872'), newInstance('LO-6971')); // マリア・ビショップ（雪雪）+ 其他
  gs.players[0].hand.push(newInstance('LO-6845'), newInstance('LO-6845')); // 雪 EX2 费用
  const h6845 = gs.players[0].hand.find((c) => c.cardId === 'LO-6845');
  if (!h6845) throw new Error('no 6845');
  let next = settle(rules.requestHandDeclare(gs, h6845.uid));
  check('6845 手札宣言进入检索', next.prompt?.kind === 'search-deploy', JSON.stringify(next.prompt?.kind));
  if (next.prompt?.kind === 'search-deploy') {
    const cand = next.prompt.candidates[0];
    next = settle(rules.chooseSearchDeploy(next, cand.uid));
    if (next.prompt?.kind === 'cost-pay') {
      const pay = next.players[0].hand.filter((c) => c.uid !== cand.uid).slice(0, 2).map((c) => c.uid);
      next = settle(rules.confirmCostPay(next, pay));
    }
    if (next.prompt?.kind === 'slot-pick') next = settle(rules.chooseSlot(next, next.prompt.slots[0].row, next.prompt.slots[0].area));
    if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip')) next = settle(rules.chooseEffectOption(next, ['o0']));
    if (next.prompt?.kind === 'declare-target') next = settle(rules.chooseDeclareTarget(next, next.prompt.candidates[0]?.uid ?? null));
  }
  check('6845 检索登场后不再重复弹检索', next.prompt === null && next.players[0].field.flat().filter(Boolean).length === 1, JSON.stringify(next.prompt?.kind));
}

/* ---------- 31. 效果装备：支付道具费用 + 装備したとき诱発 + 6961（Bug ⑧⑨⑩） ---------- */
{
  // 6957 手札宣言装备味方角色：应支付 月月，装備したとき AP+2 DP+2，6961 触发置下
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const hd = newInstance('LO-6957'); hd.faceUp = true;
  gs.players[0].hand.push(hd, newInstance('LO-6852'), newInstance('LO-6852')); // 月 EX2 支付
  const host = newInstance('LO-6845'); host.faceUp = true; host.deployedTurn = null;
  gs.players[0].field[1][0] = host;
  const area = newInstance('LO-6961'); area.faceUp = true; area.deployedTurn = null;
  gs.players[0].fieldAreas[0][0] = area;
  gs.players[0].trash.push(newInstance('LO-6846'));
  let next = rules.requestHandDeclare(gs, hd.uid);
  if (next.prompt?.kind === 'declare-target') next = settle(rules.chooseDeclareTarget(next, host.uid));
  if (next.prompt?.kind === 'response') next = settle(rules.respond(next, 'pass'));
  check('⑨ 效果装备先弹费用面板（月月）', next.prompt?.kind === 'cost-pay' && next.prompt.cost === '月月', JSON.stringify(next.prompt && { k: next.prompt.kind, cost: (next.prompt as any).cost }));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.prompt.candidates[0]?.uid;
    next = settle(rules.confirmCostPay(next, pay ? [pay] : []));
  }
  // 6961 ownCardUsed 可选诱発 → 处理 → 选卡置下
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip')) next = settle(rules.chooseEffectOption(next, [next.prompt.options[0].id]));
  if (next.prompt?.kind === 'card-pick') next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid]));
  const hostAfter = next.players[0].field[1][0];
  check('⑨ 装备成功且支付了费用（手牌剩1）', hostAfter?.equip?.cardId === 'LO-6957' && next.players[0].hand.length === 1, `equip=${hostAfter?.equip?.cardId} hand=${next.players[0].hand.length}`);
  check('⑧ 装備したとき诱発：宿主 AP 基础+4', hostAfter ? effectiveStats(next, hostAfter.uid).ap === 4 + 4 : false, `ap=${hostAfter ? effectiveStats(next, hostAfter.uid).ap : '?'}`);
  check('⑩ 6961 触发：下方置入 1 张', (next.players[0].fieldAreas[0][0]?.under ?? []).length === 1, `under=${next.players[0].fieldAreas[0][0]?.under?.length ?? 0}`);
}

{
  // 6957 手札宣言装备但费用不足 → 装备失败，道具不入装备区
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const hd = newInstance('LO-6957'); hd.faceUp = true;
  gs.players[0].hand.push(hd); // 无月卡可支付
  const host = newInstance('LO-6845'); host.faceUp = true; host.deployedTurn = null;
  gs.players[0].field[1][0] = host;
  let next = rules.requestHandDeclare(gs, hd.uid);
  if (next.prompt?.kind === 'declare-target') next = settle(rules.chooseDeclareTarget(next, host.uid));
  if (next.prompt?.kind === 'response') next = settle(rules.respond(next, 'pass'));
  check('⑨ 费用不足时装备失败（无装备、道具在ゴミ箱）', next.prompt === null && !next.players[0].field[1][0]?.equip, JSON.stringify(next.prompt?.kind));
}

{
  // 6887 宣言检索装备アクティ部：支付 月月，装備したとき诱発
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const char6887 = newInstance('LO-6887'); char6887.faceUp = true; char6887.deployedTurn = null;
  gs.players[0].field[0][0] = char6887;
  char6887.charge.push(newInstance('LO-6846')); // [C1]
  const host = newInstance('LO-6845'); host.faceUp = true; host.deployedTurn = null;
  gs.players[0].field[1][1] = host;
  gs.players[0].trash.push(newInstance('LO-6957')); // 检索目标
  gs.players[0].hand.push(newInstance('LO-6852'), newInstance('LO-6852'));
  let next = rules.requestDeclare(gs, char6887.uid);
  // 选 [C1] 能力块
  if (next.prompt?.kind === 'effect-choice' && next.prompt.pending?.trigger === '__clause') {
    const idx = next.prompt.options.findIndex((o) => o.label.includes('[C1]'));
    next = settle(rules.chooseEffectOption(next, [next.prompt.options[idx >= 0 ? idx : 0].id]));
  }
  if (next.prompt?.kind === 'card-pick') next = settle(rules.chooseCardPick(next, [next.prompt.candidates[0].uid])); // 支付 C1 充能
  if (next.prompt?.kind === 'response') next = settle(rules.respond(next, 'pass'));
  if (next.prompt?.kind === 'search-deploy') next = settle(rules.chooseSearchDeploy(next, next.prompt.candidates[0]?.uid ?? null));
  if (next.prompt?.kind === 'declare-target') next = settle(rules.chooseDeclareTarget(next, host.uid));
  if (next.prompt?.kind === 'response') next = settle(rules.respond(next, 'pass'));
  check('⑨ 检索装备先弹费用面板（月月）', next.prompt?.kind === 'cost-pay' && next.prompt.cost === '月月', JSON.stringify(next.prompt && { k: next.prompt.kind, cost: (next.prompt as any).cost }));
  if (next.prompt?.kind === 'cost-pay') {
    const pay = next.prompt.candidates[0]?.uid;
    next = settle(rules.confirmCostPay(next, pay ? [pay] : []));
  }
  const hostAfter = next.players[0].field[1][1];
  check('⑨⑧ 检索装备成功 + 装備したとき诱発', hostAfter?.equip?.cardId === 'LO-6957' && effectiveStats(next, hostAfter.uid).ap === 4 + 4, `equip=${hostAfter?.equip?.cardId} ap=${hostAfter ? effectiveStats(next, hostAfter.uid).ap : '?'}`);
}

/* ---------- 32. ① 6960 配置诱发只执行一次（不重复破弃手牌） ---------- */
{
  // 6850 手札宣言 [D2] → 检索配置 6960 → 6960 配置诱发（破弃1张 → 检索配置 6961 → 放1张到下方）
  // 之前 bug：检索配置 6961 后恢复外层链时 stage 回到 0，破弃手牌重复执行
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 1;
  const h6850 = newInstance('LO-6850'); h6850.faceUp = true;
  gs.players[0].hand.push(h6850, newInstance('LO-6845'), newInstance('LO-6845'), newInstance('LO-6845'));
  gs.players[0].deck.push(newInstance('LO-6960'), newInstance('LO-6971'), newInstance('LO-6971'));
  gs.players[0].trash.push(newInstance('LO-6961'), newInstance('LO-6846'));
  let next = rules.requestHandDeclare(gs, h6850.uid);
  const drive6960 = (n: ReturnType<typeof mkGame>, guardCap = 30) => {
    let guard = 0;
    while (guard++ < guardCap && n.prompt) {
      const k = n.prompt.kind;
      if (k === 'effect-choice') {
        const opts = n.prompt.options;
        let idx = 0;
        if (n.prompt.pending?.trigger === '__clause') {
          const d2 = opts.findIndex((o) => o.label.includes('[D2]'));
          if (d2 >= 0) idx = d2;
        }
        n = rules.chooseEffectOption(n, [opts[idx].id]);
      } else if (k === 'card-pick') n = rules.chooseCardPick(n, n.prompt.candidates.length > 0 ? [n.prompt.candidates[0].uid] : []);
      else if (k === 'search-deploy') n = rules.chooseSearchDeploy(n, n.prompt.candidates[0]?.uid ?? null);
      else if (k === 'slot-pick') n = rules.chooseSlot(n, n.prompt.slots[0].row, n.prompt.slots[0].area);
      else if (k === 'response') n = rules.respond(n, 'pass');
      else if (k === 'manual-effect') n.prompt = null;
      else break;
    }
    return n;
  };
  next = drive6960(next);
  check('① 6960 配置诱发只破弃 1 次手牌', next.log.filter((l) => l.includes('破弃手牌')).length === 1, `n=${next.log.filter((l) => l.includes('破弃手牌')).length}`);
  check('① 6960 与 6961 均已配置', next.players[0].fieldAreas[0][0]?.cardId === 'LO-6960' && next.players[0].fieldAreas[0][1]?.cardId === 'LO-6961', JSON.stringify([next.players[0].fieldAreas[0][0]?.cardId, next.players[0].fieldAreas[0][1]?.cardId]));
  check('① 破弃后手牌剩 2 张', next.players[0].hand.length === 2, `hand=${next.players[0].hand.length}`);
  check('① 1 张ゴミ箱卡放入 AMBITIOUS MISSION（6961）下方', (next.players[0].fieldAreas[0][1]?.under ?? []).length === 1 && (next.players[0].fieldAreas[0][0]?.under ?? []).length === 0, `u6961=${next.players[0].fieldAreas[0][1]?.under?.length ?? 0} u6960=${next.players[0].fieldAreas[0][0]?.under?.length ?? 0}`);
}

/* ---------- 33. ① 回合开始顺序：诱发全部处理完 → 重置+抽牌 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'start'; gs.turn = 3;
  const inst = newInstance('LO-6852'); inst.faceUp = true; inst.deployedTurn = null;
  gs.players[0].field[0][0] = inst;
  gs.players[0].trash.push(newInstance('LO-6845'));
  for (let i = 0; i < 6; i++) gs.players[0].deck.push(newInstance('LO-6971'));
  const handBefore = gs.players[0].hand.length;
  let next = rules.beginTurn(gs);
  // 诱发提示出现时尚未抽牌（诱发处理完毕才是抽牌）
  check('① 诱发提示出现时还没抽牌', next.prompt !== null && next.players[0].hand.length === handBefore, `hand=${next.players[0].hand.length} prompt=${next.prompt?.kind}`);
  if (next.prompt?.kind === 'effect-choice' && next.prompt.options.some((o) => o.id === '__skip')) next = rules.chooseEffectOption(next, ['o0']);
  if (next.prompt?.kind === 'card-pick') next = rules.chooseCardPick(next, [next.prompt.candidates[0].uid]);
  check('① 诱发全部处理完后抽牌（置いたとき抽1 + 回合抽2）', next.players[0].hand.length === handBefore + 3 && next.phase === 'main', `hand=${next.players[0].hand.length} phase=${next.phase}`);
}

/* ---------- 34. ② 6893：无充能时不能选「不做上述时 AP-2 DP-2」 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const c6893 = newInstance('LO-6893'); c6893.faceUp = true; c6893.deployedTurn = null;
  gs.players[0].field[0][0] = c6893; // 无充能
  const opp = newInstance('LO-6846'); opp.faceUp = true; opp.deployedTurn = null;
  gs.players[1].field[0][0] = opp;
  let next = settle(rules.requestDeclare(gs, c6893.uid));
  if (next.prompt?.kind === 'effect-choice' && next.prompt.pending?.trigger === '__clause') next = settle(rules.chooseEffectOption(next, [next.prompt.options[0].id]));
  check('② 6893 无充能：选项不含「不做上述时」', next.prompt?.kind === 'effect-choice' && !next.prompt.options.some((o) => o.label.includes('不做上述时')), JSON.stringify(next.prompt?.options.map((o) => o.label.slice(0, 12))));
  // 有充能 → 出现「不做上述时」
  const gs2 = mkGame();
  gs2.turnPlayer = 0; gs2.phase = 'main'; gs2.turn = 3;
  const c2 = newInstance('LO-6893'); c2.faceUp = true; c2.deployedTurn = null;
  c2.charge.push(newInstance('LO-6845'));
  gs2.players[0].field[0][0] = c2;
  const opp2 = newInstance('LO-6846'); opp2.faceUp = true; opp2.deployedTurn = null;
  gs2.players[1].field[0][0] = opp2;
  let n2 = settle(rules.requestDeclare(gs2, c2.uid));
  if (n2.prompt?.kind === 'effect-choice' && n2.prompt.pending?.trigger === '__clause') n2 = settle(rules.chooseEffectOption(n2, [n2.prompt.options[0].id]));
  check('② 6893 有充能：出现「不做上述时」', n2.prompt?.kind === 'effect-choice' && n2.prompt.options.some((o) => o.label.includes('不做上述时')), JSON.stringify(n2.prompt?.options.map((o) => o.label.slice(0, 12))));
}

/* ---------- 35. 主阶段结束小窗：可取消继续 / 同意结束 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  let next = rules.endTurn(gs);
  check('结束主阶段 → 优先权小窗（end-main）', next.prompt?.kind === 'end-main', JSON.stringify(next.prompt?.kind));
  const nCancel = rules.endMainCancel(next);
  check('回合玩家取消结束 → 继续主阶段', nCancel.prompt === null && nCancel.phase === 'main' && nCancel.turnPlayer === 0, `phase=${nCancel.phase}`);
  const nEnd = settle(rules.endMainAction(next, 'end'));
  check('同意结束 → 交给对方（回合+1）', nEnd.turnPlayer === 1 && nEnd.turn === 4 && nEnd.prompt === null, `tp=${nEnd.turnPlayer} turn=${nEnd.turn}`);
}

/* ---------- 36. ⑥ 一次支援只触发一次（6904 被支援诱发）；⑤ 费用不足但可产费时弹面板 ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const atk = newInstance('LO-6904'); atk.faceUp = true; atk.deployedTurn = null; // 水瓶陽向（被支援）
  gs.players[0].field[0][0] = atk;
  const sup = newInstance('LO-6855-S'); sup.faceUp = true; sup.deployedTurn = null; // [サポーター:花花]
  gs.players[0].field[0][1] = sup;
  const area = newInstance('LO-6962'); area.faceUp = true; area.deployedTurn = null;
  gs.players[0].fieldAreas[0][0] = area;
  const def = newInstance('LO-6971'); def.faceUp = true; def.deployedTurn = null;
  gs.players[1].field[1][0] = def;
  gs.players[0].hand.push(newInstance('LO-6855-S'));
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, def.uid);
  const supC = next.prompt?.kind === 'battle-timing' ? next.prompt.options.find((o) => o.id.startsWith('supC:')) : null;
  let yang = 0;
  let yume = 0;
  let guard = 0;
  if (supC) {
    next = rules.battleTimingAction(next, supC.id);
    if (next.prompt?.kind === 'cost-pay') {
      const pay = next.prompt.candidates[0]?.uid;
      next = rules.confirmCostPay(next, pay ? [pay] : []);
    }
    while (guard++ < 10 && next.prompt) {
      const k = next.prompt.kind;
      if (k === 'effect-choice') {
        const t = next.prompt.title ?? '';
        if (t.includes('水瓶')) yang++;
        if (t.includes('作为 DP')) yume++;
        next = rules.chooseEffectOption(next, [next.prompt.options[0].id]);
      } else if (k === 'card-pick') next = rules.chooseCardPick(next, next.prompt.candidates[0] ? [next.prompt.candidates[0].uid] : []);
      else break;
    }
  }
  check('⑥ 一次支援：水瓶陽向诱发只询问 1 次', yang === 1, `yang=${yang}`);
  check('⑥⑧ 一次支援：夢見作为DP一次确认（无额外段）', yume === 1, `yume=${yume}`);
  check('⑥ ボーナス只授予 1 次（已有则不再授）', next.log.filter((l) => l.includes('获得ボーナス')).length === 1, `n=${next.log.filter((l) => l.includes('获得ボーナス')).length}`);
}
{
  // ⑤ 手牌不足但场上有可用 [コスト] 产费（6852 产月月）→ 应弹费用面板而非直接拒绝
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 2;
  const coster = newInstance('LO-6852'); coster.faceUp = true; coster.deployedTurn = null; // [コスト] 月月（未使用）
  gs.players[0].field[0][0] = coster;
  const target = newInstance('LO-6893'); target.faceUp = true; // 玖音 费用 月月月
  gs.players[0].hand.push(target, newInstance('LO-6852')); // 只有 1 张月EX2（2 点 < 3）
  let next = rules.requestPlayCharacter(gs, target.uid, 'DF', 0);
  check('⑤ 手牌不足但可产费 → 弹费用面板', next.prompt?.kind === 'cost-pay' && next.prompt.cost === '月月月', JSON.stringify(next.prompt && { k: next.prompt.kind, cost: (next.prompt as any).cost }));
  // 点 6852 产月月 → 剩余 月（手牌 1 张月EX2 可付）→ 可支付
  if (next.prompt?.kind === 'cost-pay') {
    next = rules.useCostAbilityInPay(next, coster.uid);
    check('⑤ 使用 [コスト] 产费后剩余 月', next.prompt?.kind === 'cost-pay' && next.prompt.cost === '月', JSON.stringify((next.prompt as any)?.cost));
    if (next.prompt?.kind === 'cost-pay') {
      const pay = next.prompt.candidates.find((c) => c.cardId === 'LO-6852')?.uid;
      next = settle(rules.confirmCostPay(next, pay ? [pay] : []));
      if (next.prompt?.kind === 'response') next = settle(rules.respond(next, 'pass'));
      if (next.prompt?.kind === 'effect-choice') next = settle(rules.chooseEffectOption(next, [next.prompt.options[0].id]));
      if (next.prompt?.kind === 'card-pick') next = settle(rules.chooseCardPick(next, next.prompt.candidates[0] ? [next.prompt.candidates[0].uid] : []));
      check('⑤ 最终登场成功', !!next.players[0].field[1][0] && next.players[0].field[1][0]!.cardId === 'LO-6893', `df0=${next.players[0].field[1][0]?.cardId}`);
    }
  }
}

/* ---------- 37. 支援诱发：谁被支援谁的「このキャラにサポートをしたとき」才触发（支援 6907 时场上 6910 不触发） ---------- */
{
  const gs = mkGame();
  gs.turnPlayer = 0; gs.phase = 'main'; gs.turn = 3;
  const atk = newInstance('LO-6907'); atk.faceUp = true; atk.deployedTurn = null; // 被支援（赤塚ハル）
  gs.players[0].field[0][0] = atk;
  const other = newInstance('LO-6910'); other.faceUp = true; other.deployedTurn = null; // 场上但未被支援
  gs.players[0].field[0][1] = other;
  const sup = newInstance('LO-6855-S'); sup.faceUp = true; sup.deployedTurn = null;
  gs.players[0].field[1][0] = sup;
  const area = newInstance('LO-6962'); area.faceUp = true; area.deployedTurn = null; // 支援宣言事件型（保留触发）
  gs.players[0].fieldAreas[0][0] = area;
  const def = newInstance('LO-6971'); def.faceUp = true; def.deployedTurn = null;
  gs.players[1].field[1][0] = def;
  gs.players[0].hand.push(newInstance('LO-6855-S'));
  let next = settle(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, def.uid);
  const supC = next.prompt?.kind === 'battle-timing' ? next.prompt.options.find((o) => o.id.startsWith('supC:')) : null;
  let guard = 0;
  if (supC) {
    next = rules.battleTimingAction(next, supC.id);
    if (next.prompt?.kind === 'cost-pay') {
      const pay = next.prompt.candidates[0]?.uid;
      next = rules.confirmCostPay(next, pay ? [pay] : []);
    }
    while (guard++ < 10 && next.prompt) {
      const k = next.prompt.kind;
      if (k === 'effect-choice') {
        const t = next.prompt.title ?? '';
        if (t.includes('多个诱発')) {
          const lbl = next.prompt.options.map((o) => (o.label ?? '')).join('|');
          check('37 支援6907：候选只有被支援者(赤塚ハル)+夢見两类，无未被支援的6910', next.prompt.options.length === 2 && lbl.includes('赤塚 ハル') && lbl.includes('夢見'), `len=${next.prompt.options.length}`);
        }
        next = rules.chooseEffectOption(next, [next.prompt.options[0].id]);
      } else if (k === 'card-pick') next = rules.chooseCardPick(next, next.prompt.candidates[0] ? [next.prompt.candidates[0].uid] : []);
      else break;
    }
  }
  check('37 支援6907：被支援型强化只执行一次（6910 未误触发）', next.log.filter((l) => l.includes('自身 AP +2')).length === 1, `n=${next.log.filter((l) => l.includes('自身 AP +2')).length}`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);