// 包装测试文件中的 rules.xxx(...) 调用为 settle(...)（跳过 settle 函数本体）
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'tools/test-rules.ts';
let t = readFileSync(p, 'utf-8');
// 去掉 settle 函数本体，处理完再加回来
const settleStart = t.indexOf('function settle(');
const settleEnd = t.indexOf('function handOf(');
const settleCode = t.slice(settleStart, settleEnd);
t = t.slice(0, settleStart) + t.slice(settleEnd);

const re = /(let |const )?([A-Za-z0-9_]+)( = rules\.)([A-Za-z0-9_]+)\(/g;
const out = [];
let last = 0;
let m;
while ((m = re.exec(t)) !== null) {
  const start = m.index;
  let depth = 0;
  let i = re.lastIndex - 1;
  for (; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  const callEnd = i + 1;
  out.push(t.slice(last, start));
  out.push(`${m[1] ?? ''}${m[2]} = settle(rules.${m[4]}(`);
  out.push(t.slice(re.lastIndex, callEnd));
  out.push(')');
  last = callEnd;
  re.lastIndex = callEnd;
}
out.push(t.slice(last));
const result = out.join('');
const final = result.slice(0, settleStart) + settleCode + result.slice(settleStart);
writeFileSync(p, final);
console.log('wrapped calls:', (result.match(/settle\(rules\./g) || []).length);
