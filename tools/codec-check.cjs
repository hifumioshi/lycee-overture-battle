// 语音格式支持自检：npx electron tools/codec-check.cjs "音频文件路径"
// 用程序自带的 Electron 内核试着解析 + 播放，确认 .m4a(AAC) 能不能直接用
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.log('用法：npx electron tools/codec-check.cjs <音频文件路径>');
  app.exit(1);
}

const dir = path.join(__dirname, '_shots', 'codec');
fs.mkdirSync(dir, { recursive: true });
const base = path.basename(src);
fs.copyFileSync(src, path.join(dir, base));
const html = path.join(dir, 'codec.html');
fs.writeFileSync(
  html,
  `<!doctype html><html><body><script>
window.check = async (name) => {
  const a = new Audio(name);
  const meta = await new Promise((res) => {
    a.onloadedmetadata = () => res('loaded duration=' + a.duration.toFixed(2) + 's');
    a.onerror = () => res('LOAD-ERROR code=' + (a.error && a.error.code) + ' msg=' + (a.error && a.error.message));
    setTimeout(() => res('timeout(6s)'), 6000);
  });
  return {
    meta,
    canPlayM4a: a.canPlayType('audio/mp4'),
    canPlayAac: a.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
    canPlayMp3: a.canPlayType('audio/mpeg'),
  };
};
</script></body></html>`,
  'utf-8',
);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadFile(html);
  const r = await win.webContents.executeJavaScript(`window.check(${JSON.stringify(base)})`);
  console.log('RESULT ' + JSON.stringify(r, null, 2));
  const p = await win.webContents.executeJavaScript(
    `(async () => {
      const a = new Audio(${JSON.stringify(base)});
      try {
        await a.play();
        await new Promise((r) => setTimeout(r, 700));
        return 'play() 成功，已播放 ' + a.currentTime.toFixed(2) + 's / 总长 ' + a.duration.toFixed(2) + 's';
      } catch (e) {
        return 'play() 失败：' + e.message;
      }
    })()`,
  );
  console.log('PLAY ' + p);
  app.exit(0);
});
