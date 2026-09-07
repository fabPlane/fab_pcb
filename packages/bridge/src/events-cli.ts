#!/usr/bin/env bun
/**
 * Prints the KiCad events of a bridge session as they arrive, decoded to JSON — one line each.
 *
 *   bun run --filter @fp-pcb/bridge events <session-id>     # or: bun packages/bridge/src/events-cli.ts <id>
 *   bun run --filter @fp-pcb/bridge events                  # lists sessions
 *
 * Options: `--bridge <url>` (default env `BRIDGE_URL` or http://127.0.0.1:4020); `--sse` reads the
 * `GET /sessions/:id/events` stream instead of the WebSocket relay (both carry the same events).
 */
import { KiCadEvents, WebSocketTransport, bridgeWsUrl, eventToJson } from "@fp-pcb/client";

const args = process.argv.slice(2);
let bridgeUrl = process.env.BRIDGE_URL ?? "http://127.0.0.1:4020";
let useSse = false;
let sessionId: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--bridge") bridgeUrl = args[++i] ?? bridgeUrl;
  else if (a.startsWith("--bridge=")) bridgeUrl = a.slice("--bridge=".length);
  else if (a === "--sse") useSse = true;
  else if (a === "-h" || a === "--help") usage(0);
  else if (!sessionId) sessionId = a;
  else usage(2, `unexpected argument ${a}`);
}
bridgeUrl = bridgeUrl.replace(/\/$/, "");

function usage(code: number, message?: string): never {
  if (message) console.error(message);
  console.error("usage: events [--bridge <url>] [--sse] [<session-id>]");
  process.exit(code);
}

const stamp = () => new Date().toISOString().slice(11, 23);
const line = (tag: string, data: unknown) => console.log(`${stamp()} ${tag} ${typeof data === "string" ? data : JSON.stringify(data)}`);

async function get(path: string): Promise<Response> {
  try {
    return await fetch(`${bridgeUrl}${path}`);
  } catch (e) {
    return usage(
      1,
      `cannot reach the bridge at ${bridgeUrl}: ${e instanceof Error ? e.message : String(e)} (is it running? set --bridge or BRIDGE_URL)`,
    );
  }
}

if (!sessionId) {
  const res = await get("/sessions");
  if (!res.ok) usage(1, `${bridgeUrl}/sessions: ${res.status} ${await res.text()}`);
  const { sessions } = (await res.json()) as {
    sessions: Array<{ id: string; state: string; path: string | null; eventsState: string; clients: number }>;
  };
  if (sessions.length === 0) console.log(`no sessions on ${bridgeUrl}`);
  for (const s of sessions)
    console.log(`${s.id}  ${s.state.padEnd(8)} events:${s.eventsState.padEnd(12)} clients:${s.clients}  ${s.path ?? "(no file)"}`);
  process.exit(0);
}

if (useSse) {
  const res = await get(`/sessions/${encodeURIComponent(sessionId)}/events`);
  if (!res.ok || !res.body) usage(1, `${res.status} ${await res.text()}`);
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let type = "message";
      let data = "";
      for (const l of block.split("\n")) {
        if (l.startsWith("event:")) type = l.slice(6).trim();
        else if (l.startsWith("data:")) data += l.slice(5).trim();
      }
      if (data) line(type, data);
    }
  }
  console.log("stream ended");
  process.exit(0);
}

const ws = await WebSocketTransport.connect(bridgeWsUrl(bridgeUrl, sessionId), { log: (m) => console.error(`[transport] ${m}`) }).catch(
  (e: unknown) => {
    usage(1, `cannot connect to session ${sessionId} on ${bridgeUrl}: ${e instanceof Error ? e.message : String(e)}`);
  },
);
line("hello", { sessionId: ws.sessionId, serverState: ws.serverState, eventsState: ws.eventsState, kicadToken: ws.kicadToken });
ws.onControl((m) => {
  if (m.type === "events" || m.type === "server-state") line(m.type, m);
});
const events = KiCadEvents.fromTransport(ws);
events.on("*", (_p, ev) => line("event", eventToJson(ev)));
events.onGap((g) => line("gap", `missed events between sequence ${g.expected} and ${g.received}`));
events.onError((e) => line("error", e.message));
ws.onStateChange((s) => {
  if (s === "closed") {
    console.log("connection closed");
    process.exit(0);
  }
});
process.on("SIGINT", () => {
  void ws.close().then(() => process.exit(0));
});
