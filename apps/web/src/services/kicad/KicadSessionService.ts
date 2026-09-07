// SessionService with two transports to KiCad.
//
// **Bridge (default).** `POST /sessions {path}` spawns a `kicad-cli api-server` for the project,
// `/ws?session=<id>` carries the ApiRequest bytes through `WebSocketTransport`, `/files/*` backs
// the project browser. Bridge control frames (`server-state`) and transport state changes are
// folded into `SessionInfo.state`; a dropped WebSocket is re-dialled with backoff while the bridge
// still lists the session.
//
// **Direct ws (`directWsUrl`, from `VITE_KICAD_WS`).** The server is already running with
// `--socket ws://host:port/path` (KiCad >= 8eafd9cf01), so there is nothing to spawn: `NngWsTransport`
// dials KiCad's own nng WebSocket listener and every ApiRequest goes straight there — no bridge in
// the request path. Events come from `NngWsSubscriber` on `GetServerInfo.events_socket_url` rather
// than from the bridge's relay. A bridge may still be configured alongside it (`bridgeUrl`), and is
// then used only for `/health` and `/files/*` (the project browser, file streaming) and for the
// second server the library/footprint editor needs; with no bridge those features report that they
// need one, and the session adopts whatever project the running server already has open.

import { KiCad, KiCadEvents, NngWsSubscriber, NngWsTransport, TransportError, WebSocketTransport, bridgeWsUrl, type Transport } from '@fp-pcb/client';
import { DocumentType } from '@fp-pcb/proto';
import type { FileEntry, RecentProject, SessionInfo, SessionService } from '../types';

const RECENT_KEY = 'fp-pcb.recent-projects';

export interface BridgeSessionRecord {
  id: string;
  state: 'starting' | 'running' | 'exited' | 'failed';
  path: string | null;
  kicadToken: string | null;
  error?: string | null;
  exitCode?: number | null;
}

export interface KicadSessionOptions {
  /** Bridge origin (`http://127.0.0.1:4020`) or `''` for same-origin (Vite proxy / static hosting). */
  bridgeUrl: string;
  /**
   * `ws://host:port/path` of an already-running `kicad-cli api-server` started with
   * `--socket ws://...`. When set, requests bypass the bridge entirely (`NngWsTransport`).
   */
  directWsUrl?: string;
  /** True when no bridge is reachable at all (`bridgeUrl` empty and `directWsUrl` set). */
  bridgeless?: boolean;
  /** Injection points for tests. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  createTransport?: (wsUrl: string) => Promise<Transport>;
  /** Injection point for tests; defaults to `NngWsTransport.connect`. */
  createDirectTransport?: (wsUrl: string) => Promise<Transport>;
  /** Called with the connected KiCad before the session is reported `open` (documents load here). */
  onConnected?: (kicad: KiCad, info: SessionInfo) => Promise<void> | void;
  onDisconnected?: () => Promise<void> | void;
  /** Reconnect attempts after the WebSocket drops (default 5). */
  reconnectAttempts?: number;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export interface BridgeHealth {
  ok: boolean;
  workspaceRoot: string;
  kicadCli: string;
  kicadCliExists: boolean;
}

function fileTypeOf(name: string): FileEntry['fileType'] {
  if (name.endsWith('.kicad_pro')) return 'project';
  if (name.endsWith('.kicad_pcb')) return 'board';
  if (name.endsWith('.kicad_sch')) return 'schematic';
  if (name.endsWith('.kicad_mod')) return 'footprint';
  if (name.endsWith('.kicad_sym')) return 'symbol-lib';
  return 'other';
}

const clientTab = Math.random().toString(36).slice(2, 8);

export class KicadSessionService implements SessionService {
  session: SessionInfo | null = null;
  /** The connected object model; null until `connect()` resolves. */
  kicad: KiCad | null = null;
  transport: WebSocketTransport | Transport | null = null;
  health: BridgeHealth | null = null;
  /**
   * Direct-mode event source (`NngWsSubscriber` on KiCad's `ws://.../events`); null over the
   * bridge, where `KiCadEvents.fromTransport()` reads the bridge's relay instead.
   */
  events: KiCadEvents | null = null;

  private subs = new Set<(s: SessionInfo | null) => void>();
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private root = '';
  private offControl: (() => void) | null = null;
  private offState: (() => void) | null = null;
  private reconnecting = false;
  private subscriber: NngWsSubscriber | null = null;

  constructor(private readonly opts: KicadSessionOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    // A closed tab would otherwise leave its kicad-cli process running on the bridge. In direct
    // mode the server is not ours to stop: it was running before the tab opened.
    if (!this.direct && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => {
        const id = this.session?.id;
        if (id && this.session?.state !== 'closed') void this.fetchImpl(this.url(`/sessions/${encodeURIComponent(id)}`), { method: 'DELETE', keepalive: true }).catch(() => undefined);
      });
    }
  }

  /** True when ApiRequests go straight to KiCad over `NngWsTransport` (no bridge in the path). */
  get direct(): boolean {
    return Boolean(this.opts.directWsUrl);
  }

  /** True when there is no bridge at all: no project browser, no second server, no spawning. */
  get bridgeless(): boolean {
    return this.direct && (this.opts.bridgeless ?? this.opts.bridgeUrl === '');
  }

  // ------------------------------------------------------------------ bridge REST

  private url(path: string): string {
    return `${this.opts.bridgeUrl.replace(/\/$/, '')}${path}`;
  }

  /** Throws a clear error for the bridge-only features when the app runs against a bare server. */
  private requireBridge(what: string): void {
    if (this.bridgeless) {
      throw new Error(`${what} needs the bridge; this tab talks to ${this.opts.directWsUrl} directly (set VITE_BRIDGE_URL as well to get it back)`);
    }
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.url(path), init);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const msg = (body as { error?: string } | null)?.error ?? text ?? res.statusText;
      throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${msg}`);
    }
    return body as T;
  }

  /**
   * A JSON call on the bridge's REST API for the other services (the autorouting job under
   * `/sessions/:id/route`). Throws with the bridge's `error` on a non-2xx answer.
   */
  bridgeJson<T>(path: string, init?: RequestInit): Promise<T> {
    this.requireBridge(`${init?.method ?? 'GET'} ${path}`);
    return this.json<T>(path, init);
  }

  /** A raw fetch on the bridge (streaming responses such as the route job's SSE). */
  bridgeFetch(path: string, init?: RequestInit): Promise<Response> {
    this.requireBridge(`${init?.method ?? 'GET'} ${path}`);
    return this.fetchImpl(this.url(path), init);
  }

  /** `GET /health`: learns the workspace root. Safe to call more than once. */
  async init(): Promise<BridgeHealth> {
    if (this.bridgeless) {
      // Nothing to ask: the workspace root is learned from the project we connect to.
      const h: BridgeHealth = { ok: true, workspaceRoot: this.root, kicadCli: `direct ${this.opts.directWsUrl}`, kicadCliExists: true };
      this.health = h;
      return h;
    }
    const h = await this.json<BridgeHealth>('/health');
    this.health = h;
    this.root = h.workspaceRoot;
    return h;
  }

  async listSessions(): Promise<BridgeSessionRecord[]> {
    return (await this.json<{ sessions: BridgeSessionRecord[] }>('/sessions')).sessions;
  }

  async deleteSession(id: string): Promise<void> {
    await this.json(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // ------------------------------------------------------------------ SessionService

  onChange(cb: (s: SessionInfo | null) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private set(s: SessionInfo | null): void {
    this.session = s;
    for (const cb of this.subs) cb(s);
  }

  private patch(p: Partial<SessionInfo>): void {
    if (this.session) this.set({ ...this.session, ...p });
  }

  workspaceRoot(): string {
    return this.root;
  }

  private connecting: Promise<SessionInfo> | null = null;

  /** Opens a session for `projectPath`; a connect already in flight is awaited first (StrictMode double effects). */
  connect(projectPath: string): Promise<SessionInfo> {
    const run = async (): Promise<SessionInfo> => {
      if (this.connecting) await this.connecting.catch(() => undefined);
      if (this.session?.projectPath === projectPath && this.session.state === 'open') return this.session;
      return this.doConnect(projectPath);
    };
    const p = run().finally(() => {
      if (this.connecting === p) this.connecting = null;
    });
    this.connecting = p;
    return p;
  }

  private async doConnect(projectPath: string): Promise<SessionInfo> {
    if (this.session) await this.disconnect();
    let name = projectPath.split('/').pop()?.replace(/\.kicad_(pro|pcb|sch)$/, '') ?? 'project';
    this.set({ id: '', projectPath, projectName: name, kicadVersion: '', kicadToken: '', state: 'connecting' });
    try {
      // Direct mode: the server is already running, so there is no session to create. Its id is
      // the URL, which is what the reconnect path and the log lines want to show.
      const rec: BridgeSessionRecord = this.direct
        ? { id: this.opts.directWsUrl!, state: 'running', path: projectPath, kicadToken: null }
        : (
            await this.json<{ session: BridgeSessionRecord; wsUrl: string }>('/sessions', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: projectPath }),
            })
          ).session;
      this.patch({ id: rec.id, kicadToken: rec.kicadToken ?? '' });
      if (this.bridgeless && !this.root) this.root = projectPath.slice(0, projectPath.lastIndexOf('/'));
      const kicad = await this.dial(rec.id);
      const version = await kicad.versionString();
      this.kicad = kicad;
      // Direct mode with no path given (no project browser to pick one): adopt whatever the
      // already-running server has open, so `?kicad-ws=...` alone is enough to see the board.
      if (this.direct && !projectPath) {
        projectPath = await this.openProjectPath(kicad);
        name = projectPath.split('/').pop()?.replace(/\.kicad_(pro|pcb|sch)$/, '') ?? 'project';
        if (!this.root && projectPath) this.root = projectPath.slice(0, projectPath.lastIndexOf('/'));
        this.patch({ projectPath, projectName: name });
      }
      const info: SessionInfo = { id: rec.id, projectPath, projectName: name, kicadVersion: version, kicadToken: kicad.client.kicadToken ?? rec.kicadToken ?? '', state: 'connecting' };
      this.set(info);
      await this.opts.onConnected?.(kicad, info);
      this.patch({ state: 'open' });
      this.remember(projectPath, name);
      return this.session!;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const id = this.session?.id;
      this.patch({ state: 'error', error: message });
      this.log(message, 'error');
      await this.teardown();
      if (id && !this.direct) await this.deleteSession(id).catch(() => undefined);
      throw new Error(message);
    }
  }

  /**
   * The file a running server already has open (`GetOpenDocuments`, board before schematic), used
   * in direct mode when the caller named no project. Empty when the server holds nothing open.
   */
  private async openProjectPath(kicad: KiCad): Promise<string> {
    for (const type of [DocumentType.DOCTYPE_PCB, DocumentType.DOCTYPE_SCHEMATIC] as const) {
      const doc = (await kicad.openDocuments(type).catch(() => []))[0];
      const dir = doc?.project?.path?.replace(/\/$/, '');
      if (!doc || !dir) continue;
      // A board names its own file; a schematic's identifier is a sheet path, so the root sheet is
      // the project name with the schematic extension.
      const file =
        doc.identifier.case === 'boardFilename' && doc.identifier.value
          ? doc.identifier.value
          : doc.project?.name
            ? `${doc.project.name}.${type === DocumentType.DOCTYPE_PCB ? 'kicad_pcb' : 'kicad_sch'}`
            : '';
      if (!file) continue;
      const path = `${dir}/${file}`;
      this.log(`direct mode: adopting the document ${this.opts.directWsUrl} already has open (${path})`);
      return path;
    }
    this.log('direct mode: the server has no document open; pass ?project=<path> to open one', 'warn');
    return '';
  }

  /**
   * Opens the transport and connects the client on top of it: `NngWsTransport` straight to KiCad
   * in direct mode, otherwise the bridge's `/ws?session=<id>`.
   */
  private async dial(sessionId: string): Promise<KiCad> {
    const direct = this.direct;
    const wsUrl = direct
      ? this.opts.directWsUrl!
      : this.opts.bridgeUrl
        ? bridgeWsUrl(this.opts.bridgeUrl, sessionId)
        : bridgeWsUrl(location.origin, sessionId);
    const transport = direct
      ? this.opts.createDirectTransport
        ? await this.opts.createDirectTransport(wsUrl)
        : await NngWsTransport.connect({ url: wsUrl, defaultTimeoutMs: 120_000, log: (m) => this.log(m) })
      : this.opts.createTransport
        ? await this.opts.createTransport(wsUrl)
        : await WebSocketTransport.connect(wsUrl, { log: (m) => this.log(m) });
    this.transport = transport;
    this.offState?.();
    this.offControl?.();
    this.offState = transport.onStateChange((s) => {
      if (s === 'closed') void this.onTransportClosed();
    });
    if (transport instanceof WebSocketTransport) {
      this.offControl = transport.onControl((m) => {
        if (m.type !== 'server-state') return;
        this.log(`bridge: KiCad server ${m.state}${m.message ? ` (${m.message})` : ''}`, m.state === 'failed' ? 'error' : 'info');
        if (m.state === 'exited' || m.state === 'failed') this.patch({ state: 'error', error: `KiCad server ${m.state}${m.message ? `: ${m.message}` : ''}` });
        else if (m.state === 'running' && this.session?.state === 'error') this.patch({ state: 'open', error: undefined });
      });
    }
    const kicad = await KiCad.connect(transport, { clientName: `fp-pcb/${sessionId}/${clientTab}`, log: (m) => this.log(m) });
    if (direct) await this.subscribeEvents(kicad);
    return kicad;
  }

  /**
   * Direct mode only: `GetServerInfo` reports the events socket KiCad derived from the request URL
   * (`ws://host:port/path/events`); subscribe to it so the document service sees DocumentChanged
   * without the bridge relaying it. A server started with `--no-events` reports an empty URL and
   * the document service falls back to polling `GetDocumentRevision`.
   */
  private async subscribeEvents(kicad: KiCad): Promise<void> {
    await this.closeEvents();
    let url = '';
    try {
      url = (await kicad.serverInfo())?.eventsSocketUrl ?? '';
    } catch (e) {
      this.log(`GetServerInfo failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
    }
    if (!/^wss?:\/\//i.test(url)) {
      this.log(`KiCad publishes no ws events socket${url ? ` (${url})` : ''}; polling GetDocumentRevision instead`, 'warn');
      return;
    }
    try {
      const sub = new NngWsSubscriber({ url, reconnect: { initialDelayMs: 250, maxDelayMs: 5000 }, log: (m) => this.log(m) });
      await sub.ready();
      this.subscriber = sub;
      this.events = new KiCadEvents(sub);
      this.log(`KiCad events: subscribed directly to ${url}`);
    } catch (e) {
      this.log(`events socket ${url}: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      await this.closeEvents();
    }
  }

  private async closeEvents(): Promise<void> {
    const events = this.events;
    const sub = this.subscriber;
    this.events = null;
    this.subscriber = null;
    try {
      await events?.close();
    } catch {
      /* ignore */
    }
    try {
      await sub?.close();
    } catch {
      /* ignore */
    }
  }

  private async onTransportClosed(): Promise<void> {
    if (!this.session || this.session.state === 'closed' || this.reconnecting) return;
    const id = this.session.id;
    this.reconnecting = true;
    this.patch({ state: 'reconnecting' });
    const attempts = this.opts.reconnectAttempts ?? 5;
    try {
      for (let i = 0; i < attempts; i++) {
        await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** i, 5000)));
        if (!this.session || this.session.id !== id) return;
        if (!this.direct) {
          // The bridge owns the process; if it has forgotten the session there is nothing to redial.
          const alive = await this.listSessions()
            .then((l) => l.some((s) => s.id === id && (s.state === 'running' || s.state === 'starting')))
            .catch(() => false);
          if (!alive) {
            this.patch({ state: 'error', error: 'the bridge no longer lists this session' });
            return;
          }
        }
        try {
          const kicad = await this.dial(id);
          const previousToken = this.session.kicadToken;
          const token = kicad.client.kicadToken ?? '';
          this.kicad = kicad;
          this.patch({ state: 'open', kicadToken: token, error: undefined });
          if (previousToken && token && previousToken !== token) this.log('KiCad restarted (token changed); reload the project to resync', 'warn');
          this.log(`reconnected to session ${id}`);
          return;
        } catch (e) {
          this.log(`reconnect attempt ${i + 1}/${attempts} failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
        }
      }
      this.patch({ state: 'error', error: this.direct ? `connection to ${this.opts.directWsUrl} lost` : 'connection to the bridge lost' });
    } finally {
      this.reconnecting = false;
    }
  }

  private async teardown(): Promise<void> {
    this.offControl?.();
    this.offState?.();
    this.offControl = null;
    this.offState = null;
    await this.closeEvents();
    const k = this.kicad;
    const t = this.transport;
    this.kicad = null;
    this.transport = null;
    try {
      if (k) await k.close();
      else if (t) await t.close();
    } catch {
      /* ignore */
    }
  }

  async disconnect(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.patch({ state: 'closed' });
    await this.opts.onDisconnected?.();
    await this.teardown();
    // Direct mode never spawned the server, so it never stops it either.
    if (s.id && !this.direct) {
      await this.deleteSession(s.id).catch((e: unknown) => this.log(`DELETE /sessions/${s.id} failed: ${e instanceof Error ? e.message : String(e)}`, 'warn'));
    }
    this.set(null);
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    this.requireBridge('the project browser');
    const dir = path || this.root;
    const res = await this.json<{ path: string; absolutePath: string; entries: { name: string; kind: 'dir' | 'file'; size: number; mtime: string }[] }>(
      `/files/list?path=${encodeURIComponent(dir)}`,
    );
    const base = (res.absolutePath || dir).replace(/\/$/, '');
    return res.entries
      .map<FileEntry>((e) => ({
        name: e.name,
        path: `${base}/${e.name}`,
        kind: e.kind,
        size: e.kind === 'file' ? e.size : undefined,
        modified: e.mtime,
        fileType: e.kind === 'file' ? fileTypeOf(e.name) : undefined,
      }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  }

  /** `GET /files/stat`; null when the path does not exist. */
  async stat(path: string): Promise<{ kind: 'dir' | 'file'; size: number } | null> {
    if (this.bridgeless) return null;
    try {
      const r = await this.json<{ kind: 'dir' | 'file'; size: number }>(`/files/stat?path=${encodeURIComponent(path)}`);
      return r;
    } catch {
      return null;
    }
  }

  /** `POST /files/mkdir` (recursive, inside the workspace root). */
  async mkdir(path: string): Promise<void> {
    this.requireBridge('creating directories');
    await this.json(`/files/mkdir?path=${encodeURIComponent(path)}`, { method: 'POST' });
  }

  /** URL that streams a workspace file from the bridge (`GET /files/read`). */
  fileUrl(path: string): string {
    return this.url(`/files/read?path=${encodeURIComponent(path)}`);
  }

  /** Recent projects inside this bridge's workspace root (entries from other roots / the mock are hidden). */
  async recentProjects(): Promise<RecentProject[]> {
    const root = this.root.replace(/\/$/, '');
    return readRecent().filter((r) => !root || r.path.startsWith(`${root}/`));
  }

  async createProject(directory: string, name: string): Promise<string> {
    this.requireBridge('creating a project');
    // NewProject needs a running server; spawn a project-less session for it.
    const created = await this.json<{ session: BridgeSessionRecord }>('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: null }),
    });
    const id = created.session.id;
    let path = `${directory.replace(/\/$/, '')}/${name}/${name}.kicad_pro`;
    try {
      const kicad = await this.dial(id);
      try {
        const project = await kicad.newProject(path, { open: false });
        if (project.path) path = `${project.path.replace(/\/$/, '')}/${project.name}.kicad_pro`;
      } finally {
        await kicad.close();
      }
    } finally {
      await this.deleteSession(id).catch(() => undefined);
    }
    return path;
  }

  /**
   * A second bridge session on the same project, for work that must not disturb the main
   * server: the headless api-server holds one PCB-face document, so opening a library
   * footprint (`OpenDocument(DOCTYPE_FOOTPRINT)`) there would unload the board. Library
   * look-ups and the footprint editor live here instead.
   */
  async openAuxSession(path: string | null, label = 'aux'): Promise<{ id: string; kicad: KiCad; close(): Promise<void> }> {
    // Always over the bridge, even in direct mode: this needs a *second* kicad-cli process, and
    // spawning one is exactly what the bridge is for.
    this.requireBridge('the library / footprint editor session');
    const created = await this.json<{ session: BridgeSessionRecord }>('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const id = created.session.id;
    try {
      const wsUrl = this.opts.bridgeUrl ? bridgeWsUrl(this.opts.bridgeUrl, id) : bridgeWsUrl(location.origin, id);
      const transport = this.opts.createTransport ? await this.opts.createTransport(wsUrl) : await WebSocketTransport.connect(wsUrl, { log: (m) => this.log(`${label}: ${m}`) });
      const kicad = await KiCad.connect(transport, { clientName: `fp-pcb/${id}/${clientTab}-${label}`, log: (m) => this.log(`${label}: ${m}`) });
      this.log(`${label} session ${id} open${path ? ` on ${path.split('/').pop()}` : ''}`);
      const close = async () => {
        try {
          await kicad.close();
        } catch {
          /* ignore */
        }
        await this.deleteSession(id).catch(() => undefined);
      };
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', () => void this.fetchImpl(this.url(`/sessions/${encodeURIComponent(id)}`), { method: 'DELETE', keepalive: true }).catch(() => undefined));
      }
      return { id, kicad, close };
    } catch (e) {
      await this.deleteSession(id).catch(() => undefined);
      throw e;
    }
  }

  private remember(path: string, name: string): void {
    const list = readRecent().filter((r) => r.path !== path);
    list.unshift({ path, name, lastOpened: new Date().toISOString(), boards: 1, sheets: 1 });
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
    } catch {
      /* storage unavailable */
    }
  }

  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.opts.log?.(message, level);
  }

  /** True when `e` means the socket is gone (used by callers to avoid retry storms). */
  static isTransportError(e: unknown): boolean {
    return e instanceof TransportError;
  }
}

function readRecent(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentProject[]) : [];
  } catch {
    return [];
  }
}
