// 结构化效果解析器：把卡面效果文本解析成可执行的“子句”（宣言/诱発/常时/コスト/切札）
// 供 effectEngine 执行。解析不到的复杂文本标记 parsed=false，由引擎转手动结算面板。
import type { Card } from './cards';
import { formatAbilityText } from './cards';

export type EffTarget =
  | 'self'
  | 'oneFriendly'
  | 'oneOpponent'
  | 'allFriendly'
  | 'afFriendly'
  | 'dfFriendly'
  | 'elementFriendly'
  | 'afElement'
  | 'chosen'
  | 'supported'
  | 'ownDeck'
  | 'oppDeck'
  | 'none';

/** 目标 → 中文显示名（选项标签用，避免显示英文 target） */
export function targetCn(t: EffTarget): string {
  return (
    {
      self: '自身',
      oneFriendly: '味方角色',
      oneOpponent: '对方角色',
      allFriendly: '味方全部',
      afFriendly: '味方AF角色',
      dfFriendly: '味方DF角色',
      elementFriendly: '味方同属性角色',
      afElement: '味方AF同属性角色',
      chosen: '指定角色',
      supported: '被支援角色',
      ownDeck: '己方牌堆',
      oppDeck: '对方牌堆',
      none: '',
    }[t] ?? t
  );
}

export type EffTrigger =
  | 'deploy'
  | 'turnStart'
  | 'oppTurnStart'
  | 'turnEnd'
  | 'down'
  | 'defenderLeaves'
  | 'dealtDamage'
  | 'supportUsed'
  | 'oppCharLeaves'
  | 'equip'
  | 'areaDeploy'
  | 'itemLeaves'
  | 'engageDiscard'
  | 'ownCardUsed'
  | 'ownDeclareDraw';

export interface EffAction {
  t:
    | 'stat'
    | 'draw'
    | 'search'
    | 'charge'
    | 'discardCharge'
    | 'untap'
    | 'dmgZero'
    | 'discardDeck'
    | 'healDeck'
    | 'discardHand'
    | 'shield'
    | 'exileTrashCopy'
    | 'discardChar'
    | 'loseAbility'
    | 'setDp0'
    | 'removeSelf'
    | 'exileSelf'
    | 'store'
    | 'storeUnder'
    | 'storeAll'
    | 'storeUnderArea'
    | 'reviveSelf'
    | 'moveSelfDF'
    | 'trashCopyToDeckBottom'
    | 'equipSelfToTarget'
    | 'selfToDeckBottom'
    | 'grantBonusIfNone'
    | 'forceDefend'
    | 'grantBonus'
    | 'discardHandOrUnder'
    | 'discardCharUpTo'
    | 'discardedToDeckBottom'
    | 'recoverDiscarded'
    | 'supportAsDp'
    | 'noop';
  target?: EffTarget;
  stat?: 'ap' | 'dp' | 'sp' | 'dmg';
  amount?: number;
  n?: number;
  names?: string[];
  kind?: 'deploy' | 'place' | 'hand' | 'charge' | 'equip' | 'useDeclare';
  altKind?: 'charge';
  element?: string;
  row?: 'AF' | 'DF';
  hasAbility?: string;
  costMax?: number;
  bonus?: 'discardDeck' | 'healDeck';
  countName?: string; // 数值 = 味方「X」的枚数（特殊置场同名エリア数）
  storageName?: string; // 置き場名（store/storeUnder 用）
  excludeAbility?: string; // 检索过滤：不含某基本能力
  anyChar?: boolean; // 检索：任意角色（不限卡名）
  exEq?: number; // 检索过滤：EX 值等于
  fromTrashOnly?: boolean; // 检索：只从ゴミ箱
  free?: boolean; // 检索登场是否无偿（無償で）
  cap?: number; // 置き場/エリア下方的上限枚数
  areaName?: string; // storeUnderArea：目标エリア名
  battleAttacker?: boolean; // 目标=对方攻击角色（战斗时点）
  cond?: 'under3' | 'storage4' | 'friendlyN2' | 'friendlyN4' | 'discardedNamed' | 'yushuAreaDestroy'; // 动作级条件（中段条件前缀）
  condParam?: string; // 动作级条件参数（如味方「X」的名称）
  shuffle?: boolean; // healDeck 是否洗牌（只有「回復しシャッフル」才洗牌；普通デッキ回復放卡组底不洗牌）
  random?: boolean; // healDeck 是否随机选卡（卡面写「ランダムに」→ 随机；否则由玩家从ゴミ箱选卡）
  label?: string;
}

export interface EffOption {
  id: string;
  label: string;
  actions: EffAction[];
  optional: boolean;
  parsed: boolean;
  cond?: 'under3' | 'oppDiscarded1' | 'oppDiscarded2' | 'oppHandDiscard' | 'af2WithT' | 'selfDp0' | 'storage4' | 'friendlyN4' | 'friendlyN2' | 'charge1'; // 选项条件
  condParam?: string; // 条件参数（如置き場/エリア名）
  partialRaw?: string; // 未能自动解析的剩余文本（执行已解析部分后提示手动）
}

export interface DeclaredClause {
  tag: '宣言' | '手札宣言';
  cost: string;
  trump: boolean; // [切札]
  perTurn: number; // 每回合使用次数上限（无特殊描述 = 1 次）
  timing: Timing; // 使用时点限制（卡面描述）
  options: EffOption[];
  raw: string;
  deckMax?: number; // 使用前提：自己的牌堆在 N 张以下（如「２０枚以下の自分のデッキ」）
}

/** 使用时点限制（由卡面「使用する」描述解析；无描述 = 随时可対応） */
export interface Timing {
  response: boolean; // 可否作为対応宣言（対応を除く/対応で使用できない → false）
  battle: 'any' | 'only' | 'no'; // バトル中のみ / バトル中を除く
  noDefender: boolean; // 仅限「防御キャラが指定されていないバトル中」
  turn: 'any' | 'self' | 'opponent'; // 自ターン中 / 相手ターン中
  notDeployTurn?: boolean; // 配置ターン中を除く（エリア宣言：配置回合不能使用）
}

export function parseTiming(text: string): Timing {
  const t: Timing = { response: true, battle: 'any', noDefender: false, turn: 'any' };
  if (/対応[^を]*を除く|対応で使用できない/.test(text)) t.response = false;
  if (/防御キャラが指定されていないバトル中/.test(text)) {
    t.noDefender = true;
    t.battle = 'only';
  } else if (/バトル中を除く/.test(text)) {
    t.battle = 'no';
  } else if (/バトル中に使用する/.test(text)) {
    t.battle = 'only';
  }
  if (/配置ターン中を除く|配置ターン中を除き/.test(text)) t.notDeployTurn = true;
  if (/相手ターン中に使用する/.test(text)) t.turn = 'opponent';
  else if (/自ターン中に使用する/.test(text)) t.turn = 'self';
  return t;
}

export interface TriggerClause {
  trigger: EffTrigger;
  condition: string; // 条件原文（空 = 无）
  options: EffOption[];
  perTurn: number; // 每回合处理次数上限
  raw: string;
  supportTargetOnly?: boolean; // 支援“被支援者”诱发：只有被支援的那张卡才触发（このキャラにサポートをしたとき）
}

export interface ContinuousMod {
  target: 'self' | 'allFriendly' | 'afFriendly' | 'dfFriendly' | 'elementFriendly' | 'afElement' | 'abilityAF';
  element?: string;
  hasAbility?: string;
  stats: { stat: 'ap' | 'dp' | 'sp' | 'dmg'; amount: number }[];
  condition: 'none' | 'charge1' | 'under4' | 'storage1';
  storageName?: string; // storage1 条件：某置き場至少 1 张
  grantAggressive: boolean;
  blockFirstTurnDamage: boolean;
  supportAnyRange?: boolean; // 常时：味方キャラ全て可支援非相邻角色（6962 相手ターン中）
  banZeroCostSupporter?: boolean; // 常时：不能宣言费用 0 点以下的[サポーター]（6962）
  raw: string;
}

export interface CostAbility {
  generate: string;
  tag: string; // '' | 'no_char' | 'equip_only' | 'surprise_char' | 'char3plus_or_supporter'
  lose: boolean;
  perTurn: number;
  underCost: number;
  noDeployTurn: boolean;
  raw: string;
}

export interface ParsedCard {
  declared: DeclaredClause[];
  triggers: TriggerClause[];
  continuous: ContinuousMod[];
  costAbilities: CostAbility[];
  trump: { raw: string; parsed: boolean } | null;
}

/** 全角数字转半角 */
export function toNum(s: string): number {
  const half = s.replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)));
  return parseInt(half, 10) || 0;
}

const STAT_MAP: Record<string, 'ap' | 'dp' | 'sp' | 'dmg'> = { ＡＰ: 'ap', ＤＰ: 'dp', ＳＰ: 'sp', ＤＭＧ: 'dmg' };
const STAT_LABEL: Record<string, string> = { ap: 'AP', dp: 'DP', sp: 'SP', dmg: 'DMG' };

/* ================= 目标短语识别 ================= */

interface TargetInfo {
  target: EffTarget;
  element?: string;
  row?: 'AF' | 'DF';
  hasAbility?: string;
  len: number;
}

const TARGET_PATTERNS: { re: RegExp; make: (m: RegExpExecArray) => Omit<TargetInfo, 'len'> }[] = [
  { re: /^このキャラ/, make: () => ({ target: 'self' }) },
  { re: /^\{このキャラ\}/, make: () => ({ target: 'self' }) },
  { re: /^ＡＦのこのキャラ/, make: () => ({ target: 'self', row: 'AF' }) },
  { re: /^味方ＡＦキャラ全て/, make: () => ({ target: 'afFriendly' }) },
  { re: /^味方ＤＦキャラ全て/, make: () => ({ target: 'dfFriendly' }) },
  { re: /^味方キャラ全て/, make: () => ({ target: 'allFriendly' }) },
  { re: /^味方ＡＦキャラ１体/, make: () => ({ target: 'oneFriendly', row: 'AF' }) },
  { re: /^味方ＤＦキャラ１体/, make: () => ({ target: 'oneFriendly', row: 'DF' }) },
  { re: /^味方キャラ１体/, make: () => ({ target: 'oneFriendly' }) },
  { re: /^相手キャラ１体/, make: () => ({ target: 'oneOpponent' }) },
  { re: /^味方防御キャラ１体/, make: () => ({ target: 'oneFriendly', row: 'DF' }) },
  { re: /^味方攻撃キャラ１体/, make: () => ({ target: 'oneFriendly', row: 'AF' }) },
  { re: /^\{味方防御キャラ１体\}/, make: () => ({ target: 'oneFriendly', row: 'DF' }) },
  { re: /^\{味方攻撃キャラ１体\}/, make: () => ({ target: 'oneFriendly', row: 'AF' }) },
  { re: /^味方\[(花|月|宙|雪|日)\]キャラ全て/, make: (m) => ({ target: 'elementFriendly', element: m[1] }) },
  { re: /^味方ＡＦ\[(花|月|宙|雪|日)\]キャラ全て/, make: (m) => ({ target: 'afElement', element: m[1] }) },
  { re: /^元の\[アグレッシブ\]を持つ味方ＡＦキャラ全て/, make: () => ({ target: 'afFriendly', hasAbility: 'アグレッシブ' }) },
  { re: /^味方\[(花|月|宙|雪|日)\]キャラ１体/, make: (m) => ({ target: 'oneFriendly', element: m[1] }) },
  { re: /^\{味方\[(花|月|宙|雪|日)\]キャラ１体\}/, make: (m) => ({ target: 'oneFriendly', element: m[1] }) },
  { re: /^\{\[サプライズ\]を持つ味方キャラ１体\}/, make: () => ({ target: 'oneFriendly', hasAbility: 'サプライズ' }) },
  { re: /^\{\[サプライズ\]を持つ相手キャラ１体\}/, make: () => ({ target: 'oneOpponent', hasAbility: 'サプライズ' }) },
  { re: /^\{味方キャラ１体\}/, make: () => ({ target: 'oneFriendly' }) },
  { re: /^\{相手キャラ１体\}/, make: () => ({ target: 'oneOpponent' }) },
  { re: /^\{味方「[^」]+」１体\}/, make: () => ({ target: 'oneFriendly' }) },
  { re: /^そのキャラ/, make: () => ({ target: 'chosen' }) },
  { re: /^対象のキャラ/, make: () => ({ target: 'supported' }) },
  { re: /^\{味方(?:[「『][^」』]+[」』])?キャラ１体\}/, make: () => ({ target: 'oneFriendly' }) },
  { re: /^味方(?:[「『][^」』]+[」』])キャラ全て/, make: () => ({ target: 'allFriendly' }) },
  { re: /^味方(?:[「『][^」』]+[」』])キャラ１体/, make: () => ({ target: 'oneFriendly' }) },
  { re: /^\{(?:[「『][^」』]+[」』])キャラ１体\}/, make: () => ({ target: 'oneFriendly' }) },
];

export function matchTarget(s: string): TargetInfo | null {
  for (const p of TARGET_PATTERNS) {
    p.re.lastIndex = 0;
    const m = p.re.exec(s);
    if (m) return { ...p.make(m), len: m[0].length };
  }
  return null;
}

/* ================= 动作列表解析 ================= */

const NOISE = [
  /対応・バトル中を除く自ターン中に使用する。/g,
  /対応・バトル中に使用できない。/g,
  /対応で使用できない。/g,
  /対応を除く防御キャラが指定されていないバトル中に使用する。/g,
  /対応を除く[^。]*中に使用する。/g,
  /このキャラが登場した自ターン中に使用する。/g,
  /バトル中を除く自ターン中に使用する。/g,
  /バトル中を除く相手ターン中に使用する。/g,
  /自ターン中に使用する。/g,
  /相手ターン中に使用する。/g,
  /バトル中を除く。/g,
  /相手はこの宣言に対応して宣言できない。/g,
  /このアイテムの持ち主は/g,
  /この宣言は対応で使用できない。/g,
  /（１ターンに[０-９]+回まで使用可能）/g,
  /（１ターンに[０-９]+回まで処理可能）/g,
  /（ゲーム中[０-９]*回まで(?:選択|使用)可能）/g,
  /（同番号のこの効果は１ターンに１回まで選択可能）/g,
  /この宣言はこのキャラが未行動でないと使用できない。/g,
  /このキャラのチャージが１枚以上の場合、/g,
  /バトル中を除く自ターン中の場合、/g,
  /相手ターン中の場合、/g,
  /バトル中を除く相手ターン中の場合、/g,
  /このエリアの配置ターン中を除く/g,
  /自分のデッキをシャッフルする。/g,
  /中央ＤＦに登場した場合、/g,
  /このキャラの登場ターン中の場合、/g,
  /または味方ＤＦキャラ１体と入れ替えることができる/g,
  /ことができる/g,
  /\(ゲーム中[０-９]*回まで(?:選択|使用)可能\)/g,
  /２０枚以下の/g,
  /構築制限[:：]?[^\n]*/g,
  /装備制限[:：]?[^\n]*/g,
  /※[^\n]*/g,
];

function stripNoise(s: string): string {
  let out = s;
  for (const re of NOISE) out = out.replace(re, '');
  return out;
}

/** 把一段效果文本解析成动作列表；返回剩余未解析文本 */
export function parseActionList(text: string, out: EffAction[]): string {
  let rest = stripNoise(normalizeOrText(text)).trim();
  // 中段条件（「…の場合、」出现在选项中间时）→ 附加到下一个动作
  let pendingCond: { cond: NonNullable<EffAction['cond']>; param?: string } | null = null;
  const emit = (a: EffAction) => {
    if (pendingCond) {
      a.cond = pendingCond.cond;
      a.condParam = pendingCond.param;
      pendingCond = null;
    }
    out.push(a);
  };
  let guard = 0;
  while (rest.length > 0 && guard++ < 40) {
    const before = rest;
    let matched = false;

    // 0) 中段条件前缀：其后的动作只在条件满足时执行
    {
      const cm =
        /^(?:その置き場の枚数が([０-９]+)枚以上の場合、|下のカードが([０-９]+)枚以上の場合、|味方「([^」]+)」が([０-９]+)枚以上の場合、|破棄したキャラが「([^」]+)」の場合、|元のＤＭＧが([０-９]+)以上の味方ＡＦキャラが([０-９]+)体以下、またはエリアの効果以外で登場した「玉樹桜」の能力で配置していない場合、)/.exec(rest);
      if (cm) {
        if (cm[1]) pendingCond = { cond: 'storage4' };
        else if (cm[2]) pendingCond = { cond: 'under3' };
        else if (cm[3] && cm[4]) pendingCond = { cond: toNum(cm[4]) >= 4 ? 'friendlyN4' : 'friendlyN2', param: cm[3] };
        else if (cm[5]) pendingCond = { cond: 'discardedNamed', param: cm[5] };
        else if (cm[6] && cm[7]) pendingCond = { cond: 'yushuAreaDestroy', param: `${toNum(cm[6])}:${toNum(cm[7])}` };
        rest = rest.slice(cm[0].length);
      }
    }

    // 1) 目标 + 数值修正（多段 ＡＰ＋２・ＤＰ＋２）
    {
      const t = matchTarget(rest);
      if (t) {
        const after = rest.slice(t.len);
        const statRe = new RegExp(
          `^に(ＡＰ|ＤＰ|ＳＰ|ＤＭＧ)([＋－])([０-９]+)((?:・(ＡＰ|ＤＰ|ＳＰ|ＤＭＧ)([＋－])([０-９]+))*)(?:する|できる)?`,
        );
        const m = statRe.exec(after);
        if (m) {
          const segs: { stat: string; sign: string; num: string }[] = [{ stat: m[1], sign: m[2], num: m[3] }];
          const more = m[4] ?? '';
          for (const sm of more.matchAll(/・(ＡＰ|ＤＰ|ＳＰ|ＤＭＧ)([＋－])([０-９]+)/g)) {
            segs.push({ stat: sm[1], sign: sm[2], num: sm[3] });
          }
          for (const s of segs) {
            emit({
              t: 'stat',
              target: t.target,
              element: t.element,
              row: t.row,
              hasAbility: t.hasAbility,
              stat: STAT_MAP[s.stat],
              amount: s.sign === '－' ? -toNum(s.num) : toNum(s.num),
              label: `${targetCn(t.target)} ${STAT_LABEL[STAT_MAP[s.stat]]}${s.sign === '－' ? '-' : '+'}${toNum(s.num)}`,
            });
          }
          rest = after.slice(m[0].length);
          matched = true;
        } else if (/^にＡＰ＋\[味方「([^」]+)」の枚数\]する/.test(after)) {
          const xm = /^にＡＰ＋\[味方「([^」]+)」の枚数\]する/.exec(after)!;
          emit({ t: 'stat', target: t.target, element: t.element, row: t.row, hasAbility: t.hasAbility, stat: 'ap', amount: 0, countName: xm[1], label: `味方「${xm[1]}」枚数 的 AP` });
          rest = after.slice(xm[0].length);
          matched = true;
        } else {
          const chargeAfter = /^に([０-９１-９])枚チャージ(?:する|できる)?/.exec(after);
          if (chargeAfter) {
            emit({ t: 'charge', n: toNum(chargeAfter[1]), label: `此角色充能 ${toNum(chargeAfter[1])}` });
            rest = after.slice(chargeAfter[0].length);
            matched = true;
          } else {
            const zeroRe = /^のＤＭＧを０にし未行動に(?:する|できる)/.exec(after);
            if (zeroRe) {
              emit({ t: 'dmgZero', target: t.target, element: t.element, row: t.row, hasAbility: t.hasAbility, label: `${targetCn(t.target)} DMG=0` });
              emit({ t: 'untap', target: t.target, element: t.element, row: t.row, hasAbility: t.hasAbility, label: `${targetCn(t.target)} 未行动` });
              rest = after.slice(zeroRe[0].length);
              matched = true;
            } else {
              const z3 = /^のＤＭＧを０にする/.exec(after);
              if (z3) {
                emit({ t: 'dmgZero', target: t.target, element: t.element, row: t.row, hasAbility: t.hasAbility, label: `${targetCn(t.target)} DMG=0` });
                rest = after.slice(z3[0].length);
                matched = true;
              }
            }
          }
        }
      }
    }

    // 1b) 多目标 DMG=0（事件等：コストが２点以下の味方[雪]キャラ２体まで / 味方キャラ２体まで）
    if (!matched) {
      const m = /^コストが([０-９]+)点以下の味方\[(花|月|宙|雪|日)\]キャラ([０-９]+)体までのＤＭＧを０にし未行動に(?:する|できる)/.exec(rest);
      if (m) {
        emit({ t: 'dmgZero', target: 'elementFriendly', element: m[2], costMax: toNum(m[1]), n: toNum(m[3]), label: `味方[${m[2]}]费用≤${toNum(m[1])} 最多 ${toNum(m[3])} 体 DMG=0+未行动` });
        rest = rest.slice(m[0].length);
        matched = true;
      } else {
        const m2 = /^味方キャラ([０-９]+)体までのＤＭＧを０にし未行動に(?:する|できる)/.exec(rest);
        if (m2) {
          emit({ t: 'dmgZero', target: 'oneFriendly', n: toNum(m2[1]), label: `味方角色最多 ${toNum(m2[1])} 体 DMG=0+未行动` });
          rest = rest.slice(m2[0].length);
          matched = true;
        }
      }
    }

    // 2) 未行动
    if (!matched) {
      const t = matchTarget(rest);
      if (t) {
        const after = rest.slice(t.len);
        const m = /^を未行動に(?:する|できる)/.exec(after);
        if (m) {
          emit({ t: 'untap', target: t.target, element: t.element, row: t.row, hasAbility: t.hasAbility, label: `${targetCn(t.target)} 未行动` });
          rest = after.slice(m[0].length);
          matched = true;
        }
      }
    }

    // 3) 抽牌
    if (!matched) {
      const m = /^([０-９１-９]?)枚ドロー(?:する|できる)?/.exec(rest);
      if (m) {
        emit({ t: 'draw', n: toNum(m[1] || '１') || 1, label: `抽 ${toNum(m[1] || '１') || 1} 张` });
        rest = rest.slice(m[0].length);
        matched = true;
      }
    }

    // 4) 检索
    if (!matched) {
      const m =
        /^(?:自分のゴミ箱またはデッキ|自分のゴミ箱\/デッキ)から(?:エリア)?「([^」]+)」(?:\/「([^」]+)」)?(?:１枚|１体)を探し(無償で)?(登場|配置|公開して手札に入れる|手札に入れる|味方キャラ１体に装備|このキャラにチャージとして置ける|そのキャラの手札宣言能力を使用する)(?:(?:またはこのキャラにチャージとして置ける)|\/チャージ)?(?:する|できる)?/.exec(rest);
      if (m) {
        const names = [m[1], m[2]].filter(Boolean);
        let kind: EffAction['kind'] = 'deploy';
        if (m[4] === '配置') kind = 'place';
        else if (m[4] === '公開して手札に入れる' || m[4] === '手札に入れる') kind = 'hand';
        else if (m[4] === '味方キャラ１体に装備') kind = 'equip';
        else if (m[4] === 'このキャラにチャージとして置ける') kind = 'charge';
        else if (m[4] === 'そのキャラの手札宣言能力を使用する') kind = 'useDeclare';
        emit({
          t: 'search',
          names,
          kind,
          altKind: /(?:またはこのキャラにチャージとして置ける)|\/チャージ/.test(m[0]) ? 'charge' : undefined,
          free: !!m[3], // 無償で 出现 → free
          label: `检索「${names.join('」或「')}」`,
        });
        rest = rest.slice(m[0].length);
        matched = true;
      }
    }

    // 4b) 检索：无卡名过滤（[X]を持たない『系列』キャラ）
    if (!matched) {
      const m =
        /^(?:自分のゴミ箱またはデッキ|自分のゴミ箱\/デッキ)から\[([^\]]+)\]を持たない『[^』]+』キャラ１体を探し公開して手札に入れる/.exec(rest);
      if (m) {
        emit({ t: 'search', kind: 'hand', anyChar: true, excludeAbility: m[1], label: `检索不含[${m[1]}]的角色加入手牌` });
        rest = rest.slice(m[0].length);
        matched = true;
      } else {
        const m2 = /^\{自分のゴミ箱のＥＸが２で\[サプライズ\]を持つキャラ１体\}を登場する/.exec(rest);
        if (m2) {
          emit({ t: 'search', kind: 'deploy', anyChar: true, hasAbility: 'サプライズ', exEq: 2, fromTrashOnly: true, label: 'ゴミ箱中 EX2+サプライズ 角色登场' });
          rest = rest.slice(m2[0].length);
          matched = true;
        }
      }
    }

    // 5) 充能 / 破弃充能
    if (!matched) {
      const m = /^このキャラに([０-９１-９])枚チャージ(?:する|できる)?/.exec(rest);
      if (m) {
        emit({ t: 'charge', n: toNum(m[1]), label: `此角色充能 ${toNum(m[1])}` });
        rest = rest.slice(m[0].length);
        matched = true;
      } else {
        const m2 = /^このキャラのチャージ([０-９１-９])枚を破棄(?:する|できる)?/.exec(rest);
        if (m2) {
          emit({ t: 'discardCharge', n: toNum(m2[1]), label: `破弃充能 ${toNum(m2[1])}` });
          rest = rest.slice(m2[0].length);
          matched = true;
        }
      }
    }

    // 6) 牌堆破弃 / 回复
    if (!matched) {
      const m = /^相手のデッキを([０-９１-９])枚(?:まで)?破棄(?:する|できる)?/.exec(rest);
      if (m) {
        emit({ t: 'discardDeck', target: 'oppDeck', n: toNum(m[1]), label: `对方牌堆破弃 ${toNum(m[1])}` });
        rest = rest.slice(m[0].length);
        matched = true;
      } else {
        const m2 = /^自分のデッキをランダムに([０-９１-９])枚まで回復(?:しシャッフルする|する|できる)?/.exec(rest);
        if (m2) {
          emit({ t: 'healDeck', target: 'ownDeck', n: toNum(m2[1]), random: true, shuffle: m2[0].includes('しシャッフル'), label: `己方牌堆回复 ${toNum(m2[1])}${m2[0].includes('しシャッフル') ? '并洗牌' : ''}` });
          rest = rest.slice(m2[0].length);
          matched = true;
        } else {
          const m3 = /^自分のデッキを([０-９１-９])枚(?:まで)?回復(?:する|できる)?/.exec(rest);
          if (m3) {
            emit({ t: 'healDeck', target: 'ownDeck', n: toNum(m3[1]), label: `己方牌堆回复 ${toNum(m3[1])}` });
            rest = rest.slice(m3[0].length);
            matched = true;
          } else {
            const m4 = /^相手は相手のデッキを([０-９１-９])枚まで回復(?:できる|しシャッフルできる)/.exec(rest);
            if (m4) {
              emit({ t: 'healDeck', target: 'oppDeck', n: toNum(m4[1]), random: m4[0].includes('ランダムに'), shuffle: m4[0].includes('しシャッフル'), label: `对方牌堆回复 ${toNum(m4[1])}${m4[0].includes('しシャッフル') ? '并洗牌' : ''}` });
              rest = rest.slice(m4[0].length);
              matched = true;
            } else {
              const m5 = /^相手は相手のデッキを([０-９１-９])枚まで回復しシャッフルできる/.exec(rest);
              if (m5) {
                emit({ t: 'healDeck', target: 'oppDeck', n: toNum(m5[1]), random: true, shuffle: true, label: `对方牌堆回复 ${toNum(m5[1])}并洗牌` });
                rest = rest.slice(m5[0].length);
                matched = true;
              }
            }
          }
        }
      }
    }

    // 6b) 置き場存放（ゴミ箱 1 张 → 具名置き場 / 此卡下方；N 是置き場上限，不是一次放 N 张）
    if (!matched) {
      const m = /^自分のゴミ箱のカード１枚をカードが([０-９]+)枚以下の自分の「([^」]+)」置き場に置(?:く|ける)(?:できる)?/.exec(rest);
      if (m) {
        emit({ t: 'store', storageName: m[2], n: 1, cap: toNum(m[1]), label: `ゴミ箱1张放入「${m[2]}」置き場` });
        rest = rest.slice(m[0].length);
        matched = true;
      } else {
        const m2 = /^自分のゴミ箱のカード１枚を下のカードが([０-９]+)枚以下のこのエリアの下に置(?:く|ける)(?:できる)?/.exec(rest);
        if (m2) {
          emit({ t: 'storeUnder', n: 1, cap: toNum(m2[1]), label: `ゴミ箱1张放入此エリア下方` });
          rest = rest.slice(m2[0].length);
          matched = true;
        } else {
          const m3 = /^自分のゴミ箱のカード１枚を(?:この|その)エリアの下に置ける/.exec(rest);
          if (m3) {
            emit({ t: 'storeUnder', n: 1, label: 'ゴミ箱1张放入此エリア下方' });
            rest = rest.slice(m3[0].length);
            matched = true;
          } else {
            const m4 = /^(?:この|その持ち主の)?ゴミ箱のカード１枚を(?:この|その)持ち主の「([^」]+)」１枚の下に置ける/.exec(rest);
            if (m4) {
              emit({ t: 'storeUnderArea', areaName: m4[1], n: 1, label: `ゴミ箱1张放入「${m4[1]}」エリア下方` });
              rest = rest.slice(m4[0].length);
              matched = true;
            }
          }
        }
      }
    }

    // 7) 护盾
    if (!matched) {
      const m = /^自分にシールド＋([０-９１-９])(?:する|できる)?/.exec(rest);
      if (m) {
        emit({ t: 'shield', n: toNum(m[1]), label: `护盾 +${toNum(m[1])}` });
        rest = rest.slice(m[0].length);
        matched = true;
      }
    }

    // 8) 手牌破弃 / 场上角色放入置き場 / 手牌或味方「X」下方合计破弃
    if (!matched) {
      const m = /^自分の手札を([０-９１-９])枚破棄(?:する|できる)/.exec(rest);
      if (m) {
        emit({ t: 'discardHand', n: toNum(m[1]), label: `破弃手牌 ${toNum(m[1])} 张` });
        rest = rest.slice(m[0].length);
        matched = true;
      } else {
        const m2 = /^味方「([^」]+)」全てを自分の「([^」]+)」置き場に置く/.exec(rest);
        if (m2) {
          emit({ t: 'storeAll', names: [m2[1]], storageName: m2[2], label: `味方「${m2[1]}」全部放入「${m2[2]}」置き場` });
          rest = rest.slice(m2[0].length);
          matched = true;
        } else {
          const m3 = /^自分の手札または味方「([^」]+)」の下のカードを合計([０-９]+)枚破棄(?:する|できる)/.exec(rest);
          if (m3) {
            emit({ t: 'discardHandOrUnder', n: toNum(m3[2]), names: [m3[1]], label: `手牌或「${m3[1]}」下方合计破弃 ${toNum(m3[2])} 张` });
            rest = rest.slice(m3[0].length);
            matched = true;
          }
        }
      }
    }

    // 9) 除外ゴミ箱同名卡 / 破弃对方角色（1 体 或 N 体まで）/ 此道具破弃 / 此エリア除外
    if (!matched) {
      const m = /^ゴミ箱のこのキャラを除外する/.exec(rest);
      if (m) {
        emit({ t: 'exileTrashCopy', label: '除外ゴミ箱中的此卡' });
        rest = rest.slice(m[0].length);
        matched = true;
      } else {
        const m2 = /^相手キャラ１体を破棄する/.exec(rest);
        if (m2) {
          emit({ t: 'discardChar', target: 'oneOpponent', label: '破弃对方角色 1 体' });
          rest = rest.slice(m2[0].length);
          matched = true;
        } else {
          const m2b = /^相手キャラ([０-９]+)体までを破棄(?:する|できる)/.exec(rest);
          if (m2b) {
            emit({ t: 'discardCharUpTo', n: toNum(m2b[1]), label: `破弃对方角色最多 ${toNum(m2b[1])} 体` });
            rest = rest.slice(m2b[0].length);
            matched = true;
          } else {
            const m3 = /^このアイテムを破棄する/.exec(rest);
            if (m3) {
              emit({ t: 'removeSelf', label: '此道具破弃' });
              rest = rest.slice(m3[0].length);
              matched = true;
            } else {
              const m3c = /^このエリアを破棄する/.exec(rest);
              if (m3c) {
                emit({ t: 'removeSelf', label: '此エリア破弃' });
                rest = rest.slice(m3c[0].length);
                matched = true;
              } else {
                const m4 = /^このエリアを除外する/.exec(rest);
                if (m4) {
                  emit({ t: 'exileSelf', label: '此エリア除外' });
                  rest = rest.slice(m4[0].length);
                  matched = true;
                }
              }
            }
          }
        }
      }
    }

    // 9b) 复活 / 移动DF / 回牌堆底 / ゴミ箱道具装备
    if (!matched) {
      const m = /^ゴミ箱のこのキャラを無償で(行動済みで)?登場する/.exec(rest);
      if (m) {
        emit({ t: 'reviveSelf', n: m[1] ? 1 : 0, label: `ゴミ箱中的此卡免费登场${m[1] ? '（行动済み）' : ''}` });
        rest = rest.slice(m[0].length);
        matched = true;
      } else {
        const m2 = /^このキャラを味方ＤＦに移動(?:できる)?/.exec(rest);
        if (m2) {
          emit({ t: 'moveSelfDF', label: '此角色移动到味方ＤＦ' });
          rest = rest.slice(m2[0].length);
          matched = true;
        } else {
          const m3 = /^ゴミ箱のこのキャラをデッキの下に置ける/.exec(rest);
          if (m3) {
            emit({ t: 'trashCopyToDeckBottom', label: 'ゴミ箱中的此卡放回牌堆底' });
            rest = rest.slice(m3[0].length);
            matched = true;
          } else {
            const m3b = /^ゴミ箱のそのキャラをデッキの下に置ける/.exec(rest);
            if (m3b) {
              emit({ t: 'discardedToDeckBottom', label: 'ゴミ箱中的被破弃角色放回牌堆底' });
              rest = rest.slice(m3b[0].length);
              matched = true;
            } else {
            const m4 = /^ゴミ箱のこのアイテムを\{味方キャラ１体\}に装備する/.exec(rest);
            if (m4) {
              emit({ t: 'equipSelfToTarget', target: 'oneFriendly', label: 'ゴミ箱中的此道具装备给味方角色' });
              rest = rest.slice(m4[0].length);
              matched = true;
            } else {
              const m5 = /^ゴミ箱のこのアイテムを\{相手攻撃キャラ１体\}に装備する/.exec(rest);
              if (m5) {
                emit({ t: 'equipSelfToTarget', target: 'oneOpponent', battleAttacker: true, label: 'ゴミ箱中的此道具装备给对方的攻击角色' });
                rest = rest.slice(m5[0].length);
                matched = true;
              }
            }
          }
        }
      }
    }
  }

    // 10) ＤＰ＝０
    if (!matched) {
      const t = matchTarget(rest);
      if (t) {
        const after = rest.slice(t.len);
        const m = /^のＤＰを０にする/.exec(after);
        if (m) {
          emit({ t: 'setDp0', target: t.target, element: t.element, row: t.row, hasAbility: t.hasAbility, label: `${targetCn(t.target)} DP=0` });
          rest = after.slice(m[0].length);
          matched = true;
        }
      }
    }

    // 11) 味方キャラ１体获得数值+ボーナス
    if (!matched) {
      const m = /^味方キャラ１体はＡＰ＋２・ＤＰ＋２・\[ボーナス:\[(相手のデッキを１枚破棄|自分のデッキを１枚回復)できる。\]\]を得る/.exec(rest);
      if (m) {
        emit({ t: 'stat', target: 'oneFriendly', stat: 'ap', amount: 2, label: '味方１体 AP+2' });
        emit({ t: 'stat', target: 'oneFriendly', stat: 'dp', amount: 2, label: '味方１体 DP+2' });
        emit({ t: 'grantBonus', target: 'oneFriendly', bonus: m[1].includes('破棄') ? 'discardDeck' : 'healDeck', label: '味方１体获得ボーナス' });
        rest = rest.slice(m[0].length);
        matched = true;
      }
    }

    // 12) 这个能力失去 / エンゲージ回復 / ボーナス / 强制防御 / 回牌堆底
    if (!matched) {
      const m = /^この(?:能力|効果)は失われる/.exec(rest);
      if (m) {
        emit({ t: 'loseAbility', label: '此能力失去' });
        rest = rest.slice(m[0].length);
        matched = true;
      } else {
        // 12a) エンゲージ：破弃キャラを回復（放回牌堆底，不洗牌）＋抽1
        const mEng = /^破棄キャラを回復し(?:１枚ドローする|１枚ドローできる)/.exec(rest);
        if (mEng) {
          emit({ t: 'recoverDiscarded', label: '被破弃角色回牌堆底' });
          emit({ t: 'draw', n: 1, label: '抽 1 张' });
          rest = rest.slice(mEng[0].length);
          matched = true;
        } else {
          const mEng2 = /^破棄キャラを回復する/.exec(rest);
          if (mEng2) {
            emit({ t: 'recoverDiscarded', label: '被破弃角色回牌堆底' });
            rest = rest.slice(mEng2[0].length);
            matched = true;
          } else {
            // 12b) 无ボーナス时获得ボーナス（6898 等）
            const m2 = /^\[ボーナス\]を持たないこのキャラは\[ボーナス:\[(相手のデッキを１枚破棄できる。?|自分のデッキを１枚回復できる。?)\]\]を得る/.exec(rest);
            if (m2) {
              emit({ t: 'grantBonusIfNone', target: 'self', bonus: m2[1].includes('破棄') ? 'discardDeck' : 'healDeck', label: '无ボーナス时获得ボーナス' });
              rest = rest.slice(m2[0].length);
              matched = true;
            } else {
              // 12c) 强制防御指定（6857）
              const m3 = /^相手キャラ１体を指定する。ターン終了時まで、次のその味方キャラの攻撃で相手は可能ならその相手キャラを防御キャラに指定する。その相手キャラは行動済みまたはＡＦでも防御できる。/.exec(rest);
              if (m3) {
                emit({ t: 'forceDefend', label: '指定对方角色强制防御' });
                rest = rest.slice(m3[0].length);
                matched = true;
              } else {
                // 12d) 自己回牌堆底（置き場≥4 条件）
                const m4 = /^このキャラをデッキの下に置く/.exec(rest);
                if (m4) {
                  emit({ t: 'selfToDeckBottom', label: '此角色放回牌堆底' });
                  rest = rest.slice(m4[0].length);
                  matched = true;
                }
              }
            }
          }
        }
      }
    }

    // 13) 结尾助词
    if (!matched) {
      const m = /^[。\s・]+/.exec(rest);
      if (m) {
        rest = rest.slice(m[0].length);
        matched = true;
      } else {
        // 13a) 支援值作为 DP（6962）
        const mDp = /^サポート能力値をＤＰにできる/.exec(rest);
        if (mDp) {
          emit({ t: 'supportAsDp', label: '支援值作为DP' });
          rest = rest.slice(mDp[0].length);
          matched = true;
        } else {
          const m2 = /^(?:する|できる|したとき、|置いたとき、|破棄したとき、|してから)/.exec(rest);
          if (m2) {
            rest = rest.slice(m2[0].length);
            matched = true;
          }
        }
      }
    }

    if (rest === before) break; // 无法继续解析
  }
  return rest;
}

/* ================= 选项拆分（または / しない場合 / ・列表） ================= */

/** 归一化固定短语，避免误拆 */
function normalizeOrText(text: string): string {
  return text
    .replace(/ゴミ箱またはデッキ/g, 'ゴミ箱/デッキ')
    .replace(/デッキまたはゴミ箱/g, 'ゴミ箱/デッキ')
    .replace(/「([^」]+)」または「/g, '「$1」/「')
    .replace(/登場またはこのキャラにチャージとして置ける/g, '登場/チャージ');
}

function splitOrGroups(text: string): string[] {
  const t = normalizeOrText(text);  // 目标内嵌的 ＡＰ＋ＮまたはＤＰ＋Ｎ：拆成两份（共享目标前缀）
  const inline = /^([^、。]{0,80}?に)ＡＰ([＋－])([０-９]+)またはＤＰ([＋－])([０-９]+)(する|できる)?([。]?)([\s\S]*)$/.exec(t);
  if (inline) {
    const pre = inline[1];
    const tail = inline[7] + inline[8];
    const end = inline[6] ?? '';
    return [`${pre}ＡＰ${inline[2]}${inline[3]}${end}${tail}`, `${pre}ＤＰ${inline[4]}${inline[5]}${end}${tail}`];
  }
  // 复合来源/复合修饰：「自分の手札または味方「X」の下のカード」「行動済みまたはＡＦでも防御できる」共享同一动词 → 不是选项分支
  if (/または(?:味方「[^」]+」の下のカード|ＡＦでも|エリアの効果以外で)/.test(t)) return [t];
  if (!t.includes('または')) return [t];
  const first = t.indexOf('または');
  // 强制前缀：第一个または之前、最后一个"。"之前的内容（无条件部分）
  const dotBefore = t.lastIndexOf('。', first);
  const mandatory = dotBefore >= 0 ? t.slice(0, dotBefore + 1) : '';
  const restText = t.slice(dotBefore + 1);
  const parts = restText.split('または');
  // 后续片段若缺目标，继承第一段的目标前缀
  const prefixM = /^(\{[^}]*\}?|このキャラ|味方[^に]*|相手キャラ１体|そのキャラ|対象のキャラ)に/.exec(parts[0]);
  const prefix = prefixM ? prefixM[0] : '';
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i].trim();
    if (i > 0 && prefix && !matchTarget(p)) p = prefix + p;
    out.push(mandatory + p);
  }
  return out;
}

/** 选项条件前缀模式（整体剥离后应用到所有选项） */
const COND_PATTERNS: { re: RegExp; cond: NonNullable<EffOption['cond']>; paramIdx?: number }[] = [
  { re: /^このエリアの下のカードが３枚以上の場合、/, cond: 'under3' },
  { re: /^下のカードが３枚以上の場合、/, cond: 'under3' },
  { re: /^このターン中相手の効果で味方キャラが場を離れている場合、/, cond: 'oppDiscarded1' },
  { re: /^このターン中相手の効果で味方キャラが２体以上場を離れている場合、/, cond: 'oppDiscarded2' },
  { re: /^このターン中、相手の効果で自分の手札をゴミ箱またはデッキに置いている場合、/, cond: 'oppHandDiscard' },
  { re: /^使用代償に\[T\]を含む元の能力を持つ味方ＡＦキャラが２体以上の場合、/, cond: 'af2WithT' },
  { re: /^ＤＰが０の/, cond: 'selfDp0' },
  { re: /^その置き場の枚数が４枚以上の場合、/, cond: 'storage4' },
  { re: /^味方「([^」]+)」が４枚以上の場合、/, cond: 'friendlyN4', paramIdx: 1 },
  { re: /^味方「([^」]+)」が２枚以上の場合、/, cond: 'friendlyN2', paramIdx: 1 },
];

/** 把一个效果文本段拆成选项（含 しない場合 分支 与 ・列表） */
export function buildOptions(text0: string): EffOption[] {
  const opts: EffOption[] = [];
  // 整段条件前缀：剥离并应用到所有选项（先去掉纯时序/限制噪声）
  let text = stripNoise(text0).trim();
  let globalCond: EffOption['cond'];
  let condParam: string | undefined;
  for (const cp of COND_PATTERNS) {
    cp.re.lastIndex = 0;
    const m = cp.re.exec(text);
    if (m) {
      globalCond = cp.cond;
      condParam = cp.paramIdx !== undefined ? m[cp.paramIdx] : undefined;
      text = text.slice(m[0].length);
      break;
    }
  }
  const push = (raw0: string, extra?: { labelPrefix?: string; optional?: boolean; cond?: EffOption['cond'] }) => {
    const raw = raw0;
    const actions: EffAction[] = [];
    const leftover = parseActionList(raw, actions);
    const cleanLeft = stripNoise(leftover).replace(/[。\s・]/g, '').replace(/^(する|できる)/, '');
    let label = actions.map((a) => a.label ?? '').filter(Boolean).join('、') || raw.slice(0, 24);
    if (extra?.labelPrefix) label = `${extra.labelPrefix}：${label}`;
    const opt: EffOption = {
      id: `o${opts.length}`,
      label: label || '（无效果）',
      actions,
      optional: extra?.optional !== undefined ? extra.optional : /できる|置ける/.test(raw),
      parsed: cleanLeft.length === 0,
      cond: extra?.cond !== undefined ? extra.cond : globalCond,
      condParam,
    };
    if (cleanLeft.length > 0) opt.partialRaw = stripNoise(leftover).trim();
    opts.push(opt);
  };

  // ・列表（以下から１つを選び処理する）
  if (text.includes('以下から１つを選び処理する')) {
    const bullets = text.split('・').map((s) => s.trim()).filter(Boolean);
    for (const b of bullets) {
      const noPreamble = b.replace(/^以下から１つを選び処理する。?/, '').trim();
      if (noPreamble && stripNoise(noPreamble).trim()) push(noPreamble, { optional: true });
    }
    return opts;
  }

  // しない場合 分支
  const fallbackIdx = text.indexOf('しない場合、');
  if (fallbackIdx > 0) {
    let primary = text.slice(0, fallbackIdx).trim();
    const priParts = splitTrailingCharge(primary);
    primary = priParts[0].replace(/(?:できる|することが|こと|する)。?$/, '').trim();
    const fbParts = splitTrailingCharge(text.slice(fallbackIdx + 'しない場合、'.length).trim());
    let fallback = fbParts[0];
    // 「そのキャラ」指代主选项的目标（Bug 15：继承主选项的目标前缀，避免打到己方）
    const targetM = /^(\{[^}]*\}|相手キャラ１体|味方キャラ１体|味方(?:ＡＦ|ＤＦ)キャラ１体)に/.exec(primary);
    if (targetM) fallback = fallback.replace(/そのキャラ/g, targetM[1]);
    // 不做分支自身的中段条件（Bug ②：6893「しない場合、このキャラのチャージが１枚以上の場合、…」）
    // 注意：stripNoise 会把「このキャラのチャージが１枚以上の場合、」当噪声删掉，须基于原始 text0 判断
    let fbCond: EffOption['cond'];
    const rawFallback = text0.slice(text0.indexOf('しない場合、') + 'しない場合、'.length);
    if (/^このキャラのチャージが[０-９１-９]+枚以上の場合、/.test(rawFallback)) {
      fbCond = 'charge1';
      const fbCondM = /^このキャラのチャージが[０-９１-９]+枚以上の場合、/.exec(fallback);
      if (fbCondM) fallback = fallback.slice(fbCondM[0].length);
    }
    const priGroups = splitOrGroups(primary);
    for (const g of priGroups) push(g, { optional: /できる/.test(text.slice(0, fallbackIdx)) });
    push(fallback, { labelPrefix: '不做上述时', cond: fbCond });
    for (const t of [...priParts.slice(1), ...fbParts.slice(1)]) push(t, { optional: true });
    return opts;
  }

  const groups = splitOrGroups(text).flatMap(splitTrailingCharge);
  for (const g of groups) push(g);
  return opts;
}

/** 拆出追加句「…できる/する。{条件}？このキャラにN枚チャージできる」（6851/6860/6887 家族）→ 独立选项 */
function splitTrailingCharge(text: string): string[] {
  // 先定位末尾的充能句，再从它前面最近的「できる。/する。」处切开
  const chargeRe = /((?:バトル中を除く)?(?:自ターン中|相手ターン中)の場合、)?このキャラに[０-９１-９]+枚チャージ(?:できる|する)。?$/;
  const m = chargeRe.exec(text);
  if (!m) return [text];
  const pre = text.slice(0, m.index);
  const cutMatch = /(できる|する)。((?:バトル中を除く)?(?:自ターン中|相手ターン中)の場合、)?$/.exec(pre);
  if (!cutMatch) return [text];
  const cut = cutMatch.index + cutMatch[0].length;
  return [text.slice(0, cut), text.slice(cut)];
}

/* ================= 主解析 ================= */

const DECL_RE = /\[(宣言|手札宣言)\](\[切札\])?\s*\[([^\]]+)\]\s*:([\s\S]*?)(?=\[(?:宣言|手札宣言|誘発|常時|コスト|自動|起動|切札|構築制限)|\n*構築制限|\n*※|$)/g;

function parseDeclaredBlocks(a: string): DeclaredClause[] {
  const out: DeclaredClause[] = [];
  for (const m of a.matchAll(DECL_RE)) {
    const tag = m[1] as '宣言' | '手札宣言';
    const trump = !!m[2];
    const cost = m[3];
    const eff = m[4] ?? '';
    // 每回合使用次数：无特殊描述 = 1 次
    const perTurnM = /（１ターンに([０-９]+)回まで使用可能）/.exec(eff);
    const perTurn = perTurnM ? toNum(perTurnM[1]) : 1;
    // 「Ｎ枚以下の自分のデッキ」使用前提（如 6958/6961/6962/6963 的切札：２０枚以下 → deckMax=20）
    const deckMaxM = /^([０-９]+)枚以下の自分のデッキ/.exec(eff);
    const deckMax = deckMaxM ? toNum(deckMaxM[1]) : undefined;
    out.push({ tag, cost, trump, perTurn, timing: parseTiming(eff), options: buildOptions(eff), raw: eff.trim(), deckMax });
  }
  return out;
}

const TRIGGER_PATTERNS: { re: RegExp; kind: EffTrigger; dual?: EffTrigger; supportTargetOnly?: boolean }[] = [
  { re: /このキャラが登場したときまたはターン開始時/, kind: 'deploy', dual: 'turnStart' },
  { re: /自ターン開始時またはこのキャラが登場したとき/, kind: 'turnStart', dual: 'deploy' },
  { re: /(?:相手の先攻１ターン目以外に)?このキャラが(?:手札から|ＤＦに|ＡＦに)?登場したとき/, kind: 'deploy' },
  { re: /このキャラが効果以外で登場したとき/, kind: 'deploy' },
  { re: /このアイテムを装備したとき/, kind: 'equip' },
  { re: /このアイテムが場を離れたとき/, kind: 'itemLeaves' },
  { re: /このエリアを配置したとき/, kind: 'areaDeploy' },
  // 相手ターン開始時 必须在 自?ターン開始時 之前（否则被吞成自己回合，Bug 6）
  { re: /相手ターン開始時/, kind: 'oppTurnStart' },
  { re: /自?ターン開始時/, kind: 'turnStart' },
  { re: /自ターン終了時/, kind: 'turnEnd' },
  { re: /このキャラがダウンしたとき/, kind: 'down' },
  { re: /相手防御キャラが場を離れたとき/, kind: 'defenderLeaves' },
  { re: /(?:このターン中、)?サポートをされた味方ＡＦキャラがダメージを与えたとき/, kind: 'dealtDamage' },
  // 支援相关：被支援者型（このキャラに…したとき）只允许“被支援的那张卡”触发（Bug：支援 6907 时场上 6910 不得触发）
  { re: /(?:自ターン中、)?このキャラにサポート(?:を|の宣言を)?したとき/, kind: 'supportUsed', supportTargetOnly: true },
  { re: /(?:自ターン中、)?味方キャラでサポート(?:を|の宣言を)したとき/, kind: 'supportUsed' },
  { re: /(?:自ターン中、)?このキャラでサポート(?:を|の宣言を)したとき/, kind: 'supportUsed' },
  { re: /味方キャラが相手の効果で場を離れたとき/, kind: 'oppCharLeaves' },
  { re: /味方エリアの効果で味方キャラが場を離れたとき/, kind: 'oppCharLeaves' },
  { re: /このキャラのエンゲージ登場で(?:元のＤＭＧが[０-９]+以上のキャラ|[^を]+)を破棄した場合/, kind: 'engageDiscard' },
  { re: /持ち主が自分のアイテム・エリア・\[サプライズ\]を持つコストが[０-９]+点以上のキャラを[０-９]+点以上のコストを支払って使用したとき/, kind: 'ownCardUsed' },
  { re: /自分のコストが[０-９]+点以上のアイテム・手札宣言能力を使用したとき、または相手バトル参加キャラが場を離れたとき、または味方「([^」]+)」が場を離れたとき/, kind: 'ownCardUsed' },
  { re: /このターン中に使用した持ち主が自分のアイテム・手札宣言能力でドローしたとき/, kind: 'ownDeclareDraw' },
];

function parseTriggerSentence(sentence: string, blockTag: string): TriggerClause[] {
  const out: TriggerClause[] = [];
  const perTurnM = /（１ターンに([０-９]+)回まで処理可能）/.exec(sentence);
  const perTurn = perTurnM ? toNum(perTurnM[1]) : 1; // 无特殊描述 = 1 次
  for (const p of TRIGGER_PATTERNS) {
    p.re.lastIndex = 0;
    const m = p.re.exec(sentence);
    if (!m) continue;
    const condPrefix = sentence.slice(0, m.index).replace(/^\[誘発\]\s*/, '').trim();
    let eff = sentence.slice(m.index + m[0].length).replace(/^、/, '').trim();
    let cond = '';
    // 条件短语（相手の先攻１ターン目以外 / 手札から / ＤＦに 等）
    if (/相手の先攻１ターン目以外に/.test(m[0])) cond = 'notTurn1';
    if (/手札から登場/.test(m[0])) cond = 'fromHand';
    if (/ＤＦに登場/.test(m[0])) cond = 'toDF';
    if (/ＡＦに登場/.test(m[0])) cond = 'toAF';
    // 「自ターン中」的诱発只在己方回合处理（如 6962 支援值作为 DP）
    if (/自ターン中、/.test(m[0])) cond = [cond, 'ownTurn'].filter(Boolean).join(' ');
    // 「相手ターン中」的诱発只在对方回合处理
    if (/相手ターン中、/.test(m[0])) cond = [cond, 'oppTurn'].filter(Boolean).join(' ');
    // エンゲージ登场：记录被破弃角色的原 DMG 条件
    if (p.kind === 'engageDiscard') {
      const dm = /元のＤＭＧが([０-９]+)以上/.exec(m[0]);
      cond = dm ? `engageDmg:${toNum(dm[1])}` : 'engageAny';
    }
    // 使用了自己的卡（6961/6963）：记录条件
    if (p.kind === 'ownCardUsed') {
      const m6961 = /コストが([０-９]+)点以上のキャラを([０-９]+)点以上のコストを支払って/.exec(m[0]);
      cond = m6961 ? `ownUsed:${toNum(m6961[1])}:${toNum(m6961[2])}` : `ownUsedMulti:${(m[1] ?? '').replace(/\s/g, '')}`;
    }
    if (p.kind === 'ownDeclareDraw') cond = 'ownDeclareDraw';
    // 效果文本内的前置条件
    const condM = /^味方キャラ全てのコストが２点以下でこのエリアの下のカードが３枚以上の場合、/.exec(eff);
    if (condM) {
      cond = [cond, 'allCost2Under3'].filter(Boolean).join(' ');
      eff = eff.slice(condM[0].length);
    }
    const clause = (kind: EffTrigger, condStr: string) => {
      const rawCond = [condPrefix, condStr].filter(Boolean).join(' ');
      const tc: TriggerClause = { trigger: kind, condition: rawCond, options: buildOptions(eff), perTurn, raw: sentence };
      if (p.supportTargetOnly) tc.supportTargetOnly = true;
      out.push(tc);
    };
    clause(p.kind, cond);
    if (p.dual) clause(p.dual, cond);
    return out;
  }
  return out;
}

function parseTriggers(a: string): TriggerClause[] {
  const out: TriggerClause[] = [];
  const blockRe = /\[誘発\]\s*([\s\S]*?)(?=\[(?:宣言|手札宣言|誘発|常時|コスト|自動|起動|切札|構築制限)|\n*構築制限|\n*※|$)/g;
  for (const bm of a.matchAll(blockRe)) {
    const body = (bm[1] ?? '').trim();
    if (!body) continue;
    // ・列表：句首前为触发，后面是选项（・只跟在 。 或换行后才是列表）
    if (body.includes('・') && (body.includes('以下から１つを選び処理する') || /(?:。|\n)\s*・/.test(body))) {
      const parts = body.split(/[。\n]\s*・/);
      const head = (parts[0] ?? '').trim();
      const sentences = head.split('。').map((s) => s.trim()).filter(Boolean);
      const last = sentences.length ? sentences[sentences.length - 1] : '';
      const trigClauses = parseTriggerSentence(last, '');
      const bullets = parts.slice(1).map((b) => b.trim().replace(/。$/, '')).filter(Boolean);
      if (trigClauses.length > 0) {
        const perTurnM = /（１ターンに([０-９]+)回まで処理可能）/.exec(body);
        const perTurn = perTurnM ? toNum(perTurnM[1]) : 1; // 无特殊描述 = 1 次
        for (const tc of trigClauses) {
          const opts: EffOption[] = [];
          for (const b of bullets) {
            const actions: EffAction[] = [];
            const leftover = parseActionList(b, actions);
            const cleanLeft = stripNoise(leftover).replace(/[。\s・]/g, '').replace(/^(する|できる)/, '');
            const o: EffOption = {
              id: `o${opts.length}`,
              label: actions.map((x) => x.label ?? '').filter(Boolean).join('、') || b.slice(0, 24),
              actions,
              optional: true,
              parsed: cleanLeft.length === 0,
            };
            if (cleanLeft.length > 0) o.partialRaw = stripNoise(leftover).trim();
            opts.push(o);
          }
          out.push({ trigger: tc.trigger, condition: tc.condition, options: opts, perTurn, raw: body, ...(tc.supportTargetOnly ? { supportTargetOnly: true } : {}) });
        }
        continue;
      }
    }
    // 普通句子：触发句 + 后续的“したとき/置いたとき…”续接句并入同一效果
    const sentences = body.split('。').map((s) => s.trim()).filter(Boolean);
    const groups: string[][] = [];
    for (const s of sentences) {
      const hasTrig = TRIGGER_PATTERNS.some((p) => {
        p.re.lastIndex = 0;
        return p.re.test(s);
      });
      if (hasTrig || groups.length === 0) groups.push([s]);
      else groups[groups.length - 1].push(s);
    }
    for (const g of groups) {
      const joined = g.join('。') + '。';
      const clauses = parseTriggerSentence(joined, '');
      if (clauses.length > 0) out.push(...clauses);
    }
  }
  return out;
}

/* ================= 常时解析 ================= */

function parseContinuous(a: string): ContinuousMod[] {
  const out: ContinuousMod[] = [];
  const blockRe = /\[常時\]\s*([\s\S]*?)(?=\[(?:宣言|手札宣言|誘発|常時|コスト|自動|起動|切札|構築制限|装備制限)|\n*構築制限|\n*装備制限|\n*※|$)/g;
  for (const bm of a.matchAll(blockRe)) {
    const body = (bm[1] ?? '').trim();
    if (!body) continue;
    // 按条件前缀分段（无条件 / 充能≥1 / 置场≥N / 置き場≥1）
    const markerRe = /(このキャラのチャージが１枚以上の場合、|このエリアの下のカードが([０-９]+)枚以上の場合、|自分の「([^」]+)」置き場のカードが１枚以上の場合、)/g;
    const markers = [...body.matchAll(markerRe)];
    const segs: { cond: ContinuousMod['condition']; storageName?: string; text: string }[] = [];
    let last = 0;
    let cur: ContinuousMod['condition'] = 'none';
    let curName: string | undefined;
    for (const m of markers) {
      segs.push({ cond: cur, storageName: curName, text: body.slice(last, m.index) });
      if (m[1].includes('チャージ')) cur = 'charge1';
      else if (m[1].includes('エリアの下')) cur = 'under4';
      else {
        cur = 'storage1';
        curName = m[3];
      }
      last = m.index + m[0].length;
    }
    segs.push({ cond: cur, storageName: curName, text: body.slice(last) });
    for (const seg of segs) {
      if (!seg.text.trim()) continue;
      const acts: EffAction[] = [];
      parseActionList(seg.text, acts);
      for (const act of acts) {
        if (act.t !== 'stat' || act.stat === undefined || act.amount === undefined) continue;
        const map: Partial<Record<EffTarget, ContinuousMod['target']>> = {
          self: 'self',
          allFriendly: 'allFriendly',
          afFriendly: 'afFriendly',
          dfFriendly: 'dfFriendly',
          elementFriendly: 'elementFriendly',
          afElement: 'afElement',
        };
        const target = map[act.target ?? 'none'];
        if (!target) continue;
        if (target === 'afFriendly' && act.hasAbility) {
          out.push({ target: 'abilityAF', hasAbility: act.hasAbility, stats: [{ stat: act.stat, amount: act.amount }], condition: seg.cond, storageName: seg.storageName, grantAggressive: false, blockFirstTurnDamage: false, raw: bm[0] });
        } else {
          out.push({ target, element: act.element, hasAbility: act.hasAbility, stats: [{ stat: act.stat, amount: act.amount }], condition: seg.cond, storageName: seg.storageName, grantAggressive: false, blockFirstTurnDamage: false, raw: bm[0] });
        }
      }
    }
    // アグレッシブ 授予
    const aggRe = /元のＤＭＧまたはＳＰが２以上の味方キャラ全ては\[アグレッシブ\]を得る/.exec(body);
    if (aggRe) {
      out.push({ target: 'allFriendly', stats: [], condition: 'none', grantAggressive: true, blockFirstTurnDamage: false, raw: bm[0] });
    }
    // 登场回合伤害限制
    const blockRe2 = /登場ターン中の味方キャラ全てはダメージを与えられない/.exec(body);
    if (blockRe2) {
      out.push({ target: 'allFriendly', stats: [], condition: 'none', grantAggressive: false, blockFirstTurnDamage: true, raw: bm[0] });
    }
    // 常时：对方回合中味方角色可支援非相邻角色（6962）
    const anyRangeRe = /相手ターン中、味方キャラ全てはそのキャラに隣接していないキャラにもサポートを使用できる/.exec(body);
    if (anyRangeRe) {
      out.push({ target: 'allFriendly', stats: [], condition: 'none', grantAggressive: false, blockFirstTurnDamage: false, supportAnyRange: true, raw: bm[0] });
    }
    // 常时：不能宣言费用 0 点以下的[サポーター]（6962）
    const ban0Re = /自分のコストが０点以下の\[サポーター\]の使用を宣言できない/.exec(body);
    if (ban0Re) {
      out.push({ target: 'self', stats: [], condition: 'none', grantAggressive: false, blockFirstTurnDamage: false, banZeroCostSupporter: true, raw: bm[0] });
    }
  }
  return out;
}

function parseCostAbilities(a: string): CostAbility[] {
  const out: CostAbility[] = [];
  const blockRe = /\[コスト\]\s*([\s\S]*?)(?=\[(?:宣言|手札宣言|誘発|常時|コスト|自動|起動|切札|構築制限)|\n*構築制限|\n*※|$)/g;
  for (const bm of a.matchAll(blockRe)) {
    const body = (bm[1] ?? '').trim();
    const genM = /\[(花|月|宙|雪|日|無)(花|月|宙|雪|日|無)?\]を発生する/.exec(body);
    if (!genM) continue;
    let tag = '';
    if (/キャラの登場には支払えない/.test(body)) tag = 'no_char';
    else if (/アイテムの装備にのみ支払える/.test(body)) tag = 'equip_only';
    else if (/\[サプライズ\]を持つキャラの登場にのみ支払える/.test(body)) tag = 'surprise_char';
    else if (/コストが３点以上のキャラまたは\[サポーター\]にのみ支払える/.test(body)) tag = 'char3plus_or_supporter';
    const perTurnM = /（１ターンに([０-９]+)回まで使用可能）/.exec(body);
    const underM = /このエリアの下のカード([０-９]+)枚を破棄する/.exec(body);
    out.push({
      generate: genM[1] + (genM[2] ?? ''),
      tag,
      lose: /この能力は失われる/.test(body),
      perTurn: perTurnM ? toNum(perTurnM[1]) : 1,
      underCost: underM ? toNum(underM[1]) : 0,
      noDeployTurn: /このエリアの配置ターンを除く自ターン中に使用する/.test(body),
      raw: bm[0],
    });
  }
  return out;
}

/** 解析一张卡的全部效果结构 */
export function parseCard(card: Card): ParsedCard {
  const a = formatAbilityText(card.ability || '');
  const out: ParsedCard = {
    declared: parseDeclaredBlocks(a),
    triggers: parseTriggers(a),
    continuous: parseContinuous(a),
    costAbilities: parseCostAbilities(a),
    trump: null,
  };
  if (a.includes('[切札]')) {
    out.trump = {
      raw: '２０枚以下の自分のデッキをランダムに６枚まで回復しシャッフルする。',
      parsed: /２０枚以下の自分のデッキをランダムに６枚まで回復しシャッフルする/.test(a),
    };
  }
  return out;
}

/** 解析缓存的辅助：卡是否有 [コスト] 能力 */
export function hasCostAbility(card: Card): boolean {
  return formatAbilityText(card.ability || '').includes('[コスト]');
}

export { STAT_LABEL };
