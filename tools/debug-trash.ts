// 调试手札宣言进ゴミ箱
import { readFileSync } from 'node:fs';
import { createEmptyGame, newInstance } from '../src/core/game';
import * as rules from '../src/core/rules';

const cards = JSON.parse(readFileSync('public/cards.json', 'utf-8'));
const card = cards.find((c: any) => c.type === 'character' && (c.ability || '').includes('[手札宣言]'));
console.log('card:', card.id, card.name);
const gs = createEmptyGame(cards);
gs.turnPlayer = 0;
gs.phase = 'main';
const inst = newInstance(card.id);
inst.faceUp = true;
gs.players[0].hand.push(inst);
const next = rules.requestHandDeclare(gs, inst.uid);
console.log('hand:', next.players[0].hand.length, 'trash:', next.players[0].trash.map((c) => c.cardId), 'prompt:', next.prompt?.kind, 'log:', JSON.stringify(next.log.slice(-2)));
