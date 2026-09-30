// 提取 lycee_rulemanual_web.pdf 的文本（pdf-parse）
import { readFileSync, writeFileSync } from 'node:fs';
import pdf from 'pdf-parse';

const buf = readFileSync('../lycee_rulemanual_web.pdf');
const data = await pdf(buf);
writeFileSync('tools/rulebook.txt', data.text, 'utf-8');
console.log('pages:', data.numpages, 'chars:', data.text.length);
console.log(data.text.slice(0, 600));
