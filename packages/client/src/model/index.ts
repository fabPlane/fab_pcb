/** Layer 3 — the object model: `KiCad` -> `Project` -> `Board` | `Schematic` | `FootprintDocument`. */
export * from "./items";
export { KiCad, type TextShapes } from "./kicad";
export { Project } from "./project";
export {
  Document,
  checkItemRequestStatus,
  sheetPathKey,
  type DocumentChange,
  type DocumentKind,
  type ItemCounts,
  type ItemPageOptions,
  type ItemScope,
  type ItemsPage,
  type ItemsSince,
} from "./document";
export { Board, type CustomRules, type EnabledLayers, type NetlistImportResult } from "./board";
export { Schematic, SheetHandle, flattenHierarchy, toSheetPath, type SheetPathLike } from "./schematic";
export { FootprintDocument } from "./footprint-doc";
export { SymbolDocument } from "./symbol-doc";
export { Commit, type CommitOptions, type CommitResult, type DeleteResult, type ItemInput } from "./commit";
export { Variants } from "./variants";
export { BoardJobs, Job, SchematicJobs, type JobOptions, type JobOutput, type JobProgressInfo, type JobResult, type JobWaitOptions } from "./jobs";
export { BoardDrc, SchematicErc, activeMarkers, type DrcRunOptions, type SeveritySettings } from "./checks";
export { decodeEmbeddedFileData, embeddedFileContent, encodeEmbeddedFileData, hasZstd, toEmbeddedFile, type EmbeddedFileInput } from "./embedded";
