/**
 * Shared helper for tests that need a real KiCad API server. `startKiCad()` hides *which* server:
 * `KICAD_TRANSPORT` picks the backend, and everything above it (the conformance suite, the round
 * trip suite) is written against `RunningKiCad` alone.
 *
 *   KICAD_TRANSPORT=ipc     (default)  kicad-cli api-server on an nng ipc socket   KICAD_CLI
 *   KICAD_TRANSPORT=stdio              kicad-api-host-native over pipes            KICAD_API_HOST
 *   KICAD_TRANSPORT=wasm               the wasm build, in this process             KICAD_WASM_DIR
 *
 * The kitchen-sink fixtures are copied into one temp project so board and schematic can be open at
 * the same time (the headless server allows a single project). In `wasm` mode there is no host file
 * system behind KiCad, so that temp directory — and the QA libraries it points at — are copied into
 * the module's MEMFS *at the same absolute paths*, which keeps every path inside the `.kicad_pro`
 * and the library tables valid. See docs/08-wasm.md.
 */
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NngIpcSubscriber, NngIpcTransport, StdioSubscriber, StdioTransport, WasmSubscriber, WasmTransport } from "../src/transport";
import type { Subscriber } from "../src/transport/nng-ipc-sub";
import type { SendOptions, Transport, TransportState } from "../src/transport/types";
import { KiCad } from "../src/model";
import {
  KICAD_CLI,
  KICAD_ROOT,
  KITCHEN_SINK_PCB,
  KITCHEN_SINK_SCH,
  haveKicad as haveKicadCli,
  startKicadServer,
  type KicadServer,
} from "./kicad-fixtures";

export { KICAD_CLI, KITCHEN_SINK_PCB, KITCHEN_SINK_SCH };

export const KICAD_DATA = KITCHEN_SINK_PCB.replace(/\/pcbnew\/api_kitchen_sink\.kicad_pcb$/, "");
/** A small footprint library shipped with KiCad's QA data (R_0402/R_0603/...). */
export const QA_RESISTOR_LIB = `${KICAD_DATA}/libraries/Resistor_SMD.pretty`;
/** A KiCad s-expression netlist from the QA data, for ImportNetlist dry runs. */
export const QA_NETLIST = `${KICAD_DATA}/eeschema/netlists/prefix_bus_alias/prefix_bus_alias.net`;
/** KiCad's QA symbol library (Device.kicad_sym), for headless symbol documents. */
export const QA_DEVICE_LIB = `${KICAD_DATA}/libraries/Device.kicad_sym`;

// ---------------------------------------------------------------------------- backend selection

export type KiCadBackend = "ipc" | "stdio" | "wasm";
const BACKENDS: KiCadBackend[] = ["ipc", "stdio", "wasm"];

export const KICAD_TRANSPORT = (process.env.KICAD_TRANSPORT ?? "ipc") as KiCadBackend;
if (!BACKENDS.includes(KICAD_TRANSPORT)) {
  throw new Error(`KICAD_TRANSPORT=${process.env.KICAD_TRANSPORT} is not one of ${BACKENDS.join(" | ")}`);
}

/** The native stdio host (`kicad-api-host-native`); override with `KICAD_API_HOST`. */
export const KICAD_API_HOST = process.env.KICAD_API_HOST ?? `${KICAD_ROOT}/build/native-host/kicad-api-host-native`;
/** Directory holding `kicad_api.js` + `kicad_api.wasm`; override with `KICAD_WASM_DIR`. */
export const KICAD_WASM_DIR = process.env.KICAD_WASM_DIR ?? `${KICAD_ROOT}/build/wasm/host`;
/** KiCad's share tree to mount at the module's `share` path (templates, schemas). */
export const KICAD_WASM_SHARE = process.env.KICAD_WASM_SHARE ?? "";

const WASM_MODULE = join(KICAD_WASM_DIR, "kicad_api.js");
/** MEMFS home/share for the wasm backend. */
const WASM_HOME = "/home/kicad";
const WASM_SHARE = "/kicad/share";

/** What the selected backend needs on disk, and where it should be. */
export function backendBinary(): string {
  switch (KICAD_TRANSPORT) {
    case "stdio":
      return KICAD_API_HOST;
    case "wasm":
      return WASM_MODULE;
    default:
      return KICAD_CLI;
  }
}

/** True when the selected backend can actually be started. */
export function haveKicad(): boolean {
  return KICAD_TRANSPORT === "ipc" ? haveKicadCli() : existsSync(backendBinary());
}

/** Why the backend is unavailable, phrased for a `[skip]` line. */
export function missingBackendMessage(): string {
  switch (KICAD_TRANSPORT) {
    case "stdio":
      return `kicad-api-host-native not found at ${KICAD_API_HOST} (set KICAD_API_HOST; see docs/08-wasm.md)`;
    case "wasm":
      return `KiCad wasm build not found at ${WASM_MODULE} (set KICAD_WASM_DIR; see docs/08-wasm.md)`;
    default:
      return `kicad-cli not found at ${KICAD_CLI} (set KICAD_CLI to run the conformance tests)`;
  }
}

// ---------------------------------------------------------------------------- the temp project

export interface TempProject {
  dir: string;
  pro: string;
  pcb: string;
  sch: string;
  dru: string;
  cleanup(): Promise<void>;
}

/**
 * Host paths a `wasm` backend must be able to see. `tempProject()` registers its own directory;
 * the QA libraries the fixtures point at are registered here. Anything a test creates later has to
 * be registered (or mounted with `mountHostPath`) before the server that needs it starts.
 */
const wasmMounts = new Set<string>([QA_RESISTOR_LIB, QA_DEVICE_LIB, QA_NETLIST, KITCHEN_SINK_SCH]);

/** Make `hostPath` (a file or a directory) visible to wasm backends started from now on. */
export function registerWasmMount(hostPath: string): void {
  wasmMounts.add(hostPath);
}

/** Copies the kitchen-sink board (+ project + DRU) and schematic into one temp project directory. */
export async function tempProject(prefix = "fp-pcb-conf-"): Promise<TempProject> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const base = KITCHEN_SINK_PCB.replace(/\.kicad_pcb$/, "");
  const pro = join(dir, "api_kitchen_sink.kicad_pro");
  const pcb = join(dir, "api_kitchen_sink.kicad_pcb");
  const dru = join(dir, "api_kitchen_sink.kicad_dru");
  const sch = join(dir, "api_kitchen_sink.kicad_sch");
  await cp(`${base}.kicad_pro`, pro);
  await cp(`${base}.kicad_pcb`, pcb);
  await cp(`${base}.kicad_dru`, dru);
  await cp(KITCHEN_SINK_SCH, sch);
  // Project-local footprint library table so `Resistor_SMD:*` resolves without an installed KiCad.
  await writeFile(
    join(dir, "fp-lib-table"),
    `(fp_lib_table\n  (version 7)\n  (lib (name "Resistor_SMD") (type "KiCad") (uri "${QA_RESISTOR_LIB}") (options "") (descr "QA resistors"))\n)\n`,
  );
  registerWasmMount(dir);
  return { dir, pro, pcb, sch, dru, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------- the running server

/**
 * What the suites need to know about the process (or module) behind the transport. `KicadServer`
 * from ./kicad-fixtures satisfies it; `stdio` and `wasm` provide equivalents.
 */
export interface ServerHandle {
  /** What `GetServerInfo.socket_url` is expected to contain (`inproc://kicad` off-socket). */
  socketPath: string;
  /** What `GetServerInfo.events_socket_url` is expected to contain. */
  eventsUrl: string;
  proc: { exitCode: number | null; signalCode: string | null };
  /** True once the backend has gone away on its own — `stop()` was not called. */
  readonly crashed: boolean;
  /** Diagnostics from the backend (a crash log, the host's stderr, ...). */
  stderr(): string;
  stop(): Promise<void>;
}

export interface RunningKiCad {
  backend: KiCadBackend;
  server: ServerHandle;
  transport: Transport;
  kicad: KiCad;
  /**
   * A `Subscriber` for KiCad's events, or `undefined` when this backend publishes none.
   * `eventsUrl` comes from `GetServerInfo.events_socket_url`; only the ipc backend needs it.
   */
  subscribe(eventsUrl?: string): Promise<Subscriber | undefined>;
  /**
   * A second, independent client connection. Backends without a socket only have the one channel,
   * so they hand out a detachable view of the same transport whose `close()` leaves it running.
   */
  secondTransport(): Promise<Transport>;
  stop(): Promise<void>;
}

export interface StartKiCadOptions {
  /** ipc backend only: a different `kicad-cli`. */
  cli?: string;
  /** Extra host paths the wasm backend must see (in addition to the registered ones). */
  mount?: string[];
}

/** Starts the backend named by `KICAD_TRANSPORT` (optionally preloading `file`) and connects. */
export async function startKiCad(
  file: string | null = null,
  prefix = "conf",
  opts: StartKiCadOptions | string = {},
): Promise<RunningKiCad> {
  const o: StartKiCadOptions = typeof opts === "string" ? { cli: opts } : opts;
  if (!haveKicad()) throw new Error(`cannot start the ${KICAD_TRANSPORT} backend: ${missingBackendMessage()}`);
  switch (KICAD_TRANSPORT) {
    case "stdio":
      return startStdio(file, prefix);
    case "wasm":
      return startWasm(file, prefix, o.mount ?? []);
    default:
      return startIpc(file, prefix, o.cli);
  }
}

function connect(transport: Transport, prefix: string): Promise<KiCad> {
  return KiCad.connect(transport, { clientName: `fp-pcb/${prefix}-${process.pid}`, readyTimeoutMs: 60_000 });
}

async function startIpc(file: string | null, prefix: string, cli?: string): Promise<RunningKiCad> {
  const server: KicadServer = await startKicadServer(file, prefix, cli);
  const transport = await NngIpcTransport.connect({ path: server.socketPath, defaultTimeoutMs: 60_000 });
  const kicad = await connect(transport, prefix);
  const handle: ServerHandle = {
    socketPath: server.socketPath,
    eventsUrl: server.socketPath.replace(/\.sock$/, "-events.sock"),
    proc: server.proc,
    get crashed() {
      return server.crashed;
    },
    stderr: () => server.stderr(),
    stop: () => server.stop(),
  };
  return {
    backend: "ipc",
    server: handle,
    transport,
    kicad,
    async subscribe(eventsUrl?: string) {
      if (!eventsUrl) return undefined;
      return NngIpcSubscriber.connect({ path: eventsUrl });
    },
    secondTransport() {
      return NngIpcTransport.connect({ path: server.socketPath, defaultTimeoutMs: 60_000 });
    },
    async stop() {
      await transport.close().catch(() => {});
      await server.stop();
    },
  };
}

async function startStdio(file: string | null, prefix: string): Promise<RunningKiCad> {
  const transport = await StdioTransport.connect({
    command: KICAD_API_HOST,
    args: file ? [file] : [],
    defaultTimeoutMs: 60_000,
  });
  const kicad = await connect(transport, prefix);
  let stopping = false;
  const server: ServerHandle = {
    socketPath: "inproc://kicad",
    eventsUrl: "inproc://kicad-events",
    proc: {
      get exitCode() {
        return transport.exitCode;
      },
      get signalCode() {
        return null;
      },
    },
    get crashed() {
      return !stopping && transport.state === "closed";
    },
    stderr: () => transport.stderr(),
    async stop() {
      stopping = true;
      await transport.close();
    },
  };
  return {
    backend: "stdio",
    server,
    transport,
    kicad,
    async subscribe() {
      return new StdioSubscriber(transport);
    },
    async secondTransport() {
      return shareTransport(transport);
    },
    async stop() {
      stopping = true;
      await transport.close().catch(() => {});
    },
  };
}

async function startWasm(file: string | null, prefix: string, extraMounts: string[]): Promise<RunningKiCad> {
  // Imported lazily so the ipc and stdio backends never load the wasm package.
  const { createKiCadWasm, mountPath } = await import("@fp-pcb/kicad-wasm");
  const log: string[] = [];
  const wasm = await createKiCadWasm({
    moduleUrl: `file://${WASM_MODULE}`,
    wasmUrl: `file://${join(KICAD_WASM_DIR, "kicad_api.wasm")}`,
    home: WASM_HOME,
    share: WASM_SHARE,
    env: {
      KICAD10_SYMBOL_DIR: `${WASM_SHARE}/symbols`,
      KICAD10_FOOTPRINT_DIR: `${WASM_SHARE}/footprints`,
      KICAD10_TEMPLATE_DIR: `${WASM_SHARE}/template`,
      KICAD10_3DMODEL_DIR: `${WASM_SHARE}/3dmodels`,
    },
    preload: file ?? "",
    printErr: (line) => {
      log.push(`${line}\n`);
      if (log.length > 4096) log.splice(0, 2048);
    },
  });
  if (KICAD_WASM_SHARE) await mountPath(wasm, KICAD_WASM_SHARE, WASM_SHARE);
  for (const hostPath of [...wasmMounts, ...extraMounts]) {
    if (existsSync(hostPath)) await mountPath(wasm, hostPath);
  }

  const transport = new WasmTransport(wasm, { defaultTimeoutMs: 60_000 });
  const kicad = await connect(transport, prefix);
  let stopping = false;
  const server: ServerHandle = {
    socketPath: "inproc://kicad",
    eventsUrl: "inproc://kicad-events",
    proc: { exitCode: null, signalCode: null },
    get crashed() {
      return !stopping && transport.state === "closed";
    },
    stderr: () => log.join(""),
    async stop() {
      stopping = true;
      await transport.close();
    },
  };
  return {
    backend: "wasm",
    server,
    transport,
    kicad,
    async subscribe() {
      return new WasmSubscriber(transport);
    },
    async secondTransport() {
      return shareTransport(transport);
    },
    async stop() {
      stopping = true;
      await transport.close().catch(() => {});
    },
  };
}

/** Mount a host path into a running wasm backend's MEMFS; a no-op for the other backends. */
export async function mountHostPath(rt: RunningKiCad, hostPath: string, memfsPath: string = hostPath): Promise<void> {
  registerWasmMount(hostPath);
  if (rt.backend !== "wasm") return;
  const { mountPath } = await import("@fp-pcb/kicad-wasm");
  await mountPath((rt.transport as WasmTransport).instance as unknown as Parameters<typeof mountPath>[0], hostPath, memfsPath);
}

/**
 * A `Transport` view of an existing one whose `close()` only detaches. Backends with a single
 * channel use it where the ipc backend would open a second socket.
 */
function shareTransport(inner: Transport): Transport {
  let closed = false;
  return {
    get state(): TransportState {
      return closed ? "closed" : inner.state;
    },
    send(request: Uint8Array, opts?: SendOptions) {
      return inner.send(request, opts);
    },
    onStateChange(cb: (s: TransportState) => void) {
      return inner.onStateChange(cb);
    },
    async close() {
      closed = true; // the shared transport keeps running
    },
  };
}

if (!haveKicad()) {
  console.log(`[skip] ${missingBackendMessage()}`);
} else if (KICAD_TRANSPORT !== "ipc") {
  console.log(`[kicad] backend ${KICAD_TRANSPORT} via ${backendBinary()}`);
}
