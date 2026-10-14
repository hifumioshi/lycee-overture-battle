/*
 * 对局机器人（纯规则层模糊测试） —— 开发端工具，只在 tools/ 下
 *
 * 用法：
 *   npx tsx tools/fuzz-rules.ts                        # 默认 20 局 × 250 步
 *   npx tsx tools/fuzz-rules.ts --games 50 --steps 300
 *   npx tsx tools/fuzz-rules.ts --seed 1234 --verbose
 *
 * 每一步把"当前所有候选动作"都列出来，随机挑一个执行，然后检查这些不变量：
 *   1. 提示可解   —— 有提示时至少存在一个能被接受的动作（否则就是整局卡死）
 *   2. 拒绝有反馈 —— 动作没生效时，必须留下战报文字（否则就是"点了没反应"）
 *   3. 卡牌守恒   —— 每个玩家的卡牌实例集合前后完全一致（不多不少、不重复）
 *   4. 数字合法   —— 费用池/计数器不为负
 *   5. 能推进     —— 不会长时间原地打转（回合/手牌/场上都不变）
 *   6. 可复现     —— 同一操作流水重放一遍，最终结构指纹必须一致
 *   7. 覆盖度     —— 统计有哪些卡从没被成功使用过
 *
 * 发现问题的每一处都会写成"最小复现流水"（JSON），交给 tools/replay.ts 定位（第二期）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { GameState } from '../src/core/game';
import { cards } from './dev/harness';
import {
  applyOp,
  candidates,
  changed,
  installDeterminism,
  logDelta,
  negativeCounters,
  newMatch,
  ownCardIdOfArgs,
  normalizeOp,
  denormalizeOp,
  uidOrder,
  projectKey,
  structuralKey,
  summarize,
  uidsOf,
  type Op,
} from './dev/harness';

const argv = process.argv.slice(2);
const num = (name: string, def: number) => {
  const i = argv.indexOf('--' + name);
  const v = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : def;
};
const has = (name: string) => argv.includes('--' + name);

const GAMES = num('games', 20);
const STEPS = num('steps', 250);
const BASE_SEED = num('seed', 1);
const MAX_FINDINGS = num('max-findings', 60);
const OUT = path.resolve('tools/_fuzz');

type Finding = {
  kind: string;
  game: number;
  step: number;
  op?: Op;
  promptKind: string;
  detail: string;
  summary: string;
  repro?: string;
};

const findings: Finding[] = [];
const silentRejects = new Map<string, { count: number; example: Finding }>();
const usedCards = new Set<string>();
let stepsRun = 0;
let accepted = 0;
let rejected = 0;
let gamesFinished = 0;

function addFinding(f: Finding): void {
  findings.push(f);
  if (findings.length <= 10) {
    const file = path.join(OUT, `repro-game${f.game}-step${f.step}-${f.kind}.json`);
    fs.mkdirSync(OUT, { recursive: true });
    f.repro = file;
  }
}

/** 抽签权重：让"结束回合"少一点，局才能打得久；取消类动作也压低 */
function weightOf(op: Op): number {
  if (op.action === 'endTurn') return 0.02;
  if (op.action === 'endMainCancel' || op.action === 'cancelCostPay') return 0.05;
  if (op.action === 'chooseMulligan') return 0.2;
  return 1;
}

function pickOp(ops: Op[]): Op {
  const total = ops.reduce((s, o) => s + weightOf(o), 0);
  let r = randPick() * total;
  for (const o of ops) {
    r -= weightOf(o);
    if (r <= 0) return o;
  }
  return ops[ops.length - 1];
}

// 机器人抽签用的随机数（与引擎随机流分开，见 harness 注释）
let randPick: () => number = Math.random;
function makeBotPicker(seed: number): () => number {
  let a = (seed ^ 0x85ebca6b) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function countField(gs: GameState): number {
  return [0, 1].reduce((s, p) => s + gs.players[p as 0 | 1].field.flat().filter(Boolean).length, 0);
}

function runGame(gameIdx: number, seed: number): { ops: Op[]; finalKey: string } {
  const restore = installDeterminism(seed);
  randPick = makeBotPicker(seed);
  let gs = newMatch(seed);
  const ops: Op[] = [];
  let lastTurn = gs.turn;
  let lastProgress = 0;
  let stuckSteps = 0;
  let noAccepted = 0;

  for (let step = 1; step <= STEPS; step++) {
    if (gs.phase === 'gameover' || gs.winner !== null) {
      gamesFinished++;
      break;
    }
    const cands = candidates(gs);
    if (cands.length === 0) {
      addFinding({
        kind: 'stuck-no-candidate',
        game: gameIdx,
        step,
        promptKind: gs.prompt?.kind ?? '无',
        detail: '当前提示下枚举不到任何动作 → 玩家无法继续操作',
        summary: summarize(gs),
      });
      break;
    }
    const op = pickOp(cands);
    // 快照必须是深拷贝：引擎里有"就地修改传入状态"的函数（如 pushVoice 的注释所述），
    // 直接拿引用当下就会让"有没有变化"的判断失真，进而误报"静默失败"。
    const before = structuredClone(gs);
    const after = applyOp(gs, op);
    const didChange = changed(before, after);
    stepsRun++;

    if (!didChange) {
      rejected++;
      const logs = logDelta(before, after);
      if (logs.length === 0) {
        const key = `${op.action}｜${op.label}｜提示=${before.prompt?.kind ?? '无'}`;
        const f: Finding = {
          kind: 'silent-reject',
          game: gameIdx,
          step,
          op,
          promptKind: before.prompt?.kind ?? '无',
          detail: '动作被拒绝但没有任何战报/提示文字 → 界面上表现为"点了没反应"',
          summary: summarize(before),
        };
        const hit = silentRejects.get(key);
        if (hit) hit.count++;
        else {
          silentRejects.set(key, { count: 1, example: f });
          addFinding(f);
        }
      }
      gs = after;
      // 注意：这里不要 push（流水在循环末尾统一 push 一次）。
      // 之前这里也 push 了一次，导致 300 步记成 ~600 条流水，回放时同一操作被应用两次，
      // 于是出现假的"不可复现"报告。
      stuckSteps++;
    } else {
      accepted++;
      stuckSteps = gs.turn !== before.turn ? 0 : stuckSteps + 1;
      // 3. 卡牌守恒
      for (const p of [0, 1] as (0 | 1)[]) {
        const a = new Set(uidsOf(before, p));
        const b = new Set(uidsOf(after, p));
        for (const u of a) if (!b.has(u)) {
          addFinding({
            kind: 'card-vanished',
            game: gameIdx,
            step,
            op,
            promptKind: before.prompt?.kind ?? '无',
            detail: `玩家${p + 1} 的卡牌实例 ${u}（${cardIdOf(before, u)}）执行后消失了`,
            summary: summarize(after),
          });
        }
        for (const u of b) if (!a.has(u)) {
          const cid = cardIdOf(after, u);
          addFinding({
            kind: 'card-created',
            game: gameIdx,
            step,
            op,
            promptKind: before.prompt?.kind ?? '无',
            detail: `玩家${p + 1} 执行后凭空多出卡牌实例（${cid}）`,
            summary: summarize(after),
          });
        }
      }
      // 4. 数字合法
      const bad = negativeCounters(after);
      if (bad.length > 0) {
        addFinding({
          kind: 'negative-counter',
          game: gameIdx,
          step,
          op,
          promptKind: before.prompt?.kind ?? '无',
          detail: `出现不可能的负数：${bad.join('；')}`,
          summary: summarize(after),
        });
      }
      // 7. 覆盖度
      const cid = ownCardIdOfArgs(before, op);
      if (cid) usedCards.add(cid);
    }

    // 5. 能推进：连续很多步"一个动作都做不到"才是真卡住（单纯回合没结束不算）
    if (gs.turn !== lastTurn) {
      lastTurn = gs.turn;
      lastProgress = step;
    }
    if (didChange) noAccepted = 0;
    else noAccepted++;
    if (noAccepted > 60) {
      // 救援：逐个试一遍候选动作（在深拷贝上试，避免就地修改污染真实状态）
      const rescue = cands.filter((c) => changed(gs, applyOp(structuredClone(gs), c)));
      if (rescue.length > 0) {
        noAccepted = 0;
      } else {
        addFinding({
          kind: 'no-progress',
          game: gameIdx,
          step,
          op,
          promptKind: gs.prompt?.kind ?? '无',
          detail: `连续 ${noAccepted} 步没有任何动作生效，且逐个试过 ${cands.length} 个候选动作全都无效（真卡住）`,
          summary: summarize(gs),
        });
        break;
      }
    }
    gs = after;
    // 记流水时把 uid 归一化成"第几张卡"（#i）：这样同进程/独立进程回放都能对上同一张卡
    ops.push(normalizeOp(op, uidOrder(after)));
    if (findings.length >= MAX_FINDINGS) break;
  }

  const finalKey = projectKey(gs);
  restore();
  return { ops, finalKey };
}

/** 找出两个投影对象的第一处分歧，形如 p0.hand[2]: LO-6845 ≠ LO-6900 */
function firstDiff(a: unknown, b: unknown, trail = ''): string {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    if (JSON.stringify(a) === JSON.stringify(b)) return '';
    return `${trail}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (!Array.isArray(a) || !Array.isArray(b) || x.length !== y.length) {
      return `${trail}: 长度 ${Array.isArray(a) ? (a as unknown[]).length : '非数组'} ≠ ${Array.isArray(b) ? (b as unknown[]).length : '非数组'}`;
    }
    for (let i = 0; i < x.length; i++) {
      const r = firstDiff(x[i], y[i], `${trail}[${i}]`);
      if (r) return r;
    }
    return '';
  }
  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  for (const k of [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort()) {
    const r = firstDiff(oa[k], ob[k], trail ? `${trail}.${k}` : k);
    if (r) return r;
  }
  return '';
}

/** 找到某 uid 对应的卡号（用于报告） */
function cardIdOf(gs: GameState, uid: string): string {
  const walk = (v: unknown): string | null => {
    if (v === null || typeof v !== 'object') return null;
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = walk(x);
        if (r) return r;
      }
      return null;
    }
    const o = v as Record<string, unknown>;
    if (o.uid === uid && typeof o.cardId === 'string') return o.cardId;
    for (const k of Object.keys(o)) {
      const r = walk(o[k]);
      if (r) return r;
    }
    return null;
  };
  return walk(gs) ?? '?';
}

console.log(`对局机器人：${GAMES} 局 × 最多 ${STEPS} 步，种子 ${BASE_SEED}，卡池 ${cards.length} 张`);
const t0 = Date.now();
const opsByGame = new Map<number, Op[]>();

for (let g = 0; g < GAMES; g++) {
  const seed = BASE_SEED + g * 7919;
  const { ops, finalKey } = runGame(g, seed);
  opsByGame.set(g, ops);

  // 6. 可复现：同一种子 + 同一操作流水，重放一遍必须得到同样的结构指纹
  if (ops.length > 0) {
    const restore = installDeterminism(seed);
    randPick = makeBotPicker(seed);
    let gs2 = newMatch(seed);
    let mapFail = false;
    for (const op of ops) {
      const real = denormalizeOp(op, uidOrder(gs2));
      // 归一化后的 #i 若解析不回来（下标越界），说明"卡序映射"错位了：
      // 这是工具限制，不能当成"游戏不可复现"。
      if (real.args.some((a) => typeof a === 'string' && /^#\d+$/.test(a))) {
        mapFail = true;
        break;
      }
      gs2 = applyOp(gs2, real);
    }
    const key2 = mapFail ? '' : projectKey(gs2);
    if (mapFail) {
      addFinding({
        kind: 'replay-map-failed',
        game: g,
        step: ops.length,
        promptKind: gs2.prompt?.kind ?? '无',
        detail: '回放时无法把流水里的"卡序"映射回当前局面（工具限制，不代表游戏有问题）——待独立进程回放解决',
        summary: summarize(gs2),
      });
    } else if (key2 !== finalKey) {
      addFinding({
        kind: 'non-deterministic',
        game: g,
        step: ops.length,
        promptKind: gs2.prompt?.kind ?? '无',
        detail: `同一操作流水重放后状态不一致，首个分歧：${firstDiff(JSON.parse(finalKey), JSON.parse(key2))}`,
        summary: summarize(gs2),
      });
    }
    restore();
  }
  if (has('verbose')) console.log(`  第 ${g + 1} 局：${ops.length} 步`);
  if (findings.length >= MAX_FINDINGS) {
    console.log(`（已达 ${MAX_FINDINGS} 条问题上限，提前结束）`);
    break;
  }
}

/* ---------------- 报告 ---------------- */

const byKind = new Map<string, Finding[]>();
for (const f of findings) {
  const arr = byKind.get(f.kind) ?? [];
  arr.push(f);
  byKind.set(f.kind, arr);
}

const KIND_NAME: Record<string, string> = {
  'stuck-no-candidate': '整局卡死（提示下没有任何可执行动作）',
  'silent-reject': '静默失败（点了没反应、也没提示）',
  'card-vanished': '卡牌消失（不守恒）',
  'card-created': '卡牌凭空出现（不守恒）',
  'negative-counter': '出现负数数值',
  'no-progress': '回合推不动（原地打转）',
  'non-deterministic': '不可复现（隐藏随机/时间依赖）',
  'replay-map-failed': '回放映射失败（工具限制，非游戏问题）',
};

console.log('\n================ 结果 ================');
console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，执行 ${stepsRun} 步（生效 ${accepted} / 被拒 ${rejected}），打完 ${gamesFinished} 局`);
console.log(`卡牌覆盖：${usedCards.size} / ${cards.length} 张成功使用过`);

if (findings.length === 0) {
  console.log('\n没有发现结构性问题 🎉（这不代表规则内容都正确，只说明没卡死/没漏牌/没分叉）');
} else {
  console.log(`\n发现 ${findings.length} 处问题（按类型）：`);
  for (const [kind, arr] of byKind) {
    console.log(`\n【${KIND_NAME[kind] ?? kind}】${arr.length} 处`);
    for (const f of arr.slice(0, 3)) {
      console.log(`  · 第 ${f.game + 1} 局第 ${f.step} 步：${f.op ? f.op.action + ' ' + f.op.label : '(无动作)'}`);
      console.log(`    ${f.detail}`);
      if (f.repro) console.log(`    复现流水：${path.relative(process.cwd(), f.repro)}`);
    }
    if (arr.length > 3) console.log(`  … 另外 ${arr.length - 3} 处同类`);
  }
}

if (silentRejects.size > 0) {
  console.log(`\n静默失败归类（共 ${silentRejects.size} 种，按出现次数）：`);
  const sorted = [...silentRejects.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [key, v] of sorted.slice(0, 15)) {
    console.log(`  ${String(v.count).padStart(4)} 次  ${key}`);
    console.log(`        ${v.example.detail}`);
  }
  if (sorted.length > 15) console.log(`  … 另外 ${sorted.length - 15} 种`);
}

// 复现流水（前 10 处），供第二期 replay 使用：截到出错那一步，同一种子重跑即可复现
if (findings.length > 0) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of findings.filter((x) => x.repro)) {
    const seed = BASE_SEED + f.game * 7919;
    const full = opsByGame.get(f.game) ?? [];
    fs.writeFileSync(
      f.repro!,
      JSON.stringify(
        {
          version: '0.21.0',
          seed,
          finding: { kind: f.kind, step: f.step, detail: f.detail, action: f.op?.action, label: f.op?.label },
          ops: full.slice(0, Math.max(1, f.step)),
        },
        null,
        2,
      ),
      'utf-8',
    );
  }
  console.log(`\n复现流水已写入 ${path.relative(process.cwd(), OUT)}（第二期 replay 工具会读它）`);
}

process.exit(findings.length > 0 ? 1 : 0);
