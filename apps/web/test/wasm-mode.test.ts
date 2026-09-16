// In-browser wasm mode: `KicadSessionService` loads the module, talks to it over `WasmTransport`,
// and hands the document service a `WasmSubscriber`-backed `KiCadEvents` instead of relying on the
// `instanceof WebSocketTransport` default. Driven against the JS mock of the `kiapi_*` ABI that
// `@fp-pcb/kicad-wasm` tests with, so no wasm build is needed.
import './setup';
import { describe, expect, test } from 'bun:test';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import { ApiRequestSchema, ApiResponseSchema, ApiStatusCode, EmptySchema, EventSchema, GetOpenDocumentsResponseSchema, GetVersionResponseSchema, kiapiRegistry, packAny } from '@fp-pcb/proto';
import { KiCadEvents, WasmTransport, WebSocketTransport } from '@fp-pcb/client';
import { createKiCadWasm, type KiCadWasm } from '@fp-pcb/kicad-wasm';
import { createMockFactory } from '../../../packages/kicad-wasm/test/mock-module';
import { MOCK_ENTRY_URL, MOCK_TOKEN, inProcessWorker } from '../../../packages/kicad-wasm/test/kicad-mock-entry';
import { KicadSessionService, MEMFS_PROJECT_DIR } from '@/services/kicad/KicadSessionService';
import { dirname, join } from '@/lib/node-path-stub';
import { crc32, zipStore } from '@/lib/zip';

const TOKEN = MOCK_TOKEN;
const BOARD = `${MEMFS_PROJECT_DIR}/demo.kicad_pcb`;

/** One `DocumentSaved` frame, published from inside every `Ping` dispatch. */
const SAVED_EVENT = toBinary(EventSchema, create(EventSchema, { sequence: 7n, kind: { case: 'documentSaved', value: {} } }));

/** The whole server, synchronous, because `kiapi_dispatch` is. */
function respond(request: Uint8Array): Uint8Array {
  const envelope = fromBinary(ApiRequestSchema, request);
  const any = envelope.message;
  const name = any ? any.typeUrl.slice(any.typeUrl.lastIndexOf('/') + 1) : '';
  if (any) anyUnpack(any, kiapiRegistry); // the same decode the real server does
  const message =
    name === 'kiapi.common.commands.GetVersion'
      ? packAny(GetVersionResponseSchema, create(GetVersionResponseSchema, { version: { major: 10, minor: 99, patch: 0, fullVersion: '10.99.0-wasm' } }))
      : name === 'kiapi.board.commands.GetOpenDocuments'
        ? packAny(GetOpenDocumentsResponseSchema, create(GetOpenDocumentsResponseSchema, { documents: [] }))
        : packAny(EmptySchema, create(EmptySchema));
  return toBinary(ApiResponseSchema, create(ApiResponseSchema, { header: { kicadToken: TOKEN }, status: { status: ApiStatusCode.AS_OK }, message }));
}

function mockInstance(): Promise<KiCadWasm> {
  return createKiCadWasm({
    module: createMockFactory({
      reply: respond,
      eventsPerDispatch: (req) => (fromBinary(ApiRequestSchema, req).message?.typeUrl.endsWith('Ping') ? [SAVED_EVENT] : []),
    }),
    token: TOKEN,
  });
}

function service(): KicadSessionService {
  return new KicadSessionService({ bridgeUrl: '', wasm: { createInstance: mockInstance }, log: () => {} });
}

/**
 * The mode the app actually ships: the module in a Worker. `inProcessWorker()` is a Worker-shaped
 * object whose messages reach `serveKiCadWasm()` in this process, and `MOCK_ENTRY_URL` is the JS
 * mock of the ABI standing in for `kicad_api.js` — so this covers the whole protocol (dispatch,
 * events, MEMFS) without a thread or a bundler.
 */
function workerService(): KicadSessionService {
  return new KicadSessionService({ bridgeUrl: '', wasm: { moduleUrl: MOCK_ENTRY_URL, createWorker: inProcessWorker }, log: () => {} });
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('in-browser wasm mode', () => {
  test('is direct and bridgeless, and says so when a bridge-only feature is used', async () => {
    const s = service();
    expect(s.wasm).toBe(true);
    // `direct` is what the composition root keys on to pass `events` explicitly, and what stops
    // the service from POSTing / DELETEing sessions on a bridge that is not there.
    expect(s.direct).toBe(true);
    expect(s.bridgeless).toBe(true);
    expect(() => s.bridgeJson('/sessions')).toThrow(/runs KiCad as WebAssembly in this tab/);
    const health = await s.init();
    expect(health).toMatchObject({ ok: true, kicadCli: 'kicad_api.wasm (in this tab)', workspaceRoot: MEMFS_PROJECT_DIR });
  });

  test('imports files into MEMFS, connects over WasmTransport and subscribes in-process', async () => {
    const s = service();
    // Imported before the module exists: the files are staged and written when it loads.
    const path = await s.importProjectFiles([
      { name: 'demo.kicad_pcb', bytes: bytes('(kicad_pcb (version 20240108))') },
      { name: 'demo.kicad_pro', bytes: bytes('{}') },
    ]);
    // A `.kicad_pro` outranks the board, exactly as the project browser would have.
    expect(path).toBe(`${MEMFS_PROJECT_DIR}/demo.kicad_pro`);

    const info = await s.connect(BOARD);
    try {
      expect(info.state).toBe('open');
      expect(info.kicadVersion).toBe('10.99.0-wasm');
      expect(info.kicadToken).toBe(TOKEN);
      expect(s.transport).toBeInstanceOf(WasmTransport);
      // The document service's default event source only recognises a WebSocketTransport, so the
      // subscriber has to be handed over explicitly; this is the expression the composition root
      // uses (`session.direct ? session.events : undefined`).
      expect(s.transport instanceof WebSocketTransport).toBe(false);
      const events = s.direct ? s.events : undefined;
      expect(events).toBeInstanceOf(KiCadEvents);
      expect(events!.state).toBe('open');

      // An event the module publishes from inside a dispatch reaches the typed listener after the
      // reply that produced it.
      const saved: bigint[] = [];
      const off = events!.on('documentSaved', (_payload, event) => void saved.push(event.sequence));
      await s.kicad!.ping();
      const deadline = Date.now() + 2000;
      while (saved.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      off();
      expect(saved).toEqual([7n]);

      // MEMFS stands in for the workspace: `stat` is what tells the document service that the
      // board next to a `.kicad_pro` exists.
      expect(await s.stat(BOARD)).toMatchObject({ kind: 'file' });
      expect(await s.stat(`${MEMFS_PROJECT_DIR}/missing.kicad_pcb`)).toBeNull();
      expect((await s.listFiles(MEMFS_PROJECT_DIR)).map((e) => e.name)).toEqual(['demo.kicad_pcb', 'demo.kicad_pro']);
      expect(s.workspaceRoot()).toBe(MEMFS_PROJECT_DIR);
    } finally {
      const instance = s.wasmInstance;
      await s.disconnect();
      // `WasmTransport` owns the module, so disconnecting runs `kiapi_shutdown`.
      expect(instance?.isShutDown).toBe(true);
      expect(s.wasmInstance).toBeNull();
    }
  });

  test('loads the module once per tab, not once per project open', async () => {
    // What the app really does with `?wasm=1`: connect with no project at startup (there is no
    // bridge to browse), then connect again once the user has picked files. That used to fetch
    // 37 MB twice and throw the first module -- and MEMFS with it -- away.
    let loads = 0;
    const s = new KicadSessionService({
      bridgeUrl: '',
      wasm: {
        createInstance: () => {
          loads++;
          return mockInstance();
        },
      },
      log: () => {},
    });
    await s.connect('');
    const first = s.wasmInstance;
    expect(loads).toBe(1);
    expect(first).not.toBeNull();

    await s.importProjectFiles([{ name: 'demo.kicad_pcb', bytes: bytes('(kicad_pcb (version 20240108))') }]);
    await s.connect(BOARD);
    expect(loads).toBe(1);
    expect(s.wasmInstance).toBe(first);
    expect(first!.isShutDown).toBe(false);
    // Same module, same MEMFS: the import is there without having been replayed.
    expect(await s.stat(BOARD)).toMatchObject({ kind: 'file' });

    // Closing the project is what ends the module's life, and it does end it.
    await s.disconnect();
    expect(first!.isShutDown).toBe(true);
    expect(s.wasmInstance).toBeNull();
  });

  test('runs the module in a Worker: dispatch, events and MEMFS all cross the thread', async () => {
    const s = workerService();
    const path = await s.importProjectFiles([
      { name: 'demo.kicad_pcb', bytes: bytes('(kicad_pcb (version 20240108))') },
      { name: 'demo.kicad_pro', bytes: bytes('{}') },
    ]);
    expect(path).toBe(`${MEMFS_PROJECT_DIR}/demo.kicad_pro`);
    const info = await s.connect(BOARD);
    try {
      expect(s.wasmWorker).toBe(true);
      expect(info.state).toBe('open');
      expect(info.kicadVersion).toBe('10.99.0-wasm');
      expect(info.kicadToken).toBe(TOKEN);
      expect(s.transport).toBeInstanceOf(WasmTransport);

      const events = s.events;
      expect(events).toBeInstanceOf(KiCadEvents);
      const saved: bigint[] = [];
      const off = events!.on('documentSaved', (_payload, event) => void saved.push(event.sequence));
      await s.kicad!.ping();
      const deadline = Date.now() + 2000;
      while (saved.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      off();
      expect(saved).toEqual([7n]);

      // The staged import was written over messages, before the document service asked for it.
      expect(await s.stat(BOARD)).toMatchObject({ kind: 'file' });
      expect(await s.stat(`${MEMFS_PROJECT_DIR}/missing.kicad_pcb`)).toBeNull();
      expect((await s.listFiles(MEMFS_PROJECT_DIR)).map((e) => e.name)).toEqual(['demo.kicad_pcb', 'demo.kicad_pro']);
    } finally {
      const instance = s.wasmInstance;
      await s.disconnect();
      expect(instance?.isShutDown).toBe(true);
    }
  });

  test('refuses to import files when the tab is not in wasm mode', async () => {
    const s = new KicadSessionService({ bridgeUrl: 'http://127.0.0.1:4020', log: () => {} });
    expect(s.wasm).toBe(false);
    await expect(s.importProjectFiles([{ name: 'x.kicad_pcb', bytes: bytes('') }])).rejects.toThrow(/wasm mode/);
    await expect(s.readProjectFiles()).rejects.toThrow(/wasm mode/);
    await expect(s.stopKiCad()).rejects.toThrow(/wasm mode/);
  });

  // "Download project": MEMFS is the only place anything KiCad wrote in this tab exists, and it
  // dies with the module, so reading it back is the whole export story.
  test('reads the project back out of MEMFS, project files first', async () => {
    const s = workerService();
    await s.importProjectFiles([
      { name: 'sheets/page2.kicad_sch', bytes: bytes('(kicad_sch)') },
      { name: 'fp-info-cache', bytes: bytes('cache') },
      { name: 'demo.kicad_pcb', bytes: bytes('(kicad_pcb (version 20240108))') },
      { name: 'demo.kicad_pro', bytes: bytes('{}') },
    ]);
    await s.connect(BOARD);
    try {
      const files = await s.readProjectFiles();
      // Paths come back relative to the workspace root, sub-directories intact, project files first.
      expect(files.map((f) => f.path)).toEqual(['demo.kicad_pro', 'demo.kicad_pcb', 'sheets/page2.kicad_sch', 'fp-info-cache']);
      expect(new TextDecoder().decode(files[1]!.bytes)).toBe('(kicad_pcb (version 20240108))');
    } finally {
      await s.disconnect();
    }
    // Nothing to read once the module is gone; the message says so rather than returning nothing.
    await expect(s.readProjectFiles()).rejects.toThrow(/not running/);
  });

  // "Stop KiCad": the escape hatch for a module that no longer answers. `kiapi_dispatch` is
  // synchronous inside a single-threaded module, so ending the thread is the only way back.
  test('stops the module and replays the import into the next one', async () => {
    const s = workerService();
    await s.importProjectFiles([
      { name: 'demo.kicad_pcb', bytes: bytes('(kicad_pcb (version 20240108))') },
      { name: 'demo.kicad_pro', bytes: bytes('{}') },
    ]);
    await s.connect(BOARD);
    const first = s.wasmInstance;
    expect(first).not.toBeNull();

    await s.stopKiCad('wedged on purpose');
    expect(first!.isShutDown).toBe(true);
    expect(s.wasmInstance).toBeNull();
    // `error`, not `closed`: the project is still named, so the screen offers to reopen it.
    expect(s.session?.state).toBe('error');
    expect(s.session?.error).toBe('wedged on purpose');
    // Nothing in the old heap is reachable any more.
    await expect(s.readProjectFiles()).rejects.toThrow(/not running/);

    // The import is kept for the life of the tab, so the screen can offer this without a picker.
    const staged = s.stagedProject();
    expect(staged).toMatchObject({ path: `${MEMFS_PROJECT_DIR}/demo.kicad_pro`, name: 'demo', files: 2 });

    // Reopening loads a fresh module and writes every staged file into its empty MEMFS.
    const info = await s.connect(staged!.path);
    try {
      expect(info.state).toBe('open');
      expect(s.wasmInstance).not.toBe(first);
      expect((await s.readProjectFiles()).map((f) => f.path)).toEqual(['demo.kicad_pro', 'demo.kicad_pcb']);
    } finally {
      await s.disconnect();
    }
  });
});

// The archive "Download project" hands the browser. Store-only and hand-rolled, so the byte layout
// is worth pinning: a wrong central-directory offset makes an archive only some tools open.
describe('the zip writer', () => {
  test('produces a readable stored archive', () => {
    const zip = zipStore([
      { path: 'demo.kicad_pro', bytes: bytes('{}'), modified: new Date(2026, 0, 2, 3, 4, 6) },
      { path: '/sheets/page2.kicad_sch', bytes: bytes('(kicad_sch)'), modified: new Date(2026, 0, 2, 3, 4, 6) },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50); // the first local header

    // The end-of-central-directory record is the last 22 bytes (no archive comment).
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 8, true)).toBe(2); // entries on this disk
    expect(view.getUint16(eocd + 10, true)).toBe(2); // entries in total
    const centralSize = view.getUint32(eocd + 12, true);
    const centralAt = view.getUint32(eocd + 16, true);
    expect(centralAt + centralSize).toBe(eocd);
    expect(view.getUint32(centralAt, true)).toBe(0x02014b50);
    // The first central header points at a local header, and the leading slash was dropped.
    expect(view.getUint32(view.getUint32(centralAt + 42, true), true)).toBe(0x04034b50);
    const text = new TextDecoder().decode(zip);
    expect(text).toContain('sheets/page2.kicad_sch');
    expect(text).not.toContain('/sheets/page2.kicad_sch');
  });

  test('computes CRC-32 the way the format wants', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(bytes('abc')).toString(16)).toBe('352441c2');
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
  });
});

// The browser build aliases `node:path` to this, and the loader's MEMFS helpers build every path
// with it — a wrong `dirname` means files land in the wrong directory inside the module.
describe('the browser node:path stub', () => {
  test('joins and takes dirnames the way posix does', () => {
    expect(join('/project', 'demo.kicad_pcb')).toBe('/project/demo.kicad_pcb');
    expect(join('/project/', '/sheets/', 'a.kicad_sch')).toBe('/project/sheets/a.kicad_sch');
    expect(join('/project', 'sub', '..', 'demo.kicad_pro')).toBe('/project/demo.kicad_pro');
    expect(join('/', '..')).toBe('/');
    expect(join('')).toBe('.');
    expect(dirname('/project/sheets/a.kicad_sch')).toBe('/project/sheets');
    expect(dirname('/project/demo.kicad_pcb')).toBe('/project');
    expect(dirname('/demo.kicad_pcb')).toBe('/');
    expect(dirname('demo.kicad_pcb')).toBe('.');
  });
});
