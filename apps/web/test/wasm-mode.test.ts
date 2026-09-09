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
