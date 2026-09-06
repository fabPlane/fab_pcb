// SWAP SEAM: the only place that constructs a CanvasHost.
//
//   import { BoardCanvasHost, SchematicCanvasHost } from '@kicad-web/renderer';
//   export function createCanvasHost(kind) {
//     return kind === 'schematic' ? new SchematicCanvasHost() : new BoardCanvasHost();
//   }

import type { CanvasHost, DocumentKind } from '@/contracts';
import { MockCanvasHost } from './MockCanvasHost';

export function createCanvasHost(kind: DocumentKind): CanvasHost {
  return new MockCanvasHost(kind);
}
