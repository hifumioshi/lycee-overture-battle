# 单人测试模式：最后一块接线（照抄即可，含锚点）

> 前置已完成：`src/core/devTest.ts`、`src/ui/dev/TestMode.tsx`、主菜单入口（`onDevTest` 可选 prop）、
> App 起沙盒对局、`build` / `build:dev`、`tools/dev/check-release-clean.mjs`。
> **只差**：在战场里打开检索界面并把选中的卡应用到 `gs`。

## 改动点：`src/ui/Battlefield.tsx`

### 1) 状态与懒加载（锚点：第 167 行附近）

```tsx
  const [gs, setGs] = useState<GameState>(() => startGame(cards, deck));
```

在它**下面**插入：

```tsx
  // 🧪 开发构建专用：单人测试模式（F2 打开全卡表检索，选中即加入手牌或直接上场）
  const devTools = !!import.meta.env.VITE_DEV_TOOLS;
  const [devOpen, setDevOpen] = useState(false);
  const [DevTest, setDevTest] = useState<null | React.ComponentType<Record<string, unknown>>>(null);
  useEffect(() => {
    if (!devTools) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') setDevOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [devTools]);
  useEffect(() => {
    if (!devOpen || DevTest) return;
    // 动态 import：正式构建里 VITE_DEV_TOOLS 为假，这里永远不会执行，chunk 也不会产出
    void import('./dev/TestMode').then((m) => setDevTest(() => m.default as never));
  }, [devOpen, DevTest]);
```

> 用 F2 而不是"点卡组位"，是为了**不依赖**战场里卡组区的具体渲染结构（那部分改动面更大、风险高）。
> 若之后要点卡组位打开，在卡组区容器的 `onClick` 里 `setDevOpen(true)` 即可。

### 2) 应用选牌（放在组件内任意位置，注意 `commitGs` 是既有函数）

```tsx
  const onDevPick = (cardId: string, target: 'hand' | 'field') => {
    const cur = gsLiveRef.current ?? gs; // 用与其它操作相同的"主控副本"
    const next =
      target === 'hand'
        ? devAddToHand(cur, cardId)
        : devPlaceCharacter(cur, cardId, 0, cur.players[cur.turnPlayer].field[0].findIndex((c) => !c) === -1 ? 0 : (cur.players[cur.turnPlayer].field[0].findIndex((c) => !c) as 0 | 1 | 2));
    commitGs(next); // 既有的提交函数：界面刷新 + 联机同步都沿用现有逻辑
  };
  const onDevUntap = () => commitGs(devUntapAll(gsLiveRef.current ?? gs));
  const onDevFill = () => commitGs(devFillHand(gsLiveRef.current ?? gs, 7));
```

顶部 import（同样按需）：

```tsx
import { devAddToHand, devPlaceCharacter, devUntapAll, devFillHand } from '../core/devTest';
```

### 3) 渲染（锚点：组件 `return` 的最外层节点里，跟其它浮层并列）

```tsx
      {devTools && devOpen && DevTest && (
        <DevTest cards={cards} onPick={onDevPick} onUntap={onDevUntap} onFillHand={onDevFill} onClose={() => setDevOpen(false)} />
      )}
```

## 验收三条证据

1. `npm run build:dev` → 启动后主菜单有「🧪 单人测试模式」→ 进战场按 **F2** → 检索界面可筛属性/类别、点卡后手牌增加；
2. `npm run build` + `node tools/dev/check-release-clean.mjs` → 通过（正式产物无测试模式）；
3. `node tools/pack-update.mjs` → 玩家端需下载文件数不受影响。

## 注意

- 测试模式是沙盒：绕过 60 张 / 同编号 4 张 / 卡牌守恒，因此**不能**用来验证张数守恒类不变量；
- 不要把 `devTest` 的动作塞进 `src/net/protocol.ts` 的 `applyAction`（那是联机路径），直接改本地 `gs` 即可；
- 只想自己用时，可以把 F2 换成点击我方卡组位（可选，非必须）。
