/**
 * A session = one `kicad-cli api-server` process + one `NngIpcTransport` + one `NngIpcSubscriber`
 * on KiCad's events socket + the WebSocket clients bound to it. Every event frame KiCad publishes
 * is relayed verbatim to all clients (`encodeEventFrame`) and to `onEvent` listeners (SSE, CLI).
 * `SessionManager` spawns, supervises and tears sessions down, and reaps idle ones.
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { KiCadClient, commands } from "@fp-pcb/client";
import {
  NngIpcSubscriber,
  NngIpcTransport,
  encodeControl,
  encodeEventFrame,
  type BridgeControlMessage,
  type BridgeEventsState,
  type KiCadServerState,
} from "@fp-pcb/client/transport";
import type { BridgeConfig } from "./config";
import { pingUntilReady } from "./kicad-ping";

export interface WsData {
  session: Session;
  clientId: number;
}

export interface SessionInfo {
  id: string;
  state: KiCadServerState;
  path: string | null;
  socketPath: string;
  /** KiCad's pub/sub socket (from `GetServerInfo`, else derived); null when not relaying. */
  eventsSocketPath: string | null;
  eventsState: BridgeEventsState;
  /** Event frames relayed so far. */
  eventsRelayed: number;
  pid: number | null;
  kicadToken: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  startedAt: string;
  readyAt: string | null;
  /** Last time a WebSocket/SSE client connected or disconnected (idle reaping starts here). */
  lastClientAt: string;
  clients: number;
  /** SSE subscribers on `/sessions/:id/events`. */
  listeners: number;
  queued: number;
}

/** Derive KiCad's events socket path from its request socket path (`api-x.sock` -> `api-x-events.sock`). */
export function eventsSocketPathFor(socketPath: string): string {
  return socketPath.endsWith(".sock") ? `${socketPath.slice(0, -5)}-events.sock` : `${socketPath}-events`;
}

export interface CreateSessionOptions {
  /** File to preload (`.kicad_pro`, `.kicad_pcb`, `.kicad_sch`). Relative paths resolve against the workspace root. */
  path?: string | null;
  /** Explicit socket path; default `<socketDir>/api-<id>.sock`. */
  socket?: string;
  /** Explicit session id (must be `[A-Za-z0-9_-]{1,64}`); default random. */
  id?: string;
}

const LOG_RING = 200;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class Session {
  readonly id: string;
  path: string | null;
  readonly socketPath: string;
  readonly startedAt = new Date();
  readyAt: Date | null = null;
  state: KiCadServerState = "starting";
  kicadToken: string | null = null;
  exitCode: number | null = null;
  signal: string | null = null;
  error: string | null = null;
  proc: ReturnType<typeof Bun.spawn> | null = null;
  transport: NngIpcTransport | null = null;
  subscriber: NngIpcSubscriber | null = null;
  eventsSocketPath: string | null = null;
  eventsState: BridgeEventsState = "disconnected";
  eventsRelayed = 0;
  lastClientAt = new Date();
  readonly clients = new Set<ServerWebSocket<WsData>>();
  readonly logLines: string[] = [];
  private readonly eventListeners = new Set<(event: Uint8Array) => void>();
  private readonly eventsStateListeners = new Set<(state: BridgeEventsState, message?: string) => void>();
  private stopping = false;

  constructor(
    private readonly cfg: BridgeConfig,
    id: string,
    path: string | null,
    socketPath: string,
  ) {
    this.id = id;
    this.path = path;
    this.socketPath = socketPath;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** Refresh discovery metadata after a job creates a project in a previously bare session. */
  updateProjectPath(path: string): void {
    this.path = resolve(path);
  }

  info(): SessionInfo {
    return {
      id: this.id,
      state: this.state,
      path: this.path,
      socketPath: this.socketPath,
      eventsSocketPath: this.eventsSocketPath,
      eventsState: this.eventsState,
      eventsRelayed: this.eventsRelayed,
      pid: this.pid,
      kicadToken: this.kicadToken,
      exitCode: this.exitCode,
      signal: this.signal,
      error: this.error,
      startedAt: this.startedAt.toISOString(),
      readyAt: this.readyAt?.toISOString() ?? null,
      lastClientAt: this.lastClientAt.toISOString(),
      clients: this.clients.size,
      listeners: this.eventListeners.size,
      queued: this.transport?.queued ?? 0,
    };
  }

  /** True when no WebSocket client and no SSE listener is attached. */
  get idle(): boolean {
    return this.clients.size === 0 && this.eventListeners.size === 0;
  }

  /** Records a client (WebSocket or SSE) coming or going, for idle reaping. */
  touch(): void {
    this.lastClientAt = new Date();
  }

  /** Raw event frames as KiCad published them (SSE endpoint, CLI, tests). */
  onEvent(cb: (event: Uint8Array) => void): () => void {
    this.eventListeners.add(cb);
    this.touch();
    return () => {
      this.eventListeners.delete(cb);
      this.touch();
    };
  }

  onEventsState(cb: (state: BridgeEventsState, message?: string) => void): () => void {
    this.eventsStateListeners.add(cb);
    return () => {
      this.eventsStateListeners.delete(cb);
    };
  }

  /**
   * Learn the events socket (`GetServerInfo`, falling back to the derived name), subscribe with
   * reconnect, and relay every frame. Never throws: a session without events still works, the
   * `events` state just stays `disconnected` and clients poll.
   */
  private async startEvents(): Promise<void> {
    const { cfg } = this;
    const transport = this.transport;
    if (!cfg.relayEvents || !transport) return;
    let path = eventsSocketPathFor(transport.path);
    try {
      const client = new KiCadClient(transport, {
        clientName: `fp-pcb/bridge/${this.id}`,
        kicadToken: this.kicadToken ?? undefined,
        waitForReady: false,
      });
      const info = await commands.getServerInfo(client, {}, { timeoutMs: 5000 });
      if (info.eventsSocketUrl) path = info.eventsSocketUrl.replace(/^ipc:\/\//, "");
      else cfg.log(`session ${this.id}: GetServerInfo reports no events socket; trying ${path}`);
    } catch (e) {
      cfg.log(`session ${this.id}: GetServerInfo failed (${errorMessage(e)}); trying ${path}`);
    }
    if (this.state !== "running" || this.stopping) return;
    this.eventsSocketPath = path;
    const sub = new NngIpcSubscriber({
      path,
      connectTimeoutMs: 5000,
      reconnect: { initialDelayMs: 100, maxDelayMs: 2000 },
      maxFrameBytes: cfg.maxPayloadBytes,
      log: (m) => cfg.log(`session ${this.id}: events: ${m}`),
    });
    this.subscriber = sub;
    sub.onMessage((body) => {
      if (this.subscriber !== sub) return;
      // Copy: the parser's buffer is reused for the next frame.
      const event = body.slice();
      this.eventsRelayed++;
      const frame = encodeEventFrame(event);
      for (const ws of this.clients) {
        try {
          ws.send(frame);
        } catch {
          /* ignore */
        }
      }
      for (const cb of Array.from(this.eventListeners)) {
        try {
          cb(event);
        } catch (e) {
          cfg.log(`session ${this.id}: event listener threw: ${errorMessage(e)}`);
        }
      }
    });
    sub.onStateChange((s, err) => {
      if (this.subscriber !== sub) return;
      this.setEventsState(s === "open" ? "connected" : "disconnected", s === "open" ? path : (err?.message ?? `subscriber ${s}`));
    });
    // With reconnect on, a missing events socket (older KiCad) keeps the subscriber redialing in
    // the background; do not hold up session start for it.
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000));
    const outcome = await Promise.race([sub.ready().then(() => "open" as const), timeout]).catch((e: unknown) => errorMessage(e));
    if (outcome !== "open")
      cfg.log(`session ${this.id}: events socket ${path} not connected yet (${outcome}); keep retrying in the background`);
  }

  private setEventsState(state: BridgeEventsState, message?: string): void {
    if (this.eventsState === state) return;
    this.eventsState = state;
    this.cfg.log(`session ${this.id}: events ${state}${message ? ` (${message})` : ""}`);
    this.broadcast({ type: "events", sessionId: this.id, state, message });
    for (const cb of Array.from(this.eventsStateListeners)) {
      try {
        cb(state, message);
      } catch {
        /* ignore */
      }
    }
  }

  private async stopEvents(): Promise<void> {
    const sub = this.subscriber;
    this.subscriber = null;
    if (sub) await sub.close();
    this.setEventsState("disconnected", "session stopped");
  }

  /** Spawn KiCad, wait for its socket, connect, and Ping until AS_OK. Throws (after cleanup) on failure. */
  async start(): Promise<void> {
    const { cfg } = this;
    await mkdir(cfg.socketDir, { recursive: true });
    // If a stale socket sits at our path KiCad would silently fall back to api-<pid>.sock (when
    // another KiCad holds the directory's api.lock), so make sure the path is free first.
    await rm(this.socketPath, { force: true });

    const args = [cfg.kicadCli, "api-server", ...(this.path ? [this.path] : []), "--socket", this.socketPath];
    cfg.log(`session ${this.id}: spawning ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...process.env, ...cfg.kicadEnv },
      });
    } catch (e) {
      this.fail("failed", `cannot spawn ${cfg.kicadCli}: ${errorMessage(e)}`);
      throw new Error(this.error!);
    }
    this.proc = proc;
    void this.drain(proc.stdout as ReadableStream<Uint8Array>, "out");
    void this.drain(proc.stderr as ReadableStream<Uint8Array>, "err");
    void proc.exited.then((code) => this.onExit(code, proc.signalCode));

    const deadline = Date.now() + cfg.startTimeoutMs;
    try {
      const socketPath = await this.waitForSocket(deadline);
      if (socketPath !== this.socketPath) {
        cfg.log(`session ${this.id}: KiCad listened on ${socketPath} instead of ${this.socketPath}`);
      }
      const transport = new NngIpcTransport({
        path: socketPath,
        defaultTimeoutMs: cfg.requestTimeoutMs,
        connectTimeoutMs: Math.max(1000, deadline - Date.now()),
        log: (m) => cfg.log(`session ${this.id}: transport: ${m}`),
      });
      this.transport = transport;
      transport.onStateChange((s) => {
        if (s === "closed" && this.state === "running" && !this.stopping) {
          // socket dropped without a process exit (yet) — the exit handler will follow shortly
          cfg.log(`session ${this.id}: transport closed while running`);
        }
      });
      await transport.ready();
      this.kicadToken = await pingUntilReady(transport, {
        timeoutMs: Math.max(1000, deadline - Date.now()),
        clientName: `fp-pcb/bridge/${this.id}`,
        isCancelled: () => this.state !== "starting",
      });
      if (this.state !== "starting") throw new Error(this.error ?? `server ${this.state} during startup`);
      this.state = "running";
      this.readyAt = new Date();
      cfg.log(`session ${this.id}: running (pid ${proc.pid}, token ${this.kicadToken}) after ${Date.now() - this.startedAt.getTime()} ms`);
      this.broadcast({ type: "server-state", sessionId: this.id, state: "running", kicadToken: this.kicadToken });
      await this.startEvents();
    } catch (e) {
      const msg = this.error ?? `${errorMessage(e)}${this.tailLog()}`;
      await this.stop();
      this.fail("failed", msg);
      throw new Error(msg);
    }
  }

  /** Terminate the process (SIGTERM, then SIGKILL after 5 s), close the transport, unlink the socket. */
  async stop(): Promise<void> {
    this.stopping = true;
    const proc = this.proc;
    await this.stopEvents();
    await this.transport?.close();
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      const killer = setTimeout(() => proc.kill("SIGKILL"), 5000);
      await proc.exited;
      clearTimeout(killer);
    }
    await rm(this.socketPath, { force: true });
    for (const ws of this.clients) {
      try {
        ws.close(1001, "session closed");
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.eventListeners.clear();
    this.eventsStateListeners.clear();
  }

  broadcast(msg: BridgeControlMessage): void {
    const text = encodeControl(msg);
    for (const ws of this.clients) {
      try {
        ws.send(text);
      } catch {
        /* ignore */
      }
    }
  }

  tailLog(lines = 10): string {
    const tail = this.logLines.slice(-lines);
    return tail.length ? `\n--- kicad-cli output ---\n${tail.join("\n")}` : "";
  }

  private fail(state: KiCadServerState, message: string): void {
    this.state = state;
    this.error = message;
  }

  private onExit(code: number | null, signal: string | null): void {
    const wasRunning = this.state === "running";
    this.exitCode = code;
    this.signal = signal;
    if (this.state === "starting") {
      this.error = `kicad-cli exited during startup (code ${code}, signal ${signal})${this.tailLog()}`;
      this.state = "failed";
    } else if (this.state === "running") {
      this.state = this.stopping ? "exited" : code === 0 ? "exited" : "failed";
      if (!this.stopping) this.error = `kicad-cli exited unexpectedly (code ${code}, signal ${signal})`;
    }
    this.cfg.log(`session ${this.id}: kicad-cli exited (code ${code}, signal ${signal}) -> ${this.state}`);
    void this.stopEvents();
    void this.transport?.close();
    void rm(this.socketPath, { force: true });
    if (this.eventsSocketPath) void rm(this.eventsSocketPath, { force: true });
    if (wasRunning) {
      this.broadcast({
        type: "server-state",
        sessionId: this.id,
        state: this.state,
        exitCode: code,
        signal,
        message: this.error ?? undefined,
      });
    }
  }

  private async drain(stream: ReadableStream<Uint8Array>, tag: "out" | "err"): Promise<void> {
    const dec = new TextDecoder();
    let rest = "";
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += dec.decode(value, { stream: true });
        const parts = rest.split("\n");
        rest = parts.pop() ?? "";
        for (const line of parts) this.pushLog(`[${tag}] ${line}`);
      }
      if (rest) this.pushLog(`[${tag}] ${rest}`);
    } catch {
      /* stream closed */
    }
  }

  private pushLog(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > LOG_RING) this.logLines.splice(0, this.logLines.length - LOG_RING);
  }

  /** Poll for the socket file. Also accepts KiCad's `api-<pid>.sock` fallback. */
  private async waitForSocket(deadline: number): Promise<string> {
    const proc = this.proc!;
    const fallback = join(this.cfg.socketDir, `api-${proc.pid}.sock`);
    for (;;) {
      if (this.state !== "starting") throw new Error(this.error ?? `server ${this.state}`);
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`kicad-cli exited before listening (code ${proc.exitCode}, signal ${proc.signalCode})${this.tailLog()}`);
      }
      for (const p of [this.socketPath, fallback]) {
        try {
          if ((await stat(p)).isSocket()) return p;
        } catch {
          /* not yet */
        }
      }
      if (Date.now() > deadline)
        throw new Error(`timeout after ${this.cfg.startTimeoutMs} ms waiting for ${this.socketPath}${this.tailLog()}`);
      await Bun.sleep(20);
    }
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cfg: BridgeConfig) {
    if (cfg.sessionIdleTimeoutSec > 0) {
      const period = Math.max(250, Math.min(10_000, (cfg.sessionIdleTimeoutSec * 1000) / 4));
      this.reaper = setInterval(() => void this.reapIdle(), period);
      // Do not keep a Bun process alive just for the reaper.
      (this.reaper as { unref?: () => void }).unref?.();
    }
  }

  /** Destroy sessions idle (no WebSocket/SSE client) for longer than `sessionIdleTimeoutSec`. */
  async reapIdle(now = Date.now()): Promise<string[]> {
    const limit = this.cfg.sessionIdleTimeoutSec * 1000;
    if (limit <= 0) return [];
    const reaped: string[] = [];
    for (const s of [...this.sessions.values()]) {
      if (s.state === "starting" || !s.idle) continue;
      const idleMs = now - s.lastClientAt.getTime();
      if (idleMs < limit) continue;
      this.cfg.log(`session ${s.id}: idle for ${Math.round(idleMs / 1000)} s (limit ${this.cfg.sessionIdleTimeoutSec} s), destroying`);
      await this.destroy(s.id);
      reaped.push(s.id);
    }
    return reaped;
  }

  stopReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Spawn a server and resolve once it answers Ping with AS_OK. */
  async create(opts: CreateSessionOptions = {}): Promise<Session> {
    const id = opts.id ?? randomId();
    if (!SESSION_ID_RE.test(id)) throw new Error(`invalid session id "${id}"`);
    if (this.sessions.has(id)) throw new Error(`session "${id}" already exists`);
    const path = opts.path ? resolve(this.cfg.workspaceRoot, opts.path) : null;
    if (path) {
      try {
        await stat(path);
      } catch {
        throw new Error(`file not found: ${path}`);
      }
    }
    const socketPath = opts.socket ? resolve(opts.socket) : join(this.cfg.socketDir, `api-${id}.sock`);
    const session = new Session(this.cfg, id, path, socketPath);
    this.sessions.set(id, session);
    try {
      await session.start();
    } catch (e) {
      this.sessions.delete(id);
      throw e;
    }
    return session;
  }

  async destroy(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    await s.stop();
    this.cfg.log(`session ${id}: destroyed`);
    return true;
  }

  async destroyAll(): Promise<void> {
    this.stopReaper();
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }

  /**
   * Remove `api-*.sock` files in the socket dir that nothing listens on (left behind by killed
   * servers). Returns the paths removed.
   */
  async cleanStaleSockets(): Promise<string[]> {
    const removed: string[] = [];
    let names: string[];
    try {
      names = await readdir(this.cfg.socketDir);
    } catch {
      return removed;
    }
    for (const name of names) {
      if (!/^api-.*\.sock$/.test(name)) continue;
      const p = join(this.cfg.socketDir, name);
      if ([...this.sessions.values()].some((s) => s.socketPath === p || s.eventsSocketPath === p)) continue;
      if (await socketIsDead(p)) {
        await rm(p, { force: true });
        removed.push(p);
      }
    }
    if (removed.length) this.cfg.log(`removed ${removed.length} stale socket(s): ${removed.join(", ")}`);
    return removed;
  }
}

async function socketIsDead(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isSocket()) return false;
  } catch {
    return false;
  }
  try {
    const sock = await Bun.connect({
      unix: path,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    sock.end();
    return false;
  } catch {
    return true; // ECONNREFUSED: nobody listening
  }
}

function randomId(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
