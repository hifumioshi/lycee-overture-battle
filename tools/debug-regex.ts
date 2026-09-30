// 正则调试
const statRe = new RegExp(
  `^に(ＡＰ|ＤＰ|ＳＰ|ＤＭＧ)([＋－])([０-９]+)((?:・(ＡＰ|ＤＰ|ＳＰ|ＤＭＧ)([＋－])([０-９]+))*)(?:する|できる)?`,
);
for (const s of ['にＡＰ＋２・ＤＰ＋２する', 'にＤＰ＋５', 'にＡＰ－１', 'にＡＰ＋５・ＤＰ＋１する。']) {
  const m = statRe.exec(s);
  console.log(JSON.stringify(s), '→', m ? JSON.stringify(m.slice(0)) : 'no match');
}
const inline = /^([^、。]{0,80}?に)ＡＰ([＋－])([０-９]+)またはＤＰ([＋－])([０-９]+)(する|できる)?([。]?)([\s\S]*)$/;
for (const s of ['味方ＡＦキャラ１体にＡＰ＋５またはＤＰ＋５', '味方ＡＦキャラ１体にＡＰ＋５またはＤＰ＋５できる']) {
  const m = inline.exec(s);
  console.log(JSON.stringify(s), '→', m ? JSON.stringify(m.slice(1)) : 'no match');
}
