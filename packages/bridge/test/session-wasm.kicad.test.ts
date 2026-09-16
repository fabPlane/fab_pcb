/**
 * The wasm session backend against the *real* module: `POST /sessions` loads `kicad_api.js` in a
 * worker with the workspace project in its MEMFS, a WebSocket client talks the ordinary API to it
 * through the bridge, and what KiCad saves has to come back out to the workspace directory.
 *
 * `session-wasm.test.ts` covers the same paths against a JS mock of the C ABI and needs no build;
 * this one skips (with a message) unless `dist/kicad_api.js` or `$KICAD_WASM_DIR/kicad_api.js`
 * exists. `KICAD_WASM_SHARE` mounts KiCad's share tree when the build has no `.data` bundle.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KiCad } from "@fp-pcb/client";
import { WebSocketTransport, bridgeWsUrl } from "@fp-pcb/client/transport";
import {
  KICAD_CHECKOUT,
  configFromEnv,
  decodeApiResponse,
  encodePing,
  startBridge,
  type BridgeServer,
  type SessionInfo,
} from "../src/index";

const ENV_MODULE =
  process.env.KICAD_WASM_MODULE ?? (process.env.KICAD_WASM_DIR ? join(resolve(process.env.KICAD_WASM_DIR), "kicad_api.js") : null);
const DIST_MODULE = resolve(import.meta.dir, "../../kicad-wasm/dist/kicad_api.js");
const MODULE = [ENV_MODULE, DIST_MODULE].find((p): p is string => !!p && existsSync(p));

const FIXTURE = `${KICAD_CHECKOUT}/qa/data/pcbnew/api_kitchen_sink`;
const READY = !!MODULE && existsSync(`${FIXTURE}.kicad_pcb`);
if (!READY) {
  console.log(
    `[skip] no KiCad wasm build at ${ENV_MODULE ?? DIST_MODULE} (build it, then 'bun run --filter @fp-pcb/kicad-wasm fetch', or set KICAD_WASM_DIR)`,
  );
}

describe.skipIf(!READY)("bridge + the real wasm module + WebSocketTransport", () => {
  let bridge: BridgeServer;
  let workspace: string;
  let board: string;
  let info: SessionInfo;
  let ws: WebSocketTransport;
  let kicad: KiCad;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "fp-pcb-wasm-real-"));
    board = join(workspace, "api_kitchen_sink.kicad_pcb");
    for (const ext of [".kicad_pcb", ".kicad_pro", ".kicad_dru"]) await cp(`${FIXTURE}${ext}`, join(workspace, `api_kitchen_sink${ext}`));
    bridge = await startBridge(
      configFromEnv(process.env, {
        port: 0,
        workspaceRoot: workspace,
        sessionBackend: "wasm",
        wasmModuleUrl: pathToFileURL(MODULE!).href,
        log: () => {},
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await ws?.close();
    await bridge?.stop();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  test("POST /sessions loads the module in a worker and pings it ready", async () => {
    const t0 = performance.now();
    const res = await fetch(`${bridge.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "api_kitchen_sink.kicad_pcb" }),
    });
    expect(res.status).toBe(201);
    info = ((await res.json()) as { session: SessionInfo }).session;
    expect(info.backend).toBe("wasm");
    expect(info.state).toBe("running");
    expect(info.pid).toBeNull(); // no process: the module lives in a worker
    expect(info.kicadToken).toMatch(/^[0-9a-f-]{36}$/);
    console.log(`[bridge-wasm] session ready in ${(performance.now() - t0).toFixed(0)} ms`);
  }, 120_000);

  test("a WebSocket client gets Ping, OpenDocument and GetItems answered", async () => {
    ws = await WebSocketTransport.connect(bridgeWsUrl(bridge.url, info.id));
    expect(ws.kicadToken).toBe(info.kicadToken);

    const pong = decodeApiResponse(await ws.send(encodePing("fp-pcb/bridge-wasm-test")));
    expect(pong.statusName).toBe("AS_OK");

    kicad = await KiCad.connect(ws, { clientName: "fp-pcb/bridge-wasm-test", readyTimeoutMs: 60_000 });
    // The session preloaded the board when the module started, so it is already open.
    const b = await kicad.currentBoard();
    expect(b).toBeDefined();
    expect(b!.name).toBe("api_kitchen_sink.kicad_pcb");
    const footprints = await b!.getFootprints();
    expect(footprints.length).toBeGreaterThan(0);
    console.log(`[bridge-wasm] ${footprints.length} footprints over the WebSocket`);
  }, 120_000);

  test("SaveDocument is flushed from MEMFS back to the workspace", async () => {
    const before = await stat(board);
    const b = (await kicad.currentBoard())!;
    await b.save();
    // The flush is queued behind the reply in the worker; give it a moment to land on disk.
    let after = await stat(board);
    for (let i = 0; i < 50 && after.mtimeMs === before.mtimeMs; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = await stat(board);
    }
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
    const text = await readFile(board, "utf8");
    expect(text.startsWith("(kicad_pcb")).toBe(true);
    expect(text.length).toBeGreaterThan(1000);
    console.log(`[bridge-wasm] saved board flushed: ${before.size} -> ${after.size} bytes`);
  }, 120_000);

  test("DELETE /sessions/:id stops the worker", async () => {
    const res = await fetch(`${bridge.url}/sessions/${info.id}`, { method: "DELETE" });
    expect(res.ok).toBe(true);
    const health = (await (await fetch(`${bridge.url}/health`)).json()) as { sessions: unknown[] };
    expect(health.sessions).toEqual([]);
  }, 60_000);
});
