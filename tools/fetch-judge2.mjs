// 抓取装备相关判例
import { writeFileSync } from 'node:fs';

const ids = ['0814_20171027', '0240_20171027'];
for (const id of ids) {
  const url = `https://lycee-tcg.com/rule/judgerule.pl?mode=text&id=${id}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  let text = await res.text();
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const file = `tools/rule-html/judge-${id}.txt`;
  writeFileSync(file, text);
  console.log(id, res.status, text.length);
}
