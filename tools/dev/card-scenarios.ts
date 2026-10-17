/*
 * 全卡场景测试（开发端）
 *
 * 每张卡按"效果前置"把牌摆到对应区域，再驱动它发动；对需要特定时点的卡，
 * 额外搭一个「战斗中」场景再试一次。判定按严格口径：
 *   提示可解 = 该提示下至少有一个选项能真正改变状态（逐个试，全都不行才算死路）。
 *
 * 用法：
 *   npx tsx tools/dev/card-scenarios.ts               # 全卡
 *   npx tsx tools/dev/card-scenarios.ts --only LO-6960
 *   npx tsx tools/dev/card-scenarios.ts --steps 60 --verbose
 *
 * 产出：tools/_fuzz/card-scenarios.json / card-scenarios.md
 */
import fs from 'node:fs';
import type { Card } from '../../src/core/cards';
import type { GameState } from '../../src/core/game';
import { parseCard, type EffAction, type Timing } from '../../src/core/clauses';
import { cards, installDeterminism, newMatch, candidates, applyOp, changed, logDelta, structuralKey, rand } from './harness';
import {
  devAddToHand,
  devAddToDeck,
  devAddToTrash,
  devPlaceCharacter,
  devPlaceArea,
  devTrimDeck,
  devResetBoard,
} from '../../src/core/devTest';

const argv = process.argv.slice(2);
const argOf = (name: string, def: string) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const VERBOSE = argv.includes('--verbose');
const ONLY = argOf('only', '').split(',').filter(Boolean);
const MAX_STEPS = Number(argOf('steps', '60')) || 60;

const flat = (s: string) => s.replace(/[\s\u3000]/g, '');

/** 取消/放弃类选项：优先度最低（先试能真正推进的选项） */
const PASS_LIKE = /取消|放弃|不選択|不选择|不支援|不防御|不使|结束优先权|否/;

function strictMatch(cardName: string, needle: string): boolean {
  const c = flat(cardName);
  const n = flat(needle);
  if (!c || !n) return false;
  if (c === n) return true;
  const long = c.length >= n.length ? c : n;
  const short = c.length >= n.length ? n : c;
  return long.includes(short) && long.length - short.length <= 3;
}

function resolveTargets(a: EffAction): string[] {
  let pool = cards.slice();
  if (a.names && a.names.length > 0) {
    const needles = a.names
      .flatMap((n) => n.split(/[\uff0f\/\u3001\u30fb]/))
      .map((s) => s.trim())
      .filter(Boolean);
    const strict = pool.filter((c) => needles.some((n) => strictMatch(c.name ?? '', n)));
    pool =
      strict.length > 0
        ? strict
        : pool.filter((c) => needles.some((n) => flat(c.name ?? '').includes(flat(n)) || flat(n).includes(flat(c.name ?? ''))));
  }
  if (a.areaName) pool = pool.filter((c) => flat(c.name ?? '') === flat(a.areaName!));
  if (a.kind === 'deploy' || a.anyChar) pool = pool.filter((c) => c.type === 'character');
  if (a.kind === 'equip') pool = pool.filter((c) => c.type === 'item');
  if (a.element) pool = pool.filter((c) => (c.elements ?? '').includes(a.element!));
  if (a.costMax !== undefined) pool = pool.filter((c) => (c.cost ?? '').length <= a.costMax!);
  return pool.map((c) => c.id);
}

function prepMatch(seed: number): GameState {
  const gs = newMatch(seed);
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

function scaffold(gs0: GameState, card: Card): { gs: GameState; placed: string[] } {
  const placed: string[] = [];
  const parsed = parseCard(card);
  const actions: EffAction[] = [
    ...parsed.declared.flatMap((d) => d.options.flatMap((o) => o.actions)),
    ...parsed.triggers.flatMap((t) => t.options.flatMap((o) => o.actions)),
  ];
  let gs = devResetBoard(gs0);
  gs = devAddToHand(gs, card.id);
  placed.push('hand:' + card.id);

  for (const d of parsed.declared) {
    if (d.deckMax !== undefined && d.deckMax > 0) {
      gs = devTrimDeck(gs, Math.max(1, d.deckMax - 1));
      placed.push('deckTrim:' + d.deckMax);
    }
  }

  for (const el of ['\u96ea', '\u82b1', '\u5b99', '\u65e5', '\u6708']) {
    const cand = cards.find((c) => (c.elements ?? '').includes(el) && c.type === 'character' && (c.ex ?? 0) >= 2);
    const pickOne = cand ?? cards.find((c) => (c.elements ?? '').includes(el) && c.type === 'character');
    if (pickOne) {
      for (let k = 0; k < 4; k++) gs = devAddToHand(gs, pickOne.id);
    }
  }
  placed.push('hand:cost-cards(x20)');

  for (const a of actions) {
    if (a.t !== 'search') continue;
    const ids = resolveTargets(a);
    if (ids.length === 0) continue;
    if (a.fromTrashOnly) {
      gs = devAddToTrash(gs, ids[0], 2);
      placed.push('trash:' + ids[0]);
    } else {
      gs = devAddToDeck(gs, ids[0], { count: 2 });
      placed.push('deck:' + ids[0]);
    }
  }

  for (const a of actions) {
    if (a.t === 'reviveSelf') {
      gs = devAddToTrash(gs, card.id, 1);
      placed.push('trash:' + card.id);
    }
    if (a.t === 'healDeck' || a.t === 'exileTrashCopy' || a.t === 'trashCopyToDeckBottom') {
      const any = cards.find((c) => c.type === 'character');
      if (any) {
        gs = devAddToTrash(gs, any.id, 2);
        placed.push('trash:' + any.id);
      }
    }
  }

  for (const a of actions) {
    const wantsArea = a.t === 'storeUnderArea' || (a.t === 'search' && a.kind === 'place');
    if (!wantsArea || !a.areaName) continue;
    const areaCard = cards.find((c) => flat(c.name ?? '') === flat(a.areaName!) && c.type === 'area');
    if (areaCard) {
      gs = devPlaceArea(gs, areaCard.id, 0, 0);
      placed.push('area:' + areaCard.id);
    }
  }

  const needsChar = actions.some((a) =>
    ['discardChar', 'discardCharUpTo', 'forceDefend', 'dmgZero', 'setDp0', 'equipSelfToTarget'].includes(a.t),
  );
  const chars = cards.filter((c) => c.type === 'character');
  if (needsChar && chars[0]) {
    gs = devPlaceCharacter(gs, chars[0].id, 0, 0);
    placed.push('char:' + chars[0].id);
  }
  if (needsChar && chars[1]) {
    gs = devPlaceCharacter(gs, chars[1].id, 0, 0, 1);
    placed.push('oppchar:' + chars[1].id);
  }

  return { gs, placed };
}

/** 让局面进入"战斗中"（我方 AF 角色攻击对方 AF 角色，走到バトル开始为止） */
function enterBattle(gs0: GameState): GameState | null {
  let gs = gs0;
  const mine = gs.players[0].field.flat().find(Boolean);
  const opp = gs.players[1].field.flat().find(Boolean);
  if (!mine || !opp) return null;
  gs = applyOp(gs, { action: 'declareAttack', args: [mine.uid], label: 'battle-setup' });
  for (let i = 0; i < 8; i++) {
    if (gs.battle) return gs;
    const cands = candidates(gs);
    if (cands.length === 0) return null;
    // 只选"放弃支援/不防御"这类，快速推进到バトル开始
    const pass = cands.filter((o) => PASS_LIKE.test(o.label));
    const op = pass[0] ?? cands[0];
    const before = gs;
    gs = applyOp(gs, op);
    if (changed(before, gs) === false && gs === before) return null;
  }
  return gs.battle ? gs : null;
}

type Verdict =
  | 'ok'
  | 'ok-nolog'
  | 'prompt-dead-end'
  | 'stuck'
  | 'pending-prompt'
  | 'silent-reject'
  | 'rejected'
  | 'needs-timing'
  | 'no-effect';

type Mode = 'main' | 'battle';

type Result = {
  id: string;
  name: string;
  type: string;
  modes: Mode[];
  placed: string[];
  steps: number;
  logs: string[];
  zoneDelta: string;
  verdict: Verdict;
  deadEndPrompt?: string;
  rejectReason?: string;
  pendingPrompt?: string;
};

function zoneSummary(gs: GameState): string {
  const p = gs.players[0];
  return (
    'H' + p.hand.length +
    '/D' + p.deck.length +
    '/T' + p.trash.length +
    '/F' + p.field.flat().filter(Boolean).length +
    '/A' + p.fieldAreas.flat().filter(Boolean).length
  );
}

function selfPresent(gs: GameState, card: Card): boolean {
  const p = gs.players[0];
  if (p.hand.some((c) => c.cardId === card.id)) return true;
  for (const row of p.field) if (row.some((c) => c && c.cardId === card.id)) return true;
  for (const row of p.fieldAreas) if (row.some((c) => c && c.cardId === card.id)) return true;
  return false;
}

type RunOut = {
  verdict: Verdict;
  steps: number;
  logs: string[];
  zoneDelta: string;
  deadEndPrompt?: string;
  rejectReason?: string;
  pendingPrompt?: string;
};

/** 驱动一张卡：mode=main 主阶段；mode=battle 先进入战斗中再试 */
function drive(gsIn: GameState, card: Card, mode: Mode): RunOut {
  let gs = gsIn;
  const logs: string[] = [];
  let steps = 0;
  const visits = new Map<string, number>();
  let deadEndPrompt: string | undefined;
  let rejectReason: string | undefined;

  if (mode === 'battle') {
    const b = enterBattle(gs);
    if (!b) return { verdict: 'needs-timing', steps: 0, logs: [], zoneDelta: zoneSummary(gs) + ' -> ' + zoneSummary(gs), pendingPrompt: 'battle-setup-failed' };
    gs = b;
  }

  const before = zoneSummary(gs);

  for (let i = 0; i < MAX_STEPS; i++) {
    if (gs.prompt?.kind === 'gameover' || gs.winner !== null) break;
    const key = structuralKey(gs);
    const n = (visits.get(key) ?? 0) + 1;
    visits.set(key, n);
    if (n > 3) {
      // 同一个局面第 4 次出现 → 认定在原地打转（工具判定，非游戏问题）
      return { verdict: 'pending-prompt', steps, logs, zoneDelta: before + ' -> ' + zoneSummary(gs), pendingPrompt: gs.prompt?.kind ?? 'loop' };
    }

    const cands = candidates(gs);
    if (cands.length === 0) return { verdict: 'stuck', steps, logs, zoneDelta: before + ' -> ' + zoneSummary(gs), pendingPrompt: gs.prompt?.kind };

    const selfUids = new Set<string>();
    for (const c of gs.players[0].hand) if (c.cardId === card.id) selfUids.add(c.uid);
    for (const row of gs.players[0].field) for (const c of row) if (c && c.cardId === card.id) selfUids.add(c.uid);

    // 排序：涉及本卡的优先 → 非取消类优先 → 随机
    const ordered = cands
      .map((o) => ({
        o,
        self: o.args.some((a) => typeof a === 'string' && selfUids.has(a)) ? 1 : 0,
        pass: PASS_LIKE.test(o.label) ? 1 : 0,
        r: rand(),
      }))
      .sort((a, b) => b.self - a.self || a.pass - b.pass || a.r - b.r)
      .map((x) => x.o);

    // 主阶段：只尝试"涉及这张卡"的动作（否则会去打别的牌，永远跑不完，也没意义）
    const promptUp = !!gs.prompt;
    const consider = promptUp ? ordered : ordered.filter((o) => o.args.some((a) => typeof a === 'string' && selfUids.has(a)));
    if (!promptUp && consider.length === 0) {
      return {
        verdict: timingHints(card).length > 0 ? 'needs-timing' : 'no-effect',
        steps,
        logs,
        zoneDelta: before + ' -> ' + zoneSummary(gs),
        rejectReason: 'no-action-for-this-card',
      };
    }

    let advanced = false;
    let lastLogs: string[] = [];
    for (const op of consider) {
      const clone = structuredClone(gs);
      const after = applyOp(clone, op);
      if (changed(clone, after)) {
        const real = applyOp(gs, op);
        const nl = logDelta(gs, real);
        if (nl.length) logs.push(...nl);
        gs = real;
        steps++;
        advanced = true;
        break;
      }
      const nl = logDelta(clone, after);
      if (nl.length > 0) lastLogs = nl;
    }
    if (!advanced) {
      if (gs.prompt) {
        deadEndPrompt = gs.prompt.kind;
        return { verdict: 'prompt-dead-end', steps, logs, zoneDelta: before + ' -> ' + zoneSummary(gs), deadEndPrompt };
      }
      // 主阶段：分两种——"这张卡没给出任何可发动动作"（场景没搭对） vs "给了但全被静默拒绝"（价值最高的问题）
      const scoped = consider.length;
      rejectReason = lastLogs[0];
      return {
        verdict: scoped > 0 && lastLogs.length === 0 ? 'silent-reject' : 'rejected',
        steps,
        logs,
        zoneDelta: before + ' -> ' + zoneSummary(gs),
        rejectReason: rejectReason ?? (scoped === 0 ? 'no-action-for-this-card' : 'rejected-with-message'),
      };
    }
    if (!gs.prompt && !selfPresent(gs, card)) break;
  }

  const leftHand = !gs.players[0].hand.some((c) => c.cardId === card.id);
  const moved =
    gs.players[0].trash.some((c) => c.cardId === card.id) ||
    gs.players[0].field.flat().some((c) => c && c.cardId === card.id) ||
    gs.players[0].fieldAreas.flat().some((c) => c && c.cardId === card.id);
  const nameInLog = (card.name ?? '') !== '' && gs.log.some((l) => l.includes(card.name!));
  if ((leftHand || moved) && !gs.prompt) {
    return { verdict: nameInLog ? 'ok' : 'ok-nolog', steps, logs, zoneDelta: before + ' -> ' + zoneSummary(gs) };
  }
  if (gs.prompt) return { verdict: 'pending-prompt', steps, logs, zoneDelta: before + ' -> ' + zoneSummary(gs), pendingPrompt: gs.prompt.kind };
  return { verdict: 'no-effect', steps, logs, zoneDelta: before + ' -> ' + zoneSummary(gs) };
}

const RANK: Record<Verdict, number> = {
  ok: 100,
  'ok-nolog': 90,
  'silent-reject': 70,
  'prompt-dead-end': 65,
  stuck: 60,
  'pending-prompt': 40,
  rejected: 30,
  'needs-timing': 20,
  'no-effect': 10,
};

function timingHints(card: Card): string[] {
  const parsed = parseCard(card);
  const hints: string[] = [];
  for (const d of parsed.declared) {
    const t: Timing = d.timing;
    if (t.battle === 'only') hints.push('battle-only');
    if (t.battle === 'no') hints.push('no-battle');
    if (t.response === false) hints.push('cannot-respond');
    if (t.turn === 'opponent') hints.push('opp-turn');
    if (t.noDefender) hints.push('no-defender');
    if (t.notDeployTurn) hints.push('not-deploy-turn');
  }
  return hints;
}

function runOne(card: Card, idx: number): Result {
  const seed = 3000 + idx * 7919;
  const restore = installDeterminism(seed);
  try {
    const hints = timingHints(card);
    const modes: Mode[] = ['main'];
    if (hints.includes('battle-only') || hints.includes('no-defender')) modes.push('battle');

    const outs: RunOut[] = [];
    let placed: string[] = [];
    for (const mode of modes) {
      installDeterminism(seed);
      const base = prepMatch(seed);
      const sc = scaffold(base, card);
      if (mode === 'main') placed = sc.placed;
      outs.push(drive(sc.gs, card, mode));
    }

    const best = outs.slice().sort((a, b) => RANK[b.verdict] - RANK[a.verdict])[0];
    const logs = outs.flatMap((o) => o.logs).slice(-12);
    return {
      id: card.id,
      name: card.name ?? '',
      type: card.type,
      modes,
      placed,
      steps: outs.reduce((s, o) => s + o.steps, 0),
      logs,
      zoneDelta: best.zoneDelta,
      verdict: best.verdict,
      deadEndPrompt: best.deadEndPrompt,
      rejectReason: best.rejectReason,
      pendingPrompt: best.pendingPrompt,
    };
  } finally {
    restore();
  }
}

const targets = ONLY.length > 0 ? cards.filter((c) => ONLY.includes(c.id)) : cards;
const results: Result[] = [];
targets.forEach((card, i) => {
  const r = runOne(card, i);
  results.push(r);
  if (VERBOSE) console.log(r.id + ' ' + r.name + ': ' + r.verdict + ' (' + r.steps + ') ' + (r.deadEndPrompt ?? r.pendingPrompt ?? r.rejectReason ?? ''));
});

fs.mkdirSync('tools/_fuzz', { recursive: true });
fs.writeFileSync('tools/_fuzz/card-scenarios.json', JSON.stringify(results, null, 2), 'utf-8');

const byVerdict = new Map<Verdict, Result[]>();
for (const r of results) {
  const arr = byVerdict.get(r.verdict) ?? [];
  arr.push(r);
  byVerdict.set(r.verdict, arr);
}

const md: string[] = [];
md.push('# Full card scenario test (dev)');
md.push('');
md.push('Ran ' + results.length + ' cards. ok=resolved; ok-nolog=resolved but not in log; prompt-dead-end=NO option can advance (real candidate); stuck=no actions; pending-prompt=flow not finished; rejected=rejected with reason; needs-timing=needs a timing this harness cannot build; no-effect=nothing');
md.push('');
md.push('| verdict | count |');
md.push('|---|---|');
for (const [k, v] of [...byVerdict.entries()].sort((a, b) => b[1].length - a[1].length)) md.push('| ' + k + ' | ' + v.length + ' |');
md.push('');

for (const key of ['prompt-dead-end', 'stuck', 'rejected', 'pending-prompt', 'needs-timing', 'no-effect', 'ok-nolog'] as Verdict[]) {
  const list = byVerdict.get(key) ?? [];
  if (list.length === 0) continue;
  md.push('## ' + key + ' (' + list.length + ')');
  md.push('');
  for (const r of list) {
    md.push('### ' + r.id + ' ' + r.name + ' (' + r.type + ')');
    md.push('- modes: ' + r.modes.join(', '));
    md.push('- scene: ' + r.placed.join(' / '));
    md.push('- zones: ' + r.zoneDelta);
    if (r.deadEndPrompt) md.push('- DEAD END prompt: ' + r.deadEndPrompt);
    if (r.rejectReason) md.push('- reject reason: ' + r.rejectReason);
    if (r.pendingPrompt) md.push('- pending: ' + r.pendingPrompt);
    if (r.logs.length) md.push('- last logs: ' + r.logs.slice(-4).join(' | '));
    md.push('');
  }
}
fs.writeFileSync('tools/_fuzz/card-scenarios.md', md.join('\n'), 'utf-8');

console.log('');
console.log('Ran ' + results.length + ' cards');
for (const [k, v] of [...byVerdict.entries()].sort((a, b) => b[1].length - a[1].length)) console.log('  ' + k + ': ' + v.length);
console.log('report: tools/_fuzz/card-scenarios.md');
