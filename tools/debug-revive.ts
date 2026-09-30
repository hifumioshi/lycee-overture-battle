// 调试 6846 复活流程
import { readFileSync } from 'node:fs';
import { createEmptyGame, newInstance } from '../src/core/game';
import * as rules from '../src/core/rules';

const cards = JSON.parse(readFileSync('public/cards.json', 'utf-8'));
const gs = createEmptyGame(cards);
gs.turnPlayer = 0;
gs.phase = 'main';
gs.turn = 3;
const victim = newInstance('LO-6971');
victim.faceUp = true;
victim.deployedTurn = 1;
gs.players[0].field[1][0] = victim;
gs.players[0].turnCounters.oppDiscarded = 1;
const copy = newInstance('LO-6846');
copy.faceUp = true;
gs.players[0].trash.push(copy);
const caster = newInstance('LO-6846');
caster.faceUp = true;
gs.players[0].hand.push(caster);
gs.players[0].hand.push(newInstance('LO-6846'), newInstance('LO-6846'));
let next = rules.requestHandDeclare(gs, caster.uid);
console.log('step1:', next.prompt?.kind, JSON.stringify(next.prompt && (next.prompt as any).options?.map((o: any) => o.label)));
if (next.prompt?.kind === 'effect-choice') {
  next = rules.chooseEffectOption(next, [next.prompt.options[1].id]);
  console.log('step2:', next.prompt?.kind, 'log:', JSON.stringify(next.log.slice(-2)));
}
if (next.prompt?.kind === 'cost-pay') {
  next = rules.confirmCostPay(next, next.prompt.candidates.map((c) => c.uid));
  console.log('step3:', next.prompt?.kind, 'log:', JSON.stringify(next.log.slice(-3)));
}
console.log('trash:', next.players[0].trash.map((c) => c.cardId), 'field:', next.players[0].field.flat().filter(Boolean).map((c) => c.cardId));
