import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // The bridge (packages/bridge) serves /sessions, /files and /ws; proxy them in dev
    // so the real SessionService can be swapped in without touching URLs.
    proxy: {
      '/sessions': 'http://127.0.0.1:8787',
      '/files': 'http://127.0.0.1:8787',
      '/health': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
