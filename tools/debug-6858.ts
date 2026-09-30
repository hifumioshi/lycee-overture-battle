// 调试 6858 回合结束充能破弃
import { readFileSync } from 'node:fs';
import { createEmptyGame, newInstance } from '../src/core/game';
import * as rules from '../src/core/rules';

const cards = JSON.parse(readFileSync('public/cards.json', 'utf-8'));
const card = cards.find((c: any) => c.id === 'LO-6858');
const gs = createEmptyGame(cards);
gs.turnPlayer = 0;
gs.phase = 'main';
gs.turn = 2;
const inst = newInstance(card.id);
inst.faceUp = true;
inst.deployedTurn = 1;
inst.charge.push(newInstance('LO-6845'), newInstance('LO-6846'));
gs.players[0].field[0][0] = inst;
gs.players[0].deck.push(newInstance('LO-6971'));
const next = rules.endTurn(gs);
console.log('prompt:', next.prompt?.kind, JSON.stringify(next.prompt && (next.prompt as any).title), 'log:', JSON.stringify(next.log.slice(-3)));
