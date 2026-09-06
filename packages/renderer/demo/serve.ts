/**
 * Tiny static server for the demo: `bun run demo` (builds first, then serves on :8787).
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);

const build = await Bun.build({
  entrypoints: [join(here, 'main.ts')],
  outdir: join(here, 'dist'),
  target: 'browser',
  format: 'esm',
  sourcemap: 'linked',
  minify: false,
});
if (!build.success) {
  for (const log of build.logs) console.error(log);
  process.exit(1);
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(resolve(here, `.${path}`));
    if (!(await file.exists())) return new Response('not found', { status: 404 });
    return new Response(file);
  },
});
console.log(`demo: http://localhost:${port}/  (try ?n=100000 for a stress test, &spin=1 for an fps run)`);
