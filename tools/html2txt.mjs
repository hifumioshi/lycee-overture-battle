// HTML → 纯文本
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

for (const f of readdirSync('tools/rule-html')) {
  if (!f.endsWith('.html')) continue;
  let h = readFileSync('tools/rule-html/' + f, 'utf-8');
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
  h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
  h = h.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th)[^>]*>/gi, '\n');
  h = h.replace(/<[^>]+>/g, '');
  h = h
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)));
  h = h.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  writeFileSync('tools/rule-html/' + f.replace('.html', '.txt'), h);
}
console.log('done');
