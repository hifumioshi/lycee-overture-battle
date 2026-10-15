/*
 * 开发端：把测试模式检索界面挂到页面上（**仅开发构建**由战场动态 import）
 *
 * 为什么用 portal 挂载：这样战场里只需要一处很小的改动（一个 effect），
 * 不必动 3200 行组件的 JSX 结构，降低改坏正式代码的风险。
 */
import { createRoot, type Root } from 'react-dom/client';
import TestMode, { type TestModeTarget } from './TestMode';
import type { Card } from '../../core/cards';

export type MountOptions = {
  cards: Card[];
  /** 取当前局面（沙盒操作都基于它） */
  getGs: () => unknown;
  /** 应用一个"把 gs 变成新 gs"的函数（沿用战场上既有的提交逻辑） */
  apply: (mutate: (gs: never) => unknown) => void;
  /** 打开/关闭状态变化的回调（便于战场显示提示） */
  onOpenChange?: (open: boolean) => void;
};

/** 挂载检索界面，返回卸载函数 */
export function mountTestMode(opts: MountOptions): () => void {
  const host = document.createElement('div');
  host.setAttribute('data-dev-test-mode', '1');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  let open = true;

  const render = () => {
    if (!open) return;
    root.render(
      <TestMode
        cards={opts.cards}
        onPick={async (cardId: string, target: TestModeTarget) => {
          // 注意：必须"先算出新状态、再 apply 一次"。
          // 之前写成 opts.apply(() => { void import(...).then(...) }) —— 外层返回 undefined，
          // 会把游戏状态设成 undefined，界面直接白掉。
          const m = await import('../../core/devTest');
          const cur = opts.getGs() as Parameters<typeof m.devAddToHand>[0];
          const next =
            target === 'hand'
              ? m.devAddToHand(cur, cardId)
              : m.devPlaceCharacter(cur, cardId, 0, firstEmptyArea(cur));
          opts.apply(() => next as never);
        }}
        onUntap={() =>
          void import('../../core/devTest').then((m) => {
            const cur = opts.getGs() as never as Parameters<typeof m.devUntapAll>[0];
            opts.apply(() => m.devUntapAll(cur) as never);
          })
        }
        onFillHand={() =>
          void import('../../core/devTest').then((m) => {
            const cur = opts.getGs() as never as Parameters<typeof m.devFillHand>[0];
            opts.apply(() => m.devFillHand(cur, 7) as never);
          })
        }
        onClose={() => {
          open = false;
          opts.onOpenChange?.(false);
          unmount();
        }}
      />,
    );
  };

  const unmount = () => {
    try {
      root.unmount();
    } catch {
      /* 忽略 */
    }
    host.remove();
  };

  render();
  opts.onOpenChange?.(true);
  return unmount;
}

/** 找我方 AF 第一个空位（没有空位就退回左上） */
function firstEmptyArea(gs: { turnPlayer: 0 | 1; players: { field: (unknown | null)[][] }[] }): 0 | 1 | 2 {
  const row = gs.players[gs.turnPlayer].field[0];
  const i = row.findIndex((c) => !c);
  return (i === -1 ? 0 : i) as 0 | 1 | 2;
}
