# @fp-pcb/client

The KiCad IPC API client: transport-agnostic, isomorphic (Bun and browser), and generated from
the fork's protos so it never drifts from the server. It talks to a `kicad-cli api-server`
process — directly over its nng IPC socket in Bun, or through `@fp-pcb/bridge` from a page.

```
src/
  transport/      Layer 1  NngIpcTransport, WebSocketTransport, NngIpcSubscriber, framing
  client.ts       Layer 2  KiCadClient: ApiRequest/ApiResponse envelope, retries, capabilities
  commands.ts               one generated function per command (gen-commands.ts, do not edit)
  commands-data.ts          the bundled coverage table (COMMANDS, KICAD_COMMIT)
  events.ts                 KiCadEvents over the pub/sub socket
  units.ts, errors.ts
  model/          Layer 3  KiCad -> Project -> Board | Schematic | FootprintDocument | SymbolDocument
  store/          Layer 4  ItemStore, DocumentSync, DocumentUndo
```

## The four layers

| Layer         | Entry point                                                       | What it does                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — transport | `NngIpcTransport`, `WebSocketTransport`                           | bytes in, bytes out. `send(request): Promise<reply>`, one request in flight, FIFO queue, timeouts, reconnect. `NngIpcSubscriber` is the matching SUB socket for events. Nothing here knows protobuf.                                                                                                                                               |
| 2 — client    | `KiCadClient`, `commands.*`                                       | packs a request message into `ApiRequest{header, Any}`, unpacks `ApiResponse`, maps status codes to `KiCadApiError`, retries `AS_BUSY`/`AS_NOT_READY` with backoff, detects server restarts via `AS_TOKEN_MISMATCH`, and caches `GetSupportedCommands`. `commands.ts` is generated: one typed function per command, `getVersion(client, req)` etc. |
| 3 — model     | `KiCad`, `Project`, `Board`, `Schematic`, `Commit`, item wrappers | the ergonomic surface. Handles specifiers, sheet paths, unit conversion, commit batching, job polling, and the "GUI-only means `[]`, not an error" cases. This is the layer application code should use.                                                                                                                                           |
| 4 — store     | `MemoryItemStore`, `DocumentSync`, `DocumentUndo`                 | a normalised, indexed, subscribable view of one document's items, kept in step with commits (optimistic apply, canonical replace) and with changes made elsewhere (`since_revision` when the server has it, full reload otherwise). The renderer consumes this, not Layer 3.                                                                       |

Each layer only depends on the ones below it, so a transport can be swapped without touching the
model and the model can be exercised against a fake transport in unit tests.

## Worked example

### Bun — over the IPC socket

```ts
import { NngIpcTransport, NngIpcSubscriber } from "@fp-pcb/client/transport";
import { KiCad, Track, KiCadEvents, mm } from "@fp-pcb/client";
import { BoardLayer } from "@fp-pcb/proto";

// kicad-cli api-server board.kicad_pcb --socket /tmp/kicad/demo.sock
const transport = await NngIpcTransport.connect({ path: "/tmp/kicad/demo.sock" });
const kicad = await KiCad.connect(transport, { clientName: "my-app" }); // pings until AS_OK

// --- events: KiCad publishes on a second socket, named by GetServerInfo ---
const info = await kicad.serverInfo();
const events = new KiCadEvents(await NngIpcSubscriber.connect({ path: info!.eventsSocketUrl }));
events.onDocumentChanged((e) => console.log("changed", e.document?.type, e.revision));
events.onGap(() => console.warn("missed events — re-read state, do not guess"));

// --- open a project and its board ---
const project = await kicad.openProject("/work/demo/demo.kicad_pro");
const board = await project.openBoard();

// --- read items (Layer 3 wrappers; positions are plain numbers in nm) ---
const footprints = await board.getFootprints();
console.log(footprints[0]!.reference, footprints[0]!.position); // "R1" { x: 12000000, y: 8000000 }
// Moves the anchor plus pads, fields, text, and graphics; send the returned wrapper in one commit.
footprints[0]!.translate({ x: mm(1), y: 0 });
await board.commit("move R1", (tx) => tx.update([footprints[0]!]));

// --- write: one commit = BeginCommit + batched Create/Update/Delete + EndCommit ---
const track = new Track();
track.start = { x: mm(5), y: mm(5) };
track.end = { x: mm(15), y: mm(5) };
track.width = mm(0.3);
track.layerId = BoardLayer.BL_F_Cu;
const { created } = await board.commit("add a track", (tx) => tx.create([track]));
console.log(created[0]!.id); // KIID KiCad assigned

// --- settings the renderer needs ---
const theme = await kicad.settings.colorTheme("KiCad Default"); // renderer Theme shape
const app = await kicad.settings.appSettings("pcb"); // units, grids, zoom factors

await events.close();
await kicad.close();
```

### Browser — over the WebSocket bridge

Identical from Layer 2 up; only the transport changes. `@fp-pcb/bridge` owns the KiCad process
and relays the same frames, adding a 4-byte correlation id so several tabs can pipeline.

```ts
import { WebSocketTransport, bridgeWsUrl } from "@fp-pcb/client/transport";
import { KiCad, KiCadEvents } from "@fp-pcb/client";

const transport = await WebSocketTransport.connect(bridgeWsUrl(location.origin, sessionId));
const kicad = await KiCad.connect(transport, { clientName: "fp-pcb/ui" });
const events = KiCadEvents.fromTransport(transport); // events ride the same socket
const board = await (await kicad.openProject(path)).openBoard();
```

### Keeping a store in sync (Layer 4)

```ts
import { DocumentSync } from "@fp-pcb/client/store";

const sync = new DocumentSync(board);
await sync.load(); // GetItems for every type of the document
sync.store.subscribe((diff) => host.applyDiff(diff)); // added / updated / removed + revision
```

## Units

KiCad's IPC API carries lengths as **int64 nanometres**, which protobuf-es surfaces as `bigint`,
and angles as double degrees. Above the wire layer this package works in **plain `number`
nanometres** — exact to 2^53 nm (about 9000 km, far past any board) — so application code never
does bigint arithmetic and never mixes the two.

- Conversion happens exactly at the wrapper boundary (`src/units.ts`): `nm(distance)` unwraps,
  `toDistance` / `toVector2` / `box2` wrap.
- Helpers to write literals: `mm(0.3)`, `mil(50)`, `nm(x)`, `deg(a)`.
- `fromBigInt` throws `RangeError` outside the safe-integer range rather than losing precision
  silently.
- Exceptions, on purpose: `Document.revision()` and `GetItems.since_revision` stay `bigint`
  (they are opaque counters, not lengths), as do event sequence numbers. `AppSettings.grids` and
  `AppSettings.defaults` stay the user's own strings ("50 mil", "1.0 mm") because KiCad stores
  them verbatim.
- Raw protobuf messages you reach through `commands.*` are untouched: those still carry `bigint`.

## Errors

| Error                | Raised when                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TransportError`     | connection, timeout, framing (Layer 1; `code` is `closed` / `timeout` / …)                                                                                                                                                          |
| `KiCadApiError`      | KiCad answered a status other than `AS_OK`. `code`, `codeName`, `command`, `serverMessage`; `isUnsupported` is true for `AS_UNIMPLEMENTED` / `AS_UNHANDLED`. `KiCadApiError.is(e, ApiStatusCode.AS_BAD_REQUEST)` is the type guard. |
| `CapabilityError`    | the client refused to send a command this server does not advertise                                                                                                                                                                 |
| `KiCadItemError`     | a Create/Update/Delete came back `AS_OK` but individual items were rejected; `failures[]` has id, index, code and message. `commit(..., { strict: false })` skips them instead of throwing.                                         |
| `CommitDroppedError` | a commit callback threw; the commit was `CMA_DROP`-ed and the original error is `cause`                                                                                                                                             |
| `JobError`           | a `RunBoardJob*` / `RunSchematicJob*` reported `JS_ERROR` (or `JS_WARNING` with `failOnWarning`)                                                                                                                                    |
| `ActionError`        | `RunAction` answered other than `RAS_OK` — an unknown action name, or a GUI-only one headless                                                                                                                                       |

`AS_BUSY` and `AS_NOT_READY` are not errors you see: `KiCadClient` retries them with exponential
backoff until `retry.deadlineMs` (30 s by default). `connect()` uses the same mechanism to wait out
a document load.

## Capabilities and GUI-only commands

The server advertises what it implements. `client.capabilities()` calls `GetSupportedCommands` and
caches the answer; on a server too old to have it, it falls back to the coverage table bundled in
`commands-data.ts` (generated from the KiCad tree at `KICAD_COMMIT`).

```ts
const caps = await kicad.capabilities();
caps.size; // 164 on the current fork
caps.has("GetRatsnest"); // advertised at all?
caps.isHeadless("GetSelection"); // false — needs a GUI frame
await client.supports("Undo"); // advertised and usable here
```

15 of the 165 commands are **GUI-only**: selection (`GetSelection`, `AddToSelection`,
`ClearSelection`, `RemoveFromSelection`, `SyncSelection`, `HighlightNets`), visible layers and
appearance state, `RevertDocument`, and the interactive tools. Headless they answer
`AS_UNIMPLEMENTED` or `AS_UNHANDLED`. A web UI owns that state itself, so this is a non-issue in
practice — but it is why the model layer keeps them out of the ergonomic surface, and why the
conformance suite asserts they fail _cleanly_ rather than crashing or hanging.

Set `checkCapabilities: true` on `KiCadClient` to have `call()` consult the capability set first
and throw `KiCadApiError(AS_UNIMPLEMENTED)` locally, saving a round trip. Where the model layer can
give a sensible answer instead of an error it does — `kicad.openDocuments(type)` maps KiCad's
`AS_UNHANDLED` ("no editor of that kind exists") to `[]`, and `kicad.serverInfo()` returns
`undefined` on a server that predates the command.

## Tests

```bash
bun test                                # unit tests: fake transport / fake REP + PUB servers, no KiCad
KICAD_CLI=/path/to/kicad-cli bun test   # adds the *.kicad.test.ts integration and conformance suites
bun run test:conformance                # just test/conformance
bunx tsc -b packages/client             # from the repo root
```

Without `KICAD_CLI` (and with no `kicad-cli` at the default fork build path) every `*.kicad.test.ts`
skips cleanly and prints one `[skip]` line — the suites are guarded by `describe.skipIf(!haveKicad())`.

`test/conformance/commands.kicad.test.ts` is the contract with the server: **one test per command in
`tooling/coverage/commands.json`**, run against a real `kicad-cli api-server` on a unique socket with
the kitchen-sink board and schematic copied into a temp project. It asserts invariants, records the
observed values as a note, expects GUI-only commands to answer `AS_UNIMPLEMENTED`/`AS_UNHANDLED`, and
fails the run if any command in the table has no test. Server crashes are caught, the server is
restarted, and the incident is reported instead of taking the rest of the suite down. Notes
containing `KICAD-BUG` flag behaviour that is wrong on the KiCad side and worked around here.

The run prints a summary and writes it to `dist/conformance-summary.txt`:

```
=== IPC conformance (KiCad bc8e733a20) ===
165 commands: 150 pass, 15 skip (gui-only), 0 fail; headless 150/150 green; ...
  pass GetColorTheme   common/settings   KiCad Default: 301 colors over 3d_viewer/board/gerbview/schematic, ...
```
