// 调试 6858 完整流程
import { readFileSync } from 'node:fs';
import { createEmptyGame, newInstance } from '../src/core/game';
import * as rules from '../src/core/rules';

const cards = JSON.parse(readFileSync('public/cards.json', 'utf-8'));
const gs = createEmptyGame(cards);
gs.turnPlayer = 0;
gs.phase = 'main';
gs.turn = 2;
const inst = newInstance('LO-6858');
inst.faceUp = true;
inst.deployedTurn = 1;
inst.charge.push(newInstance('LO-6845'), newInstance('LO-6846'));
gs.players[0].field[0][0] = inst;
gs.players[0].deck.push(newInstance('LO-6971'));
let next = rules.endTurn(gs);
console.log('step1:', next.prompt?.kind, 'phase:', next.phase);
if (next.prompt?.kind === 'card-pick') {
  console.log('title:', (next.prompt as any).title);
  next = rules.chooseCardPick(next, [next.prompt.candidates[1].uid]);
  console.log('step2 prompt:', next.prompt?.kind, 'phase:', next.phase, 'log:', JSON.stringify(next.log.slice(-4)));
}
console.log('charge:', next.players[0].field[0][0]?.charge.length, 'hand:', next.players[0].hand.length, 'trash:', next.players[0].trash.length, 'turnPlayer:', next.turnPlayer);
