/*
 * 开发端入口（**只由 vite 插件在 VITE_DEV_TOOLS=1 时注入**，正式源码不引用它）
 *
 * 注入方式见 vite.config.ts 的 devToolsInject 插件：它在开发构建里往 index.html 追加
 * <script type="module"> import('/src/dev/entry.tsx') </script>。
 * 正式构建不注入 → 这个文件、ui/dev/*、core/devTest.ts 都不会出现在 dist 产物里。
 *
 * 它做两件事：
 *   1. 右下角放一个「🧪 测试模式」浮动按钮，并支持 F2 开关；
 *   2. 打开后挂载卡牌检索界面（复用 ui/dev/mountTestMode）。
 * 游戏状态通过战场暴露的通用调试钩子 window.__lyceeDebug 取得（正式版里该钩子不做任何事）。
 */
import { mountTestMode } from '../ui/dev/mountTestMode';

type GsLike = Parameters<typeof import('../core/devTest').devAddToHand>[0];
type DebugHook = () => { get: () => GsLike; set: (fn: (gs: GsLike) => GsLike) => void; cards: Parameters<typeof mountTestMode>[0]['cards'] };

const hook = () => (window as unknown as { __lyceeDebug?: DebugHook }).__lyceeDebug;

function mount(): void {
  // 等战场把调试钩子挂上（战场可能在任意时刻重建）
  const started = Date.now();
  const timer = setInterval(() => {
    const h = hook();
    if (!h) {
      if (Date.now() - started > 30000) clearInterval(timer);
      return;
    }
    if (!h().cards || h().cards.length === 0) return; // 卡牌还没加载完
    clearInterval(timer);
    install();
  }, 500);
}

function install(): void {
  let unmount: (() => void) | null = null;

  const btn = document.createElement('button');
  btn.textContent = '🧪 测试模式 (F2)';
  btn.title = '测试模式：按 F2 或点这里打开卡牌检索';
  Object.assign(btn.style, {
    position: 'fixed',
    right: '14px',
    bottom: '14px',
    zIndex: '9000',
    padding: '8px 12px',
    borderRadius: '8px',
    border: '1px solid #4a7',
    background: '#16341f',
    color: '#d9ffe4',
    fontSize: '13px',
    cursor: 'pointer',
  });
  document.body.appendChild(btn);

  const toggle = () => {
    if (unmount) {
      unmount();
      unmount = null;
      return;
    }
    if (!hook()) {
      // 还没进对局：先用通用调试钩子开一局沙盒（全卡表卡组），进战场后自己打开检索界面
      const start = (window as unknown as { __lyceeDebugStart?: (ids?: string[]) => void }).__lyceeDebugStart;
      if (!start) {
        alert('测试模式：找不到调试钩子（是不是还没加载完？请稍等再点）');
        return;
      }
      btn.textContent = '🧪 进入沙盒中…';
      start();
      let tries = 0;
      const wait = setInterval(() => {
        tries++;
        if (hook()) {
          clearInterval(wait);
          btn.textContent = '🧪 测试模式 (F2)';
          toggle();
        } else if (tries > 40) {
          clearInterval(wait);
          btn.textContent = '🧪 测试模式 (F2)';
        }
      }, 250);
      return;
    }
    const api = hook()!();
    unmount = mountTestMode({
      cards: api.cards as never,
      getGs: () => api.get() as never,
      apply: (fn) => api.set(fn as never),
      onOpenChange: (open) => {
        if (!open) unmount = null;
      },
    });
  };

  btn.onclick = toggle;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F2') {
      e.preventDefault();
      toggle();
    }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
