// 解析器自测：用扫描到的全部真实基本能力格式验证（复制自 src/core/cards.ts 的实现）
import { readFile } from 'node:fs/promises';

function parseBasicAbilities(raw) {
  if (!raw) return [];
  const out = [];
  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '[') { if (depth === 0) start = i; depth++; }
    else if (ch === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        const token = raw.slice(start + 1, i);
        const colon = token.indexOf(':');
        const tag = (colon >= 0 ? token.slice(0, colon) : token).trim();
        let value = (colon >= 0 ? token.slice(colon + 1) : '').trim();
        if (value.startsWith('[') && value.endsWith(']')) {
          let d = 0, balanced = true;
          for (let j = 0; j < value.length; j++) {
            if (value[j] === '[') d++;
            else if (value[j] === ']') { d--; if (d < 0) { balanced = false; break; } }
          }
          if (balanced && d === 0) value = value.slice(1, -1).trim();
        }
        out.push({ tag, value });
        start = -1;
      }
    }
  }
  return out;
}

const cards = JSON.parse(await readFile('data/cards/range.json', 'utf-8'));
const seen = new Set();
let fail = 0;
for (const c of cards) {
  const raw = c.basicAbilities || '';
  if (!raw || seen.has(raw)) continue;
  seen.add(raw);
  const parsed = parseBasicAbilities(raw);
  // 自检：tag 必须在 19 种基本能力内
  const known = ['ステップ','サイドステップ','オーダーステップ','オーダーチェンジ','ジャンプ','ペナルティ','アグレッシブ','アシスト','エンゲージ','リカバリー','ガッツ','リーダー','サポーター','ボーナス','チャージ','ターンリカバリー','プリンシパル','サプライズ','コンバート'];
  const bad = parsed.filter((p) => !known.includes(p.tag));
  if (bad.length > 0) { fail++; console.log('✗ 未知能力:', raw, '->', parsed); continue; }
  console.log('✓', raw.padEnd(60), '->', parsed.map((p) => `${p.tag}${p.value ? ':' + p.value : ''}`).join(' | '));
}
console.log('\n共', seen.size, '种格式，未知能力格式:', fail);
