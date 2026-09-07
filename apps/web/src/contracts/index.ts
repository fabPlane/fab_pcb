// The contracts from docs/contracts.md, re-exported from the packages that own them:
// the ItemStore family from `@fp-pcb/client/store` and the CanvasHost family from
// `@fp-pcb/renderer`. Nothing else in apps/web imports those types from anywhere else,
// so the mock services and the mock canvas host implement exactly what the real ones do.

export type { StoredItem, StoreDiff, ItemStore } from '@fp-pcb/client/store';
export type { DocumentKind } from '@fp-pcb/client';
export type { Theme, PickResult, CanvasHost } from '@fp-pcb/renderer';
export type { CameraState as Camera } from '@fp-pcb/renderer';
