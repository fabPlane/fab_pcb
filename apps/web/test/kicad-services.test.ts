import './setup';
import { beforeEach, describe, expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import {
  ApiStatusCode,
  BeginCommitResponseSchema,
  BeginCommitSchema,
  BoardEnabledLayersResponseSchema,
  BoardLayer,
  BoardLayerNameResponseSchema,
  CommitAction,
  DocumentRevisionResponseSchema,
  DocumentType,
  EndCommitSchema,
  FootprintInstanceSchema,
  GetBoardEnabledLayersSchema,
  GetBoardLayerNameSchema,
  GetDocumentRevisionSchema,
  GetItemsResponseSchema,
  GetItemsSchema,
  GetOpenDocumentsResponseSchema,
  GetOpenDocumentsSchema,
  GetVersionResponseSchema,
  GetVersionSchema,
  ItemRequestStatus,
  ItemStatusCode,
  PadSchema,
  TrackSchema,
  UpdateItemsResponseSchema,
  UpdateItemsSchema,
  packAny,
  unpackAny,
  type FootprintInstance,
  type Track,
} from '@kicad-web/proto';
import { KiCad, type KiCadClientOptions } from '@kicad-web/client';
import { CommandServiceImpl } from '@/services/CommandService';
import { KicadCommitBackend, KicadDocumentService, KicadSessionService } from '@/services/kicad';
import { FakeTransport, fail, ok, reply } from './fakeTransport';

const R1 = '0b9cc5a8-6a75-47df-9617-9721c2785946';
const T1 = 'f0d13343-ad3f-4a47-aba7-e70711c71e3f';
const P1 = '2ac8ad84-5a2e-4b4e-8ef8-6b5e6b0e2f55';

const boardSpec = { type: DocumentType.DOCTYPE_PCB, identifier: { case: 'boardFilename' as const, value: 'api_kitchen_sink.kicad_pcb' }, project: { name: 'api_kitchen_sink', path: '/ws/pcbnew/' } };

/** A server holding one board with a footprint, a pad inside it and a track. */
function boardServer(): FakeTransport {
  const t = new FakeTransport();
  let revision = 0n;
  let commits = 0;
  const footprint = () =>
    create(FootprintInstanceSchema, {
      id: { value: R1 },
      layer: BoardLayer.BL_F_Cu,
      position: { xNm: 125_200_000n, yNm: 90_900_000n },
      orientation: { valueDegrees: 0 },
      referenceField: { name: 'Reference', text: { id: { value: '7d789367-57eb-4a89-8956-2169b84c120e' }, layer: BoardLayer.BL_F_SilkS, text: { text: 'R1', position: { xNm: 125_200_000n, yNm: 89_000_000n } } } },
    });
  const pad = () => create(PadSchema, { id: { value: P1 }, parent: { value: R1 }, number: '1', net: { name: 'A' }, position: { xNm: 124_400_000n, yNm: 90_900_000n } });
  const track = () => create(TrackSchema, { id: { value: T1 }, layer: BoardLayer.BL_F_Cu, net: { name: 'A' }, start: { xNm: 100_000_000n, yNm: 100_000_000n }, end: { xNm: 110_000_000n, yNm: 100_000_000n }, width: { valueNm: 250_000n } });
  t.on(GetVersionSchema, () => reply(GetVersionResponseSchema, { version: { major: 10, minor: 99, patch: 0, fullVersion: '10.99.0-fake' } }));
  t.on(GetOpenDocumentsSchema, (req) => (req.type === DocumentType.DOCTYPE_PCB ? reply(GetOpenDocumentsResponseSchema, { documents: [boardSpec] }) : fail(ApiStatusCode.AS_UNHANDLED)));
  t.on(GetItemsSchema, () => reply(GetItemsResponseSchema, { status: ItemRequestStatus.IRS_OK, items: [packAny(FootprintInstanceSchema, footprint()), packAny(PadSchema, pad()), packAny(TrackSchema, track())] }));
  t.on(GetBoardEnabledLayersSchema, () => reply(BoardEnabledLayersResponseSchema, { copperLayerCount: 2, layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu, BoardLayer.BL_F_SilkS, BoardLayer.BL_Edge_Cuts] }));
  t.on(GetBoardLayerNameSchema, (req) => reply(BoardLayerNameResponseSchema, { name: req.layer === BoardLayer.BL_F_Cu ? 'Top copper' : BoardLayer[req.layer]!.replace('BL_', '').replace('_', '.') }));
  t.on(GetDocumentRevisionSchema, () => reply(DocumentRevisionResponseSchema, { revision }));
  t.on(BeginCommitSchema, () => reply(BeginCommitResponseSchema, { id: { value: `commit-${++commits}` } }));
  t.on(UpdateItemsSchema, (req) =>
    reply(UpdateItemsResponseSchema, {
      status: ItemRequestStatus.IRS_OK,
      // KiCad echoes the canonical item; here the request item is canonical enough.
      updatedItems: req.items.map((item) => ({ status: { code: ItemStatusCode.ISC_OK }, item })),
    }),
  );
  t.on(EndCommitSchema, (req) => {
    if (req.action === CommitAction.CMA_COMMIT) revision++;
    return ok();
  });
  return t;
}

function fetchStub(calls: { method: string; path: string; body?: unknown }[]) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/health') return json({ ok: true, workspaceRoot: '/ws', kicadCli: '/opt/kicad-cli', kicadCliExists: true });
    if (url.pathname === '/sessions' && method === 'POST') return json({ session: { id: 'sess1', state: 'running', path: '/ws/pcbnew/api_kitchen_sink.kicad_pro', kicadToken: 'tok' }, wsUrl: '/ws?session=sess1' }, 201);
    if (url.pathname === '/sessions' && method === 'GET') return json({ sessions: [{ id: 'sess1', state: 'running' }] });
    if (url.pathname.startsWith('/sessions/') && method === 'DELETE') return json({ ok: true });
    if (url.pathname === '/files/list') {
      const p = url.searchParams.get('path');
      return json({ path: 'pcbnew', absolutePath: p, entries: [{ name: 'sub', kind: 'dir', size: 96, mtime: '2026-09-06T10:00:00Z' }, { name: 'api_kitchen_sink.kicad_pro', kind: 'file', size: 2411, mtime: '2026-09-06T10:00:00Z' }, { name: 'api_kitchen_sink.kicad_pcb', kind: 'file', size: 100, mtime: '2026-09-06T10:00:00Z' }] });
    }
    if (url.pathname === '/files/stat') return json({ error: 'not found' }, 404);
    return json({ error: `unexpected ${method} ${url.pathname}` }, 500);
  };
}

async function connectedKiCad(t: FakeTransport): Promise<KiCad> {
  const opts: KiCadClientOptions = { clientName: 'test', waitForReady: false };
  return KiCad.connect(t, opts);
}

describe('KicadSessionService', () => {
  test('connect: POST /sessions, dials the transport, reports the KiCad version, disconnect deletes the session', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const transport = boardServer();
    const states: string[] = [];
    let connectedWith: KiCad | null = null;
    const session = new KicadSessionService({
      bridgeUrl: 'http://bridge.test',
      fetch: fetchStub(calls),
      createTransport: async () => transport,
      onConnected: (k) => {
        connectedWith = k;
      },
    });
    session.onChange((s) => states.push(s?.state ?? 'null'));
    await session.init();
    expect(session.workspaceRoot()).toBe('/ws');

    const info = await session.connect('/ws/pcbnew/api_kitchen_sink.kicad_pro');
    expect(info.state).toBe('open');
    expect(info.id).toBe('sess1');
    expect(info.projectName).toBe('api_kitchen_sink');
    expect(info.kicadVersion).toBe('10.99.0-fake');
    expect(info.kicadToken).toBe(transport.token);
    expect(connectedWith as KiCad | null).toBe(session.kicad as KiCad);
    expect(calls.find((c) => c.method === 'POST' && c.path === '/sessions')?.body).toEqual({ path: '/ws/pcbnew/api_kitchen_sink.kicad_pro' });
    expect(transport.calls.map((c) => c.clientName)[0]).toMatch(/^kicad-web\/sess1\//);
    expect(states).toEqual(['connecting', 'connecting', 'connecting', 'open']);

    await session.disconnect();
    expect(session.session).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/sessions/sess1')).toBe(true);
    expect(transport.state).toBe('closed');
  });

  test('listFiles maps bridge entries to absolute paths with file types', async () => {
    const session = new KicadSessionService({ bridgeUrl: 'http://bridge.test', fetch: fetchStub([]) });
    const entries = await session.listFiles('/ws/pcbnew');
    expect(entries.map((e) => [e.name, e.kind, e.fileType, e.path])).toEqual([
      ['sub', 'dir', undefined, '/ws/pcbnew/sub'],
      ['api_kitchen_sink.kicad_pcb', 'file', 'board', '/ws/pcbnew/api_kitchen_sink.kicad_pcb'],
      ['api_kitchen_sink.kicad_pro', 'file', 'project', '/ws/pcbnew/api_kitchen_sink.kicad_pro'],
    ]);
  });

  test('a dropped transport is re-dialled while the bridge still lists the session', async () => {
    const transports: FakeTransport[] = [];
    const session = new KicadSessionService({
      bridgeUrl: 'http://bridge.test',
      fetch: fetchStub([]),
      createTransport: async () => {
        const t = boardServer();
        transports.push(t);
        return t;
      },
      reconnectAttempts: 2,
    });
    const states: string[] = [];
    session.onChange((s) => states.push(s?.state ?? 'null'));
    await session.connect('/ws/pcbnew/api_kitchen_sink.kicad_pro');
    transports[0]!.drop();
    await new Promise((r) => setTimeout(r, 700));
    expect(transports.length).toBe(2);
    expect(session.session?.state).toBe('open');
    expect(states).toContain('reconnecting');
    expect(session.kicad?.client.transport).toBe(transports[1]!);
  });
});

describe('KicadDocumentService', () => {
  let transport: FakeTransport;
  let docs: KicadDocumentService;

  beforeEach(async () => {
    transport = boardServer();
    docs = new KicadDocumentService();
    await docs.open(await connectedKiCad(transport), '/ws/pcbnew/api_kitchen_sink.kicad_pro', { exists: async () => false });
  });

  test('fills the board store from GetItems and derives layers / nets / sheets', () => {
    const store = docs.board()!;
    expect(store).not.toBeNull();
    expect([...store.all()].map((i) => i.type).sort()).toEqual(['KOT_PCB_FOOTPRINT', 'KOT_PCB_PAD', 'KOT_PCB_TRACE']);
    const r1 = store.get(R1)!;
    expect(r1.layer).toBe('BL_F_Cu');
    expect((r1.proto as FootprintInstance).position?.xNm).toBe(125_200_000n);
    expect(store.get(P1)?.parent).toBe(R1);
    expect([...store.byNet('A')].map((i) => i.id).sort()).toEqual([P1, T1].sort());
    expect(docs.layers().map((l) => [l.id, l.name, l.kind])).toEqual([
      ['BL_F_Cu', 'Top copper', 'copper'],
      ['BL_B_Cu', 'B.Cu', 'copper'],
      ['BL_F_SilkS', 'F.SilkS', 'technical'],
      ['BL_Edge_Cuts', 'Edge.Cuts', 'edge'],
    ]);
    expect(docs.copperLayers).toEqual(['BL_F_Cu', 'BL_B_Cu']);
    expect(docs.sheets()).toEqual([]);
    expect(docs.sheet('/')).toBeNull();
    expect(docs.isDirty('board')).toBe(false);
    expect(docs.targetFor(store)?.kind).toBe('board');
    // GetOpenDocuments answered AS_UNHANDLED for schematics: treated as "none open", not an error
    expect(transport.requestsOf(GetOpenDocumentsSchema).length).toBe(2);
    docs.close();
  });
});

describe('KicadCommitBackend', () => {
  let transport: FakeTransport;
  let docs: KicadDocumentService;
  let commands: CommandServiceImpl;

  beforeEach(async () => {
    transport = boardServer();
    docs = new KicadDocumentService();
    await docs.open(await connectedKiCad(transport), '/ws/pcbnew/api_kitchen_sink.kicad_pro', { exists: async () => false });
    commands = new CommandServiceImpl(new KicadCommitBackend(docs));
  });

  test('a transaction becomes BeginCommit / UpdateItems / EndCommit(CMA_COMMIT) and the store holds the canonical item', async () => {
    const store = docs.board()!;
    await commands.run(store, 'Move R1', (tx) => tx.update(R1, [{ path: ['position', 'xNm'], value: 130_000_000n }]));

    expect(transport.requestsOf(BeginCommitSchema).length).toBe(1);
    const updates = transport.requestsOf(UpdateItemsSchema);
    expect(updates.length).toBe(1);
    expect(updates[0]!.header?.document?.identifier).toEqual(boardSpec.identifier);
    const sent = unpackAny(updates[0]!.items[0]!) as FootprintInstance;
    expect(sent.$typeName).toBe('kiapi.board.types.FootprintInstance');
    expect(sent.id?.value).toBe(R1);
    expect(sent.position?.xNm).toBe(130_000_000n);
    expect(sent.position?.yNm).toBe(90_900_000n);
    const ends = transport.requestsOf(EndCommitSchema);
    expect(ends.map((e) => [e.action, e.message, e.id?.value])).toEqual([[CommitAction.CMA_COMMIT, 'Move R1', 'commit-1']]);

    const after = store.get(R1)!;
    expect((after.proto as FootprintInstance).position?.xNm).toBe(130_000_000n);
    expect(after.item?.proto).toBe(after.proto as never); // canonical wrapper from the client
    expect(commands.history().undo.map((e) => e.message)).toEqual(['Move R1']);
    await new Promise((r) => setTimeout(r, 0));
    expect(docs.isDirty('board')).toBe(true);
  });

  test('undo replays the inverse as a new commit', async () => {
    const store = docs.board()!;
    await commands.run(store, 'Move R1', (tx) => tx.update(R1, [{ path: ['position', 'xNm'], value: 130_000_000n }]));
    const entry = await commands.undo();
    expect(entry?.message).toBe('Move R1');
    const updates = transport.requestsOf(UpdateItemsSchema);
    expect(updates.length).toBe(2);
    expect((unpackAny(updates[1]!.items[0]!) as FootprintInstance).position?.xNm).toBe(125_200_000n);
    expect(transport.requestsOf(EndCommitSchema).map((e) => e.action)).toEqual([CommitAction.CMA_COMMIT, CommitAction.CMA_COMMIT]);
    expect((store.get(R1)!.proto as FootprintInstance).position?.xNm).toBe(125_200_000n);
    expect(commands.canUndo()).toBe(false);
    expect(commands.canRedo()).toBe(true);
  });

  test('a rejected UpdateItems drops the commit and rolls the store back', async () => {
    const store = docs.board()!;
    transport.on(UpdateItemsSchema, (req) =>
      reply(UpdateItemsResponseSchema, { status: ItemRequestStatus.IRS_OK, updatedItems: req.items.map(() => ({ status: { code: ItemStatusCode.ISC_INVALID_DATA, errorMessage: 'nope' } })) }),
    );
    await expect(commands.run(store, 'Widen track', (tx) => tx.update(T1, [{ path: ['width', 'valueNm'], value: 500_000n }]))).rejects.toThrow(/nope|UpdateItems/);
    expect((store.get(T1)!.proto as Track).width?.valueNm).toBe(250_000n);
    expect(transport.requestsOf(EndCommitSchema).map((e) => e.action)).toEqual([CommitAction.CMA_DROP]);
    expect(commands.history().undo).toEqual([]);
  });

  test('concurrent transactions are serialised onto one KiCad commit at a time', async () => {
    const store = docs.board()!;
    let open = 0;
    let maxOpen = 0;
    transport.on(BeginCommitSchema, () => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      return reply(BeginCommitResponseSchema, { id: { value: `c${open}` } });
    });
    transport.on(EndCommitSchema, () => {
      open--;
      return ok();
    });
    await Promise.all([
      commands.run(store, 'a', (tx) => tx.update(R1, [{ path: ['position', 'xNm'], value: 1n }])),
      commands.run(store, 'b', (tx) => tx.update(T1, [{ path: ['width', 'valueNm'], value: 2n }])),
    ]);
    expect(maxOpen).toBe(1);
    expect(transport.requestsOf(EndCommitSchema).length).toBe(2);
  });
});

describe('toItem', () => {
  test('re-types plain nested objects left by patches', async () => {
    const { toItem } = await import('@/services/kicad');
    const proto = { ...create(TrackSchema, { id: { value: T1 }, start: { xNm: 1n, yNm: 2n } }), end: { xNm: 3, yNm: 4 }, width: { valueNm: 5 } };
    const item = toItem({ id: T1, type: 'KOT_PCB_TRACE', proto });
    const any = item.toAny();
    const back = unpackAny(any) as Track;
    expect(back.end?.xNm).toBe(3n);
    expect(back.width?.valueNm).toBe(5n);
    expect(back.start?.yNm).toBe(2n);
  });
});
