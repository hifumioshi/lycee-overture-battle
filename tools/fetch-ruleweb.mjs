// 抓取 lycee-tcg.com 规则页 HTML
import { writeFileSync } from 'node:fs';

const base = 'https://lycee-tcg.com/rule/';
async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return res.ok ? res.text() : `HTTP ${res.status}`;
}
const index = await get(base + 'index.html');
console.log('index len', index.length);
console.log(index.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500));
// 找出链接
const links = [...index.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((l) => l.startsWith('index_') || l.includes('rule'));
console.log('links:', links);
writeFileSync('tools/rule-html/index.html', index);
for (const l of new Set(links)) {
  if (!l.startsWith('index_')) continue;
  const html = await get(base + l);
  const file = 'tools/rule-html/' + l;
  writeFileSync(file, html);
  console.log(l, html.length);
}
