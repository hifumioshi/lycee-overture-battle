import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite builds the renderer (UI) part of the Electron app.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
