// 构建期常量（由 vite.config.ts 的 define 注入）
// 正式构建时为 false，开发构建（VITE_DEV_TOOLS=1）时为 true。
// 用它包住开发端功能（单人测试模式等）的代码与文案，打包器才能把它们从正式产物里删掉。
declare const __DEV_TOOLS__: boolean;
