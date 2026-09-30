import { app, BrowserWindow, shell, ipcMain, protocol, net } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

// 战歌 / 语音 自定义协议（本地播放 mp3/wav/ogg/m4a）：
//   song://local/<文件名>
//   voice://local/<语音包名>/<行为文件夹>/<台词文件>
protocol.registerSchemesAsPrivileged([
  { scheme: 'song', privileges: { stream: true, secure: true, supportFetchAPI: true } },
  { scheme: 'voice', privileges: { stream: true, secure: true, supportFetchAPI: true } },
]);

/** 自建中继地址：程序目录下 data/relay.txt（一行 ip:port）；不存在则用内置默认 */
function relayUrlFile(): string {
  return path.join(app.getPath('userData'), '..', 'relay.txt');
}

/** 战歌文件夹：数据目录下 songs（与卡组数据同目录，打包恢复时不丢） */
function songsDir(): string {
  return path.join(app.getPath('userData'), '..', 'songs');
}

/** 语音文件夹：数据目录下 voices/<语音包名>/<行为>/<台词文件> */
function voicesDir(): string {
  return path.join(app.getPath('userData'), '..', 'voices');
}

/** 语音包清单：data/voices/<包名>/<行为文件夹>/<音频文件> */
function listVoices() {
  const root = voicesDir();
  const audio = /\.(mp3|wav|ogg|m4a|flac)$/i;
  let packNames: string[] = [];
  try {
    packNames = fs.readdirSync(root).filter((n) => {
      try {
        return fs.statSync(path.join(root, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  return packNames.map((pack) => {
    const actions: { folder: string; files: { file: string; url: string }[] }[] = [];
    try {
      for (const folder of fs.readdirSync(path.join(root, pack))) {
        const dir = path.join(root, pack, folder);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        const files = fs
          .readdirSync(dir)
          .filter((f) => audio.test(f))
          .map((f) => ({ file: f, url: `voice://local/${encodeURIComponent(pack)}/${encodeURIComponent(folder)}/${encodeURIComponent(f)}` }));
        if (files.length > 0) actions.push({ folder, files });
      }
    } catch {
      /* 忽略单个包的错误 */
    }
    return { name: pack, actions };
  });
}

// 把应用数据目录（缓存/网络数据等）放到可写位置：
// 开发时放项目内 data/user-data；打包后放 exe 旁边的 data/user-data（便携，且不在只读的 asar 内）。
// 便携版（portable）运行时 process.execPath 是临时解压路径，用 PORTABLE_EXECUTABLE_DIR 定位原始 exe。
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
app.setPath(
  'userData',
  portableDir
    ? path.join(portableDir, 'data', 'user-data')
    : app.isPackaged
      ? path.join(path.dirname(process.execPath), 'data', 'user-data')
      : path.join(__dirname, '..', 'data', 'user-data'),
);

// ===== 联机服务器（房主模式）：支持多客户端（玩家2 + 观战者） =====
let wss: WebSocketServer | null = null;
const clients = new Map<number, WebSocket>();
let nextClientId = 1;

function sendToClient(ws: WebSocket | undefined, msg: string): void {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
  } catch {
    /* 忽略 */
  }
}

function setupNetIpc(win: BrowserWindow): void {
  ipcMain.handle('net:start', (_e, port: number) => {
    return new Promise<{ ok: boolean; message?: string }>((resolve) => {
      try {
        if (wss) {
          for (const ws of clients.values()) ws.close();
          clients.clear();
          wss.close();
          wss = null;
        }
        wss = new WebSocketServer({ port });
        wss.on('listening', () => resolve({ ok: true }));
        wss.on('error', (err) => {
          resolve({ ok: false, message: err.message });
        });
        wss.on('connection', (ws) => {
          const id = nextClientId++;
          clients.set(id, ws);
          // 告知客户端自己的 id（用于识别身份）
          sendToClient(ws, JSON.stringify({ type: 'welcome', id }));
          win.webContents.send('net:client-connected', id);
          ws.on('message', (data) => {
            win.webContents.send('net:client-message', { id, msg: data.toString() });
          });
          ws.on('close', () => {
            if (clients.get(id) === ws) clients.delete(id);
            win.webContents.send('net:client-disconnected', id);
          });
          ws.on('error', () => {
            /* 忽略单个连接错误 */
          });
        });
      } catch (err) {
        resolve({ ok: false, message: String(err) });
      }
    });
  });

  ipcMain.handle('net:stop', () => {
    try {
      for (const ws of clients.values()) ws.close();
      clients.clear();
      wss?.close();
      wss = null;
    } catch {
      /* 忽略 */
    }
    return { ok: true };
  });

  // 房主 → 广播给所有客户端（房间状态 / 对局状态）
  ipcMain.on('net:broadcast', (_e, msg: string) => {
    for (const ws of clients.values()) sendToClient(ws, msg);
  });

  // 房主 → 定向发送给指定客户端
  ipcMain.on('net:send-to', (_e, id: number, msg: string) => {
    sendToClient(clients.get(id), msg);
  });
}

// 主进程：负责创建窗口。游戏逻辑全部在渲染进程（网页）中运行。
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Lycee Overture 对战平台',
    backgroundColor: '#1a2332',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 外部链接用系统浏览器打开（避免在应用内跳转）
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    // 入口在 dist-electron/main.js，dist 在项目根（打包后 resources/app/dist）
    // SHOT_DETAIL=1 时带 #debug-detail 锚点加载（自动打开第一张卡详情，供截图自检）
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      hash: process.env.SHOT_DETAIL ? 'debug-detail' : '',
    });
  }

  // 开发自检用：设置 SHOT_PATH 时，页面加载完成后截图保存并退出（用于无人值守验证界面渲染）
  const shotPath = process.env.SHOT_PATH ?? '';
  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          // 可选：SHOT_DUMP 指向的文件路径，导出页面关键文本（用于无头验证）
          const dumpPath = process.env.SHOT_DUMP ?? '';
          if (dumpPath) {
            const dump = await win.webContents.executeJavaScript(
              `(() => {
                const active = document.querySelector('.top-nav button.active')?.textContent ?? '';
                const zones = [...document.querySelectorAll('.zone')].map((e) => {
                  const label = e.querySelector('.zone-label')?.textContent ?? '';
                  const count = e.querySelector('.zone-count')?.textContent ?? '0';
                  const hasDeck = !!e.querySelector('.card-back');
                  return label + '=' + count + (hasDeck ? '(deck)' : '');
                });
                const slots = [...document.querySelectorAll('.field-slot')].map((e) =>
                  e.classList.contains('occupied') ? 'X' : '_'
                ).join('');
                const tags = [...document.querySelectorAll('.ability-tag')].map((e) => e.textContent.trim());
                const name = document.querySelector('.modal-info h2')?.textContent ?? '';
                const log = [...document.querySelectorAll('.battle-log div')].map((e) => e.textContent).join(' | ');
                const prompt = document.querySelector('.prompt-modal h3')?.textContent ?? '';
                return JSON.stringify({ active, zones, slots, tags, name, log, prompt }, null, 2);
              })()`,
            );
            fs.writeFileSync(dumpPath, dump, 'utf-8');
            console.log(`[dump] saved to ${dumpPath}`);
          }
          // 可选：SHOT_TEST 指向的文件路径，模拟点击操作并导出结果（无头交互自检）
          const testPath = process.env.SHOT_TEST ?? '';
          if (testPath) {
            const result = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              const q = (sel) => document.querySelector(sel);
              const btns = (sel) => [...document.querySelectorAll(sel)];
              const byText = (arr, t) => arr.find((b) => (b.textContent ?? '').includes(t));
              const out = {};
              // 1. 主菜单 → "卡组制作"
              out.menuTitle = q('.main-menu h1')?.textContent ?? '';
              const deckBtn = byText(btns('.menu-btn'), '卡组制作');
              if (deckBtn) click(deckBtn);
              await sleep(400);
              out.deckLoaded = !!q('.deck-builder');
              // 2. 加 3 张卡到牌组
              const poolCards = document.querySelectorAll('.deck-pool-card');
              for (let i = 0; i < 3 && i < poolCards.length; i++) {
                click(poolCards[i]);
                await sleep(80);
              }
              // 3. 输入名称并保存
              const nameInput = q('.deck-name-input');
              if (nameInput) {
                nameInput.value = '测试卡组A';
                nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                await sleep(100);
              }
              const saveBtn = byText(btns('.deck-actions button'), '保存卡组');
              if (saveBtn) click(saveBtn);
              await sleep(300);
              out.deckCount = q('.deck-count')?.textContent ?? '';
              out.savedChips = btns('.deck-chip').map((b) => (b.textContent ?? '').trim());
              // 4. 返回主菜单 → 开始对战 → 选卡组
              const back = byText(btns('.top-nav button'), '主菜单');
              if (back) click(back);
              await sleep(300);
              const start = byText(btns('.menu-btn'), '开始对战');
              if (start) click(start);
              await sleep(400);
              out.deckSelectShown = !!q('.deck-select');
              out.deckCards = btns('.deck-select-card').map((b) => (b.textContent ?? '').trim());
              // 5. 点击保存的"卡组 1"（非随机）
              const savedDeckBtn = byText(btns('.deck-select-card'), '卡组 1');
              if (savedDeckBtn) click(savedDeckBtn);
              await sleep(500);
              out.battleLoaded = !!q('.side-field');
              out.activeDeck = JSON.stringify((window).__activeDeck ?? null);
              out.deckLength = ((window).__activeDeck ?? []).length;
              return out;
            })()`);
            fs.writeFileSync(testPath, JSON.stringify(result, null, 2), 'utf-8');
            console.log(`[test] saved to ${testPath}`);
          }

          // 可选：SHOT_ROOM 指向的文件路径，无头验证房间系统（观战席/上桌/准备→开始）
          const roomTestPath = process.env.SHOT_ROOM ?? '';
          // 模拟客户端 A/B 用哪个中继服务器（默认本机；设为 SHOT_RELAY=ip:port 可测公网服务器）
          const relayTarget = process.env.SHOT_RELAY ?? '127.0.0.1:9600';
          if (roomTestPath) {
            const result = await win.webContents.executeJavaScript(`(async () => {
              try {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              const q = (sel) => document.querySelector(sel);
              const qa = (sel) => [...document.querySelectorAll(sel)];
              const byText = (arr, t) => arr.find((b) => (b.textContent ?? '').includes(t));
              // 轮询等待元素出现（公网地址连不上时客户端会兜底重试，需要留足时间）
              const waitFor = async (sel, ms) => {
                for (let i = 0; i < Math.ceil(ms / 250); i++) {
                  if (q(sel)) return true;
                  await sleep(250);
                }
                return false;
              };
              const out = {};
              // 捕获渲染进程错误
              window.__errs = [];
              window.addEventListener('error', (e) => window.__errs.push('err:' + String(e.message)));
              window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej:' + String(e.reason)));
              out.rendererErrors = [];
              // 诊断：拦截 WebSocket 收发，记录房间相关关键帧（定位"房主是否收到/发出房间消息"）
              window.__frames = [];
              const t0 = Date.now();
              const stamp = () => Date.now() - t0;
              const keyOf = (s) =>
                s.indexOf('peer-joined') >= 0 ||
                s.indexOf('peer-left') >= 0 ||
                s.indexOf('spectators') >= 0 ||
                s.indexOf('"t":"create"') >= 0 ||
                s.indexOf('"t":"join"') >= 0 ||
                s.indexOf('"t":"deck"') >= 0;
              try {
                const OrigWS = window.WebSocket;
                let sockSeq = 0;
                const TrackWS = function (u, p) {
                  const sock = new OrigWS(u, p);
                  const id = ++sockSeq;
                  window.__frames.push(stamp() + ' new socket #' + id + ' ' + String(u).slice(-24));
                  sock.addEventListener('message', (e) => {
                    const s = String(e.data);
                    if (keyOf(s)) window.__frames.push(stamp() + ' IN#' + id + ' ' + s.slice(0, 100));
                  });
                  sock.addEventListener('close', () => window.__frames.push(stamp() + ' CLOSED#' + id));
                  sock.addEventListener('error', () => window.__frames.push(stamp() + ' ERR#' + id));
                  const origSend = sock.send.bind(sock);
                  sock.send = (d) => {
                    const s = String(d);
                    const kind = s.slice(0, 22);
                    window.__frames.push(stamp() + ' OUT#' + id + ' ' + kind + ' len=' + s.length);
                    return origSend(d);
                  };
                  return sock;
                };
                TrackWS.prototype = OrigWS.prototype;
                TrackWS.CONNECTING = OrigWS.CONNECTING;
                TrackWS.OPEN = OrigWS.OPEN;
                TrackWS.CLOSING = OrigWS.CLOSING;
                TrackWS.CLOSED = OrigWS.CLOSED;
                window.WebSocket = TrackWS;
              } catch (e) {
                window.__frames.push('patch failed: ' + String(e));
              }
              // 0. 先在「卡组制作」造一副 60 张的卡组并绑定语音包（验证语音下拉 + 卡组绑定）
              await waitFor('.menu-btn', 20000); // 等卡牌数据加载完、主菜单出现
              const deckBtn = byText(qa('.menu-btn'), '卡组制作');
              if (deckBtn) click(deckBtn);
              out.deckBuilder = await waitFor('.deck-builder', 8000);
              const pool = qa('.deck-pool-card');
              for (let i = 0; i < 60 && i < pool.length; i++) {
                click(pool[i]);
                if (i % 10 === 9) await sleep(60);
              }
              out.deckCountText = q('.deck-count')?.textContent ?? '';
              // React 受控输入需要用原生 setter 才能触发 onChange
              const setReactValue = (el, value) => {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(el, value);
                el.dispatchEvent(new Event('input', { bubbles: true }));
              };
              const nameInput = q('.deck-name-input');
              if (nameInput) {
                setReactValue(nameInput, '语音测试卡组');
                await sleep(150);
              }
              const voiceSel = q('.deck-voice-select');
              out.voiceOptions = voiceSel ? [...voiceSel.options].map((o) => o.textContent) : [];
              const songSel = q('.deck-song-select');
              out.songOptions = songSel ? [...songSel.options].map((o) => o.textContent) : [];
              if (voiceSel) {
                const opt = [...voiceSel.options].find((o) => o.value && o.value !== '');
                if (opt) {
                  voiceSel.value = opt.value;
                  voiceSel.dispatchEvent(new Event('change', { bubbles: true }));
                }
                out.voiceSelected = voiceSel.value;
                await sleep(150);
              } else {
                out.voiceSelected = '(没有语音下拉)';
              }
              const saveBtn0 = byText(qa('.deck-actions button'), '保存卡组');
              if (saveBtn0) click(saveBtn0);
              await sleep(400);
              out.savedDeckChips = qa('.deck-chip').map((b) => (b.textContent ?? '').trim());
              const backBtn = byText(qa('.top-nav button'), '主菜单');
              if (backBtn) click(backBtn);
              await sleep(400);

              // 1. 主菜单 → 多人游戏（直接进房间列表页）
              const multiBtn = byText(qa('.menu-btn'), '多人游戏');
              if (multiBtn) click(multiBtn);
              out.multiPage = await waitFor('.multi-page', 8000);
              out.connected = await waitFor('.multi-status.on', 20000);
              // 2. 创建房间 → 进入房间大厅
              const createBtn = q('.multi-create button.primary');
              if (createBtn) click(createBtn);
              out.lobby = await waitFor('.room-lobby', 20000);
              out.seat1Name = q('.room-seat:nth-child(1) .room-seat-name')?.textContent ?? '';
              // 3. 房内选卡组：点「选择卡组」→ 选刚做好、绑了语音的卡组
              const pickBtn = byText(qa('.room-controls button'), '选择卡组');
              if (pickBtn) click(pickBtn);
              out.pickOpened = await waitFor('.deck-pick-layer', 4000);
              const pickedDeck =
                byText(qa('.deck-pick-layer .deck-select-card'), '语音测试卡组') ?? q('.deck-pick-layer .deck-select-card.random');
              out.pickedDeckText = pickedDeck?.textContent ?? '';
              if (pickedDeck) click(pickedDeck);
              out.deckPicked = (await waitFor('.room-seat-deck', 4000)) ? (q('.room-seat.occupied .room-seat-deck')?.textContent ?? '') : '';
              // 未选卡组时「准备」应被禁用（用另一个座位验证不了，这里只验证已选后可准备）
              const readyBtn0 = byText(qa('.room-controls button'), '准备');
              out.readyEnabledAfterPick = !!readyBtn0 && !readyBtn0.disabled;
              // 4. 房主单独点准备（此时房间里只有房主）
              const readyBtn = byText(qa('.room-controls button'), '准备');
              if (readyBtn) click(readyBtn);
              await sleep(400);
              out.hostOnlyReadyOk = !!q('.room-lobby') && !!byText(qa('.room-controls button'), '取消准备');
              out.hostReadyBtn = byText(qa('.room-controls button'), '取消准备')?.textContent ?? '';
              out.rendererErrors = window.__errs.slice();
              // 5. 通过中继服务器模拟：客户端 A（上桌玩家2）+ 客户端 B（观战者）
              const RELAY = 'ws://${relayTarget}';
              const roomId = await new Promise((res) => {
                try {
                  const s = new WebSocket(RELAY);
                  s.onopen = () => s.send(JSON.stringify({ t: 'list' }));
                  s.onmessage = (e) => {
                    const m = JSON.parse(e.data);
                    if (m.t === 'rooms') { s.close(); res((m.rooms[0] || {}).id ?? null); }
                  };
                  setTimeout(() => res(null), 3000);
                } catch { res(null); }
              });
              out.roomId = roomId;
              const mkClient = (name) => {
                const c = new WebSocket(RELAY);
                c.roomState = null; c.gotState = false; c.cid = null; c.types = []; c.roomCount = 0; c.log = [];
                c.onmessage = (e) => {
                  const m = JSON.parse(e.data);
                  if (m.t === 'joined') {
                    c.cid = m.cid;
                    c.log.push(stamp() + ' joined cid=' + m.cid);
                    c.send(JSON.stringify({ t: 'relay', to: -1, msg: JSON.stringify({ type: 'hello', name }) }));
                  } else if (m.t === 'relay') {
                    const inner = JSON.parse(m.msg);
                    c.types.push(inner.type);
                    c.log.push(stamp() + ' ' + inner.type + (inner.type === 'room' ? '(' + (inner.room?.spectators ?? []).map((s) => s.name).join(',') + ')' : ''));
                    if (inner.type === 'room') { c.roomState = inner.room; c.roomCount++; }
                    if (inner.type === 'state') c.gotState = true;
                    if (inner.type === 'ack') { (c.acks = c.acks || []).push(inner); }
                  } else {
                    c.types.push('srv:' + m.t);
                    c.log.push(stamp() + ' srv:' + m.t);
                  }
                };
                return c;
              };
              // 轮询等待条件成立（公网中继有延迟，固定 sleep 不够）
              const waitUntil = async (fn, ms) => {
                for (let i = 0; i < Math.ceil(ms / 250); i++) {
                  if (fn()) return true;
                  await sleep(250);
                }
                return !!fn();
              };
              const a = mkClient('小明');
              await new Promise((r) => { a.onopen = r; });
              a.send(JSON.stringify({ t: 'join', roomId, playerName: '小明' }));
              await sleep(500);
              a.send(JSON.stringify({ t: 'relay', to: -1, msg: JSON.stringify({ type: 'sit' }) }));
              out.aInRoom = await waitUntil(() => a.roomState?.seat2?.name === '小明', 10000);
              // 客机 A 在房内选卡组（随机 20 张）→ 房主/观战者都应能看到卡组名
              a.send(JSON.stringify({ t: 'relay', to: -1, msg: JSON.stringify({ type: 'deck', deckName: '小明卡组', deck: Array(20).fill('LO-6845'), count: 20 }) }));
              a.send(JSON.stringify({ t: 'relay', to: -1, msg: JSON.stringify({ type: 'ready', count: 20 }) }));
              const b = mkClient('小红');
              await new Promise((r) => { b.onopen = r; });
              b.send(JSON.stringify({ t: 'join', roomId, playerName: '小红' }));
              out.bSpectator = await waitUntil(() => (b.roomState?.spectators ?? []).some((s) => s.name === '小红'), 10000);
              // 6. 等待对局开始（房主界面出现战场）
              let battleSeen = false;
              for (let i = 0; i < 40 && !battleSeen; i++) {
                await sleep(250);
                if (q('.side-field')) battleSeen = true;
              }
              out.battleStarted = battleSeen;
              out.hostTurnInfo = q('.turn-info')?.textContent ?? '';
              out.hostSideLabels = qa('.side-player-label').map((e) => e.textContent.trim()).join(' | ');
              out.hostNetPlayer = q('.net-player')?.textContent ?? '';
              // 7. 走完开局流程（石头剪刀布 → 确认 → 双方起手换牌）→ 点「开始回合」→ 检查语音 + 操作回执
              const clientAction = (action, args) =>
                a.send(JSON.stringify({ t: 'relay', to: -1, msg: JSON.stringify({ type: 'action', action, args }) }));
              // 新协议：带确认的操作（opId + rev），房主应回 ack
              let opSeq = 0;
              const clientOp = (action, args) => {
                opSeq++;
                const opId = 'e2e-' + opSeq;
                a.send(JSON.stringify({ t: 'relay', to: -1, msg: JSON.stringify({ type: 'op', opId, action, args, rev: 0 }) }));
                return opId;
              };
              let voicePlayedText = '';
              for (let step = 0; step < 40 && !voicePlayedText; step++) {
                await sleep(400);
                const btns = qa('.prompt-actions button, .mulligan-panel button');
                const findBtn = (t) => btns.find((b) => (b.textContent ?? '').includes(t));
                const beginBtn = byText(qa('.battle-actions button'), '开始回合');
                if (beginBtn) {
                  out.beginTurnBtn = beginBtn.textContent ?? '';
                  click(beginBtn);
                  await sleep(700);
                  voicePlayedText = window.__lastVoice ? String(window.__lastVoice) : '';
                  continue;
                }
                if (findBtn('石头') && !out.rpsSent) {
                  out.rpsSent = true;
                  click(findBtn('石头'));
                  out.opIdSent = clientOp('chooseRps', [1, 'scissors']);
                  continue;
                }
                if (findBtn('开始起手换牌')) {
                  click(findBtn('开始起手换牌'));
                  continue;
                }
                if (q('.mulligan-panel')) {
                  const mine = (q('.mulligan-panel p')?.textContent ?? '').includes('玩家 1');
                  if (mine && !out.mulliganSent) {
                    // 房主（先攻）先决定 → 保留手牌；随后轮到客机，由测试客户端代它决定
                    click(findBtn('保留手牌'));
                    out.mulliganSent = true;
                    await sleep(900);
                    clientAction('chooseMulligan', [false]);
                  }
                  continue;
                }
                out.stuckPrompt = q('.prompt-modal h3, .mulligan-panel h3')?.textContent ?? q('.turn-info')?.textContent ?? '';
              }
              out.voicePlayed = voicePlayedText;
              out.hostTurnAfterBegin = q('.turn-info')?.textContent ?? '';
              // 操作回执 + 同步诊断条
              out.ackList = (a.acks || []).map((k) => k.opId + ':' + (k.ok ? 'ok' : 'fail') + (k.reason ? '/' + k.reason : ''));
              out.diagText = q('.sync-diag')?.textContent ?? '';
              out.bPhase = b.roomState?.phase;
              out.bSpectatorDuringPlay = !!b.roomState && b.roomState.phase === 'playing' && (b.roomState.spectators ?? []).some((s) => s.name === '小红');
              out.bGotState = await waitUntil(() => b.gotState, 10000);
              out.aSeat2 = a.roomState?.seat2?.name ?? null;
              // 双方都能看到对方选的卡组名（房主界面 + 客机/观战者收到的房间状态）
              out.aSeesSeat1Deck = a.roomState?.seat1?.deckName ?? null;
              out.aSeesSeat2Deck = a.roomState?.seat2?.deckName ?? null;
              out.bSeesDecks = [b.roomState?.seat1?.deckName, b.roomState?.seat2?.deckName].join(' / ');
              // 诊断：B 收到的消息类型 / 最后一份房间状态 / 房主侧日志
              out.aTypes = a.types.join(',');
              out.bTypes = b.types.join(',');
              out.bRoomCount = b.roomCount;
              out.bRoomJson = JSON.stringify(b.roomState ?? null).slice(0, 400);
              out.hostLogTail = (q('.battle-log')?.textContent ?? '').slice(-260);
              out.aCid = a.cid;
              out.bCid = b.cid;
              out.hostNetStatus = q('.net-status')?.textContent ?? '';
              out.hostJoinTexts = document.body.innerText
                .split(String.fromCharCode(10))
                .filter((l) => l.indexOf('加入') >= 0)
                .slice(0, 8)
                .join(' | ');
              out.frames = window.__frames.slice(0, 90);
              out.aLog = a.log.slice(0, 20);
              out.bLog = b.log.slice(0, 20);
              a.close(); b.close();
              return out;
              } catch (e) {
                return { scriptError: String(e), scriptStack: String((e && e.stack) || '').slice(0, 600) };
              }
            })()`);
            fs.writeFileSync(roomTestPath, JSON.stringify(result, null, 2), 'utf-8');
            console.log(`[room] saved to ${roomTestPath}`);
          }

          const image = await win.webContents.capturePage();
          fs.writeFileSync(shotPath, image.toPNG());
          console.log(`[screenshot] saved to ${shotPath}`);
          app.quit();
        })();
      }, 4000);
    });
  }

  return win;
}

void app.whenReady().then(() => {
  // 战歌：读取 songs 目录列表（渲染端下拉用）；协议读取本地音频文件
  fs.mkdirSync(songsDir(), { recursive: true });
  ipcMain.handle('songs:list', () => {
    try {
      const names = fs.readdirSync(songsDir()).filter((f) => /\.(mp3|wav|ogg|m4a|flac)$/i.test(f));
      return names.map((f) => ({ file: f, name: f.replace(/\.[^.]+$/, ''), url: `song://local/${encodeURIComponent(f)}` }));
    } catch {
      return [];
    }
  });
  protocol.handle('song', (req) => {
    try {
      const u = new URL(req.url);
      const file = decodeURIComponent(u.pathname.replace(/^\//, ''));
      const p = path.join(songsDir(), path.basename(file));
      return net.fetch(pathToFileURL(p).toString());
    } catch {
      return new Response('', { status: 404 });
    }
  });
  // 语音：读取 data/voices 下的语音包清单（渲染端下拉/播放用）
  fs.mkdirSync(voicesDir(), { recursive: true });
  ipcMain.handle('voices:list', () => listVoices());
  // 自建中继服务器地址（data/relay.txt，一行 ip:port；没有则返回空 = 用内置默认）
  ipcMain.handle('relay:url', () => {
    try {
      const raw = fs.readFileSync(relayUrlFile(), 'utf-8');
      return (raw.split(/\r?\n/)[0] ?? '').trim();
    } catch {
      return '';
    }
  });
  protocol.handle('voice', (req) => {
    try {
      const u = new URL(req.url);
      const parts = u.pathname
        .replace(/^\//, '')
        .split('/')
        .map((s) => decodeURIComponent(s))
        .filter(Boolean);
      if (parts.length < 3) return new Response('', { status: 404 });
      const [pack, folder, file] = parts;
      // 只允许 voices/<包>/<行为>/<文件> 三层，避免越权读取
      const p = path.join(voicesDir(), path.basename(pack), path.basename(folder), path.basename(file));
      return net.fetch(pathToFileURL(p).toString());
    } catch {
      return new Response('', { status: 404 });
    }
  });
  const win = createWindow();
  setupNetIpc(win);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
