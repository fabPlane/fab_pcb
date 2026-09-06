/**
 * Browser-side half of `multiHost.test.ts` — bundled by Bun and loaded into headless
 * Chromium (SwiftShader WebGL), because two real Pixi renderers are needed and `bun test`
 * has no WebGL.
 *
 * Mounts two `BoardCanvasHost`s in one document, renders a few frames on each (so both
 * renderers have `Batch` objects parked in Pixi's process-wide `batchPool`), unmounts the
 * first and keeps rendering the second. Before the fix the surviving host threw
 * `Cannot read properties of null (reading 'clear')` out of `Batcher.break`.
 */
import { GlobalResourceRegistry } from 'pixi.js';
import { BoardCanvasHost } from '../src/board/BoardCanvasHost.js';
import { KICAD_DEFAULT_THEME } from '../src/core/theme.js';
import { MemoryStore, syntheticBoard } from './fixtures.js';

export interface MultiHostResult {
  /** frames rendered on the surviving host after the first one was unmounted */
  framesAfterUnmount: number;
  /** message of the first error thrown by a post-unmount frame, if any */
  error: string | null;
  /** times unmounting one host wiped Pixi's process-wide pools; must be 0 */
  globalReleases: number;
  /** `textures` state of every batch the surviving renderer is still drawing with */
  survivingBatches: Array<'live' | 'destroyed'>;
  /**
   * Control: a global release really does poison this exact pipeline. Run last, after the
   * assertions above, so it cannot affect them.
   */
  releaseIsHarmful: boolean;
}

function slot(id: string): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  el.style.width = '400px';
  el.style.height = '300px';
  document.body.appendChild(el);
  return el;
}

async function run(): Promise<MultiHostResult> {
  const preview = new BoardCanvasHost(KICAD_DEFAULT_THEME);
  const editor = new BoardCanvasHost(KICAD_DEFAULT_THEME);
  preview.mount(slot('preview'), new MemoryStore(syntheticBoard()), KICAD_DEFAULT_THEME);
  editor.mount(slot('editor'), new MemoryStore(syntheticBoard()), KICAD_DEFAULT_THEME);
  await preview.ready;
  await editor.ready;

  // Pixi only re-runs the batcher when the scene is dirty, so every frame here rebuilds the
  // render items. >= 2 frames each: a Batch only enters the shared pool array on the frame
  // after the one that allocated it (`Batcher.begin` -> `returnBatchToPool`), which is what
  // makes it reachable by a global release while the batcher is still using it.
  const draw = (host: BoardCanvasHost) => {
    host.rebuildAll();
    host.renderNow();
  };
  for (let i = 0; i < 3; i++) {
    draw(preview);
    draw(editor);
  }

  // With the bug this fires once, and whichever renderer's batches happen to be parked in
  // the shared pool at that moment are destroyed mid-flight.
  let globalReleases = 0;
  const release = GlobalResourceRegistry.release.bind(GlobalResourceRegistry);
  (GlobalResourceRegistry as unknown as { release: () => void }).release = () => {
    globalReleases++;
    release();
  };

  preview.unmount();

  let error: string | null = null;
  let framesAfterUnmount = 0;
  for (let i = 0; i < 5; i++) {
    try {
      draw(editor);
      framesAfterUnmount++;
    } catch (err) {
      error ??= err instanceof Error ? err.message : String(err);
    }
  }
  const batchesOf = (host: BoardCanvasHost): Array<'live' | 'destroyed'> => {
    const batcher = (
      host as unknown as {
        app?: {
          renderer: {
            renderPipes: { batch: { _activeBatch?: { batches: Array<{ textures: unknown } | undefined>; batchIndex: number } } };
          };
        };
      }
    ).app?.renderer.renderPipes.batch._activeBatch;
    if (!batcher) return [];
    return batcher.batches.slice(0, batcher.batchIndex).map((b) => (b && b.textures !== null ? 'live' : 'destroyed'));
  };
  const survivingBatches = batchesOf(editor);

  // Control, deliberately last: prove a global release is genuinely fatal here, so this test
  // fails loudly if a Pixi upgrade ever makes the pools per-renderer and the guard moot.
  release();
  let releaseIsHarmful = false;
  try {
    draw(editor);
  } catch {
    releaseIsHarmful = true;
  }

  (GlobalResourceRegistry as unknown as { release: () => void }).release = release;
  editor.unmount();
  return { framesAfterUnmount, error, globalReleases, survivingBatches, releaseIsHarmful };
}

(window as unknown as { multiHost: { run: typeof run } }).multiHost = { run };
