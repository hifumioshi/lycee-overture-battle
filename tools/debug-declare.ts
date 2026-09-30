// 调试手札宣言流程
import { readFileSync } from 'node:fs';
import { createEmptyGame, newInstance } from '../src/core/game';
import * as rules from '../src/core/rules';

const cards = JSON.parse(readFileSync('public/cards.json', 'utf-8'));

{
  const gs = createEmptyGame(cards);
  gs.turnPlayer = 0;
  gs.phase = 'main';
  gs.turn = 3;
  const caster = newInstance('LO-6849-X');
  caster.faceUp = true;
  gs.players[0].hand.push(caster);
  const next = rules.requestHandDeclare(gs, caster.uid);
  console.log('6849-X prompt:', next.prompt?.kind, 'log:', JSON.stringify(next.log.slice(-3)));
}
{
  const gs2 = createEmptyGame(cards);
  gs2.turnPlayer = 0;
  gs2.phase = 'main';
  gs2.turn = 3;
  const c2 = newInstance('LO-6850');
  c2.faceUp = true;
  gs2.players[0].hand.push(c2);
  const area = newInstance('LO-6960');
  area.faceUp = false;
  gs2.players[0].deck.push(area);
  let n2 = rules.requestHandDeclare(gs2, c2.uid);
  console.log('6850 first:', n2.prompt?.kind);
  if (n2.prompt?.kind === 'effect-choice') {
    console.log('   options:', JSON.stringify(n2.prompt.options));
    n2 = rules.chooseEffectOption(n2, [n2.prompt.options[0].id]);
    console.log('6850 after choose:', n2.prompt?.kind, n2.prompt ? JSON.stringify((n2.prompt as { title?: string }).title) : '', 'log:', JSON.stringify(n2.log.slice(-2)));
  }
  if (n2.prompt?.kind === 'search-deploy') {
    n2 = rules.chooseSearchDeploy(n2, area.uid);
    console.log('6850 after search: special=', n2.players[0].special.length, 'prompt=', n2.prompt?.kind);
  }
}
{
  const gs3 = createEmptyGame(cards);
  gs3.turnPlayer = 0;
  gs3.phase = 'main';
  const c3 = newInstance('LO-6856');
  c3.faceUp = true;
  gs3.players[0].hand.push(c3);
  const n3 = rules.requestHandDeclare(gs3, c3.uid);
  console.log('6856:', n3.prompt?.kind, 'log:', JSON.stringify(n3.log.slice(-2)));
}
