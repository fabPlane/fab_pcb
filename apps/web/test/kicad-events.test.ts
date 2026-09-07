// KicadDocumentService consuming KiCad events (DocumentChanged / DocumentSaved / ServerShutdown)
// through an injected KiCadEvents, with the revision poll parked while events are live.
import './setup';
import { beforeEach, describe, expect, test } from 'bun:test';
import { create, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import {
  ApiStatusCode,
  BoardEnabledLayersResponseSchema,
  BoardLayer,
  BoardLayerNameResponseSchema,
  DocumentRevisionResponseSchema,
  DocumentType,
  EventSchema,
  GetBoardEnabledLayersSchema,
  GetBoardLayerNameSchema,
  GetDocumentRevisionSchema,
  GetItemsByIdSchema,
  GetItemsResponseSchema,
  GetItemsSchema,
  GetOpenDocumentsResponseSchema,
  GetOpenDocumentsSchema,
  GetVersionResponseSchema,
  GetVersionSchema,
  ItemRequestStatus,
  TrackSchema,
  packAny,
} from '@fp-pcb/proto';
import { KiCad, KiCadEvents } from '@fp-pcb/client';
import { KicadDocumentService } from '@/services/kicad';
import { FakeTransport, fail, reply } from './fakeTransport';

const T1 = 'f0d13343-ad3f-4a47-aba7-e70711c71e3f';
const T2 = '0b9cc5a8-6a75-47df-9617-9721c2785946';
const OWN = 'fp-pcb/test-tab';
const boardSpec = { type: DocumentType.DOCTYPE_PCB, identifier: { case: 'boardFilename' as const, value: 'api_kitchen_sink.kicad_pcb' }, project: { name: 'api_kitchen_sink', path: '/ws/pcbnew/' } };

function eventBytes(sequence: bigint, kind: MessageInitShape<typeof EventSchema>['kind']): Uint8Array {
  return toBinary(EventSchema, create(EventSchema, { sequence, kind }));
}

/** A board with one track; `serverWidth` is what GetItemsById currently returns for it. */
function boardServer() {
  const t = new FakeTransport();
  const state = { widthNm: 250_000n, revision: 0n, tracks: new Map([[T1, true]]) };
  const track = (id: string) =>
    create(TrackSchema, { id: { value: id }, layer: BoardLayer.BL_F_Cu, net: { name: 'A' }, start: { xNm: 0n, yNm: 0n }, end: { xNm: 10_000_000n, yNm: 0n }, width: { valueNm: state.widthNm } });
  t.on(GetVersionSchema, () => reply(GetVersionResponseSchema, { version: { major: 10, minor: 99, patch: 0, fullVersion: '10.99.0-fake' } }));
  t.on(GetOpenDocumentsSchema, (req) => (req.type === DocumentType.DOCTYPE_PCB ? reply(GetOpenDocumentsResponseSchema, { documents: [boardSpec] }) : fail(ApiStatusCode.AS_UNHANDLED)));
  t.on(GetItemsSchema, () => reply(GetItemsResponseSchema, { status: ItemRequestStatus.IRS_OK, items: [...state.tracks.keys()].map((id) => packAny(TrackSchema, track(id))) }));
  t.on(GetItemsByIdSchema, (req) =>
    reply(GetItemsResponseSchema, { status: ItemRequestStatus.IRS_OK, items: req.items.filter((k) => state.tracks.has(k.value)).map((k) => packAny(TrackSchema, track(k.value))) }),
  );
  t.on(GetBoardEnabledLayersSchema, () => reply(BoardEnabledLayersResponseSchema, { copperLayerCount: 2, layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu] }));
  t.on(GetBoardLayerNameSchema, (req) => reply(BoardLayerNameResponseSchema, { name: BoardLayer[req.layer]! }));
  t.on(GetDocumentRevisionSchema, () => reply(DocumentRevisionResponseSchema, { revision: state.revision }));
  return { t, state };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe('KicadDocumentService + KiCadEvents', () => {
  let server: ReturnType<typeof boardServer>;
  let docs: KicadDocumentService;
  let events: KiCadEvents;
  let shutdowns = 0;
  const log: string[] = [];

  beforeEach(async () => {
    server = boardServer();
    events = new KiCadEvents();
    docs = new KicadDocumentService();
    shutdowns = 0;
    log.length = 0;
    const kicad = await KiCad.connect(server.t, { clientName: OWN, waitForReady: false });
    await docs.open(kicad, '/ws/pcbnew/api_kitchen_sink.kicad_pro', { exists: async () => false, events, log: (m) => log.push(m), onServerShutdown: () => shutdowns++ });
  });

  test("another client's DocumentChanged re-reads the listed KIIDs with GetItemsById and marks the board dirty", async () => {
    expect(docs.eventsLive).toBe(true);
    expect(docs.isDirty('board')).toBe(false);
    const store = docs.board()!;
    expect(store.get(T1)?.proto).toMatchObject({ width: { valueNm: 250_000n } });

    // the other client widened T1 and created T2
    server.state.widthNm = 400_000n;
    server.state.tracks.set(T2, true);
    server.state.revision = 1n;
    events.push(
      eventBytes(3n, { case: 'documentChanged', value: { document: boardSpec, revision: 1n, message: 'widen', clientName: 'someone-else', updated: [{ value: T1 }], created: [{ value: T2 }] } }),
    );
    await until(() => store.get(T2) !== undefined);
    expect(server.t.requestsOf(GetItemsByIdSchema).map((r) => r.items.map((k) => k.value).sort())).toEqual([[T1, T2].sort()]);
    expect(store.get(T1)?.proto).toMatchObject({ width: { valueNm: 400_000n } });
    expect(docs.isDirty('board')).toBe(true);
    // no full GetItems reload was needed
    expect(server.t.requestsOf(GetItemsSchema).length).toBe(1);

    // a foreign delete removes the item
    server.state.tracks.delete(T2);
    events.push(eventBytes(4n, { case: 'documentChanged', value: { document: boardSpec, revision: 2n, clientName: 'someone-else', deleted: [{ value: T2 }] } }));
    await until(() => store.get(T2) === undefined);
    expect(server.t.requestsOf(GetItemsByIdSchema).length).toBe(1);

    // a change outside a commit (no ids) reloads the whole document
    events.push(eventBytes(5n, { case: 'documentChanged', value: { document: boardSpec, revision: 3n } }));
    await until(() => server.t.requestsOf(GetItemsSchema).length === 2);
    expect(log.some((m) => m.includes('re-reading the document'))).toBe(true);
  });

  test('our own DocumentChanged only records the revision; DocumentSaved clears dirty; ServerShutdown is reported', async () => {
    const store = docs.board()!;
    events.push(eventBytes(3n, { case: 'documentChanged', value: { document: boardSpec, revision: 1n, clientName: OWN, updated: [{ value: T1 }] } }));
    await until(() => docs.isDirty('board'));
    await new Promise((r) => setTimeout(r, 20));
    expect(server.t.requestsOf(GetItemsByIdSchema).length).toBe(0);
    expect(store.get(T1)?.proto).toMatchObject({ width: { valueNm: 250_000n } });

    events.push(eventBytes(4n, { case: 'documentSaved', value: { document: boardSpec, path: '/ws/pcbnew/api_kitchen_sink.kicad_pcb', revision: 2n } }));
    await until(() => !docs.isDirty('board'));
    // a later change relative to the saved revision is dirty again; the same revision is not
    events.push(eventBytes(5n, { case: 'documentChanged', value: { document: boardSpec, revision: 3n, clientName: OWN } }));
    await until(() => docs.isDirty('board'));

    events.push(eventBytes(6n, { case: 'serverShutdown', value: {} }));
    expect(shutdowns).toBe(1);
    expect(log.some((m) => m.includes('shutting down'))).toBe(true);
    docs.close();
  });

  test('events for documents that are not open are ignored', async () => {
    events.push(eventBytes(3n, { case: 'documentChanged', value: { document: { type: DocumentType.DOCTYPE_SCHEMATIC }, revision: 9n, clientName: 'x' } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(docs.isDirty('schematic')).toBe(false);
    expect(docs.isDirty('board')).toBe(false);
    expect(server.t.requestsOf(GetItemsByIdSchema).length).toBe(0);
    docs.close();
  });
});
