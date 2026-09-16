/**
 * The wasm session backend, driven through the bridge's public surface (`POST /sessions`, `/ws`,
 * `DELETE /sessions/:id`) so the test also proves the WebSocket pass-through does not care which
 * backend answers. No wasm build is needed: the worker loads `fixtures/mock-kicad-api.ts`, a JS
 * implementation of the same C ABI, exactly the way it would load `kicad_api.js`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketTransport, bridgeWsUrl } from "@fp-pcb/client/transport";
import {
  configFromEnv,
  decodeApiResponse,
  encodeApiRequest,
  encodePing,
  requestTypeName,
  shouldFlushAfter,
  startBridge,
  type BridgeServer,
  type SessionInfo,
} from "../src/index";

const MOCK_MODULE = pathToFileURL(join(import.meta.dir, "fixtures", "mock-kicad-api.ts")).href;
const BOARD = "board.kicad_pcb";
const ORIGINAL = "(kicad_pcb (version 20240108))\n";
/** Must match `SAVED_TEXT` in the fixture (importing it here would load the mock into this process). */
const SAVED_TEXT = "saved by the mock wasm module\n";

const req = (type: string) => encodeApiRequest("fp-pcb/session-wasm-test", `kiapi.common.commands.${type}`);

describe("request envelope sniffing", () => {
  test("reads the message name out of an ApiRequest", () => {
    expect(requestTypeName(encodePing())).toBe("Ping");
    expect(requestTypeName(req("SaveDocument"))).toBe("SaveDocument");
    expect(requestTypeName(Uint8Array.from([0xff, 0xff]))).toBe("");
    expect(requestTypeName(new Uint8Array())).toBe("");
  });
  test("only the file-touching commands flush MEMFS", () => {
    expect(shouldFlushAfter("SaveDocument")).toBe(true);
    expect(shouldFlushAfter("SaveCopyOfDocument")).toBe(true);
    expect(shouldFlushAfter("CloseDocument")).toBe(true);
    // A commit changes the document in memory only, so flushing there would rewrite the whole
    // project on every edit for nothing.
    expect(shouldFlushAfter("EndCommit")).toBe(false);
    expect(shouldFlushAfter("GetItems")).toBe(false);
  });
});

describe("SESSION_BACKEND", () => {
  test("defaults to the process backend and rejects anything else", () => {
    expect(configFromEnv({}).sessionBackend).toBe("process");
    expect(configFromEnv({ SESSION_BACKEND: "wasm" }).sessionBackend).toBe("wasm");
    expect(configFromEnv({ SESSION_BACKEND: "process" }).sessionBackend).toBe("process");
    expect(() => configFromEnv({ SESSION_BACKEND: "native" })).toThrow(/process.*wasm/);
  });
  test("the module URL follows KICAD_WASM_MODULE, then KICAD_WASM_DIR", () => {
    expect(configFromEnv({}).wasmModuleUrl).toMatch(/^file:\/\/.*kicad-wasm\/dist\/kicad_api\.js$/);
    expect(configFromEnv({ KICAD_WASM_DIR: "/build/wasm/host" }).wasmModuleUrl).toBe("file:///build/wasm/host/kicad_api.js");
    expect(configFromEnv({ KICAD_WASM_MODULE: "https://cdn.example/kicad_api.js" }).wasmModuleUrl).toBe("https://cdn.example/kicad_api.js");
  });
});

describe("wasm-backed sessions", () => {
  let bridge: BridgeServer | null = null;
  let workspace = "";

  async function start(overrides: Partial<Parameters<typeof startBridge>[0]> = {}): Promise<BridgeServer> {
    workspace = await mkdtemp(join(tmpdir(), "fp-pcb-wasm-"));
    await writeFile(join(workspace, BOARD), ORIGINAL);
    bridge = await startBridge(
      configFromEnv(
        {},
        {
          port: 0,
          workspaceRoot: workspace,
          sessionBackend: "wasm",
          wasmModuleUrl: MOCK_MODULE,
          kicadCli: "/nonexistent/kicad-cli",
          log: () => {},
          ...overrides,
        },
      ),
    );
    return bridge;
  }

  async function createSession(body: Record<string, unknown> = { path: BOARD }): Promise<SessionInfo> {
    const res = await fetch(`${bridge!.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { session?: SessionInfo; error?: string };
    if (!res.ok) throw new Error(`POST /sessions: ${res.status} ${json.error}`);
    return json.session!;
  }

  afterEach(async () => {
    await bridge?.stop();
    bridge = null;
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = "";
  });

  test("start, hello, one request, an event, stop", async () => {
    await start();
    const info = await createSession();
    expect(info.backend).toBe("wasm");
    expect(info.state).toBe("running");
    expect(info.pid).toBeNull();
    expect(info.socketPath).toBe(`inproc://kicad-${info.id}`);
    // `pingUntilReady` ran against the module, so the token is the one `kiapi_init` was handed.
    expect(info.kicadToken).toMatch(/^[0-9a-f-]{36}$/);

    const ws = await WebSocketTransport.connect(bridgeWsUrl(bridge!.url, info.id));
    try {
      expect(ws.sessionId).toBe(info.id);
      expect(ws.kicadToken).toBe(info.kicadToken);
      expect(ws.serverState).toBe("running");

      const events: Uint8Array[] = [];
      ws.onEvent((e) => events.push(e));

      // One ApiRequest through the same frame path the process backend uses.
      const reply = decodeApiResponse(await ws.send(req("GetOpenDocuments"), { timeoutMs: 10_000 }));
      expect(reply).toMatchObject({ statusName: "AS_OK", token: info.kicadToken });

      const deadline = Date.now() + 5000;
      while (events.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(events[0]).toEqual(Uint8Array.from([0x08, 0x01]));

      const after = (await (await fetch(`${bridge!.url}/sessions/${info.id}`)).json()) as { session: SessionInfo };
      expect(after.session.eventsState).toBe("connected");
      expect(after.session.eventsRelayed).toBeGreaterThan(0);
    } finally {
      await ws.close();
    }

    expect((await fetch(`${bridge!.url}/sessions/${info.id}`, { method: "DELETE" })).ok).toBe(true);
    expect(bridge!.sessions.size).toBe(0);
  }, 30_000);

  test("the project is mounted into MEMFS and a save is copied back out", async () => {
    await start();
    const info = await createSession();
    const ws = await WebSocketTransport.connect(bridgeWsUrl(bridge!.url, info.id));
    try {
      // The mock only knows the document because the worker mounted it and passed it as `preload`.
      expect(decodeApiResponse(await ws.send(req("SaveDocument"), { timeoutMs: 10_000 })).statusName).toBe("AS_OK");
      const deadline = Date.now() + 5000;
      let text = ORIGINAL;
      while (text !== SAVED_TEXT && Date.now() < deadline) {
        text = await readFile(join(workspace, BOARD), "utf8");
        if (text !== SAVED_TEXT) await Bun.sleep(20);
      }
      expect(text).toBe(SAVED_TEXT);
    } finally {
      await ws.close();
    }
  }, 30_000);

  test("a request that outlives its budget terminates the worker and fails the session", async () => {
    // Shorter than the fixture's 1500 ms `GetVersion`, so the timeout fires while the module holds
    // its thread — the case a `kicad-cli` process would answer with SIGKILL.
    await start({ requestTimeoutMs: 250 });
    const info = await createSession();
    const session = bridge!.sessions.get(info.id)!;
    const ws = await WebSocketTransport.connect(bridgeWsUrl(bridge!.url, info.id));
    try {
      const failed = await ws.send(req("GetVersion"), { timeoutMs: 10_000 }).then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      );
      // The bridge forwards the transport's own code, so the client learns it was a timeout and
      // not a lost connection.
      expect(failed?.code).toBe("timeout");
      expect(failed?.message).toMatch(/did not answer within 250 ms/);
      expect(session.state).toBe("failed");
      expect(session.error).toMatch(/did not answer within 250 ms/);
      expect(session.transport?.state).toBe("closed");
      // The session survives as a record; a client that keeps sending is told the server is gone.
      const next = await ws.send(encodePing(), { timeoutMs: 5000 }).then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
      expect(next?.code).toBe("closed");
    } finally {
      await ws.close();
    }
    expect((await fetch(`${bridge!.url}/sessions/${info.id}`, { method: "DELETE" })).ok).toBe(true);
  }, 30_000);

  test("POST /sessions {backend} overrides SESSION_BACKEND, and an unknown one is a 400", async () => {
    await start({ sessionBackend: "process" });
    const res = await fetch(`${bridge!.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: BOARD, backend: "sideways" }),
    });
    expect(res.status).toBe(400);
    const info = await createSession({ path: BOARD, backend: "wasm" });
    expect(info.backend).toBe("wasm");
    expect(info.state).toBe("running");
  }, 30_000);
});
