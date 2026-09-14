#!/usr/bin/env bun
/**
 * Request-latency comparison of the three ways a client reaches `kicad-cli api-server`:
 *
 *   direct-ws  NngWsTransport  →  ws://127.0.0.1:<port>/kicad          (no bridge in the path)
 *   ipc        NngIpcTransport →  ipc:///tmp/kicad/<...>.sock          (Bun only)
 *   bridge     WebSocketTransport → bridge /ws → NngIpcTransport → ipc (what the app ships by default)
 *
 * Each path gets its own `kicad-cli api-server` on the same board, is warmed up, then answers N
 * sequential Pings; the script reports mean / median / p95 / min / max per request.
 *
 *   bun tooling/bench/transport-latency.ts [--n 500] [--warmup 50] [--board <path>] [--only ws,ipc,bridge]
 *
 * Needs a kicad-cli that accepts `--socket ws://...` (KiCad fork >= 8eafd9cf01); set KICAD_CLI to
 * point at it. Exits 2 when the binary is missing.
 */
import { existsSync } from "node:fs";
import { NngIpcTransport, NngWsTransport, WebSocketTransport, bridgeWsUrl, type Transport } from "@fp-pcb/client/transport";
import { startBridge, configFromEnv, type BridgeServer } from "@fp-pcb/bridge";
import {
  KICAD_CLI,
  KITCHEN_SINK_PCB,
  PING_REQUEST,
  decodeApiResponse,
  startKicadServer,
  startKicadWsServer,
} from "../../packages/client/test/kicad-fixtures";

interface Args {
  n: number;
  warmup: number;
  board: string;
  only: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { n: 500, warmup: 50, board: KITCHEN_SINK_PCB, only: new Set(["ws", "ipc", "bridge"]) };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--n" && value) ((a.n = Number(value)), i++);
    else if (flag === "--warmup" && value) ((a.warmup = Number(value)), i++);
    else if (flag === "--board" && value) ((a.board = value), i++);
    else if (flag === "--only" && value) ((a.only = new Set(value.split(","))), i++);
    else if (flag === "--help") {
      console.log("usage: bun tooling/bench/transport-latency.ts [--n 500] [--warmup 50] [--board <path>] [--only ws,ipc,bridge]");
      process.exit(0);
    }
  }
  return a;
}

interface Stats {
  n: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  totalMs: number;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((x, y) => x - y);
  const total = samples.reduce((s, x) => s + x, 0);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    n: samples.length,
    meanMs: total / samples.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    minMs: sorted[0]!,
    maxMs: sorted.at(-1)!,
    totalMs: total,
  };
}

/** Ping until the server answers AS_OK (the board is still loading for the first ~0.5 s). */
async function waitReady(t: Transport, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = decodeApiResponse(await t.send(PING_REQUEST, { timeoutMs: 30_000 }));
    if (r.status === 1) return;
    if (Date.now() > deadline) throw new Error(`server never became ready (last status ${r.statusName})`);
    await Bun.sleep(25);
  }
}

async function measure(t: Transport, n: number, warmup: number): Promise<Stats> {
  for (let i = 0; i < warmup; i++) await t.send(PING_REQUEST, { timeoutMs: 30_000 });
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = decodeApiResponse(await t.send(PING_REQUEST, { timeoutMs: 30_000 }));
    samples.push(performance.now() - t0);
    if (r.status !== 1) throw new Error(`unexpected status ${r.statusName}`);
  }
  return stats(samples);
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(KICAD_CLI)) {
  console.error(`kicad-cli not found at ${KICAD_CLI}; set KICAD_CLI`);
  process.exit(2);
}

console.log(`board   ${args.board}`);
console.log(`kicad   ${KICAD_CLI}`);
console.log(`samples ${args.n} sequential Pings per path (after ${args.warmup} warm-up requests)\n`);

const results = new Map<string, Stats>();

if (args.only.has("ws")) {
  const server = await startKicadWsServer(args.board, { token: "bench-ws" });
  const t = await NngWsTransport.connect({ url: server.url, defaultTimeoutMs: 60_000 });
  try {
    await waitReady(t);
    results.set(`direct-ws  (${server.url})`, await measure(t, args.n, args.warmup));
  } finally {
    await t.close();
    await server.stop();
  }
}

if (args.only.has("ipc")) {
  const server = await startKicadServer(args.board, "bench-ipc");
  const t = await NngIpcTransport.connect({ path: server.socketPath, defaultTimeoutMs: 60_000 });
  try {
    await waitReady(t);
    results.set("ipc        (unix socket)", await measure(t, args.n, args.warmup));
  } finally {
    await t.close();
    await server.stop();
  }
}

if (args.only.has("bridge")) {
  let bridge: BridgeServer | undefined;
  let t: WebSocketTransport | undefined;
  let sessionId = "";
  try {
    bridge = await startBridge({ ...configFromEnv(process.env, { port: 0, log: () => {} }), workspaceRoot: "/" });
    const res = await fetch(`${bridge.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: args.board }),
    });
    if (!res.ok) throw new Error(`POST /sessions: ${res.status} ${await res.text()}`);
    sessionId = ((await res.json()) as { session: { id: string } }).session.id;
    t = await WebSocketTransport.connect(bridgeWsUrl(bridge.url, sessionId), { defaultTimeoutMs: 60_000 });
    await waitReady(t);
    results.set("bridge     (ws → bridge → ipc)", await measure(t, args.n, args.warmup));
  } finally {
    await t?.close();
    if (bridge && sessionId) await fetch(`${bridge.url}/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
    await bridge?.stop();
  }
}

const pad = (s: string, w: number) => s.padEnd(w);
const num = (x: number) => x.toFixed(3).padStart(8);
console.log(
  `${pad("path", 32)}${"mean".padStart(8)}${"median".padStart(9)}${"p95".padStart(9)}${"min".padStart(9)}${"max".padStart(9)}   (ms/request)`,
);
for (const [name, s] of results) {
  console.log(`${pad(name, 32)}${num(s.meanMs)}${num(s.medianMs)}${num(s.p95Ms)}${num(s.minMs)}${num(s.maxMs)}`);
}
const base = results.get("ipc        (unix socket)");
if (base) {
  for (const [name, s] of results) {
    if (s === base) continue;
    const delta = s.meanMs - base.meanMs;
    console.log(
      `\n${name.trim().split(" ")[0]} vs ipc: ${delta >= 0 ? "+" : ""}${delta.toFixed(3)} ms/request (${((s.meanMs / base.meanMs) * 100).toFixed(0)}% of ipc)`,
    );
  }
}
process.exit(0);
