// 效果系统（阶段 5·第一阶段）
// 自动解析最常见的效果模式并生效：
//   - 登场诱発：このキャラが登場したとき、Ｎ枚ドローする
//   - 常时数值：このキャラに/味方キャラ全てに ＡＰ/ＤＰ/ＳＰ/ＤＭＧ ＋－Ｎ
// 结构化效果由 clauses.ts 解析、effectEngine.ts 执行；本文件保留兼容接口。
import type { Card } from './cards';
import { formatAbilityText } from './cards';
import { GameState, CardInstance, PlayerIndex } from './game';
import * as eng from './effectEngine';

export type StatKey = 'ap' | 'dp' | 'sp' | 'dmg';
export type EffectTarget = 'self' | 'allFriendly';

export interface StatMod {
  stat: StatKey;
  amount: number;
}

export interface CardEffect {
  kind: 'deploy-draw' | 'deploy-stat' | 'continuous-stat';
  target: EffectTarget;
  draw?: number;
  stats?: StatMod[];
  raw: string; // 命中的原始效果文本（用于标注）
}

/** 全角数字转半角 */
function toNum(s: string): number {
  const half = s.replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)));
  return parseInt(half, 10) || 0;
}

const STAT_MAP: Record<string, StatKey> = { ＡＰ: 'ap', ＤＰ: 'dp', ＳＰ: 'sp', ＤＭＧ: 'dmg' };

/** 解析一张卡的效果（返回能自动执行的常见效果；保守精确匹配第一处简单效果） */
export function parseEffects(card: Card): CardEffect[] {
  const a = formatAbilityText(card.ability || '');
  const out: CardEffect[] = [];
  if (!a) return out;

  // 1) 登场诱発：このキャラが登場したとき、Ｎ枚ドローする。
  const dm = /登場したとき、([１-９]?)枚ドローする。/.exec(a);
  if (dm) {
    out.push({ kind: 'deploy-draw', target: 'self', draw: toNum(dm[1] || '１') || 1, raw: dm[0].trim() });
  }

  // 1b) 登场诱発：登場したとき、このキャラに/味方キャラ全てに 数值修正
  const dsRe = /登場したとき、?(このキャラに|味方キャラ全てに)(ＡＰ|ＤＰ|ＳＰ|ＤＭＧ)([＋－])([０-９]+)する。/.exec(a);
  if (dsRe && !dm) {
    const target: EffectTarget = dsRe[1] === '味方キャラ全てに' ? 'allFriendly' : 'self';
    out.push({
      kind: 'deploy-stat',
      target,
      stats: [{ stat: STAT_MAP[dsRe[2]], amount: dsRe[3] === '－' ? -toNum(dsRe[4]) : toNum(dsRe[4]) }],
      raw: dsRe[0].trim().slice(0, 80),
    });
  }

  // 2) 常时数值（保守：只取第一处简单的"このキャラにXする。" / "味方キャラ全てにXする。"）
  const statRe = (target: string) => new RegExp(`\\[常時\\][\\s\\S]*?${target}(ＡＰ|ＤＰ|ＳＰ|ＤＭＧ)([＋－])([０-９]+)する。`);
  const sm = statRe('このキャラに').exec(a);
  if (sm) {
    out.push({
      kind: 'continuous-stat',
      target: 'self',
      stats: [{ stat: STAT_MAP[sm[1]], amount: sm[2] === '－' ? -toNum(sm[3]) : toNum(sm[3]) }],
      raw: sm[0].trim().slice(0, 80),
    });
  }
  const am = statRe('味方キャラ全てに').exec(a);
  if (am) {
    out.push({
      kind: 'continuous-stat',
      target: 'allFriendly',
      stats: [{ stat: STAT_MAP[am[1]], amount: am[2] === '－' ? -toNum(am[3]) : toNum(am[3]) }],
      raw: am[0].trim().slice(0, 80),
    });
  }

  return out;
}

/** 该卡是否有效果但未被自动解析（用于界面标注"未实现"） */
export function hasUnsupportedEffect(card: Card): boolean {
  const a = formatAbilityText(card.ability || '');
  if (!a) return false;
  const parsed = parseEffects(card);
  // 简单判断：只要有效果文本但解析出的可执行效果为空或很少，就视为有未实现部分
  return a.length > 0;
}

/* ================= 宣言 / 手札宣言 效果解析 ================= */

export interface DeclaredEffect {
  cost: string; // 使用费用：'0' | 'T' | 'C1' 等
  target: 'self' | 'oneFriendly' | 'oneOpponent' | 'allFriendly' | 'none';
  action: 'stat' | 'draw' | 'search';
  stat?: StatKey;
  amount?: number;
  draw?: number;
  searchNames?: string[]; // 检索的卡名（「...」）
  searchKind?: 'deploy' | 'place' | 'hand'; // 检索后：登场 / 配置 / 加入手牌
}

/** 解析 [宣言] / [手札宣言] 后的效果（支持：数值增减/抽牌；目标：自身/味方1体/相手1体/味方全部） */
export function parseDeclaredEffect(card: Card, tag: string): DeclaredEffect | null {
  const a = formatAbilityText(card.ability || '');
  const re = new RegExp(`\\[${tag}\\]\\s*\\[([^\\]]+)\\]:([\\s\\S]*?)(?=\\[(?:宣言|手札宣言|誘発|常時|コスト|自動|起動)|$)`);
  const m = re.exec(a);
  if (!m) return null;
  const cost = m[1];
  const eff = m[2] || '';
  let target: DeclaredEffect['target'] = 'none';
  if (/このキャラに/.test(eff)) target = 'self';
  else if (/\{味方キャラ１体\}/.test(eff)) target = 'oneFriendly';
  else if (/\{相手キャラ１体\}/.test(eff)) target = 'oneOpponent';
  else if (/味方キャラ全てに/.test(eff)) target = 'allFriendly';
  const statM = /(ＡＰ|ＤＰ|ＳＰ|ＤＭＧ)([＋－])([０-９]+)/.exec(eff);
  if (statM) {
    const amt = toNum(statM[3]);
    return { cost, target, action: 'stat', stat: STAT_MAP[statM[1]], amount: statM[2] === '－' ? -amt : amt };
  }
  const drawM = /([１-９]?)枚ドローする/.exec(eff);
  if (drawM) {
    return { cost, target, action: 'draw', draw: toNum(drawM[1] || '１') || 1 };
  }
  // 检索：デッキ/ゴミ箱から「卡名」を探し → 登場/配置/手札に入れる
  const names = [...eff.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
  if (names.length > 0) {
    let kind: 'deploy' | 'place' | 'hand' | null = null;
    if (/登場する/.test(eff)) kind = 'deploy';
    else if (/配置する/.test(eff)) kind = 'place';
    else if (/手札に入れる/.test(eff)) kind = 'hand';
    if (kind) {
      return { cost, target: 'none', action: 'search', searchNames: names, searchKind: kind };
    }
  }
  return null;
}

/** 提取卡上所有"登場したとき"触发的句子（用于手动结算面板） */
export function deployTriggerTexts(card: Card): string[] {
  const a = formatAbilityText(card.ability || '');
  return a
    .split(/[。\n]/)
    .map((s) => s.trim())
    .filter((s) => s.includes('登場したとき') && s.length > 0);
}

/** 该卡的登场触发句数量（用于判断是否有未自动覆盖的触发） */
export function deployTriggerCount(card: Card): number {
  return deployTriggerTexts(card).length;
}

/** 该卡被自动解析的登场效果数量 */
export function parsedDeployCount(card: Card): number {
  return parseEffects(card).filter((e) => e.kind === 'deploy-draw' || e.kind === 'deploy-stat').length;
}

/* ================= 生效 ================= */

/** 计算卡片的有效数值（基础值 + 常时加成 + 临时修正 + 临时设定；由效果引擎统一计算） */
export function effectiveStats(gs: GameState, uid: string): { ap: number; dp: number; sp: number; dmg: number } {
  return eng.effectiveStats(gs, uid);
}

/** 登场时触发：登场诱発效果 */
export function runDeployEffects(gs: GameState, uid: string, player: PlayerIndex): GameState {
  const inst = findInst(gs, uid);
  if (!inst) return gs;
  const card = gs.cardsById[inst.cardId];
  if (!card) return gs;
  const effects = parseEffects(card);
  let next = gs;
  for (const e of effects) {
    if (e.kind === 'deploy-draw' && e.draw) {
      for (let i = 0; i < e.draw; i++) {
        const st = next.players[player];
        if (st.deck.length === 0) {
          next = { ...next, log: [...next.log, '牌堆为空，无法抽牌。'] };
          break;
        }
        const top = st.deck.pop()!;
        top.faceUp = true;
        st.hand.push(top);
      }
      next = { ...next, log: [...next.log, `「${card.name}」登场效果：抽 ${e.draw} 张牌。`] };
    }
    if (e.kind === 'deploy-stat' && e.stats) {
      // 对自身或我方全部角色应用临时数值修正
      for (let r = 0; r < 2; r++) {
        for (let a = 0; a < 3; a++) {
          const f = next.players[player].field[r][a];
          if (!f) continue;
          if (e.target === 'self' && f.uid !== uid) continue;
          for (const s of e.stats) f.tempMods[s.stat] += s.amount;
        }
      }
      const statLabel = e.stats.map((s) => `${s.stat.toUpperCase()}${s.amount > 0 ? `+${s.amount}` : s.amount}`).join('、');
      next = { ...next, log: [...next.log, `「${card.name}」登场效果：${e.target === 'self' ? '自身' : '我方全部'} ${statLabel}（到回合结束）。`] };
    }
  }
  return next;
}

/* ===== 内部辅助 ===== */function findInst(gs: GameState, uid: string): CardInstance | null {
  for (const p of [0, 1] as PlayerIndex[]) {
    const st = gs.players[p];
    for (const list of [st.deck, st.hand, st.trash, st.shield, st.special]) {
      const c = list.find((x) => x.uid === uid);
      if (c) return c;
    }
    for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) if (st.field[r][a]?.uid === uid) return st.field[r][a]!;
  }
  return null;
}

function ownerOf(gs: GameState, uid: string): PlayerIndex | null {
  for (const p of [0, 1] as PlayerIndex[]) {
    const st = gs.players[p];
    for (const list of [st.deck, st.hand, st.trash, st.shield, st.special]) if (list.some((x) => x.uid === uid)) return p;
    for (let r = 0; r < 2; r++) for (let a = 0; a < 3; a++) if (st.field[r][a]?.uid === uid) return p;
  }
  return null;
}
