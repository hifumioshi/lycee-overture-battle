// 抓取判例页面（text 模式）
import { writeFileSync } from 'node:fs';

const ids = ['0811_20171027', '0602_20171027', '0850_20221021'];
for (const id of ids) {
  const url = `https://lycee-tcg.com/rule/judgerule.pl?mode=text&id=${id}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  const file = `tools/rule-html/judge-${id}.txt`;
  writeFileSync(file, text);
  console.log(id, res.status, text.length);
  console.log(text.slice(0, 400));
  console.log('---');
}
