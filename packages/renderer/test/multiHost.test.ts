/**
 * Two PixiJS hosts in one document (the editor canvas plus the app's library preview).
 *
 * Regression for: unmounting one host made every later frame on the surviving host throw
 * `Cannot read properties of null (reading 'clear')` from `Batcher.break`.
 *
 * Root cause: `Application.destroy(true, ...)` reaches `AbstractRenderer.destroy(true)`,
 * which calls `GlobalResourceRegistry.release()`. That is a *process-wide* wipe of pools
 * shared by every renderer (`BigPool`, `TexturePool`, `CanvasPool` and the batcher's
 * `batchPool`). The batcher pool's `clear()` walks the whole `batchPool` array — including
 * the slots above its stack pointer, which hold `Batch` objects other live renderers have
 * checked out — and `destroy()`s them, nulling `Batch.textures`.
 *
 * Two tests:
 *  - `shared batch pool` pins that Pixi behaviour headlessly, with no WebGL, so a Pixi
 *    upgrade that changes the hazard (or fixes it upstream) is noticed here.
 *  - `two hosts` is the real thing in headless Chromium, and is skipped when Playwright's
 *    browser is not installed (same convention as the kicad-cli integration tests).
 */
import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Batcher, GlobalResourceRegistry, InstructionSet, Texture } from 'pixi.js';
import { BoardCanvasHost } from '../src/board/BoardCanvasHost.js';
import { KICAD_DEFAULT_THEME } from '../src/core/theme.js';
import type { MultiHostResult } from './multiHost.page.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `tsc -b` emits a copy of this file under `dist/`, and a bare `bun test` inside the package
 * picks that copy up too, so the page entry is resolved from the package root rather than from
 * this module's own directory.
 */
function packageRoot(from: string): string {
  let dir = from;
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`no package.json above ${from}`);
    dir = up;
  }
  return dir;
}

const PAGE_ENTRY = join(packageRoot(here), 'test', 'multiHost.page.ts');

// --------------------------------------------------------------------------- headless

/**
 * `Batcher` is pure CPU (the GPU lives in `DefaultBatcher`'s shader, which needs a GL
 * context), so the pool lifecycle can be exercised without a renderer. Only `break` is
 * under test; the pack* hooks just have to exist.
 */
class TestBatcher extends Batcher {
  override name = 'test';
  override vertexSize = 6;
  // never touched by `break`; the real ones need a GPU
  override geometry = null as unknown as Batcher['geometry'];
  override shader = null as unknown as Batcher['shader'];
  override packAttributes(): void {}
  override packQuadAttributes(): void {}
  override packIndex(): void {}
  override packQuadIndex(): void {}
}

const element = () =>
  ({
    texture: Texture.WHITE,
    blendMode: 'normal',
    topology: 'triangle-list',
    packAsQuad: true,
    indexSize: 6,
    attributeSize: 4,
    _indexStart: 0,
    _attributeStart: 0,
    _textureId: 0,
    _batch: null,
    _batcher: null,
  }) as unknown as Parameters<Batcher['add']>[0];

function frame(batcher: Batcher): void {
  batcher.begin();
  batcher.add(element());
  batcher.break(new InstructionSet());
}

describe('pixi shared batch pool', () => {
  test('a global resource release destroys batches a live batcher is still using', () => {
    const live = new TestBatcher({ maxTextures: 16 });
    // Frame 1 allocates a Batch; frame 2 parks it in the module-level `batchPool` array and
    // immediately checks it out again, leaving the array slot pointing at a batch in use.
    frame(live);
    frame(live);
    const batch = live.batches[0]!;
    expect(batch.textures).not.toBeNull();

    // This is exactly what `renderer.destroy(true)` does for an unrelated renderer.
    GlobalResourceRegistry.release();

    expect(batch.textures).toBeNull();
    // ...and the next frame hands that dead batch straight back to `break`.
    expect(() => frame(live)).toThrow(/clear/);
  });

  test('unmount() destroys its renderer without asking for a global release', () => {
    // `AbstractRenderer.destroy` releases the shared pools for exactly these options.
    const releasesGlobals = (options: unknown): boolean =>
      options === true ||
      (typeof options === 'object' && options !== null && !!(options as { releaseGlobalResources?: boolean }).releaseGlobalResources);

    const destroyArgs: unknown[] = [];
    let viewRemoved = false;
    const host = new BoardCanvasHost(KICAD_DEFAULT_THEME);
    const fakeApp = {
      stage: { removeChild: () => {} },
      canvas: {
        remove() {
          viewRemoved = true;
        },
      },
      destroy: (rendererOptions: unknown, options: unknown) => destroyArgs.push(rendererOptions, options),
    };
    // stand in for a mounted app; `mount` itself needs a WebGL context
    (host as unknown as { app: unknown; el: unknown }).app = fakeApp;
    (host as unknown as { app: unknown; el: unknown }).el = {};

    host.unmount();

    const [rendererOptions] = destroyArgs;
    expect(destroyArgs.length).toBe(2);
    expect(releasesGlobals(true)).toBe(true); // what unmount used to pass
    expect(releasesGlobals(rendererOptions)).toBe(false); // what it passes now
    // the canvas still goes away
    expect(viewRemoved).toBe(true);
    expect((rendererOptions as { removeView?: boolean }).removeView).toBe(true);
  });
});

// --------------------------------------------------------------------------- browser

const chromiumInstalled = (): boolean => {
  try {
    const { chromium } = require('playwright') as typeof import('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
};

const PAGE_HTML = '<!doctype html><meta charset="utf-8"><body style="margin:0"><script type="module" src="/page.js"></script>';

describe.skipIf(!chromiumInstalled())('two hosts in one document (headless chromium)', () => {
  test('unmounting one host leaves the other rendering without errors', async () => {
    const { chromium } = await import('playwright');
    const out = await mkdtemp(join(tmpdir(), 'multihost-'));
    const build = await Bun.build({
      entrypoints: [PAGE_ENTRY],
      outdir: out,
      naming: 'page.js',
      target: 'browser',
      format: 'esm',
    });
    if (!build.success) {
      for (const log of build.logs) console.error(log);
      throw new Error('page bundle failed');
    }
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/') return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html' } });
        if (path === '/page.js') return new Response(Bun.file(join(out, 'page.js')), { headers: { 'content-type': 'text/javascript' } });
        return new Response('not found', { status: 404 });
      },
    });
    const browser = await chromium.launch({
      headless: true,
      args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
    });
    const consoleErrors: string[] = [];
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.waitForFunction(() => !!(window as unknown as { multiHost?: unknown }).multiHost, null, { timeout: 30_000 });
      const result = (await page.evaluate(() =>
        (window as unknown as { multiHost: { run: () => Promise<MultiHostResult> } }).multiHost.run(),
      )) as MultiHostResult;

      // the invariant: tearing down one host never wipes the pools the other is using
      expect(result.globalReleases).toBe(0);
      expect(result.survivingBatches).not.toContain('destroyed');
      expect(result.survivingBatches.length).toBeGreaterThan(0);
      expect(result.error).toBeNull();
      expect(result.framesAfterUnmount).toBe(5);
      expect(consoleErrors.filter((e) => /reading 'clear'|textures/.test(e))).toEqual([]);
      // control: a global release would still break this pipeline, so the guard is load-bearing
      expect(result.releaseIsHarmful).toBe(true);
    } finally {
      await browser.close();
      server.stop(true);
      await rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});
