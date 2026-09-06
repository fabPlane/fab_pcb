import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getCanvasHost } from './canvas/CanvasSlot';
import { registerBuiltinCommands } from './commands/builtins';
import { getCommand } from './commands/registry';
import { useAppStore } from './state/appStore';
import { useEditorStore } from './state/editorStore';
import { usePromptStore } from './state/promptStore';
import { useLibraryStore } from './state/libraryStore';
import { useLogStore } from './state/logStore';
import { useUiStore } from './state/uiStore';
import { registerEditingCommands } from './commands/editing';
import { registerToolCommands } from './commands/tools';
import { activeTool, bindTools, cancelTool, toolFinish, toolKey } from './canvas/tools';
import { installCrossProbe } from './services/crossProbe';
import { createMockServices, ServicesProvider, type Services } from './services';
import { createKicadServices } from './services/kicad';
import { bindHistory } from './state/historyStore';
import { log } from './state/logStore';
import './styles/app.css';

// Service selection (documented in apps/web/README.md):
//   - `?mock=1` or VITE_SERVICES=mock  -> in-memory mock services (the default for `bun run dev`,
//                                         which the e2e smoke tests rely on);
//   - `?bridge=<url>` or VITE_BRIDGE_URL -> real KiCad through the bridge at that URL
//                                         ('' / 'proxy' = same origin, i.e. the Vite proxy);
//   - `?kicad-ws=<url>` or VITE_KICAD_WS -> real KiCad *directly*, over nng's own WebSocket
//                                         transport: the page dials `kicad-cli api-server --socket
//                                         ws://host:port/path` itself, with no bridge in the
//                                         request path. Add `?bridge=` as well to keep the project
//                                         browser and the library session (both need a bridge to
//                                         spawn processes and read files); on its own the app
//                                         adopts whatever project the running server has open.
//   - VITE_SERVICES=kicad               -> real services on the same origin.
function pickServices(): { mode: 'mock' } | { mode: 'kicad'; bridgeUrl: string; directWsUrl?: string; bridgeless: boolean } {
  const params = new URLSearchParams(location.search);
  const env = import.meta.env as Record<string, string | undefined>;
  if (params.get('mock') === '1' || env.VITE_SERVICES === 'mock') return { mode: 'mock' };
  const direct = params.get('kicad-ws') ?? env.VITE_KICAD_WS;
  const bridge = params.get('bridge') ?? env.VITE_BRIDGE_URL;
  const asked = bridge !== undefined && bridge !== null && bridge !== '';
  const bridgeUrl = !asked ? '' : bridge === 'proxy' || bridge === '1' ? '' : bridge!;
  // A direct URL on its own means "no bridge anywhere"; asking for one as well keeps the
  // bridge-only features (file access, spawning) while requests still go straight to KiCad.
  if (direct) return { mode: 'kicad', bridgeUrl, directWsUrl: direct, bridgeless: !asked };
  if (bridge !== undefined && bridge !== null) return { mode: 'kicad', bridgeUrl, bridgeless: false };
  if (env.VITE_SERVICES === 'kicad') return { mode: 'kicad', bridgeUrl: '', bridgeless: false };
  return { mode: 'mock' };
}

const choice = pickServices();
const services: Services =
  choice.mode === 'kicad'
    ? await createKicadServices({ bridgeUrl: choice.bridgeUrl, directWsUrl: choice.directWsUrl, bridgeless: choice.bridgeless })
    : createMockServices();
log(
  choice.mode !== 'kicad'
    ? 'Services: in-memory mock (add ?bridge=http://127.0.0.1:4020 or ?kicad-ws=ws://127.0.0.1:5599/kicad for real KiCad)'
    : choice.directWsUrl
      ? `Services: KiCad directly at ${choice.directWsUrl}${choice.bridgeless ? ' (no bridge)' : ` (bridge ${choice.bridgeUrl || location.origin} for files only)`}`
      : `Services: KiCad via bridge ${choice.bridgeUrl || location.origin}`,
);
registerBuiltinCommands(services);
registerEditingCommands(services, { library: choice.mode === 'kicad' ? (services as unknown as { library: import('./services/kicad/KicadLibraryService').KicadLibraryService }).library : undefined });
registerToolCommands(services);
bindTools(services);
installCrossProbe(services);
bindHistory(services.commands);
{
  // Debug hook for the browser console and the proof / e2e harness (`__kicadWeb.services`,
  // `__kicadWeb.host('board')`, `__kicadWeb.runCommand(id)`); kept in production builds too so
  // `vite preview` can be driven the same way.
  (window as unknown as { __kicadWeb?: unknown }).__kicadWeb = {
    services,
    host: getCanvasHost,
    mode: choice.mode,
    /** Runs a registered command in the active editor's context (the proof script / e2e). */
    runCommand: (id: string) => getCommand(id)?.run({ editor: useAppStore.getState().activeEditor }),
    tools: { activeTool, toolFinish, toolKey, cancelTool },
    stores: { app: useAppStore, editor: useEditorStore, prompt: usePromptStore, ui: useUiStore, log: useLogStore, library: useLibraryStore },
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServicesProvider services={services}>
      <App />
    </ServicesProvider>
  </StrictMode>,
);
