/**
 * `Bun.serve` front: HTTP JSON API for sessions and files, WebSocket `/ws?session=<id>` that
 * forwards binary frames byte-for-byte to the session's KiCad server (and relays KiCad's events
 * to it), `GET /sessions/:id/events` mirroring those events as JSON over SSE, optional static
 * hosting.
 */
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { decodeEvent, eventToJson } from "@kicad-web/client";
import { createRouteJobs, matchRouteJobPath, type RouteJobs } from "@kicad-web/router/bridge-job";
import {
  TransportError,
  WS_BRIDGE_PROTOCOL_VERSION,
  decodeWsFrame,
  encodeControl,
  encodeWsFrame,
  parseControl,
  type BridgeErrorCode,
} from "@kicad-web/client/transport";
import type { BridgeConfig } from "./config";
import { handleFiles } from "./files";
import { SessionManager, type Session, type WsData } from "./session";

export interface BridgeServer {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly config: BridgeConfig;
  readonly sessions: SessionManager;
  /** The autorouting jobs mounted under `/sessions/:id/route`. */
  readonly routeJobs: RouteJobs;
  stop(): Promise<void>;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-expose-headers": "x-file-path",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8" } });
}

export async function startBridge(cfg: BridgeConfig): Promise<BridgeServer> {
  const sessions = new SessionManager(cfg);
  const startedAt = Date.now();
  let clientCounter = 0;
  await sessions.cleanStaleSockets();
  const kicadCliExists = await stat(cfg.kicadCli)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!kicadCliExists) cfg.log(`warning: kicad-cli not found at ${cfg.kicadCli} (set KICAD_CLI)`);
  const routeJobs = createRouteJobs({ freerouting: cfg.freerouting, log: cfg.log });
  if (!cfg.freerouting.ok) cfg.log(`warning: ${cfg.freerouting.reason}`);

  const server = Bun.serve<WsData>({
    port: cfg.port,
    hostname: cfg.hostname,
    idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      if (path === "/ws") {
        const id = url.searchParams.get("session") ?? "";
        const session = sessions.get(id);
        if (!session) return json({ error: `unknown session "${id}"` }, 404);
        const ok = srv.upgrade(req, { data: { session, clientId: ++clientCounter } });
        return ok ? undefined : json({ error: "WebSocket upgrade failed" }, 400);
      }

      if (path === "/health") {
        return json({
          ok: true,
          name: "@kicad-web/bridge",
          protocolVersion: WS_BRIDGE_PROTOCOL_VERSION,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          kicadCli: cfg.kicadCli,
          kicadCliExists,
          workspaceRoot: cfg.workspaceRoot,
          staticDir: cfg.staticDir,
          freerouting: cfg.freerouting,
          sessions: sessions.list().map((s) => ({ id: s.id, state: s.state, path: s.path, clients: s.clients })),
        });
      }

      if (path === "/sessions") {
        if (req.method === "GET") return json({ sessions: sessions.list() });
        if (req.method === "POST") {
          let body: { path?: string | null; socket?: string; id?: string } = {};
          const text = await req.text();
          if (text.trim()) {
            try {
              body = JSON.parse(text);
            } catch {
              return json({ error: "body must be JSON" }, 400);
            }
          }
          try {
            const s = await sessions.create({ path: body.path ?? null, socket: body.socket, id: body.id });
            return json({ session: s.info(), wsUrl: `/ws?session=${encodeURIComponent(s.id)}` }, 201);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const status = /not found|invalid|already exists/.test(msg) ? 400 : 502;
            return json({ error: msg }, status);
          }
        }
        return json({ error: "method not allowed" }, 405);
      }

      const route = matchRouteJobPath(path);
      if (route) {
        const session = sessions.get(route.sessionId);
        if (!session) return json({ error: `unknown session "${route.sessionId}"` }, 404);
        session.touch();
        return routeJobs.handle(
          req,
          { id: session.id, transport: session.transport, clientName: `kicad-web/bridge/${session.id}/router` },
          route.jobId,
        );
      }

      const m = /^\/sessions\/([^/]+)(?:\/(log|events))?$/.exec(path);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        const session = sessions.get(id);
        if (!session) return json({ error: `unknown session "${id}"` }, 404);
        if (m[2] === "log") return json({ id, lines: session.logLines });
        if (m[2] === "events") return req.method === "GET" ? eventStream(session, cfg) : json({ error: "method not allowed" }, 405);
        if (req.method === "GET") return json({ session: session.info() });
        if (req.method === "DELETE") {
          await sessions.destroy(id);
          return json({ ok: true, id });
        }
        return json({ error: "method not allowed" }, 405);
      }

      if (path === "/files" || path.startsWith("/files/")) return handleFiles(req, url, cfg, CORS);

      if (cfg.staticDir && req.method === "GET") {
        const res = await serveStatic(cfg.staticDir, path);
        if (res) return res;
      }
      return json({ error: `not found: ${path}` }, 404);
    },
    websocket: {
      maxPayloadLength: cfg.maxPayloadBytes,
      idleTimeout: Math.min(960, Math.max(0, cfg.wsIdleTimeoutSec)),
      sendPings: true,
      open(ws) {
        const { session, clientId } = ws.data;
        session.clients.add(ws);
        session.touch();
        cfg.log(`session ${session.id}: client #${clientId} connected (${session.clients.size} total)`);
        ws.send(
          encodeControl({
            type: "hello",
            protocolVersion: WS_BRIDGE_PROTOCOL_VERSION,
            sessionId: session.id,
            kicadToken: session.kicadToken,
            serverState: session.state,
            eventsState: session.eventsState,
          }),
        );
      },
      message(ws, raw) {
        const { session } = ws.data;
        if (typeof raw === "string") {
          try {
            const m = parseControl(raw);
            if (m.type === "ping") ws.send(encodeControl({ type: "pong", t: m.t }));
          } catch (e) {
            ws.send(encodeControl({ type: "error", id: null, code: "bad-request", message: e instanceof Error ? e.message : String(e) }));
          }
          return;
        }
        let id: number;
        let payload: Uint8Array;
        try {
          ({ id, payload } = decodeWsFrame(raw));
        } catch (e) {
          ws.send(encodeControl({ type: "error", id: null, code: "bad-request", message: e instanceof Error ? e.message : String(e) }));
          return;
        }
        const transport = session.transport;
        if (session.state !== "running" || !transport || transport.state !== "open") {
          ws.send(
            encodeControl({
              type: "error",
              id,
              code: "closed",
              message: `KiCad server is ${session.state}${session.error ? `: ${session.error}` : ""}`,
            }),
          );
          return;
        }
        // Copy: Bun may reuse the message buffer after this callback returns.
        const request = payload.slice();
        transport.send(request, { timeoutMs: cfg.requestTimeoutMs }).then(
          (reply) => {
            if (ws.readyState === 1) ws.send(encodeWsFrame(id, reply));
          },
          (e: unknown) => {
            if (ws.readyState !== 1) return;
            const code: BridgeErrorCode = e instanceof TransportError ? e.code : "internal";
            ws.send(encodeControl({ type: "error", id, code, message: e instanceof Error ? e.message : String(e) }));
          },
        );
      },
      close(ws) {
        const { session, clientId } = ws.data;
        session.clients.delete(ws);
        session.touch();
        cfg.log(`session ${session.id}: client #${clientId} disconnected (${session.clients.size} left)`);
      },
    },
  });

  const url = `http://${server.hostname}:${server.port}`;
  cfg.log(
    `listening on ${url} (kicad-cli: ${cfg.kicadCli}, workspace: ${cfg.workspaceRoot}${cfg.staticDir ? `, static: ${cfg.staticDir}` : ""}, freerouting: ${cfg.freerouting.ok ? `${cfg.freerouting.jar} with ${cfg.freerouting.java}` : "unavailable"})`,
  );

  return {
    port: server.port!,
    hostname: server.hostname!,
    url,
    config: cfg,
    sessions,
    routeJobs,
    async stop() {
      await sessions.destroyAll();
      await server.stop(true);
      cfg.log("stopped");
    },
  };
}

/**
 * `GET /sessions/:id/events`: Server-Sent Events mirroring the session's KiCad events as proto3
 * JSON, for debugging with curl / EventSource. Stream layout:
 *   event: state   data: {"sessionId","state":"connected"|"disconnected","message"?}   (on open, then on change)
 *   event: event   data: {"sequence":"12","documentChanged":{...}}                    (one per KiCad event)
 *   event: error   data: {"message"}                                                  (frame failed to decode)
 *   ": keepalive" comment every 15 s. Holding the stream open counts as a client for idle reaping.
 */
function eventStream(session: Session, cfg: BridgeConfig): Response {
  const enc = new TextEncoder();
  let cleanup: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (type: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup?.();
        }
      };
      send("state", { sessionId: session.id, state: session.eventsState, socket: session.eventsSocketPath, serverState: session.state });
      const offEvent = session.onEvent((bytes) => {
        try {
          send("event", eventToJson(decodeEvent(bytes)));
        } catch (e) {
          send("error", { message: `undecodable event frame (${bytes.length} bytes): ${e instanceof Error ? e.message : String(e)}` });
        }
      });
      const offState = session.onEventsState((state, message) => send("state", { sessionId: session.id, state, message }));
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": keepalive\n\n"));
        } catch {
          cleanup?.();
        }
      }, 15_000);
      cleanup = () => {
        cleanup = undefined;
        clearInterval(keepalive);
        offEvent();
        offState();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
    },
    cancel() {
      cleanup?.();
    },
  });
  cfg.log(`session ${session.id}: SSE listener attached`);
  return new Response(stream, {
    headers: { ...CORS, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

async function serveStatic(dir: string, pathname: string): Promise<Response | null> {
  const root = resolve(dir);
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = resolve(root, `.${rel}`);
  if (target !== root && !target.startsWith(root + "/")) return null;
  const candidates = [target];
  if (!extname(target)) candidates.push(resolve(target, "index.html"), resolve(root, "index.html"));
  for (const c of candidates) {
    const s = await stat(c).catch(() => null);
    if (s?.isFile()) return new Response(Bun.file(c), { headers: CORS });
  }
  return null;
}
