// 联机协议：消息类型、动作定义与映射
// 房主权威：客户端发送动作，房主应用规则并广播状态（玩家2 + 观战者）
import type { GameState, PlayerIndex, RowName, AreaIndex } from '../core/game';
import type { RoomState } from '../core/room';
import type { StatePacket } from './gsSync';
import * as rules from '../core/rules';

/** 联机模式：本地双人 / 房主 / 客机（上桌玩家）/ 观战者 */
export type NetMode = 'local' | 'host' | 'guest' | 'spectator';

/** 客机/观战者 → 房主：动作 */
export interface NetAction {
  type: 'action';
  action: string;
  args: unknown[];
}

/** 服务器 → 客户端：自己的 id（用于识别身份） */
export interface NetWelcome {
  type: 'welcome';
  id: number;
}

/** 客户端 → 房主：房间操作 */
export type NetRoomClientMsg =
  | { type: 'hello'; name: string }
  | { type: 'sit' }
  | { type: 'stand' }
  | { type: 'ready'; deck: string[] }
  | { type: 'unready' }
  | { type: 'deck'; deck: string[]; deckName?: string; count?: number; song?: string };

/** 房主 → 客户端：房间状态 */
export interface NetRoomState {
  type: 'room';
  room: RoomState;
}

/** 房主 → 客户端：状态数据包（默认增量，见 net/gsSync.ts） */
export interface NetState {
  type: 'state';
  pkt: StatePacket;
}

/** 客户端 → 房主：请求整份状态（基线对不上时） */
export interface NetResync {
  type: 'resync';
}

/** 房主 → 客机：定期校验包（只带版本号+校验码，约 100 字节；对不上就要整份） */
export interface NetHash {
  type: 'hash';
  rev: number;
  hash: number;
  seq: number;
}

/** 客机 → 房主：带确认的操作（opId 用于去重、rev = 我基于哪一版点的） */
export interface NetOp {
  type: 'op';
  opId: string;
  action: string;
  args: unknown[];
  rev: number;
}

/** 房主 → 客机：操作回执（ok=false 时 reason 说明原因，如 stale=你的画面旧了） */
export interface NetAck {
  type: 'ack';
  opId: string;
  ok: boolean;
  rev: number;
  reason?: string;
  message?: string;
}

/** 客机 → 房主：我已同步到第 rev 版（房主据此显示"对方同步中/已同步"） */
export interface NetRevReport {
  type: 'rev';
  rev: number;
  hash: number;
}

/** 客机 → 房主：校验码对不上，附带逐槽位校验值供房主定位 */
export interface NetDesync {
  type: 'desync';
  rev: number;
  hash: number;
  slots: [string, number][];
}

/** 房主 → 全体：分车报告（哪些字段不一致） */
export interface NetDesyncReport {
  type: 'desync';
  ok: boolean;
  hostHash: number;
  guestHash: number;
  paths: string[];
}

export type NetMessage =
  | NetAction
  | NetState
  | NetHash
  | NetResync
  | NetOp
  | NetAck
  | NetRevReport
  | NetDesync
  | NetDesyncReport
  | NetRoomClientMsg
  | NetWelcome
  | NetRoomState;

/** 动作处理器：根据动作名与参数应用规则（房主使用） */
export function applyAction(gs: GameState, action: string, args: unknown[]): GameState {
  switch (action) {
    case 'beginTurn':
      return rules.beginTurn(gs);
    case 'endTurn':
      return rules.endTurn(gs);
    case 'markReady':
      return rules.markReady(gs);
    case 'chooseRps':
      return rules.chooseRps(gs, args[0] as PlayerIndex, args[1] as 'rock' | 'paper' | 'scissors');
    case 'confirmRpsResult':
      return rules.confirmRpsResult(gs);
    case 'requestPlayCharacter':
      return rules.requestPlayCharacter(gs, args[0] as string, args[1] as RowName, args[2] as AreaIndex);
    case 'confirmCostPay':
      return rules.confirmCostPay(gs, args[0] as string[]);
    case 'cancelCostPay':
      return rules.cancelCostPay(gs);
    case 'requestPlayEvent':
      return rules.requestPlayEvent(gs, args[0] as string);
    case 'requestPlayArea':
      return rules.requestPlayArea(gs, args[0] as string);
    case 'chooseMulligan':
      return rules.chooseMulligan(gs, args[0] as boolean);
    case 'chooseCardPick':
      return rules.chooseCardPick(gs, args[0] as string[]);
    case 'chooseSlot':
      return rules.chooseSlot(gs, args[0] as RowName, args[1] as AreaIndex);
    case 'respond':
      return rules.respond(gs, args[0] as string);
    case 'battleTimingAction':
      return rules.battleTimingAction(gs, args[0] as string);
    case 'endMainAction':
      return rules.endMainAction(gs, args[0] as string);
    case 'endMainCancel':
      return rules.endMainCancel(gs);
    case 'requestEquipItem':
      return rules.requestEquipItem(gs, args[0] as string, args[1] as string);
    case 'requestEquipTarget':
      return rules.requestEquipTarget(gs, args[0] as string);
    case 'cancelPrompt':
      return rules.cancelPrompt(gs);
    case 'requestHandDeclare':
      return rules.requestHandDeclare(gs, args[0] as string);
    case 'requestDeclare':
      return rules.requestDeclare(gs, args[0] as string);
    case 'chooseDeclareTarget':
      return rules.chooseDeclareTarget(gs, (args[0] as string) ?? null);
    case 'chooseEffectOption':
      return rules.chooseEffectOption(gs, args[0] as string[]);
    case 'chooseSupport':
      return rules.chooseSupport(gs, (args[0] as string) ?? null);
    case 'useCostAbility':
      return rules.useCostAbility(gs, args[0] as string);
    case 'useCostAbilityInPay':
      return rules.useCostAbilityInPay(gs, args[0] as string);
    case 'manualDraw':
      return rules.manualDraw(gs, args[0] as number);
    case 'manualStat':
      return rules.manualStat(gs, args[0] as string, args[1] as string, args[2] as number);
    case 'manualDeckDiscard':
      return rules.manualDeckDiscard(gs, args[0] as number);
    case 'manualDone':
      return rules.manualDone(gs);
    case 'chooseSearchDeploy':
      return rules.chooseSearchDeploy(gs, args[0] as string);
    case 'moveCharacter':
      return rules.moveCharacter(gs, args[0] as string, args[1] as RowName, args[2] as AreaIndex);
    case 'declareAttack':
      return rules.declareAttack(gs, args[0] as string);
    case 'chooseDefense':
      return rules.chooseDefense(gs, (args[0] as string) ?? null);
    case 'chooseShield':
      return rules.chooseShield(gs, args[0] as boolean);
    case 'confirmDamage':
      return rules.confirmDamage(gs);
    case 'confirmDiscard':
      return rules.confirmDiscard(gs, args[0] as string[]);
    default:
      return gs;
  }
}

/** 客机动作的权限校验：该动作是否允许由 guestPlayer 发起 */
export function canGuestAct(gs: GameState, action: string, guestPlayer: PlayerIndex): boolean {
  // 提示类动作：只有提示归属方可以操作
  const prompt = gs.prompt;
  const owner = prompt ? promptOwner(prompt, gs.turnPlayer) : null;
  if (prompt) {
    const promptActions = ['chooseRps', 'chooseDefense', 'chooseShield', 'confirmDiscard', 'confirmCostPay', 'cancelCostPay', 'cancelPrompt', 'chooseDeclareTarget', 'chooseEffectOption', 'chooseSupport', 'chooseMulligan', 'chooseCardPick', 'chooseSlot', 'respond', 'battleTimingAction', 'endMainAction', 'endMainCancel', 'manualDraw', 'manualStat', 'manualDeckDiscard', 'manualDone', 'chooseSearchDeploy', 'useCostAbilityInPay', 'confirmRpsResult', 'confirmDamage'];
    if (promptActions.includes(action)) {
      // 石头剪刀布双方都可操作；其余提示由归属方操作
      if (action === 'chooseRps') return prompt.kind === 'rps';
      if (action === 'confirmRpsResult') return prompt.kind === 'rps-result';
      if (action === 'confirmDamage') return prompt.kind === 'damage';
      // 结束主阶段：优先权玩家可同意/使用宣言；回合玩家可“取消结束”继续主阶段
      if (action === 'endMainAction') return prompt.kind === 'end-main' && owner === guestPlayer;
      if (action === 'endMainCancel') return prompt.kind === 'end-main' && gs.turnPlayer === guestPlayer;
      return owner === guestPlayer;
    }
    // 其他动作在提示期间不允许（除非该提示属于本玩家且动作不冲突）
    return false;
  }
  // 回合动作：只有回合玩家可操作
  const turnActions = ['beginTurn', 'endTurn', 'requestPlayCharacter', 'requestPlayEvent', 'requestPlayArea', 'requestEquipItem', 'requestEquipTarget', 'declareAttack', 'requestHandDeclare', 'requestDeclare', 'moveCharacter', 'useCostAbility'];
  if (turnActions.includes(action)) {
    return gs.turnPlayer === guestPlayer && gs.phase !== 'gameover';
  }
  return false;
}

/** 提示归属玩家（谁需要做决定）：-1 表示双方都看（如 gameover） */
export function promptOwner(
  prompt: GameState['prompt'],
  turnPlayer: PlayerIndex,
): PlayerIndex | -1 {
  if (!prompt) return -1;
  switch (prompt.kind) {
    case 'rps':
      return -1; // 双方都参与
    case 'defense':
    case 'shield':
      return (1 - turnPlayer) as PlayerIndex; // 非回合玩家防御/护盾
    case 'cost-pay':
      // 支付者 = prompt.owner（サプライズ登场等在对方回合的行动，付款人是行动者而非回合玩家）
      return prompt.owner;
    case 'equip-target':
    case 'hand-adjust':
      return turnPlayer;
    case 'declare-target':
      return prompt.owner;
    case 'manual-effect':
      return prompt.owner;
    case 'search-deploy':
      return prompt.owner;
    case 'effect-choice':
      return prompt.owner;
    case 'support':
      return prompt.gain === 'AP' ? turnPlayer : ((1 - turnPlayer) as PlayerIndex);
    case 'mulligan':
      return prompt.owner;
    case 'card-pick':
      return prompt.owner;
    case 'slot-pick':
      return prompt.owner;
    case 'response':
      return prompt.owner;
    case 'battle-timing':
      return prompt.owner;
    case 'end-main':
      return prompt.owner;
    case 'rps-result':
    case 'damage':
      return -1; // 双方都查看/确认
    case 'gameover':
      return -1;
    default:
      return -1;
  }
}
