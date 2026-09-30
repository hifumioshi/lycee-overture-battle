// 游戏核心数据模型：区域、卡牌实例、移动/操作（纯逻辑，不依赖 DOM）
import type { Card } from './cards';

export type PlayerIndex = 0 | 1;
export type RowName = 'AF' | 'DF'; // AF=前列(攻击区) DF=后列(防御区)
export type AreaIndex = 0 | 1 | 2; // 左 中 右
export type ZoneName = 'deck' | 'hand' | 'field' | 'trash' | 'shield' | 'special' | 'removed' | 'area' | 'equip';

/** 卡牌实例（场上的实体卡，可与牌组数据分离） */
export interface CardInstance {
  uid: string; // 实例唯一 id
  cardId: string; // 对应 Card.id
  faceUp: boolean; // 是否面朝上
  tapped: boolean; // 行动済み（横向）
  deployedTurn: number | null; // 登场时的回合数（用于登场ターン制限）
  equip: CardInstance | null; // 装备的道具实例（角色卡专用）
  tempMods: { ap: number; dp: number; sp: number; dmg: number }; // 宣言/效果产生的临时数值修正（回合结束清除）
  tempSet: { ap?: number; dp?: number; sp?: number; dmg?: number }; // 效果将数值“设为”指定值（回合结束清除）
  charge: CardInstance[]; // 充能（此角色下方的卡，用于支付 [C#] 费用）
  under: CardInstance[]; // 置场（エリア/角色下方的卡，用于效果计数）
  lost: string[]; // 已失去的能力标记（如 'コスト'、'切札'、'効果'）
  supports: { attackerUid: string; battleTurn: number } | null; // 本回合支援过的攻击者（用于支援诱発）
  tempBonus: 'discardDeck' | 'healDeck' | null; // 临时获得的ボーナス（回合结束清除）
  tempForceDefend: { targetUid: string; turn: number } | null; // 强制防御指定（6857，回合结束清除）
  pendingEngage: { discardedUid: string } | null; // エンゲージ登场：待处理的被破弃角色（登场链完成后结算）
  placedByYushu?: boolean; // 此エリア是否由「玉樹桜」的能力配置（6958 自毁条件）
  pendingResumeChain?: PendingEffect | null; // 登场诱发链完成后恢复的外层效果链（检索登场等）
}

/** 效果结算链（effect-choice / declare-target / search-deploy 提示携带） */
export interface PendingEffect {
  sourceUid: string; // 触发效果的卡实例
  owner: PlayerIndex; // 效果归属玩家
  declIdx: number; // declared 子句下标（-1 = 不是宣言）
  trigIdx: number; // trigger 子句下标（-1 = 不是诱発）
  tag?: '宣言' | '手札宣言'; // 宣言类别（clause 选择流程用）
  optionId: string; // 已选择的选项 id
  optionLabel: string;
  trigger: string | null; // 诱発类别（deploy/turnStart/oppTurnStart/turnEnd/defenderLeaves/dealtDamage/supportUsed）
  stage: number; // 下一个要执行的动作下标
  targetUid: string | null; // 已选目标
  forceTarget: string | null; // 强制防御指定目标（6857）
  extraUids: string[]; // 额外选择（手牌破弃等；动作消费后清空）
  searchDone: boolean;
  paidCost: boolean;
  scanAll?: boolean; // 触发来自全卡扫描（turnStart 等多触发时恢复链要保持全局扫描）
  scanTrigger?: string; // __triggerPick：记录原触发类别（供选择顺序后继续扫描）
  placedAny?: boolean; // 最近一次 store/storeUnder 是否实际放置了卡（置いたとき才抽）
  equipPaid?: boolean; // 效果装备的费用已支付（装备支付后恢复链跳过重复付费）
  equippedUid?: string | null; // 刚被效果装备的道具 uid（装備したとき诱発用）
  searchEquip?: { itemUid: string; free: boolean } | null; // 检索装备：待装备的道具（6887）
  placedAreaUid?: string | null; // 本选项内检索配置的エリア uid（后续 storeUnder「そのエリア」指向它，6960）
  underPicked?: number; // discardHandOrUnder 已选的张数（discardCharUpTo 的触发门槛用）
  skipCurrent?: boolean; // 取消选卡等：跳过当前动作继续后续（Bug：6848 二段选 5 张取消无效）
  resumePending?: PendingEffect | null; // 嵌套效果链完成后恢复的外层链（如 6862 检索用手札宣言）
}

/** 战斗状态 */
export interface BattleState {
  attackerUid: string;
  attackerPlayer: PlayerIndex;
  defenderUid: string | null;
  active: boolean; // 战斗中（禁止其他行动）
  supportAP: number; // 支援给攻击者的 AP（战斗结束清掉）
  supportDP: number; // 支援给防御者的 DP（战斗结束清掉）
  timingActor: PlayerIndex; // 当前拥有バトル中宣言タイミング的玩家
  lastPass: boolean; // 上一手是否放弃（双方连续放弃才结算战斗）
  lastSupport: { supporterUid: string; targetUid: string; sp: number; attackerSide: boolean } | null; // 最近一次支援（6962 支援值作为DP 用）
}

/** 待执行的动作（支付费用确认后继续执行） */
export type PendingAction =
  | { action: 'deploy'; uid: string; row: RowName; area: AreaIndex }
  | { action: 'event'; uid: string }
  | { action: 'equip'; itemUid: string; charUid: string }
  | { action: 'area'; uid: string; row?: RowName; area?: AreaIndex }
  | { action: 'declare'; uid: string; tag: '宣言' | '手札宣言'; declIdx: number; targetUid: string | null }
  | { action: 'attack'; uid: string }
  | { action: 'move'; uid: string; row: RowName; area: AreaIndex }
  | { action: 'searchDeployPay'; uid: string; effectPending: PendingEffect | null }
  | { action: 'equipSelfToTargetPay'; uid: string; itemCardId: string; effectPending: PendingEffect | null }
  | { action: 'searchEquipPay'; uid: string; charUid: string; itemCardId: string; effectPending: PendingEffect | null }
  | { action: 'supporterCost'; supporterUid: string };

/** UI 决策提示（由规则引擎生成，界面渲染后回传选择） */
export type PromptState =
  | { kind: 'rps' }
  | { kind: 'rps-result'; winner: PlayerIndex; p0: RpsChoice; p1: RpsChoice; turnPlayer: PlayerIndex; opponent: PlayerIndex }
  | { kind: 'defense'; attackerUid: string; attackerName: string; candidates: { uid: string; name: string }[] }
  | { kind: 'shield'; attackerUid: string; dmg: number; shieldCount: number }
  | { kind: 'hand-adjust'; need: number }
  | { kind: 'equip-target'; itemUid: string; targets: { uid: string; name: string }[] }
  | {
      kind: 'cost-pay';
      cost: string; // 费用要求（如"日日"）
      actionLabel: string; // 动作说明（如：登场「凉花」）
      owner: PlayerIndex; // 支付者（通常=回合玩家；サプライズ登场等窗口行动可能不同）
      pending: PendingAction; // 支付确认后执行的动作
      candidates: { uid: string; name: string; elements: string; ex: number; cardId: string }[]; // 可选的手牌费用卡
    }
  | {
      kind: 'declare-target'; // 宣言/手札宣言/效果：选择目标角色
      uid: string; // 使用宣言的卡
      tag: string; // '宣言' | '手札宣言'
      owner: PlayerIndex; // 发起宣言的玩家
      actionLabel: string;
      candidates: { uid: string; name: string; cardId: string }[];
      pending: PendingEffect | null; // 新引擎效果链（旧流程为 null）
    }
  | {
      kind: 'manual-effect'; // 无法自动结算的效果：手动辅助面板
      title: string;
      text: string;
      owner: PlayerIndex;
    }
  | {
      kind: 'search-deploy'; // 检索登场/配置：选择要登场的卡
      owner: PlayerIndex;
      title: string;
      mode: 'deploy' | 'place' | 'hand' | 'charge' | 'equip'; // 检索后处理方式
      placeMode?: boolean; // 旧字段（兼容）
      altMode?: 'charge'; // 可选替代处理（登场或作为充能）
      free?: boolean; // 登场是否无偿（不付费用）
      candidates: { uid: string; name: string; zone: string; cardId?: string }[];
      pending: PendingEffect | null; // 非空：检索是某效果链的一环
    }
  | {
      kind: 'mulligan'; // 起手换牌（先攻先决定）
      owner: PlayerIndex;
    }
  | {
      kind: 'card-pick'; // 选择卡片（充能/エリア下方/置き場 的放置或破弃）
      owner: PlayerIndex;
      title: string;
      max: number;
      candidates: { uid: string; name: string; cardId: string }[];
      zone: 'trash' | 'charge' | 'under' | 'hand-under' | 'field';
      sourceUid: string | null; // 充能/下方的宿主卡
      purpose: 'store' | 'storeUnder' | 'charge' | 'discardCharge' | 'discardUnder' | 'discardChargeCost' | 'costUnder' | 'costUnderInPay' | 'handUnder' | 'discardOppChar' | 'healDeck';
      param?: string; // 附加参数（如置き場名 / 费用下标）
      pending: PendingEffect | null; // 效果链继续用
      resumePrompt?: Extract<PromptState, { kind: 'cost-pay' }>; // [コスト]能力在付费时使用：破弃完成后回到费用支付
    }
  | { kind: 'damage'; defender: PlayerIndex; dmg: number; broken: number; attackerUid: string; attOwner: PlayerIndex }
  | {
      kind: 'slot-pick'; // 登场位置选择（检索登场 / 复活等）
      owner: PlayerIndex;
      title: string;
      uid: string; // 要登场的卡实例
      slots: { row: RowName; area: AreaIndex }[];
      purpose: 'searchDeploy' | 'revive' | 'surpriseDeploy' | 'areaPlace' | 'areaPlaceHand';
      tapped?: boolean; // 复活时是否行动済み登场
      pending: PendingEffect | null;
    }
  | {
      kind: 'response'; // 对应宣言窗口（0602 判例）
      title: string;
      owner: PlayerIndex; // 当前可响应的玩家
      cardId?: string; // 对方宣言的卡（顶部显示卡图）
      effectLabel?: string; // 对方宣言的具体效果（宣言/手札宣言）
      options: { id: string; label: string; cardId?: string }[];
    }
  | {
      kind: 'battle-timing'; // バトル中宣言タイミング（0850 判例，双方交替）
      owner: PlayerIndex;
      attackerUid: string;
      defenderUid: string | null;
      options: { id: string; label: string; cardId?: string }[];
    }
  | {
      kind: 'end-main'; // 回合结束优先权转移（双方都同意才进结束阶段）
      owner: PlayerIndex;
      options: { id: string; label: string; cardId?: string }[];
    }
  | {
      kind: 'effect-choice'; // 效果选项：选择一个或多个选项继续结算
      owner: PlayerIndex;
      title: string;
      multi: boolean;
      max: number;
      options: { id: string; label: string; cardId?: string }[];
      pending: PendingEffect;
    }
  | {
      kind: 'support'; // 战斗支援：选择支援角色（攻击方支援→AP，防御方支援→DP）
      attackerUid: string;
      attackerName: string;
      targetUid: string; // 被支援的角色（攻击者或防御者）
      gain: 'AP' | 'DP';
      candidates: { uid: string; name: string; sp: number; cost: string }[];
    }
  | { kind: 'gameover'; winner: PlayerIndex };

export type Phase = 'start' | 'main' | 'end' | 'gameover';

/** 位置描述 */
export interface Loc {
  zone: ZoneName;
  player: PlayerIndex;
  row?: RowName; // field 专用
  area?: AreaIndex; // field 专用
}

/** 对应宣言链中的一个宣言 */
export interface ResponseItem {
  owner: PlayerIndex; // 宣言方
  label: string;
  kind: 'deploy' | 'event' | 'area' | 'equip' | 'attack' | 'declare' | 'move';
  pend?: PendingAction;
  eff?: PendingEffect;
}

/** 对应宣言链（0602 判例：交替宣言累积，放弃后倒序（后发先至）结算） */
export interface ResponseChain {
  stack: ResponseItem[]; // 未结算的宣言栈（后发先至）
  awaiting: PlayerIndex; // 当前拥有对应宣言权的玩家
}

export interface PlayerState {
  deck: CardInstance[]; // 数组末尾 = 牌堆顶
  hand: CardInstance[];
  trash: CardInstance[];
  shield: CardInstance[];
  special: CardInstance[];
  field: (CardInstance | null)[][]; // [row: 0=AF, 1=DF][area: 0左 1中 2右] 角色
  fieldAreas: (CardInstance | null)[][]; // 每个フィールド上的エリア卡（フィールド1つ=角色1+エリア1）
  removed: CardInstance[]; // 除外区
  exPool: { elem: string; points: number; tag: string }[]; // [コスト]能力生成的费用（回合开始清空）
  perTurn: Record<string, number>; // 每回合次数限制计数（如 ts:uid:i / dl:uid:turn）
  storage: Record<string, CardInstance[]>; // 具名置き場（青春カウント / 野良天使 / Orohoraの箱 等）
  turnCounters: Record<string, number>; // 回合内事件计数（oppDiscarded：味方因对方效果离场数等）
  song?: string; // 该玩家本局卡组绑定的“战歌”文件名（切札发动时播放）
  name?: string; // 该玩家 ID（联机房间里的昵称，用于界面区分谁是谁）
  voice?: string; // 该玩家本局卡组绑定的“语音包”名（做行为时播放对应台词）
}

export interface GameState {
  cardsById: Record<string, Card>; // cardId -> 卡牌数据
  players: [PlayerState, PlayerState];
  turnPlayer: PlayerIndex;
  turn: number; // 回合数（1 起）
  phase: Phase;
  winner: PlayerIndex | null;
  battle: BattleState | null;
  prompt: PromptState | null;
  ready: boolean; // 双方是否已就位（在线联机等双方连接）
  rps: { p0: RpsChoice | null; p1: RpsChoice | null } | null; // 石头剪刀布
  mulligan: { stage: 0 | 1 | 2 } | null; // 起手换牌流程（0=先攻决定 1=后攻决定 2=完成）
  trumpUsed: boolean; // 切札：本局是否已使用过（游戏中仅1回）
  trumpSignal?: { owner: PlayerIndex; turn: number } | null; // 最近一次切札发动信号（前端据此播“战歌”）
  voiceQueue?: VoiceCue[]; // 行为语音队列（做行为时压入；前端按 seq 顺序播放对应台词）
  response: ResponseChain | null; // 对应宣言链
  pendingTurnStart?: { owner: PlayerIndex } | null; // 待执行的“自回合开始诱発”阶段（在对方回合开始诱発结算完后恢复）
  pendingStartPhase?: { owner: PlayerIndex } | null; // 回合开始诱発全部处理完后执行「重置+抽牌」（スタートフェイズ）
  turnStartChainDone?: boolean; // 已进入“自回合开始诱発”链（对方回合开始诱発阶段不触发 pendingStartPhase）
  pendingFiredKeys?: string[]; // 当前事件已处理的触发 key（同类多诱発：每事件每张卡只处理一次，Bug：支援诱发一次支援重复3次）
  lastEngageDiscard: { cardId: string; dmg: number; name: string } | null; // 最近一次エンゲージ登场被破弃的角色（6940 家族诱発用）
  lastAreaEvent: {
    kind: 'ownUsed' | 'oppBattleCharLeft' | 'friendlyNamedLeft' | 'ownDeclareDraw';
    owner: PlayerIndex;
    cardId?: string;
    paid?: number;
    usedFrom?: string; // ownUsed 来源：handDeclare / item / area / surpriseChar
    name?: string; // friendlyNamedLeft 的角色名
    fired?: boolean; // 是否已触发 6961/6963 エリア诱発
  } | null;
  log: string[];
}

export type RpsChoice = 'rock' | 'paper' | 'scissors';

/** 行为语音的一条：谁（owner）做了什么（action），seq 单调递增（两端一致，用于去重与挑选台词版本） */
export interface VoiceCue {
  owner: PlayerIndex;
  action: string;
  seq: number;
  turn: number;
}

/** 语音队列上限（同一次结算可能连发多条，只保留最近的几条） */
export const VOICE_QUEUE_MAX = 6;

/** 压入一条行为语音（就地修改传入的状态；调用方应已克隆） */
export function pushVoice(gs: GameState, owner: PlayerIndex, action: string): void {
  const q = gs.voiceQueue ?? (gs.voiceQueue = []);
  const last = q.length > 0 ? q[q.length - 1].seq : 0;
  q.push({ owner, action, seq: last + 1, turn: gs.turn });
  if (q.length > VOICE_QUEUE_MAX) q.splice(0, q.length - VOICE_QUEUE_MAX);
}

let uidCounter = 0;
export function newUid(): string {
  uidCounter++;
  return `c${uidCounter.toString(36)}_${Date.now().toString(36)}`;
}

export function newInstance(cardId: string): CardInstance {
  return {
    uid: newUid(),
    cardId,
    faceUp: false,
    tapped: false,
    deployedTurn: null,
    equip: null,
    tempMods: { ap: 0, dp: 0, sp: 0, dmg: 0 },
    tempSet: {},
    charge: [],
    under: [],
    lost: [],
    supports: null,
    tempBonus: null,
    tempForceDefend: null,
    pendingEngage: null,
  };
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function emptyPlayer(): PlayerState {
  return {
    deck: [],
    hand: [],
    trash: [],
    shield: [],
    special: [],
    field: [
      [null, null, null], // AF
      [null, null, null], // DF
    ],
    fieldAreas: [
      [null, null, null],
      [null, null, null],
    ],
    removed: [],
    exPool: [],
    perTurn: {},
    storage: {},
    turnCounters: {},
  };
}

/** 创建一个空对局状态（牌组内容由外部填充） */
export function createEmptyGame(cards: Card[]): GameState {
  const cardsById: Record<string, Card> = {};
  for (const c of cards) cardsById[c.id] = c;
  return {
    cardsById,
    players: [emptyPlayer(), emptyPlayer()],
    turnPlayer: 0,
    turn: 1,
    phase: 'start',
    winner: null,
    battle: null,
    prompt: null,
    ready: false,
    rps: null,
    mulligan: null,
    trumpUsed: false,
    response: null,
    lastEngageDiscard: null,
    lastAreaEvent: null,
    log: [],
  };
}

/** 找到实例当前所在位置（zone/row/area/数组内下标） */
export function findInstance(
  gs: GameState,
  uid: string,
): { player: PlayerIndex; zone: ZoneName; row?: RowName; area?: AreaIndex; index: number } | null {
  for (const p of [0, 1] as PlayerIndex[]) {
    const st = gs.players[p];
    const zones: { zone: ZoneName; list: CardInstance[] }[] = [
      { zone: 'deck', list: st.deck },
      { zone: 'hand', list: st.hand },
      { zone: 'trash', list: st.trash },
      { zone: 'shield', list: st.shield },
      { zone: 'special', list: st.special },
    ];
    for (const { zone, list } of zones) {
      const idx = list.findIndex((c) => c.uid === uid);
      if (idx >= 0) return { player: p, zone, index: idx };
    }
    for (let r = 0; r < 2; r++) {
      const row = (r === 0 ? 'AF' : 'DF') as RowName;
      for (let a = 0; a < 3; a++) {
        const cell = st.field[r][a];
        if (cell && cell.uid === uid) return { player: p, zone: 'field', row, area: a as AreaIndex, index: -1 };
        if (cell && cell.equip && cell.equip.uid === uid) return { player: p, zone: 'equip', row, area: a as AreaIndex, index: -1 };
        const areaCard = st.fieldAreas[r][a];
        if (areaCard && areaCard.uid === uid) return { player: p, zone: 'area', row, area: a as AreaIndex, index: -1 };
      }
    }
  }
  return null;
}

/** 从位置移除实例（返回被移除的实例，不改变其他状态） */
function removeInstance(
  gs: GameState,
  player: PlayerIndex,
  loc: { zone: ZoneName; row?: RowName; area?: AreaIndex; index: number },
): CardInstance | null {
  const st = gs.players[player];
  if (loc.zone === 'field') {
    const cell = st.field[loc.row === 'AF' ? 0 : 1][loc.area ?? 0];
    if (cell) st.field[loc.row === 'AF' ? 0 : 1][loc.area ?? 0] = null;
    return cell;
  }
  if (loc.zone === 'area') {
    const cell = st.fieldAreas[loc.row === 'AF' ? 0 : 1][loc.area ?? 0];
    if (cell) st.fieldAreas[loc.row === 'AF' ? 0 : 1][loc.area ?? 0] = null;
    return cell;
  }
  const zoneMap: Record<string, CardInstance[]> = {
    deck: st.deck,
    hand: st.hand,
    trash: st.trash,
    shield: st.shield,
    special: st.special,
  };
  const list = zoneMap[loc.zone];
  if (!list || loc.index < 0 || loc.index >= list.length) return null;
  return list.splice(loc.index, 1)[0];
}

function placeInstance(
  gs: GameState,
  player: PlayerIndex,
  zone: ZoneName,
  inst: CardInstance,
  opts: { row?: RowName; area?: AreaIndex; top?: boolean; faceUp?: boolean; tapped?: boolean } = {},
): boolean {
  if (opts.faceUp !== undefined) inst.faceUp = opts.faceUp;
  if (opts.tapped !== undefined) inst.tapped = opts.tapped;
  const st = gs.players[player];
  if (zone === 'field') {
    const r = opts.row === 'DF' ? 1 : 0;
    const a = opts.area ?? 0;
    if (st.field[r][a]) return false; // 该格已占用
    st.field[r][a] = inst;
    return true;
  }
  const zoneMap: Record<string, CardInstance[]> = {
    deck: st.deck,
    hand: st.hand,
    trash: st.trash,
    shield: st.shield,
    special: st.special,
  };
  const list = zoneMap[zone];
  if (!list) return false;
  // 牌堆中的卡必须背面朝上（防止回血等把卡放回牌堆后显示为正面）
  if (zone === 'deck') inst.faceUp = false;
  if (opts.top) list.push(inst);
  else list.unshift(inst);
  return true;
}

/** 移动一张卡到目标位置。返回新状态（不可变） */
export function moveTo(
  gs: GameState,
  uid: string,
  target: { zone: ZoneName; player: PlayerIndex; row?: RowName; area?: AreaIndex },
  opts: { faceUp?: boolean; tapped?: boolean; top?: boolean } = {},
): GameState {
  const next: GameState = structuredClone(gs);
  const from = findInstance(next, uid);
  if (!from) return gs;
  const inst = removeInstance(next, from.player, from);
  if (!inst) return gs;
  const ok = placeInstance(next, target.player, target.zone, inst, {
    row: target.row,
    area: target.area,
    top: opts.top,
    faceUp: opts.faceUp,
    tapped: opts.tapped,
  });
  if (!ok) return gs;
  return next;
}

/** 从牌堆顶抽 n 张到手牌 */
export function draw(gs: GameState, player: PlayerIndex, n: number): GameState {
  let next = gs;
  for (let i = 0; i < n; i++) {
    const st = next.players[player];
    if (st.deck.length === 0) break;
    const top = st.deck[st.deck.length - 1];
    next = moveTo(next, top.uid, { zone: 'hand', player }, { faceUp: true });
  }
  return next;
}

/** 切换行动済み/未行动（横向/纵向） */
export function toggleTapped(gs: GameState, uid: string): GameState {
  const next: GameState = structuredClone(gs);
  const inst = findInstance(next, uid);
  if (!inst) return gs;
  const zoneMap: Record<string, CardInstance[]> = {
    deck: next.players[inst.player].deck,
    hand: next.players[inst.player].hand,
    trash: next.players[inst.player].trash,
    shield: next.players[inst.player].shield,
    special: next.players[inst.player].special,
  };
  if (inst.zone === 'field') {
    const cell = next.players[inst.player].field[inst.row === 'AF' ? 0 : 1][inst.area ?? 0];
    if (cell) cell.tapped = !cell.tapped;
  } else {
    const list = zoneMap[inst.zone];
    if (list && list[inst.index]) list[inst.index].tapped = !list[inst.index].tapped;
  }
  return next;
}

/** 翻面 */
export function toggleFaceUp(gs: GameState, uid: string): GameState {
  const next: GameState = structuredClone(gs);
  const inst = findInstance(next, uid);
  if (!inst) return gs;
  if (inst.zone === 'field') {
    const cell = next.players[inst.player].field[inst.row === 'AF' ? 0 : 1][inst.area ?? 0];
    if (cell) cell.faceUp = !cell.faceUp;
  } else {
    const zoneMap: Record<string, CardInstance[]> = {
      deck: next.players[inst.player].deck,
      hand: next.players[inst.player].hand,
      trash: next.players[inst.player].trash,
      shield: next.players[inst.player].shield,
      special: next.players[inst.player].special,
    };
    const list = zoneMap[inst.zone];
    if (list && list[inst.index]) list[inst.index].faceUp = !list[inst.index].faceUp;
  }
  return next;
}

/** 洗牌 */
export function shuffleDeck(gs: GameState, player: PlayerIndex): GameState {
  const next: GameState = structuredClone(gs);
  next.players[player].deck = shuffle(next.players[player].deck);
  return next;
}

/** 日志 */
export function pushLog(gs: GameState, msg: string): GameState {
  const next: GameState = structuredClone(gs);
  next.log.push(msg);
  if (next.log.length > 200) next.log.splice(0, next.log.length - 200);
  return next;
}
