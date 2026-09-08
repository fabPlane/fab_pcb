import { createReadStream, existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The bridge (packages/bridge) listens on PORT (default 4020) and serves /sessions, /files,
// /health and the /ws WebSocket. In dev they are proxied so the app can talk to it on the
// same origin; set BRIDGE_PORT (or BRIDGE_URL) when the bridge runs elsewhere.
const bridgePort = process.env.BRIDGE_PORT ?? '4020';
const bridge = process.env.BRIDGE_URL ?? `http://127.0.0.1:${bridgePort}`;
const bridgeWs = bridge.replace(/^http/, 'ws');

const here = fileURLToPath(new URL('.', import.meta.url));
/** Where `bun run --filter @fp-pcb/kicad-wasm fetch` puts `kicad_api.js` / `.wasm` / `.data`. */
const wasmDist = process.env.KICAD_WASM_DIR ?? join(here, '../../packages/kicad-wasm/dist');
/** The URL `?wasm=1` loads the module from (see src/main.tsx and docs/08-wasm.md). */
const WASM_BASE = '/kicad-wasm';

/**
 * Serve the wasm build under `/kicad-wasm/` in dev and copy it into `dist/` on build.
 *
 * It cannot be an import: `kicad_api.js` is Emscripten glue loaded at runtime by URL
 * (`createKiCadWasm({ moduleUrl })`), and its `.wasm` / `.data` siblings are fetched by that glue
 * rather than by the bundler. None of it is needed for the mock, bridge or direct-ws modes, so a
 * missing `dist/` is a warning, not an error.
 */
function kicadWasmAssets(): Plugin {
  return {
    name: 'fp-pcb:kicad-wasm-assets',
    configureServer(server) {
      server.middlewares.use(WASM_BASE, (req, res, next) => {
        const name = basename((req.url ?? '/').split('?')[0] ?? '');
        const file = name ? join(wasmDist, name) : '';
        if (!file || !existsSync(file)) return next();
        res.setHeader('content-type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    async closeBundle() {
      if (!existsSync(wasmDist)) {
        this.warn(`no wasm build at ${wasmDist}; ?wasm=1 will not work in this build (run: bun run --filter @fp-pcb/kicad-wasm fetch)`);
        return;
      }
      await cp(wasmDist, join(here, 'dist', WASM_BASE.slice(1)), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), kicadWasmAssets()],
  resolve: {
    alias: [
      // `@fp-pcb/kicad-wasm`'s entry point re-exports host-disk helpers the browser never calls,
      // so `node:fs/promises` only has to resolve; `node:path` has to actually work, because MEMFS
      // paths are POSIX paths. Vite's own `node:` externals export nothing at all.
      { find: /^node:fs\/promises$/, replacement: join(here, 'src/lib/node-fs-stub.ts') },
      { find: /^node:path$/, replacement: join(here, 'src/lib/node-path-stub.ts') },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  // Emscripten fetches these itself; keep them as files instead of inlining them as base64.
  assetsInclude: ['**/*.wasm', '**/*.data'],
  // The module is single-threaded (no pthreads), so it needs neither COOP/COEP nor SharedArrayBuffer.
  worker: { format: 'es' },
  // A workspace source package whose loader `import()`s the Emscripten glue at runtime.
  optimizeDeps: { exclude: ['@fp-pcb/kicad-wasm'] },
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
