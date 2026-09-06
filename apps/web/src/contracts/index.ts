// The contracts from docs/contracts.md, re-exported from the packages that own them:
// the ItemStore family from `@kicad-web/client/store` and the CanvasHost family from
// `@kicad-web/renderer`. Nothing else in apps/web imports those types from anywhere else,
// so the mock services and the mock canvas host implement exactly what the real ones do.

export type { StoredItem, StoreDiff, ItemStore } from '@kicad-web/client/store';
export type { DocumentKind } from '@kicad-web/client';
export type { Theme, PickResult, CanvasHost } from '@kicad-web/renderer';
export type { CameraState as Camera } from '@kicad-web/renderer';
