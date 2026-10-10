// LO-6960（月影怪盗ミス・アルテ）+ LO-6961（AMBITIOUS MISSION）流程自检
// npx tsx tools/test-6960.ts
// 覆盖用户报告的"往这张卡下面放置一张卡，这一阶段会卡住、不能选择"：
//   ① 回合开始诱発：ゴミ箱1张放入此エリア下方 → 置いたとき 1 ドロー
//   ② 配置诱発：破弃1张手牌 → 检索 AMBITIOUS MISSION 无偿配置 → ゴミ箱1张放入そのエリア下方
//   ③ 下方上限（2 张以下才能放）时的行为
//   ④ 非法位置/找不到卡时**必须给出提示并继续**，不能静默卡死（这是曾经的 bug）
//   ⑤ 选卡面板确认 0 张时不再反复弹（否则玩家会觉得"卡住"）
import { readFileSync } from 'node:fs';
import type { Card } from '../src/core/cards';
import { createEmptyGame, newInstance, PlayerIndex, GameState } from '../src/core/game';
import * as rules from '../src/core/rules';

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
const note = (m: string) => console.log(`  ⚠️ ${m}`);

const ambition = cards.find((c) => (c.name ?? '').includes('AMBITIOUS MISSION'))!;
const mk = (): GameState => {
  const gs = createEmptyGame(cards);
  gs.turnPlayer = 0;
  gs.turn = 3;
  gs.ready = true;
  gs.phase = 'main';
  gs.players[0].deck = Array.from({ length: 20 }, () => newInstance('LO-6845'));
  gs.players[1].deck = Array.from({ length: 20 }, () => newInstance('LO-6845'));
  return gs;
};
const putArea = (gs: GameState, p: PlayerIndex, id: string, row: 0 | 1, area: 0 | 1 | 2) => {
  const inst = newInstance(id);
  inst.faceUp = true;
  inst.deployedTurn = null;
  gs.players[p].fieldAreas[row][area] = inst;
  return inst;
};
const putCard = (gs: GameState, p: PlayerIndex, zone: 'trash' | 'hand' | 'deck', id: string) => {
  const inst = newInstance(id);
  inst.faceUp = zone !== 'deck';
  gs.players[p][zone].push(inst);
  return inst;
};

/** 自动推进各种提示；返回 { gs, steps, done } */
function drive(g0: GameState, cap = 30): { gs: GameState; steps: string[]; done: boolean } {
  let n = g0;
  const steps: string[] = [];
  let i = 0;
  while (i++ < cap && n.prompt) {
    const p = n.prompt as unknown as {
      kind: string;
      title?: string;
      options?: { id: string; label: string }[];
      candidates?: { uid: string }[];
      slots?: { row: string; area: 0 | 1 | 2 }[];
      owner?: PlayerIndex;
      purpose?: string;
    };
    steps.push(p.kind + (p.purpose ? ':' + p.purpose : ''));
    if (p.kind === 'effect-choice' && p.options) {
      const pick = p.options.find((o) => o.id !== '__skip') ?? p.options[0];
      n = rules.chooseEffectOption(n, [pick.id]);
    } else if (p.kind === 'card-pick') {
      const c = p.candidates?.[0];
      n = rules.chooseCardPick(n, c ? [c.uid] : []);
    } else if (p.kind === 'search-deploy') {
      n = rules.chooseSearchDeploy(n, p.candidates?.[0]?.uid ?? null);
    } else if (p.kind === 'slot-pick') {
      const s = p.slots![0];
      n = rules.chooseSlot(n, s.row as 'AF' | 'DF', s.area);
    } else if (p.kind === 'response') n = rules.respond(n, 'pass');
    else if (p.kind === 'battle-timing') n = rules.battleTimingAction(n, 'end');
    else if (p.kind === 'end-main') n = rules.endMainAction(n, 'end');
    else if (p.kind === 'cost-pay') {
      const pr = n.prompt as unknown as { candidates: { uid: string }[]; owner: PlayerIndex };
      const cands = pr.candidates.map((c) => c.uid);
      let paid: GameState | null = null;
      for (let m = 1; m < 1 << cands.length; m++) {
        const sel = cands.filter((_, k) => (m >> k) & 1);
        const trial = rules.confirmCostPay(structuredClone(n), sel);
        const after = trial.players[pr.owner].hand.map((c) => c.uid);
        if (sel.every((u) => !after.includes(u))) {
          paid = trial;
          break;
        }
      }
      if (!paid) break;
      n = paid;
    } else break;
  }
  return { gs: n, steps, done: !n.prompt };
}

console.log('\n① 回合开始诱発：ゴミ箱 1 张放入此エリア下方 → 抽 1 张');
{
  const gs = mk();
  const area = putArea(gs, 0, 'LO-6960', 0, 0);
  const t1 = putCard(gs, 0, 'trash', 'LO-6846');
  putCard(gs, 0, 'trash', 'LO-6847');
  gs.phase = 'start';
  const handBefore = gs.players[0].hand.length;
  const r = drive(rules.beginTurn(gs));
  check('整条流程走完（没有卡住）', r.done, r.steps.join(' → '));
  check('提示顺序：效果选择 → 选卡', r.steps[0] === 'effect-choice' && r.steps[1] === 'card-pick:storeUnder', r.steps.join(' → '));
  const areaAfter = r.gs.players[0].fieldAreas[0][0]!;
  check('卡确实放到了エリア下方', areaAfter.under.length === 1 && areaAfter.under[0].uid === t1.uid, `under=${areaAfter.under.length}`);
  check('「置いたとき」抽了 1 张（含回合开始抽 2）', r.gs.players[0].hand.length === handBefore + 3, `手牌 ${handBefore} → ${r.gs.players[0].hand.length}`);
  check('进入主阶段', r.gs.phase === 'main');
}

console.log('\n② 配置诱発：破弃 1 张 → 检索 AMBITIOUS MISSION → 放入そのエリア下方');
{
  const gs = mk();
  const h6960 = putCard(gs, 0, 'hand', 'LO-6960');
  for (const c of cards.filter((c) => c.type === 'character' && (c.elements ?? '').includes('月')).slice(0, 4)) putCard(gs, 0, 'hand', c.id);
  putCard(gs, 0, 'trash', 'LO-6846');
  putCard(gs, 0, 'trash', 'LO-6847');
  putCard(gs, 0, 'deck', ambition.id);
  const r = drive(rules.requestPlayArea(gs, h6960.uid));
  check('整条流程走完（没有卡住）', r.done, r.steps.join(' → '));
  check('包含检索配置（search-deploy）', r.steps.includes('search-deploy'), r.steps.join(' → '));
  check('包含两次「放入下方」选卡', r.steps.filter((s) => s === 'card-pick:storeUnder').length === 2, r.steps.join(' → '));
  const a0 = r.gs.players[0].fieldAreas[0][0];
  const a1 = r.gs.players[0].fieldAreas[0][1];
  check('6960 已在场上', a0?.cardId === 'LO-6960');
  check('AMBITIOUS MISSION 已无偿配置', a1?.cardId === ambition.id, String(a1?.cardId));
  check('放入的是「そのエリア（AMBITIOUS MISSION）」下方', (a1?.under.length ?? 0) >= 1, `其下方 ${a1?.under.length}`);
}

console.log('\n③ 下方已满（3 张）时不再放置');
{
  const gs = mk();
  const area = putArea(gs, 0, 'LO-6960', 0, 0);
  area.under = [newInstance('LO-6846'), newInstance('LO-6847'), newInstance('LO-6848')];
  putCard(gs, 0, 'trash', 'LO-6849');
  gs.phase = 'start';
  const r = drive(rules.beginTurn(gs));
  check('流程走完', r.done, r.steps.join(' → '));
  check('没有放第 4 张（上限 2 张以下才可放）', area.under.length === 3, `under=${area.under.length}`);
  check('日志说明了原因', r.gs.log.some((l) => l.includes('下方已满')) || r.gs.log.some((l) => l.includes('无法放入')), r.gs.log.slice(-2).join(' / '));
}

console.log('\n④ 非法位置/找不到卡：必须给提示并继续，不能静默卡死（曾经的 bug）');
{
  // 4-1 点了不在列表里的格子
  const gs = mk();
  const h = putCard(gs, 0, 'hand', 'LO-6960');
  for (const c of cards.filter((c) => c.type === 'character' && (c.elements ?? '').includes('月')).slice(0, 4)) putCard(gs, 0, 'hand', c.id);
  const first = rules.requestPlayArea(gs, h.uid);
  const p = first.prompt as unknown as { slots: { row: string; area: 0 | 1 | 2 }[] };
  const bad = { row: 'AF', area: 0 } as { row: string; area: 0 | 1 | 2 };
  const isBad = !p.slots.some((s) => s.row === bad.row && s.area === bad.area);
  if (isBad) {
    const after = rules.chooseSlot(first, 'AF', 0);
    check('点非法格子：提示保留（还能继续选）', after.prompt?.kind === 'slot-pick');
    check('并且给出明确提示（不再静默）', after.log.some((l) => l.includes('不能选择')), after.log.slice(-1)[0] ?? '');
  } else {
    note('该局面没有"非法格子"可测（跳过）');
  }

  // 4-2 配置时目标卡已不在牌堆/ゴミ箱 → 以前会无限循环，现在必须提示并继续
  const gs2 = mk();
  const h2 = putCard(gs2, 0, 'hand', 'LO-6960');
  for (const c of cards.filter((c) => c.type === 'character' && (c.elements ?? '').includes('月')).slice(0, 4)) putCard(gs2, 0, 'hand', c.id);
  const opened = rules.requestPlayArea(gs2, h2.uid);
  const slot = (opened.prompt as unknown as { slots: { row: string; area: 0 | 1 | 2 }[] }).slots[0];
  // 手动把待配置的卡从手牌移走，模拟"卡不见了"
  const broken = structuredClone(opened);
  broken.players[0].hand = broken.players[0].hand.filter((c) => c.uid !== h2.uid);
  const after2 = rules.chooseSlot(broken, slot.row as 'AF' | 'DF', slot.area);
  check('卡找不到时：给出提示', after2.log.some((l) => l.includes('找不到')), after2.log.slice(-1)[0] ?? '');
  check('卡找不到时：提示被清掉（不会无限循环）', after2.prompt === null, String(after2.prompt?.kind));
}

console.log('\n⑤ 选卡面板确认 0 张 → 视为放弃并继续（不再反复弹面板）');
{
  const gs = mk();
  const area = putArea(gs, 0, 'LO-6960', 0, 0);
  putCard(gs, 0, 'trash', 'LO-6846');
  gs.phase = 'start';
  let n = rules.beginTurn(gs);
  // 第一步：处理诱発
  const p1 = n.prompt as unknown as { kind: string; options: { id: string }[] };
  n = rules.chooseEffectOption(n, [p1.options.find((o) => o.id !== '__skip')!.id]);
  check('出现选卡面板', n.prompt?.kind === 'card-pick', String(n.prompt?.kind));
  // 确认 0 张 → 应视为放弃并继续（以前会再弹一次同样的面板）
  n = rules.chooseCardPick(n, []);
  check('确认 0 张后不再弹同一个面板', n.prompt?.kind !== 'card-pick', String(n.prompt?.kind));
  check('流程能走到主阶段', n.phase === 'main' || n.prompt?.kind === 'end-main', `phase=${n.phase} prompt=${n.prompt?.kind}`);
  check('エリア下方没有放卡', area.under.length === 0, `under=${area.under.length}`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
