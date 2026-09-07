// Simulates the bridge (docs/contracts.md, "Bridge WebSocket protocol"):
//   POST /sessions {path}      -> {id, kicadToken}
//   GET  /ws?session=<id>      -> text frame {type:'hello', sessionId, kicadToken}
//   GET  /files/<path>         -> directory listing inside the workspace root
//
// SWAP SEAM: `services/kicad/BridgeSessionService.ts` does the same with fetch() and a
// WebSocketTransport from `@fp-pcb/client/transport`; the UI never sees the difference.

import type { FileEntry, RecentProject, SessionInfo, SessionService } from '../types';

const RECENT_KEY = 'fp-pcb.recent-projects';

interface MockNode {
  name: string;
  kind: 'dir' | 'file';
  size?: number;
  modified?: string;
  children?: MockNode[];
}

const WORKSPACE = '/Users/hyper/projects';

const TREE: MockNode = {
  name: 'projects',
  kind: 'dir',
  children: [
    {
      name: 'kicad',
      kind: 'dir',
      children: [
        {
          name: 'qa',
          kind: 'dir',
          children: [
            {
              name: 'data',
              kind: 'dir',
              children: [
                {
                  name: 'pcbnew',
                  kind: 'dir',
                  children: [
                    { name: 'api_kitchen_sink.kicad_pro', kind: 'file', size: 2411, modified: '2026-09-01T09:12:00Z' },
                    { name: 'api_kitchen_sink.kicad_pcb', kind: 'file', size: 184_302, modified: '2026-09-01T09:12:00Z' },
                    { name: 'api_kitchen_sink.kicad_sch', kind: 'file', size: 96_115, modified: '2026-09-01T09:12:00Z' },
                    { name: 'api_kitchen_sink.kicad_prl', kind: 'file', size: 1_002, modified: '2026-09-01T09:12:00Z' },
                    { name: 'fp-lib-table', kind: 'file', size: 212, modified: '2026-05-13T15:40:00Z' },
                    { name: 'sym-lib-table', kind: 'file', size: 198, modified: '2026-05-13T15:40:00Z' },
                  ],
                },
                {
                  name: 'eeschema',
                  kind: 'dir',
                  children: [
                    { name: 'api_kitchen_sink.kicad_sch', kind: 'file', size: 96_115, modified: '2026-08-22T11:03:00Z' },
                    { name: 'variants.kicad_pro', kind: 'file', size: 3_120, modified: '2026-08-30T17:21:00Z' },
                    { name: 'variants.kicad_sch', kind: 'file', size: 41_900, modified: '2026-08-30T17:21:00Z' },
                  ],
                },
              ],
            },
          ],
        },
        { name: 'README.md', kind: 'file', size: 1_140, modified: '2026-09-06T11:19:00Z' },
      ],
    },
    {
      name: 'tensorfleet',
      kind: 'dir',
      children: [
        {
          name: 'carrier-board',
          kind: 'dir',
          children: [
            { name: 'carrier-board.kicad_pro', kind: 'file', size: 4_310, modified: '2026-09-04T20:08:00Z' },
            { name: 'carrier-board.kicad_pcb', kind: 'file', size: 2_204_113, modified: '2026-09-04T20:08:00Z' },
            { name: 'carrier-board.kicad_sch', kind: 'file', size: 310_777, modified: '2026-09-03T14:52:00Z' },
            { name: 'power.kicad_sch', kind: 'file', size: 88_012, modified: '2026-09-03T14:52:00Z' },
            { name: 'io.kicad_sch', kind: 'file', size: 120_400, modified: '2026-09-03T14:52:00Z' },
            { name: 'carrier-board.kicad_dru', kind: 'file', size: 1_880, modified: '2026-08-12T10:00:00Z' },
            {
              name: 'libs',
              kind: 'dir',
              children: [
                { name: 'tensorfleet.pretty', kind: 'dir', children: [{ name: 'QFN-48_7x7mm_P0.5mm.kicad_mod', kind: 'file', size: 9_302 }] },
                { name: 'tensorfleet.kicad_sym', kind: 'file', size: 52_010, modified: '2026-07-30T09:00:00Z' },
              ],
            },
            { name: 'fab', kind: 'dir', children: [{ name: 'carrier-board-gerbers.zip', kind: 'file', size: 731_002, modified: '2026-08-28T18:30:00Z' }] },
          ],
        },
        {
          name: 'sensor-node',
          kind: 'dir',
          children: [
            { name: 'sensor-node.kicad_pro', kind: 'file', size: 2_950, modified: '2026-07-19T08:45:00Z' },
            { name: 'sensor-node.kicad_pcb', kind: 'file', size: 402_330, modified: '2026-07-19T08:45:00Z' },
            { name: 'sensor-node.kicad_sch', kind: 'file', size: 77_002, modified: '2026-07-19T08:45:00Z' },
          ],
        },
      ],
    },
  ],
};

function fileTypeOf(name: string): FileEntry['fileType'] {
  if (name.endsWith('.kicad_pro')) return 'project';
  if (name.endsWith('.kicad_pcb')) return 'board';
  if (name.endsWith('.kicad_sch')) return 'schematic';
  if (name.endsWith('.kicad_mod')) return 'footprint';
  if (name.endsWith('.kicad_sym')) return 'symbol-lib';
  return 'other';
}

function resolve(path: string): MockNode | null {
  if (!path.startsWith(WORKSPACE)) return null;
  const rel = path.slice(WORKSPACE.length).split('/').filter(Boolean);
  let node: MockNode = TREE;
  for (const seg of rel) {
    const next = node.children?.find((c) => c.name === seg);
    if (!next) return null;
    node = next;
  }
  return node;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MockSessionService implements SessionService {
  session: SessionInfo | null = null;
  private subs = new Set<(s: SessionInfo | null) => void>();
  private latencyMs: number;

  constructor(opts: { latencyMs?: number } = {}) {
    this.latencyMs = opts.latencyMs ?? 180;
  }

  onChange(cb: (s: SessionInfo | null) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private set(s: SessionInfo | null): void {
    this.session = s;
    for (const cb of this.subs) cb(s);
  }

  workspaceRoot(): string {
    return WORKSPACE;
  }

  async connect(projectPath: string): Promise<SessionInfo> {
    const name = projectPath.split('/').pop()?.replace(/\.kicad_pro$/, '') ?? 'project';
    const id = `sess-${Math.random().toString(36).slice(2, 8)}`;
    // POST /sessions
    this.set({ id, projectPath, projectName: name, kicadVersion: '', kicadToken: '', state: 'connecting' });
    await delay(this.latencyMs);
    if (!resolve(projectPath)) {
      const err = { ...this.session!, state: 'error' as const, error: `Project not found inside workspace: ${projectPath}` };
      this.set(err);
      throw new Error(err.error);
    }
    // GET /ws?session=<id> -> hello
    await delay(this.latencyMs / 2);
    const open: SessionInfo = {
      id,
      projectPath,
      projectName: name,
      kicadVersion: '10.99.0-cbd303d16b',
      kicadToken: 'kt-' + Math.random().toString(36).slice(2, 10),
      state: 'open',
    };
    this.set(open);
    this.remember(projectPath, name);
    return open;
  }

  async disconnect(): Promise<void> {
    if (!this.session) return;
    this.set({ ...this.session, state: 'closed' });
    await delay(30);
    this.set(null);
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    await delay(40);
    const node = resolve(path);
    if (!node || node.kind !== 'dir') throw new Error(`Not a directory: ${path}`);
    return (node.children ?? [])
      .map<FileEntry>((c) => ({
        name: c.name,
        path: `${path.replace(/\/$/, '')}/${c.name}`,
        kind: c.kind,
        size: c.size,
        modified: c.modified,
        fileType: c.kind === 'file' ? fileTypeOf(c.name) : undefined,
      }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  }

  async recentProjects(): Promise<RecentProject[]> {
    const seeded: RecentProject[] = [
      { path: `${WORKSPACE}/kicad/qa/data/pcbnew/api_kitchen_sink.kicad_pro`, name: 'api_kitchen_sink', lastOpened: '2026-09-06T10:41:00Z', boards: 1, sheets: 2 },
      { path: `${WORKSPACE}/tensorfleet/carrier-board/carrier-board.kicad_pro`, name: 'carrier-board', lastOpened: '2026-09-04T20:08:00Z', boards: 1, sheets: 3 },
      { path: `${WORKSPACE}/tensorfleet/sensor-node/sensor-node.kicad_pro`, name: 'sensor-node', lastOpened: '2026-07-19T08:45:00Z', boards: 1, sheets: 1 },
    ];
    const stored = readRecent();
    const seen = new Set(stored.map((r) => r.path));
    return [...stored, ...seeded.filter((r) => !seen.has(r.path))];
  }

  async createProject(directory: string, name: string): Promise<string> {
    await delay(this.latencyMs);
    const dir = resolve(directory);
    if (!dir || dir.kind !== 'dir') throw new Error(`Directory not found: ${directory}`);
    const folder: MockNode = {
      name,
      kind: 'dir',
      children: [
        { name: `${name}.kicad_pro`, kind: 'file', size: 1_024, modified: new Date().toISOString() },
        { name: `${name}.kicad_pcb`, kind: 'file', size: 512, modified: new Date().toISOString() },
        { name: `${name}.kicad_sch`, kind: 'file', size: 512, modified: new Date().toISOString() },
      ],
    };
    dir.children = [...(dir.children ?? []), folder];
    return `${directory.replace(/\/$/, '')}/${name}/${name}.kicad_pro`;
  }

  private remember(path: string, name: string): void {
    const list = readRecent().filter((r) => r.path !== path);
    list.unshift({ path, name, lastOpened: new Date().toISOString(), boards: 1, sheets: 2 });
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
    } catch {
      /* storage unavailable */
    }
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
