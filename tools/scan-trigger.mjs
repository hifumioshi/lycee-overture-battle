import { readFileSync } from "node:fs";
import { createEmptyGame, newInstance } from "../src/core/game";
import * as rules from "../src/core/rules";
const cards = JSON.parse(readFileSync("data/cards/range.json","utf-8"));
const gs = createEmptyGame(cards);
gs.turnPlayer = 0; gs.turn = 2; gs.phase = 'start';
const a = newInstance('LO-6852'); a.faceUp = true; a.deployedTurn = null;
gs.players[0].field[0][0] = a;
const ar = newInstance('LO-6960'); ar.faceUp = true; ar.deployedTurn = null;
gs.players[0].fieldAreas[0][0] = ar;
gs.players[0].trash.push(newInstance('LO-6845'), newInstance('LO-6846'));
gs.players[0].deck.push(newInstance('LO-6971'), newInstance('LO-6971'), newInstance('LO-6971'), newInstance('LO-6971'), newInstance('LO-6971'));
let n = rules.beginTurn(gs);
let guard = 0;
console.log('beginTurn: ' + (n.prompt?.kind ?? 'null'));
while (guard++ < 14 && n.prompt) {
  const k = n.prompt.kind;
  if (k === 'effect-choice') { const opt = n.prompt.options.find(o => o.id !== '__skip') ?? n.prompt.options[0]; n = rules.chooseEffectOption(n, [opt.id]); }
  else if (k === 'card-pick') { n = rules.chooseCardPick(n, n.prompt.candidates[0] ? [n.prompt.candidates[0].uid] : []); }
  else if (k === 'response') n = rules.respond(n, 'pass');
  else break;
  if (!n.prompt) console.log('  处理完 -> prompt=null phase=' + n.phase + ' 仍需开始回合? ' + (n.phase === 'start'));
}
