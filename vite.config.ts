import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Vite builds the renderer (UI) part of the Electron app.
// VITE_DEV_TOOLS=1 时才是"开发构建"：会把 src/dev/entry.tsx 注入 index.html（测试模式）。
// 正式构建完全不引用 src/dev/**、src/ui/dev/**、src/core/devTest.ts，所以它们不会进产物。
const devTools = process.env.VITE_DEV_TOOLS === '1';

/** 开发构建才注入的开发入口插件（正式构建注入空字符串 = 什么也不加） */
function devToolsInject(enabled: boolean): Plugin {
  return {
    name: 'lycee-dev-tools-inject',
    transformIndexHtml(html) {
      if (!enabled) return html;
      return html.replace(
        '</body>',
        '  <script type="module" src="/src/dev/entry.tsx"></script>\n  </body>',
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), devToolsInject(devTools)],
  base: './',
  define: {
    __DEV_TOOLS__: JSON.stringify(devTools),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
