/*
 * 开发端沙盒辅助（单人测试模式用）—— **仅开发构建会 import 本文件**
 *
 * 正式构建里没有任何地方 import 它（入口在 src/ui/dev/TestMode.tsx，只有
 * VITE_DEV_TOOLS=1 时才会被动态 import），因此 Vite 不会把它打进 dist 产物。
 *
 * 用途：测试单个效果与联动时，直接把任意卡加入我方手牌，不必先组 60 张卡组。
 * 注意：本文件里的操作是**沙盒**——会绕过"卡组 60 张 / 同编号最多 4 张 / 卡牌守恒"等校验，
 * 所以这类对局不能用来验证张数守恒类不变量（那类请用正常模式）。
 */
import type { Card } from './cards';
import { GameState, PlayerIndex, newInstance, pushLog, draw } from './game';

/** 卡号是否在卡池里 */
export function devHasCard(gs: GameState, cardId: string): boolean {
  return !!gs.cardsById[cardId];
}

/** 直接把一张卡加入手牌（按卡号） */
export function devAddToHand(gs: GameState, cardId: string, player: PlayerIndex = 0): GameState {
  const card: Card | undefined = gs.cardsById[cardId];
  if (!card) return gs;
  const next: GameState = structuredClone(gs);
  next.players[player].hand.push(newInstance(cardId));
  return pushLog(next, `【测试模式】把「${card.name}」加入${player === 0 ? '我方' : '对方'}手牌。`);
}

/** 把一张卡直接放到我方场上指定位置（角色用，绕过登场流程与费用） */
export function devPlaceCharacter(
  gs: GameState,
  cardId: string,
  row: 0 | 1,
  area: 0 | 1 | 2,
  player: PlayerIndex = 0,
): GameState {
  const card: Card | undefined = gs.cardsById[cardId];
  if (!card) return gs;
  const next: GameState = structuredClone(gs);
  const inst = newInstance(cardId);
  inst.faceUp = true;
  next.players[player].field[row][area] = inst;
  return pushLog(next, `【测试模式】把「${card.name}」放到${player === 0 ? '我方' : '对方'}场上 ${row === 0 ? 'AF' : 'DF'}・${['左', '中', '右'][area]}。`);
}

/** 我方场上角色全部恢复未行动（方便反复测试同一个能力） */
export function devUntapAll(gs: GameState, player: PlayerIndex = 0): GameState {
  const next: GameState = structuredClone(gs);
  let n = 0;
  for (let r = 0; r < 2; r++) {
    for (let a = 0; a < 3; a++) {
      const c = next.players[player].field[r][a];
      if (c && c.tapped) {
        c.tapped = false;
        n++;
      }
    }
  }
  next.players[player].perTurn = {};
  return pushLog(next, `【测试模式】重置了 ${n} 个角色的行动状态（本回合次数限制也一并清空）。`);
}

/** 手牌补到 n 张（不足时从卡组抽；卡组空了就原样返回） */
export function devFillHand(gs: GameState, n = 7, player: PlayerIndex = 0): GameState {
  const need = n - gs.players[player].hand.length;
  if (need <= 0) return gs;
  const next = draw(gs, player, need);
  return pushLog(next, `【测试模式】补 ${need} 张手牌（目标 ${n} 张）。`);
}

/** 把一张卡放进卡组（默认放牌堆顶，方便检索类效果立刻找到） */
export function devAddToDeck(
  gs: GameState,
  cardId: string,
  opts: { count?: number; top?: boolean; player?: PlayerIndex } = {},
): GameState {
  const card: Card | undefined = gs.cardsById[cardId];
  if (!card) return gs;
  const player = opts.player ?? 0;
  const count = opts.count ?? 1;
  const next: GameState = structuredClone(gs);
  for (let i = 0; i < count; i++) {
    const inst = newInstance(cardId);
    if (opts.top === false) next.players[player].deck.unshift(inst); // 牌堆底
    else next.players[player].deck.push(inst); // 牌堆顶（数组末尾）
  }
  return pushLog(next, `【测试模式】把「${card.name}」×${count} 放进${player === 0 ? '我方' : '对方'}卡组。`);
}

/** 把一张卡放进垃圾箱 */
export function devAddToTrash(gs: GameState, cardId: string, count = 1, player: PlayerIndex = 0): GameState {
  const card: Card | undefined = gs.cardsById[cardId];
  if (!card) return gs;
  const next: GameState = structuredClone(gs);
  for (let i = 0; i < count; i++) {
    const inst = newInstance(cardId);
    inst.faceUp = true;
    next.players[player].trash.push(inst);
  }
  return pushLog(next, `【测试模式】把「${card.name}」×${count} 放进${player === 0 ? '我方' : '对方'}垃圾箱。`);
}

/** 把一张エリア（场地）卡放到我方场上指定位置 */
export function devPlaceArea(
  gs: GameState,
  cardId: string,
  row: 0 | 1,
  area: 0 | 1 | 2,
  player: PlayerIndex = 0,
): GameState {
  const card: Card | undefined = gs.cardsById[cardId];
  if (!card) return gs;
  const next: GameState = structuredClone(gs);
  const inst = newInstance(cardId);
  inst.faceUp = true;
  next.players[player].fieldAreas[row][area] = inst;
  return pushLog(next, `【测试模式】把エリア「${card.name}」放到${player === 0 ? '我方' : '对方'} ${row === 0 ? 'AF' : 'DF'}・${['左', '中', '右'][area]}。`);
}

/** 把卡组压到指定张数（测试"自己牌堆在 N 张以下"这类使用前提用） */
export function devTrimDeck(gs: GameState, keep: number, player: PlayerIndex = 0): GameState {
  const deck = gs.players[player].deck;
  if (deck.length <= keep) return gs;
  const next: GameState = structuredClone(gs);
  next.players[player].deck = next.players[player].deck.slice(next.players[player].deck.length - Math.max(0, keep));
  return pushLog(next, `【测试模式】把${player === 0 ? '我方' : '对方'}卡组压到 ${Math.max(0, keep)} 张。`);
}

/** 把双方场上/手牌/弃牌都清干净（每张卡单独测时用，避免互相干扰） */
export function devResetBoard(gs: GameState): GameState {
  const next: GameState = structuredClone(gs);
  for (const p of [0, 1] as PlayerIndex[]) {
    const pl = next.players[p];
    const keepDeck = pl.deck;
    pl.hand = [];
    pl.trash = [];
    pl.shield = [];
    pl.special = [];
    pl.field = [
      [null, null, null],
      [null, null, null],
    ];
    pl.fieldAreas = [
      [null, null, null],
      [null, null, null],
    ];
    pl.removed = [];
    pl.storage = {};
    pl.exPool = [];
    pl.perTurn = {};
    pl.turnCounters = {};
    pl.deck = keepDeck;
  }
  next.prompt = null;
  next.battle = null;
  next.response = null;
  return pushLog(next, '【测试模式】清空场面（保留卡组）。');
}
