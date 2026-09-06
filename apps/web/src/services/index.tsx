// Composition root for the service layer.
//
// SWAP SEAM: `createMockServices()` is the only place that knows about mocks. To use the
// real bridge + KiCad, add `createKicadServices(bridgeUrl)` returning the same `Services`
// shape (BridgeSessionService over fetch/WebSocket, a DocumentService that wraps
// `@kicad-web/client`'s Project/Board/Schematic and exposes their ItemStores, a
// CommandServiceImpl built with a KiCadCommitBackend) and pick it in main.tsx.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { CommandServiceImpl, MockCommitBackend } from './CommandService';
import { MockDocumentService } from './mock/MockDocumentService';
import { MockJobsService } from './mock/MockJobsService';
import { MockMarkerService } from './mock/MockMarkerService';
import { MockSessionService } from './mock/MockSessionService';
import type { Services } from './types';

export type { Services } from './types';

export function createMockServices(opts: { latencyMs?: number } = {}): Services {
  const documents = new MockDocumentService();
  return {
    session: new MockSessionService(opts),
    documents,
    commands: new CommandServiceImpl(new MockCommitBackend()),
    jobs: new MockJobsService(),
    markers: new MockMarkerService(documents.boardIds, { ...documents.schematicIds, sheetPower: documents.sheets()[0]?.children[0]?.path.split('/')[1] ?? '' }),
  };
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('useServices must be used inside <ServicesProvider>');
  return s;
}

/** Re-renders when a service with an `onChange` subscription emits. */
export function useServiceVersion(subscribe: (cb: () => void) => () => void): number {
  const [v, setV] = useState(0);
  useEffect(() => subscribe(() => setV((x) => x + 1)), [subscribe]);
  return v;
}
