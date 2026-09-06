import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerBuiltinCommands } from './commands/builtins';
import { createMockServices, ServicesProvider } from './services';
import { bindHistory } from './state/historyStore';
import './styles/app.css';

// SWAP SEAM: replace createMockServices() with createKicadServices({ bridgeUrl: location.origin })
// once packages/client and packages/bridge are wired. Nothing below this line changes.
const services = createMockServices();
registerBuiltinCommands(services);
bindHistory(services.commands);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServicesProvider services={services}>
      <App />
    </ServicesProvider>
  </StrictMode>,
);
