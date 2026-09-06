// SessionService over the bridge (packages/bridge): `POST /sessions {path}` spawns a
// `kicad-cli api-server` for the project, `/ws?session=<id>` carries the ApiRequest bytes
// through `WebSocketTransport`, `/files/*` backs the project browser. Bridge control frames
// (`server-state`) and transport state changes are folded into `SessionInfo.state`; a
// dropped WebSocket is re-dialled with backoff while the bridge still lists the session.

import { KiCad, TransportError, WebSocketTransport, bridgeWsUrl, type Transport } from '@kicad-web/client';
import type { FileEntry, RecentProject, SessionInfo, SessionService } from '../types';

const RECENT_KEY = 'kicad-web.recent-projects';

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
  /** Injection points for tests. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  createTransport?: (wsUrl: string) => Promise<Transport>;
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

  private subs = new Set<(s: SessionInfo | null) => void>();
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private root = '';
  private offControl: (() => void) | null = null;
  private offState: (() => void) | null = null;
  private reconnecting = false;

  constructor(private readonly opts: KicadSessionOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    // A closed tab would otherwise leave its kicad-cli process running on the bridge.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => {
        const id = this.session?.id;
        if (id && this.session?.state !== 'closed') void this.fetchImpl(this.url(`/sessions/${encodeURIComponent(id)}`), { method: 'DELETE', keepalive: true }).catch(() => undefined);
      });
    }
  }

  // ------------------------------------------------------------------ bridge REST

  private url(path: string): string {
    return `${this.opts.bridgeUrl.replace(/\/$/, '')}${path}`;
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

  /** `GET /health`: learns the workspace root. Safe to call more than once. */
  async init(): Promise<BridgeHealth> {
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
    const name = projectPath.split('/').pop()?.replace(/\.kicad_(pro|pcb|sch)$/, '') ?? 'project';
    this.set({ id: '', projectPath, projectName: name, kicadVersion: '', kicadToken: '', state: 'connecting' });
    try {
      const created = await this.json<{ session: BridgeSessionRecord; wsUrl: string }>('/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      });
      const rec = created.session;
      this.patch({ id: rec.id, kicadToken: rec.kicadToken ?? '' });
      const kicad = await this.dial(rec.id);
      const version = await kicad.versionString();
      this.kicad = kicad;
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
      if (id) await this.deleteSession(id).catch(() => undefined);
      throw new Error(message);
    }
  }

  /** Opens the WebSocket for a session and connects the client on top of it. */
  private async dial(sessionId: string): Promise<KiCad> {
    const wsUrl = this.opts.bridgeUrl ? bridgeWsUrl(this.opts.bridgeUrl, sessionId) : bridgeWsUrl(location.origin, sessionId);
    const transport = this.opts.createTransport ? await this.opts.createTransport(wsUrl) : await WebSocketTransport.connect(wsUrl, { log: (m) => this.log(m) });
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
    const kicad = await KiCad.connect(transport, { clientName: `kicad-web/${sessionId}/${clientTab}`, log: (m) => this.log(m) });
    return kicad;
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
        const alive = await this.listSessions()
          .then((l) => l.some((s) => s.id === id && (s.state === 'running' || s.state === 'starting')))
          .catch(() => false);
        if (!alive) {
          this.patch({ state: 'error', error: 'the bridge no longer lists this session' });
          return;
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
      this.patch({ state: 'error', error: 'connection to the bridge lost' });
    } finally {
      this.reconnecting = false;
    }
  }

  private async teardown(): Promise<void> {
    this.offControl?.();
    this.offState?.();
    this.offControl = null;
    this.offState = null;
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
    if (s.id) await this.deleteSession(s.id).catch((e: unknown) => this.log(`DELETE /sessions/${s.id} failed: ${e instanceof Error ? e.message : String(e)}`, 'warn'));
    this.set(null);
  }

  async listFiles(path: string): Promise<FileEntry[]> {
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
    try {
      const r = await this.json<{ kind: 'dir' | 'file'; size: number }>(`/files/stat?path=${encodeURIComponent(path)}`);
      return r;
    } catch {
      return null;
    }
  }

  /** `POST /files/mkdir` (recursive, inside the workspace root). */
  async mkdir(path: string): Promise<void> {
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
