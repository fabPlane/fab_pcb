// Composition root for the real services: bridge session + KiCad object model + renderer.
//
//   const services = await createKicadServices({ bridgeUrl: 'http://127.0.0.1:4020' });
//
// `bridgeUrl` may be '' to use the page origin (Vite proxies /sessions, /files, /health and
// /ws to the bridge; the bridge can also host the built app itself with STATIC_DIR).

import { CommandServiceImpl } from '../CommandService';
import type { Services } from '../types';
import { setCanvasHostFactory } from '@/canvas/hostFactory';
import { themeFor } from '@/canvas/theme';
import { resolveTheme, useUiStore } from '@/state/uiStore';
import { log as appLog } from '@/state/logStore';
import { createKicadCanvasFactory } from './KicadCanvas';
import { KicadCommitBackend } from './KicadCommitBackend';
import { KicadDocumentService } from './KicadDocumentService';
import { KicadJobsService } from './KicadJobsService';
import { KicadLibraryService } from './KicadLibraryService';
import { KicadMarkerService } from './KicadMarkerService';
import { KicadSessionService } from './KicadSessionService';

export { KicadSessionService, KicadDocumentService, KicadCommitBackend, KicadJobsService, KicadMarkerService, KicadLibraryService };
export { toItem } from './KicadCommitBackend';

export interface KicadServicesOptions {
  bridgeUrl: string;
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
}

/** Builds the service graph; resolves once the bridge answered `/health` (workspace root known). */
export async function createKicadServices(opts: KicadServicesOptions): Promise<KicadServices> {
  const log = opts.log ?? ((m, level) => appLog(m, level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info'));
  const documents = new KicadDocumentService();
  let library!: KicadLibraryService;
  const session = new KicadSessionService({
    bridgeUrl: opts.bridgeUrl,
    log,
    onConnected: async (kicad, info) => {
      await documents.open(kicad, info.projectPath, { exists: async (p) => (await session.stat(p))?.kind === 'file', log });
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
  if (!opts.mockCanvas) {
    setCanvasHostFactory(createKicadCanvasFactory({ docs: documents, theme: () => themeFor(resolveTheme(useUiStore.getState().theme)), log }));
  }
  if (!opts.skipInit) {
    try {
      const h = await session.init();
      log(`bridge ${opts.bridgeUrl || location.origin}: workspace ${h.workspaceRoot}, kicad-cli ${h.kicadCliExists ? 'found' : 'MISSING'} at ${h.kicadCli}`);
    } catch (e) {
      log(`bridge ${opts.bridgeUrl || location.origin} unreachable: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }
  return { session, documents, commands, jobs, markers, library };
}
