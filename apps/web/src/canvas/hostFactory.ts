// The only place that constructs a CanvasHost.
//
// Mock services draw with the Canvas2D `MockCanvasHost` (the e2e smoke tests depend on it);
// the KiCad services install a factory (`setCanvasHostFactory`) that returns the PixiJS
// `BoardCanvasHost` / `SchematicCanvasHost` from `@fp-pcb/renderer` with the adapter
// contexts (pad polygons, text shapes, copper layers) wired to the live document.

import type { CanvasHost, DocumentKind, ItemStore } from '@/contracts';
import { MockCanvasHost } from './MockCanvasHost';

export type CanvasHostFactory = (kind: DocumentKind, storeKey: string, store: ItemStore) => CanvasHost;

let factory: CanvasHostFactory | null = null;

/** Installs the real-renderer factory (called by `createKicadServices`); `null` restores the mock. */
export function setCanvasHostFactory(f: CanvasHostFactory | null): void {
  factory = f;
}

export function createCanvasHost(kind: DocumentKind, storeKey: string, store: ItemStore): CanvasHost {
  return factory ? factory(kind, storeKey, store) : new MockCanvasHost(kind);
}
