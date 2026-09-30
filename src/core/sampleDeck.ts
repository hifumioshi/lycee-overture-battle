// 示例牌组构建 + 开局：先用测试区间卡池组一个 60 张的测试牌组
import { Card } from './cards';
import { GameState, createEmptyGame, newInstance, shuffle, draw, CardInstance, pushLog } from './game';

/** 从卡池构建示例牌组：优先角色卡（有配置位置的），补齐事件/道具，每种最多 4 张 */
export function buildSampleDeck(pool: Card[], size = 60): Card[] {
  const chars = pool
    .filter((c) => c.type === 'character' && c.positionFlags.trim() !== '')
    .sort((a, b) => a.id.localeCompare(b.id));
  const others = pool
    .filter((c) => !(c.type === 'character' && c.positionFlags.trim() !== ''))
    .sort((a, b) => a.id.localeCompare(b.id));

  const deck: Card[] = [];
  const counts = new Map<string, number>();
  const pick = (list: Card[]) => {
    for (const c of list) {
      if (deck.length >= size) return;
      const key = c.id.replace(/-[A-Z]$/, ''); // 同编号（忽略尾部字母）最多 4 张
      const n = counts.get(key) ?? 0;
      if (n < 4) {
        deck.push(c);
        counts.set(key, n + 1);
      }
    }
  };
  // 交替取，尽量混合角色与事件/道具
  let ci = 0;
  let oi = 0;
  while (deck.length < size) {
    const takeChar = deck.length % 3 !== 0; // 大约 2/3 角色
    if (takeChar) {
      const c = chars[ci % chars.length];
      const key = c.id.replace(/-[A-Z]$/, '');
      if ((counts.get(key) ?? 0) < 4) {
        deck.push(c);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      ci++;
    } else {
      const c = others[oi % others.length];
      const key = c.id.replace(/-[A-Z]$/, '');
      if ((counts.get(key) ?? 0) < 4) {
        deck.push(c);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      oi++;
    }
    // 防止死循环（卡池不足时）
    if (ci > chars.length * 20 && oi > others.length * 20 && deck.length < size) {
      // 允许超编复制以凑满（测试用）
      const c = chars[ci % chars.length];
      deck.push(c);
      ci++;
    }
  }
  return deck.slice(0, size);
}

function toInstance(card: Card): CardInstance {
  return newInstance(card.id);
}

/** 开局：洗牌、各抽 7 张，等待双方就位后石头剪刀布决定先攻 */
export function startGame(pool: Card[], deckIds?: string[], deckIds2?: string[]): GameState {
  const deckCards = deckIds && deckIds.length > 0 ? deckIds.map((id) => pool.find((c) => c.id === id)!).filter(Boolean) : buildSampleDeck(pool);
  // 玩家 2 卡组：联机时由客机提供（deckIds2）；未提供时与玩家 1 相同（本地测试）
  const deckCards2 = deckIds2 && deckIds2.length > 0 ? deckIds2.map((id) => pool.find((c) => c.id === id)!).filter(Boolean) : deckCards;
  const gs = createEmptyGame(pool);
  gs.players[0].deck = shuffle(deckCards.map(toInstance));
  gs.players[1].deck = shuffle(deckCards2.map(toInstance));
  let next = draw(gs, 0, 7);
  next = draw(next, 1, 7);
  next = pushLog(next, '对局开始：双方各抽 7 张。');
  next.phase = 'start';
  next.prompt = null;
  next.ready = false;
  return next;
}

/** 重建玩家 2（客机）的卡组与手札（联机：客机选好卡组后发给房主） */
export function resetPlayerDeck(gs: GameState, player: 1, pool: Card[], deckIds: string[]): GameState {
  const next = gs;
  const cards2 = deckIds.length > 0 ? deckIds.map((id) => pool.find((c) => c.id === id)!).filter(Boolean) : buildSampleDeck(pool);
  next.players[player].deck = shuffle(cards2.map(toInstance));
  next.players[player].hand = [];
  next.players[player].trash = [];
  next.players[player].shield = [];
  next.players[player].removed = [];
  next.players[player].field = [
    [null, null, null],
    [null, null, null],
  ];
  next.players[player].fieldAreas = [
    [null, null, null],
    [null, null, null],
  ];
  // draw 是纯函数：必须用返回值（修复：玩家2开局不抽7）
  return draw(next, player, 7);
}
