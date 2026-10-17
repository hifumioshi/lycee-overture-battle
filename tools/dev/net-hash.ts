/*
 * 联机测试用的小工具：直接复用正式实现，避免测试与游戏逻辑漂移。
 */
export { applyAction, guestActDenied, rateLimited } from '../../src/net/protocol';
import type { GameState } from '../../src/core/game';

/** 状态指纹（简化版：只用于两端比对一致性，不做增量） */
export function stateHashLite(gs: GameState): number {
  const s = JSON.stringify({
    turn: gs.turn,
    turnPlayer: gs.turnPlayer,
    phase: gs.phase,
    prompt: gs.prompt ? gs.prompt.kind : null,
    winner: gs.winner,
    p: gs.players.map((pl) => ({
      hand: pl.hand.map((c) => c.cardId).sort(),
      deck: pl.deck.length,
      trash: pl.trash.map((c) => c.cardId).sort(),
      field: pl.field.flat().map((c) => (c ? c.cardId : null)),
      areas: pl.fieldAreas.flat().map((c) => (c ? c.cardId : null)),
    })),
  });
  // FNV-1a 32 位
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
