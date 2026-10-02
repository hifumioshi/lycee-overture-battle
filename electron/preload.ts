// 预加载脚本：暴露联机服务器控制 API 给渲染进程
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

function subscribe(channel: string, cb: (...args: unknown[]) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('lyceeNet', {
  // 房主：启动/停止 WebSocket 服务器（支持多客户端：玩家2 + 观战者）
  startServer: (port: number) => ipcRenderer.invoke('net:start', port),
  stopServer: () => ipcRenderer.invoke('net:stop'),
  // 房主 → 广播给所有客户端 / 定向发送
  broadcast: (msg: string) => ipcRenderer.send('net:broadcast', msg),
  sendTo: (id: number, msg: string) => ipcRenderer.send('net:send-to', id, msg),
  // 房主：客户端连接/消息/断开事件（返回取消订阅函数）
  onClientConnected: (cb: (id: number) => void) => subscribe('net:client-connected', (id) => cb(id as number)),
  onClientMessage: (cb: (m: { id: number; msg: string }) => void) =>
    subscribe('net:client-message', (m) => cb(m as { id: number; msg: string })),
  onClientDisconnected: (cb: (id: number) => void) => subscribe('net:client-disconnected', (id) => cb(id as number)),
});

// 战歌：列出 songs 文件夹中的音频（文件名即选项名；通过 song:// 协议播放）
contextBridge.exposeInMainWorld('lyceeSongs', {
  list: () => ipcRenderer.invoke('songs:list') as Promise<{ file: string; name: string; url: string }[]>,
});

// 语音：列出 voices 文件夹中的语音包（包名即选项名；通过 voice:// 协议播放台词）
contextBridge.exposeInMainWorld('lyceeVoices', {
  list: () =>
    ipcRenderer.invoke('voices:list') as Promise<
      { name: string; actions: { folder: string; files: { file: string; url: string }[] }[] }[]
    >,
});

// 自建中继服务器地址（data/relay.txt，一行 ip:port；空字符串 = 用内置默认地址）
contextBridge.exposeInMainWorld('lyceeRelay', {
  url: () => ipcRenderer.invoke('relay:url') as Promise<string>,
});

// 版本号 + 在线更新（安装版可自动更新；便携版会提示下载安装版）
contextBridge.exposeInMainWorld('lyceeApp', {
  version: () => ipcRenderer.invoke('app:version') as Promise<string>,
  updateStatus: () => ipcRenderer.invoke('app:update-status') as Promise<unknown>,
  checkUpdate: () => ipcRenderer.invoke('app:check-update') as Promise<unknown>,
  installUpdate: () => ipcRenderer.invoke('app:install-update') as Promise<{ ok: boolean; message?: string }>,
  openReleases: () => ipcRenderer.invoke('app:open-releases') as Promise<{ ok: boolean; message?: string }>,
  onUpdateStatus: (cb: (s: unknown) => void) => subscribe('update:status', (s) => cb(s)),
});
