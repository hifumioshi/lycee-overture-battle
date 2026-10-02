import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../types/net';

/**
 * 左下角的版本号 + 在线更新（类似网游：打开游戏自动检查，发现新版本一键重启更新）。
 * 更新源是 GitHub Releases；只有「安装版」能自动更新，便携版/解压版会提示去下载安装版。
 */
export default function VersionBadge() {
  const [version, setVersion] = useState('');
  const [st, setSt] = useState<UpdateStatus>({ state: 'idle' });

  useEffect(() => {
    let dead = false;
    const api = window.lyceeApp;
    if (!api) return;
    void (async () => {
      try {
        const v = await api.version();
        if (!dead) setVersion(v);
        const s = await api.updateStatus();
        if (!dead && s) setSt(s as UpdateStatus);
      } catch {
        /* 非 Electron 环境忽略 */
      }
    })();
    const off = api.onUpdateStatus((s) => setSt(s as UpdateStatus));
    return () => {
      dead = true;
      off();
    };
  }, []);

  if (!window.lyceeApp) return null;

  const check = () => void window.lyceeApp.checkUpdate().then((s) => setSt(s as UpdateStatus)).catch(() => {});
  const install = () => void window.lyceeApp.installUpdate();
  const releases = () => void window.lyceeApp.openReleases();

  let text = '';
  let extra: React.ReactNode = null;
  switch (st.state) {
    case 'idle':
      text = '';
      extra = (
        <button className="ver-btn" onClick={check}>
          检查更新
        </button>
      );
      break;
    case 'checking':
      text = '正在检查更新…';
      break;
    case 'latest':
      text = '已是最新版本';
      extra = (
        <button className="ver-btn" onClick={check}>
          再检查一次
        </button>
      );
      break;
    case 'available':
      text = `发现新版本 v${st.version}，开始下载…`;
      break;
    case 'downloading':
      text = `正在下载新版本${st.version ? ` v${st.version}` : ''} ${st.percent}%`;
      break;
    case 'ready':
      text = `新版本 v${st.version} 已下载完成`;
      extra = (
        <button className="ver-btn primary" onClick={install}>
          🔄 立即重启并更新
        </button>
      );
      break;
    case 'error':
      text = `更新检查失败：${st.message}`;
      extra = (
        <>
          <button className="ver-btn" onClick={check}>
            重试
          </button>
          <button className="ver-btn" onClick={releases}>
            手动下载
          </button>
        </>
      );
      break;
    case 'unsupported':
      text = st.message;
      extra = (
        <button className="ver-btn" onClick={releases}>
          下载安装版
        </button>
      );
      break;
  }

  return (
    <div className={`ver-badge state-${st.state}`}>
      <span className="ver-num">v{version || '—'}</span>
      {text && <span className="ver-text">{text}</span>}
      {extra}
    </div>
  );
}
