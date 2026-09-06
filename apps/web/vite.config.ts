import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The bridge (packages/bridge) listens on PORT (default 4020) and serves /sessions, /files,
// /health and the /ws WebSocket. In dev they are proxied so the app can talk to it on the
// same origin; set BRIDGE_PORT (or BRIDGE_URL) when the bridge runs elsewhere.
const bridgePort = process.env.BRIDGE_PORT ?? '4020';
const bridge = process.env.BRIDGE_URL ?? `http://127.0.0.1:${bridgePort}`;
const bridgeWs = bridge.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/sessions': bridge,
      '/files': bridge,
      '/health': bridge,
      '/ws': { target: bridgeWs, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
