/*
 * 全卡场景测试（开发端）
 * 用法：npx tsx tools/dev/card-scenarios.ts [--only LO-6960,LO-6850] [--verbose] [--steps 40]
 * 产出：tools/_fuzz/card-scenarios.json + card-scenarios.md
 */
import fs from 'node:fs';
import type { Card } from '../../src/core/cards';
import type { GameState } from '../../src/core/game';
import { parseCard, type EffAction } from '../../src/core/clauses';
import { cards, installDeterminism, newMatch, candidates, applyOp, changed, logDelta, rand } from './harness';
import { devAddToHand, devAddToDeck, devAddToTrash, devPlaceCharacter, devPlaceArea, devTrimDeck, devResetBoard } from '../../src/core/devTest';

const argv = process.argv.slice(2);
const argOf = (name: string, def: string) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const VERBOSE = argv.includes('--verbose');
const ONLY = argOf('only', '').split(',').filter(Boolean);
const MAX_STEPS = Number(argOf('steps', '40')) || 40;

const flat = (s: string) => s.replace(/[\s\u3000]/g, '');

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
        : pool.filter((c) =>
            needles.some((n) => flat(c.name ?? '').includes(flat(n)) || flat(n).includes(flat(c.name ?? ''))),
          );
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
  let gs = gs0;

  // 先把场面清干净（保留卡组），避免上一局的残留干扰
  gs = devResetBoard(gs);

  gs = devAddToHand(gs, card.id);
  placed.push('hand:' + card.id);

  // 使用前提：牌堆 ≤ N 张（例如 AMBITIOUS MISSION）
  for (const d of parsed.declared) {
    if (d.deckMax !== undefined && d.deckMax > 0) {
      gs = devTrimDeck(gs, Math.max(1, d.deckMax - 1));
      placed.push('deckTrim:' + d.deckMax);
    }
  }

  for (const el of ['\u96ea', '\u82b1', '\u5b99', '\u65e5', '\u6708']) {
    const cand = cards.find((c) => (c.elements ?? '').includes(el) && c.type === 'character');
    if (cand) {
      gs = devAddToHand(gs, cand.id);
      gs = devAddToHand(gs, cand.id);
    }
  }
  placed.push('hand:cost-cards');

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
  if (needsChar) {
    const chars = cards.filter((c) => c.type === 'character');
    if (chars[0]) {
      gs = devPlaceCharacter(gs, chars[0].id, 0, 0);
      placed.push('char:' + chars[0].id);
    }
    if (chars[1]) {
      gs = devPlaceCharacter(gs, chars[1].id, 0, 0, 1);
      placed.push('oppchar:' + chars[1].id);
    }
  }

  return { gs, placed };
}

type Verdict = 'ok' | 'ok-nolog' | 'pending-prompt' | 'prompt-dead-end' | 'rejected' | 'stuck' | 'no-effect' | 'scenario-miss';

type Result = {
  id: string;
  name: string;
  type: string;
  placed: string[];
  played: boolean;
  stuck: boolean;
  steps: number;
  logs: string[];
  zoneDelta: string;
  verdict: Verdict;
  firstReject?: string;
  pendingPrompt?: string;
};

function zoneSummary(gs: GameState): string {
  const p = gs.players[0];
  const field = p.field.flat().filter(Boolean).length;
  const areas = p.fieldAreas.flat().filter(Boolean).length;
  return 'H' + p.hand.length + '/D' + p.deck.length + '/T' + p.trash.length + '/F' + field + '/A' + areas;
}

function selfPresent(gs: GameState, card: Card): boolean {
  const p = gs.players[0];
  if (p.hand.some((c) => c.cardId === card.id)) return true;
  for (const row of p.field) if (row.some((c) => c && c.cardId === card.id)) return true;
  for (const row of p.fieldAreas) if (row.some((c) => c && c.cardId === card.id)) return true;
  return false;
}

function runOne(card: Card, idx: number): Result {
  const seed = 1000 + idx * 7919;
  const restore = installDeterminism(seed);
  try {
    let gs = prepMatch(seed);
    const sc = scaffold(gs, card);
    gs = sc.gs;
    const before = zoneSummary(gs);
    const logs: string[] = [];
    let played = false;
    let stuck = false;
    let firstReject: string | undefined;
    let stalled: string | undefined;
    let rejectReason: string | undefined;
    let steps = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      if (gs.prompt?.kind === 'gameover' || gs.winner !== null) break;
      const cands = candidates(gs);
      if (cands.length === 0) {
        stuck = true;
        break;
      }
      const selfUids = new Set<string>();
      for (const c of gs.players[0].hand) if (c.cardId === card.id) selfUids.add(c.uid);
      for (const row of gs.players[0].field) for (const c of row) if (c && c.cardId === card.id) selfUids.add(c.uid);

      // 候选排序：涉及这张卡的优先，其余随机（打乱避免总是同一条路径）
      const ordered = cands
        .map((o) => ({ o, r: rand(), self: o.args.some((a) => typeof a === 'string' && selfUids.has(a)) ? 1 : 0 }))
        .sort((a, b) => b.self - a.self || a.r - b.r)
        .map((x) => x.o);

      // 逐个试：只有"真的改变了状态"的选项才算可推进（在克隆上试，不污染真实状态）
      let advanced = false;
      let lastLogs: string[] = [];
      for (const op of ordered) {
        const clone = structuredClone(gs);
        const after = applyOp(clone, op);
        if (changed(clone, after)) {
          const real = applyOp(gs, op);
          const newLogs = logDelta(gs, real);
          if (newLogs.length) logs.push(...newLogs);
          const touchesSelf = op.args.some((a) => typeof a === 'string' && selfUids.has(a));
          if (touchesSelf) played = true;
          gs = real;
          steps++;
          advanced = true;
          break;
        }
        const nl = logDelta(clone, after);
        if (nl.length > 0) lastLogs = nl;
      }
      if (!advanced) {
        // 所有候选都不生效：提示窗口里 = 死路（真问题候选）；主阶段 = 被拒绝（附原因）
        if (gs.prompt) stalled = gs.prompt.kind;
        else rejectReason = lastLogs[0];
        break;
      }
      if (!gs.prompt && !selfPresent(gs, card)) break;
    }

    const afterText = zoneSummary(gs);
    const leftHand = !gs.players[0].hand.some((c) => c.cardId === card.id);
    const inTrashOrField =
      gs.players[0].trash.some((c) => c.cardId === card.id) ||
      gs.players[0].field.flat().some((c) => c && c.cardId === card.id) ||
      gs.players[0].fieldAreas.flat().some((c) => c && c.cardId === card.id);
    const nameInLog = (card.name ?? '') !== '' && gs.log.some((l) => l.includes(card.name!));
    const resolved = played && (leftHand || inTrashOrField) && !gs.prompt;

    // 这张卡的效果要求特定时点？（战斗中/对方回合/不能对应…）——那种情况本场景覆盖不到，单独标出来
    const parsedNow = parseCard(card);
    const hints: string[] = [];
    for (const d of parsedNow.declared) {
      const t = d.timing;
      if (t.battle === 'only') hints.push('battle-only');
      if (t.response === false) hints.push('no-response');
      if (t.turn === 'opponent') hints.push('opp-turn');
      if (t.noDefender) hints.push('no-defender');
      if (t.notDeployTurn) hints.push('not-deploy-turn');
    }

    let verdict: Verdict;
    if (stuck) verdict = 'stuck';
    else if (resolved) verdict = nameInLog ? 'ok' : 'ok-nolog';
    else if (stalled) verdict = 'prompt-dead-end';
    else if (gs.prompt) verdict = 'pending-prompt';
    else if (rejectReason) verdict = 'rejected';
    else if (hints.length > 0) verdict = 'scenario-miss';
    else verdict = 'no-effect';

    return {
      id: card.id,
      name: card.name ?? '',
      type: card.type,
      placed: sc.placed,
      played,
      stuck,
      steps,
      logs: logs.slice(-12),
      zoneDelta: before + ' -> ' + afterText,
      verdict,
      firstReject: rejectReason ?? firstReject,
      pendingPrompt: stalled ?? (gs.prompt ? gs.prompt.kind : undefined),
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
  if (VERBOSE) console.log(r.id + ' ' + r.name + ': ' + r.verdict + ' (' + r.steps + ') ' + (r.pendingPrompt ?? r.firstReject ?? ''));
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
md.push('# Full card scenario test (dev)', '');
md.push('Ran ' + results.length + ' cards. Verdict: ok=resolved; ok-nolog=resolved but not in log; pending-prompt=stuck on prompt; rejected=rejected; stuck=no actions; no-effect=nothing');
md.push('');
md.push('| verdict | count |');
md.push('|---|---|');
for (const [k, v] of [...byVerdict.entries()].sort((a, b) => b[1].length - a[1].length)) md.push('| ' + k + ' | ' + v.length + ' |');
md.push('');

for (const key of ['stuck', 'pending-prompt', 'rejected', 'no-effect', 'ok-nolog'] as Verdict[]) {
  const list = byVerdict.get(key) ?? [];
  if (list.length === 0) continue;
  md.push('## ' + key + ' (' + list.length + ')', '');
  for (const r of list) {
    md.push('### ' + r.id + ' ' + r.name + ' (' + r.type + ')');
    md.push('- scene: ' + r.placed.join(' / '));
    md.push('- zones: ' + r.zoneDelta);
    if (r.pendingPrompt) md.push('- pending prompt: ' + r.pendingPrompt);
    if (r.firstReject) md.push('- first silent reject: ' + r.firstReject);
    if (r.logs.length) md.push('- last logs: ' + r.logs.slice(-4).join(' | '));
    md.push('');
  }
}
fs.writeFileSync('tools/_fuzz/card-scenarios.md', md.join('\n'), 'utf-8');

console.log('');
console.log('Ran ' + results.length + ' cards');
for (const [k, v] of [...byVerdict.entries()].sort((a, b) => b[1].length - a[1].length)) console.log('  ' + k + ': ' + v.length);
console.log('report: tools/_fuzz/card-scenarios.md');
