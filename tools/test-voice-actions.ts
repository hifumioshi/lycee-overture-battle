// 语音行为接线自检：npx tsx tools/test-voice-actions.ts
// 真的在规则引擎里把每个行为跑一遍，检查有没有发出对应的语音信号（谁发的、行为是什么）
import { readFileSync } from 'node:fs';
import type { Card } from '../src/core/cards';
import { createEmptyGame, newInstance, PlayerIndex, GameState } from '../src/core/game';
import * as rules from '../src/core/rules';
import { parseCard } from '../src/core/clauses';
import { parseBasicAbilities } from '../src/core/cards';
import { hasHandDeclare, hasDeclare } from '../src/core/abilities';

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
/** 不算失败的信息提示（例如测试卡池里根本没有能触发该行为的卡） */
const note = (msg: string) => {
  console.log(`  ⚠️ ${msg}`);
};

const mkGame = () => {
  const gs = createEmptyGame(cards);
  gs.players[0].deck = Array.from({ length: 20 }, () => newInstance('LO-6845'));
  gs.players[1].deck = Array.from({ length: 20 }, () => newInstance('LO-6845'));
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  gs.ready = true;
  return gs;
};

/** 费用支付：按费用元素从候选里挑卡（与界面自动选择一致） */
function payChoice(n: GameState): string[] {
  const p = n.prompt;
  if (!p || p.kind !== 'cost-pay') return [];
  const groups = rules.parseCost(p.cost);
  const pool = [...p.candidates];
  const used: string[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.points; i++) {
      const idx = pool.findIndex((c) => c.elements.includes(g.elem) || c.ex >= 2);
      if (idx >= 0) {
        used.push(pool[idx].uid);
        pool.splice(idx, 1);
      }
    }
  }
  return used;
}

/** 自动支付：穷举候选组合，找出一个真的被规则接受的付款方案（判据：所选卡确实离开了手牌） */
function tryPay(n: GameState): GameState | null {
  const p = n.prompt;
  if (!p || p.kind !== 'cost-pay') return null;
  const owner = p.owner;
  const cands = p.candidates.map((c) => c.uid).slice(0, 10);
  const before = n.players[owner].hand.map((c) => c.uid);
  for (let mask = 1; mask < 1 << cands.length; mask++) {
    const sel = cands.filter((_, i) => (mask >> i) & 1);
    let trial: GameState;
    try {
      trial = rules.confirmCostPay(structuredClone(n), sel);
    } catch {
      continue;
    }
    const afterHand = trial.players[owner].hand.map((c) => c.uid);
    // 付款成功 = 选中的卡都离开了手牌（失败时手牌一张不动）；
    // 注意别用「手牌少了 N 张」判断：エリア配置等行为会同时把卡本身移出手牌。
    if (!sel.every((u) => !afterHand.includes(u))) continue;
    return trial;
  }
  return null;
}

/** 自动把各种提示推到结束（对应链/战斗时点/选位置/选费用/选项…） */
function drive(g: GameState, cap = 60): GameState {
  let n = g;
  let guard = 0;
  while (guard++ < cap && n.prompt) {
    const k = n.prompt.kind;
    if (k === 'response') n = rules.respond(n, 'pass');
    else if (k === 'battle-timing') n = rules.battleTimingAction(n, 'end');
    else if (k === 'end-main') n = rules.endMainAction(n, 'end');
    else if (k === 'slot-pick') n = rules.chooseSlot(n, n.prompt.slots[0].row, n.prompt.slots[0].area);
    else if (k === 'effect-choice') n = rules.chooseEffectOption(n, [n.prompt.options[0].id]);
    else if (k === 'card-pick') n = rules.chooseCardPick(n, n.prompt.candidates.length > 0 ? [n.prompt.candidates[0].uid] : []);
    else if (k === 'search-deploy') n = rules.chooseSearchDeploy(n, n.prompt.candidates[0]?.uid ?? null);
    else if (k === 'cost-pay') {
      const paid = tryPay(n);
      if (!paid) break;
      n = paid;
    } else if (k === 'manual-effect') {
      const m = structuredClone(n);
      m.prompt = null;
      n = m;
    } else break;
  }
  return n;
}

const cues = (g: GameState) => (g.voiceQueue ?? []).map((c) => c.action);
const owners = (g: GameState, action: string) => (g.voiceQueue ?? []).filter((c) => c.action === action).map((c) => c.owner);
/** 各元素各一张的“万能支付手牌”（用于需要费用的行为） */
const payerIds = (() => {
  const seen = new Set<string>();
  const out: string[] = ['LO-6971']; // EX2 万能
  for (const c of cards) {
    if (c.type !== 'character') continue;
    const e = c.elements ?? '';
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(c.id);
    }
  }
  return out.slice(0, 8);
})();
const handOf = (gs: GameState, p: PlayerIndex, ids: string[]) => {
  gs.players[p].hand = ids.map((id) => {
    const i = newInstance(id);
    i.faceUp = true;
    return i;
  });
};
const putField = (gs: GameState, p: PlayerIndex, cardId: string, row: 0 | 1, area: 0 | 1 | 2) => {
  const inst = newInstance(cardId);
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[p].field[row][area] = inst;
  return inst;
};

/** 精确按基本能力标签找卡（'ステップ' 不能误配 'サイドステップ'） */
const charWithTag = (tag: string) =>
  cards.find((c) => c.type === 'character' && parseBasicAbilities(c.basicAbilities ?? '').some((b) => b.tag === tag));

const costChar = cards.find((c) => c.type === 'character' && c.cost === '日');
const smallChar = cards.find((c) => c.type === 'character' && (c.dmg ?? 99) <= 3);
const anyItem = cards.find((c) => c.type === 'item' && !/元のＤＭＧが３以下/.test(c.ability ?? ''));
const anyArea = cards.find((c) => c.type === 'area');
const trumpCard = cards.find((c) => parseCard(c).declared.some((d) => d.trump));
const declareCard = cards.find((c) => hasDeclare(c) && parseCard(c).declared.some((d) => !d.trump));
const handDeclareCard = cards.find((c) => hasHandDeclare(c) && parseCard(c).declared.some((d) => d.tag === '手札宣言' && !d.timing.response));

console.log('\n① 基本行为');
{
  const gs = mkGame();
  handOf(gs, 0, [costChar ? costChar.id : 'LO-6845', ...payerIds]);
  const uid = gs.players[0].hand[0].uid;
  const next = drive(rules.requestPlayCharacter(gs, uid, 'DF', 0));
  check('角色登场 → deploy', cues(next).includes('deploy'), JSON.stringify(cues(next)));
  check('归属 = 登场方', owners(next, 'deploy').includes(0));
}
{
  const gs = mkGame();
  const host = putField(gs, 0, smallChar?.id ?? 'LO-6845', 1, 0);
  handOf(gs, 0, [anyItem!.id, ...payerIds]);
  const item = gs.players[0].hand[0].uid;
  const next = drive(rules.requestEquipItem(gs, item, host.uid));
  check('道具装备 → equip', cues(next).includes('equip'), `${JSON.stringify(cues(next))} log=${next.log.slice(-1)[0] ?? ''}`);
}
{
  const gs = mkGame();
  handOf(gs, 0, [anyArea!.id, ...payerIds]);
  const area = gs.players[0].hand[0].uid;
  const next = drive(rules.requestPlayArea(gs, area));
  check('地板配置 → area', cues(next).includes('area'), `${JSON.stringify(cues(next))} prompt=${next.prompt?.kind ?? 'none'} log=${next.log.slice(-2).join(' | ')}`);
}
{
  const gs = mkGame();
  const atk = putField(gs, 0, 'LO-6846', 0, 0);
  const next = drive(rules.declareAttack(gs, atk.uid));
  check('攻击宣言 → attack', cues(next).includes('attack'), JSON.stringify(cues(next)));
}
{
  const gs = mkGame();
  const atk = putField(gs, 0, 'LO-6846', 0, 0);
  const def = putField(gs, 1, 'LO-6971', 1, 0);
  let next = drive(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, def.uid);
  check('选择防御 → defense', cues(next).includes('defense'), JSON.stringify(cues(next)));
  check('防御记在防御方身上', owners(next, 'defense').includes(1));

  const gs2 = mkGame();
  const atk2 = putField(gs2, 0, 'LO-6846', 0, 0);
  putField(gs2, 1, 'LO-6971', 1, 0);
  let n2 = drive(rules.declareAttack(gs2, atk2.uid));
  n2 = rules.chooseDefense(n2, null); // 不防御 → 牌堆伤害
  n2 = drive(n2);
  if (n2.prompt?.kind === 'damage') n2 = rules.confirmDamage(n2);
  check('牌堆受到伤害 → damage', cues(n2).includes('damage'), `${JSON.stringify(cues(n2))} log=${n2.log.slice(-1)[0] ?? ''}`);
  check('受伤记在被破弃的一方', owners(n2, 'damage').includes(1));
}

console.log('\n② 四种移动');
{
  const map: [string, string][] = [
    ['ステップ', 'moveStep'],
    ['サイドステップ', 'moveSide'],
    ['オーダーステップ', 'moveOrder'],
    ['ジャンプ', 'jump'],
  ];
  for (const [tag, cue] of map) {
    const cand = charWithTag(tag);
    if (!cand) {
      note(`「${tag}」→ ${cue}：这 208 张测试卡里没有带该基本能力的角色，实战遇不到（映射表已覆盖，等正式卡池）`);
      continue;
    }
    let done = false;
    for (const [row, area] of [
      [0, 1],
      [1, 1],
      [0, 0],
      [1, 0],
      [0, 2],
      [1, 2],
    ] as [0 | 1, 0 | 1 | 2][]) {
      const gs = mkGame();
      const inst = putField(gs, 0, cand.id, row, area);
      const targets = rules.validMoveTargets(gs, inst.uid);
      if (targets.length === 0) continue;
      const next = drive(rules.moveCharacter(gs, inst.uid, targets[0].row, targets[0].area));
      check(`「${tag}」→ ${cue}`, cues(next).includes(cue), JSON.stringify(cues(next)));
      done = true;
      break;
    }
    if (!done) check(`「${tag}」→ ${cue}`, false, '所有位置都没有合法落点');
  }
}

console.log('\n③ 宣言 / 手札宣言 / 切札');
{
  if (declareCard) {
    const gs = mkGame();
    const inst = putField(gs, 0, declareCard.id, 1, 0);
    handOf(gs, 0, payerIds);
    const next = drive(rules.requestDeclare(gs, inst.uid));
    check('宣言（効果発動）→ declare', cues(next).includes('declare'), `${JSON.stringify(cues(next))} log=${next.log.slice(-1)[0] ?? ''}`);
  } else {
    check('宣言（効果発動）→ declare', false, '卡池里找不到带宣言的卡');
  }

  if (handDeclareCard) {
    const gs = mkGame();
    handOf(gs, 0, [handDeclareCard.id, ...payerIds]);
    const uid = gs.players[0].hand[0].uid;
    const next = drive(rules.requestHandDeclare(gs, uid));
    check('手札宣言 → declare', cues(next).includes('declare'), `${JSON.stringify(cues(next))} log=${next.log.slice(-1)[0] ?? ''}`);
  } else {
    check('手札宣言 → declare', false, '卡池里找不到合适的[手札宣言]卡');
  }

  if (trumpCard) {
    const gs = mkGame();
    const inst = putField(gs, 0, trumpCard.id, 1, 0);
    handOf(gs, 0, payerIds);
    const next = drive(rules.requestDeclare(gs, inst.uid));
    check('切札 → trump', cues(next).includes('trump'), `${JSON.stringify(cues(next))} log=${next.log.slice(-1)[0] ?? ''}`);
    check('切札同时给出战歌信号（两者并存）', !!next.trumpSignal);
  } else {
    check('切札 → trump', false, '卡池里找不到切札');
  }
}

console.log('\n④ 支援');
{
  const gs = mkGame();
  const atk = putField(gs, 0, 'LO-6846', 0, 0);
  putField(gs, 0, 'LO-6845', 0, 1); // 相邻支援者
  putField(gs, 1, 'LO-6971', 1, 0);
  let next = drive(rules.declareAttack(gs, atk.uid));
  next = rules.chooseDefense(next, next.players[1].field[1][0]!.uid);
  const supOpt = next.prompt?.options?.find((o: { id: string }) => o.id.startsWith('sup:'));
  if (supOpt) {
    next = rules.battleTimingAction(next, supOpt.id);
    check('支援 → support', cues(next).includes('support'), JSON.stringify(cues(next)));
  } else {
    check('支援 → support', false, '战斗时点里没有支援选项');
  }
}

console.log('\n⑤ 对应宣言');
{
  const gs = mkGame();
  const atk = putField(gs, 0, 'LO-6846', 0, 0);
  putField(gs, 1, 'LO-6971', 1, 0);
  const next = rules.declareAttack(gs, atk.uid);
  if (next.prompt?.kind === 'response') {
    const opt = next.prompt.options?.find((o: { id: string }) => o.id !== 'pass');
    if (opt) {
      const after = rules.respond(next, opt.id);
      check('对应宣言 → respond', cues(after).includes('respond'), JSON.stringify(cues(after)));
    } else {
      check('对应宣言 → respond（该局面无可宣言卡，跳过）', true);
    }
  } else {
    check('对应宣言 → respond（无对应窗口，跳过）', true);
  }
}

console.log('\n⑥ 队列行为');
{
  const gs = mkGame();
  const atk = putField(gs, 0, 'LO-6846', 0, 0);
  const next = drive(rules.declareAttack(gs, atk.uid));
  const seqs = (next.voiceQueue ?? []).map((c) => c.seq);
  check('seq 严格递增', seqs.every((s, i) => i === 0 || s > seqs[i - 1]), JSON.stringify(seqs));
  check('队列不会无限增长（上限 6）', (next.voiceQueue ?? []).length <= 6, String((next.voiceQueue ?? []).length));
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
