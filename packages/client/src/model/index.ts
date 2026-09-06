/** Layer 3 — the object model: `KiCad` -> `Project` -> `Board` | `Schematic` | `FootprintDocument`. */
export * from "./items";
export { KiCad, type TextShapes } from "./kicad";
export { Project } from "./project";
export { Document, checkItemRequestStatus, sheetPathKey, type DocumentChange, type DocumentKind, type ItemScope } from "./document";
export { Board, type CustomRules, type EnabledLayers, type NetlistImportResult } from "./board";
export { Schematic, SheetHandle, flattenHierarchy, toSheetPath, type SheetPathLike } from "./schematic";
export { FootprintDocument } from "./footprint-doc";
export { SymbolDocument } from "./symbol-doc";
export { Commit, type CommitOptions, type CommitResult, type DeleteResult, type ItemInput } from "./commit";
export { Variants } from "./variants";
export { BoardJobs, SchematicJobs, type JobOptions, type JobResult } from "./jobs";
export { decodeEmbeddedFileData, embeddedFileContent, encodeEmbeddedFileData, hasZstd, toEmbeddedFile, type EmbeddedFileInput } from "./embedded";
