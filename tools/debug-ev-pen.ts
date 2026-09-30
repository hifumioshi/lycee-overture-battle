// 调试事件与ペナルティ
import { readFileSync } from 'node:fs';
import { createEmptyGame, newInstance } from '../src/core/game';
import * as rules from '../src/core/rules';
import { effectiveStats } from '../src/core/effects';

const cards = JSON.parse(readFileSync('public/cards.json', 'utf-8'));
const byId: Record<string, any> = Object.fromEntries(cards.map((c: any) => [c.id, c]));

{
  const gs = createEmptyGame(cards);
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const ch = newInstance('LO-6971');
  ch.faceUp = true;
  ch.deployedTurn = 1;
  gs.players[0].field[0][0] = ch;
  const ev = newInstance('LO-6954');
  ev.faceUp = true;
  gs.players[0].hand.push(ev);
  gs.players[0].hand.push(newInstance('LO-6846'), newInstance('LO-6846'), newInstance('LO-6968'));
  let next = rules.requestPlayEvent(gs, ev.uid);
  console.log('event step1 prompt:', next.prompt?.kind, 'log:', JSON.stringify(next.log.slice(-1)));
  if (next.prompt?.kind === 'cost-pay') {
    next = rules.confirmCostPay(next, next.prompt.candidates.map((c) => c.uid));
    console.log('event step2 prompt:', next.prompt?.kind, 'log:', JSON.stringify(next.log.slice(-3)));
  }
  console.log('event ap:', effectiveStats(next, ch.uid).ap);
}
{
  const card = byId['LO-6898'];
  const gs = createEmptyGame(cards);
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  gs.players[1].deck.push(newInstance('LO-6845'));
  const atk = newInstance('LO-6857');
  atk.faceUp = true;
  atk.deployedTurn = 1;
  gs.players[0].field[0][0] = atk;
  const def = newInstance(card.id);
  def.faceUp = true;
  def.deployedTurn = 1;
  gs.players[1].field[1][0] = def;
  let next = rules.declareAttack(gs, atk.uid);
  console.log('penalty step1 prompt:', next.prompt?.kind);
  if (next.prompt?.kind === 'support') next = rules.chooseSupport(next, null);
  next = rules.chooseDefense(next, def.uid);
  console.log('penalty hand:', next.players[1].hand.length, 'log:', JSON.stringify(next.log.slice(-5)));
}
