# 单人测试模式：接线待办（下一步就做这些）

> 零件已完成，**只差接线**。这份清单是为了让下一次开工能 2~3 步内做完，不用重新摸代码。

## 已完成（可直接用）

| 文件 | 内容 |
|---|---|
| `src/core/devTest.ts` | 沙盒辅助：`devAddToHand(gs, cardId)`、`devPlaceCharacter(gs, cardId, row, area)`、`devUntapAll(gs)`、`devFillHand(gs, n)`、`devHasCard(gs, cardId)` |
| `src/ui/dev/TestMode.tsx` | 检索界面（属性 雪/花/宙/日/月、类别 角色/道具/场地、搜索、点卡加手牌或直接上场、重置行动、补手牌），样式内联 |
| `package.json` | `build`（正式，不含）/ `build:dev`（`VITE_DEV_TOOLS=1`，含）/ `build:release`（正式 + 洁净检查） |
| `tools/dev/check-release-clean.mjs` | 正式产物若含测试模式特征串则**退出码 1**（已跑通：当前产物干净） |

两个新文件目前**没有任何地方 import**，所以对正式构建零影响。

## 待接线（按顺序）

1. **看主菜单组件**：在 `src/ui/` 里找渲染 `.menu-btn`（含「卡组制作」「多人游戏」等按钮）的那个组件 —— 这是加「🧪 单人测试模式」按钮的地方；
2. **看 App 层**：找到它如何构造对局并切到战场（`App.tsx` 里的 mode/state 与传给 `Battlefield` 的 props）。测试模式需要：
   - 用 `startGame(cards, sandboxDeckIds, sandboxDeckIds)` 或空卡组起一局（沙盒，允许超 60 张）；
   - 以"本地单机"形态进入 `Battlefield`（`mode==='local'`，此时 `actPlayer = gs.turnPlayer`）；
3. **加按钮**（仅开发构建渲染）：
   ```tsx
   {import.meta.env.VITE_DEV_TOOLS && (
     <button className="menu-btn" onClick={startSandbox}>🧪 单人测试模式</button>
   )}
   ```
4. **战场里打开检索界面**：在我方卡组/牌堆区域加 `onClick`（同样用 `VITE_DEV_TOOLS` 包住），
   用**动态 import** 以免打进正式包：
   ```tsx
   const { default: TestMode } = await import('./dev/TestMode');
   ```
   打开后用 `devTest` 的函数把选中的卡加进 `gs`，再走**已有的 `commitGs`**（主控副本）更新状态，
   这样联机同步与界面刷新都沿用现有逻辑；
5. **把洁净检查挂到打包前**：在 `npm run dist` 开头加 `node tools/dev/check-release-clean.mjs`；
6. **验收三条证据**：
   - `npm run build:dev` → 开发版能用（点开检索界面、加牌、点数正确）；
   - `npm run build` + `node tools/dev/check-release-clean.mjs` → 通过（正式产物里 grep 不到测试模式）；
   - `npm run pack:update` → 清单里没有测试模式相关文件（玩家端下载量不受影响）。

## 注意

- 测试模式是**沙盒**：绕过卡组 60 张 / 同编号 4 张 / 卡牌守恒，因此这类对局**不能**用于验证张数守恒类不变量；
- 接线时**不要**给 `devTest` 加进 `protocol.ts` 的动作派发（那是联机路径），直接改本地 `gs` 即可，
  免得开发功能渗进联机协议与权限校验。
