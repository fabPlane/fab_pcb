// Composition root for the real services: KiCad session + object model + renderer.
//
//   const services = await createKicadServices({ bridgeUrl: 'http://127.0.0.1:4020' });
//   const services = await createKicadServices({ bridgeUrl: '', directWsUrl: 'ws://127.0.0.1:5599/kicad' });
//
// `bridgeUrl` may be '' to use the page origin (Vite proxies /sessions, /files, /health and
// /ws to the bridge; the bridge can also host the built app itself with STATIC_DIR).
//
// `directWsUrl` (VITE_KICAD_WS) points at an already-running `kicad-cli api-server --socket
// ws://host:port/path`: requests then go straight to KiCad and the bridge, if configured at all,
// only serves /health, /files/* and the library's second server. See apps/web/README.md.

import { CommandServiceImpl } from '../CommandService';
import type { Services } from '../types';
import { setCanvasHostFactory } from '@/canvas/hostFactory';
import { themeFor } from '@/canvas/theme';
import { resolveTheme, useUiStore } from '@/state/uiStore';
import { log as appLog } from '@/state/logStore';
import { useAppStore } from '@/state/appStore';
import { createKicadCanvasFactory } from './KicadCanvas';
import { KicadBoardTools } from './KicadBoardTools';
import { KicadCommitBackend } from './KicadCommitBackend';
import { KicadDocumentService } from './KicadDocumentService';
import { KicadJobsService } from './KicadJobsService';
import { KicadLibraryService } from './KicadLibraryService';
import { KicadMarkerService } from './KicadMarkerService';
import { KicadSchematicTools } from './KicadSchematicTools';
import { KicadSessionService } from './KicadSessionService';
import { KicadSettingsService } from './KicadSettingsService';
import { KicadUndoService } from './KicadUndoService';

export { KicadSessionService, KicadDocumentService, KicadCommitBackend, KicadJobsService, KicadMarkerService, KicadLibraryService };
export { KicadBoardTools, KicadSchematicTools, KicadSettingsService, KicadUndoService };
export { toItem } from './KicadCommitBackend';

export interface KicadServicesOptions {
  bridgeUrl: string;
  /** `ws://host:port/path` of a running api-server; requests bypass the bridge (`VITE_KICAD_WS`). */
  directWsUrl?: string;
  /**
   * Direct mode with no bridge at all, so `/health`, `/files/*` and the library session are not
   * even attempted. Defaults to "`directWsUrl` set and no bridge was asked for": pass it explicitly
   * to combine a direct request path with a same-origin bridge (`bridgeUrl: ''`) for file access.
   */
  bridgeless?: boolean;
  /** Skip the initial `GET /health` (tests). */
  skipInit?: boolean;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Leave the mock canvas host installed (tests without WebGL). */
  mockCanvas?: boolean;
}

export interface KicadServices extends Services {
  session: KicadSessionService;
  documents: KicadDocumentService;
  jobs: KicadJobsService;
  markers: KicadMarkerService;
  /** Library look-ups + footprint editor documents, in a second bridge session. */
  library: KicadLibraryService;
  board: KicadBoardTools;
  schematic: KicadSchematicTools;
  settings: KicadSettingsService;
  undo: KicadUndoService;
}

/** Builds the service graph; resolves once the bridge answered `/health` (workspace root known). */
export async function createKicadServices(opts: KicadServicesOptions): Promise<KicadServices> {
  const log = opts.log ?? ((m, level) => appLog(m, level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info'));
  const documents = new KicadDocumentService();
  let library!: KicadLibraryService;
  const session = new KicadSessionService({
    bridgeUrl: opts.bridgeUrl,
    directWsUrl: opts.directWsUrl,
    bridgeless: opts.bridgeless,
    log,
    onConnected: async (kicad, info) => {
      // Direct mode owns its event subscriber (KiCad's ws events socket); `null` there means the
      // server publishes none, so the document service polls GetDocumentRevision. Over the bridge
      // `undefined` keeps the default (KiCadEvents.fromTransport, i.e. the bridge's relay).
      const events = session.direct ? session.events : undefined;
      await documents.open(kicad, info.projectPath, { exists: async (p) => (await session.stat(p))?.kind === 'file', events, log });
    },
    onDisconnected: async () => {
      await library.close().catch((e: unknown) => log(`library session close: ${e instanceof Error ? e.message : String(e)}`, 'warn'));
      await documents.close();
    },
  });
  library = new KicadLibraryService(session, log);
  // Library footprints are opened in the library session: opening one on the project's server
  // would unload the board (the headless api-server holds one PCB-face document).
  documents.openFootprintDocument = (libId) => library.openFootprintDocument(libId);
  const commands = new CommandServiceImpl(new KicadCommitBackend(documents, log));
  const jobs = new KicadJobsService(documents, session, log);
  const markers = new KicadMarkerService(documents, log);
  const board = new KicadBoardTools(documents, log);
  const schematic = new KicadSchematicTools(documents, log);
  const settings = new KicadSettingsService(documents, log);
  const undo = new KicadUndoService(
    documents,
    commands,
    () => {
      const editor = useAppStore.getState().activeEditor;
      return editor === 'board' || editor === 'schematic' ? editor : null;
    },
    log,
  );
  if (!opts.mockCanvas) {
    setCanvasHostFactory(createKicadCanvasFactory({ docs: documents, theme: () => themeFor(resolveTheme(useUiStore.getState().theme)), log }));
  }
  if (opts.directWsUrl) log(`KiCad: direct nng WebSocket to ${opts.directWsUrl} (no bridge in the request path)`);
  if (!opts.skipInit) {
    if (session.bridgeless) {
      log('no bridge configured: the project browser, project creation and the library session are unavailable');
    } else {
      try {
        const h = await session.init();
        log(`bridge ${opts.bridgeUrl || location.origin}: workspace ${h.workspaceRoot}, kicad-cli ${h.kicadCliExists ? 'found' : 'MISSING'} at ${h.kicadCli}`);
      } catch (e) {
        log(`bridge ${opts.bridgeUrl || location.origin} unreachable: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    }
  }
  return { session, documents, commands, jobs, markers, library, board, schematic, settings, undo };
}
