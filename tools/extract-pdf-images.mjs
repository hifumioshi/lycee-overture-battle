// 从 PDF 提取图像 XObject（DCTDecode/FlateDecode）流
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const buf = readFileSync('../lycee_rulemanual_web.pdf');
const text = buf.toString('latin1');
let n = 0;
const objRe = /(\d+)\s+0\s+obj\s*<<([\s\S]*?)>>\s*stream\r?\n?/g;
let m;
const out = [];
while ((m = objRe.exec(text)) !== null) {
  const head = m[2];
  if (!/Subtype\s*\/Image/.test(head)) continue;
  const filter = /\/Filter\s*(\/DCTDecode|\/FlateDecode)/.exec(head);
  if (!filter) continue;
  const lenM = /\/Length\s+(\d+)/.exec(head);
  if (!lenM) continue;
  const len = parseInt(lenM[1], 10);
  const start = objRe.lastIndex;
  let data = buf.subarray(start, start + len);
  if (filter[1] === '/FlateDecode') {
    try {
      data = inflateSync(data);
    } catch {
      continue;
    }
  }
  const widthM = /\/Width\s+(\d+)/.exec(head);
  const heightM = /\/Height\s+(\d+)/.exec(head);
  const isJpeg = data[0] === 0xff && data[1] === 0xd8;
  const isPng = data[0] === 0x89 && data[1] === 0x50;
  const ext = isJpeg ? 'jpg' : isPng ? 'png' : 'raw';
  n++;
  const file = `tools/rulebook-pages/${String(n).padStart(3, '0')}_${widthM?.[1] ?? '?'}x${heightM?.[1] ?? '?'}.${ext}`;
  writeFileSync(file, data);
  out.push(file);
}
console.log(out.join('\n'));
console.log('total:', n);
