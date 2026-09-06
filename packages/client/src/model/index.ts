/** Layer 3 — the object model: `KiCad` -> `Project` -> `Board` | `Schematic` | `FootprintDocument`. */
export * from "./items";
export { toEntries, toRecord, type EntryMapLike } from "./entries";
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
  type UndoRedoResult,
  type UndoStacks,
} from "./document";
export {
  Board,
  type AutoplaceOutcome,
  type CustomRules,
  type EnabledLayers,
  type FootprintUpdateResult,
  type GlobalDeletionOptions,
  type NetlistImportResult,
  type Ratsnest,
  type RatsnestEdge,
  type TeardropTargets,
  type UnroutedCount,
} from "./board";
export {
  Schematic,
  SheetHandle,
  flattenHierarchy,
  toSheetPath,
  type AnnotateOptions,
  type AnnotateResult,
  type AnnotationScope,
  type AssignFootprintsResult,
  type FootprintAssignment,
  type FootprintAssignments,
  type FieldEdit,
  type FieldsTableRow,
  type NewSheetOptions,
  type SetFieldsResult,
  type SheetPathLike,
  type SyncToBoardOptions,
  type SyncToBoardResult,
} from "./schematic";
export {
  Libraries,
  LibraryView,
  libIdString,
  libraryType,
  tableScope,
  toLibraryId,
  type CreateLibraryOptions,
  type LibIdLike,
  type LibraryItem,
  type LibraryKind,
  type TableRowInput,
  type TableScope,
  type WizardParams,
  type WizardResult,
} from "./libraries";
export {
  Settings,
  toAppType,
  toThemeColor,
  unitSuffix,
  type AppName,
  type ColorTheme,
  type ColorThemeSummary,
  type ThemeColor,
} from "./settings";
export { FootprintDocument } from "./footprint-doc";
export { SymbolDocument } from "./symbol-doc";
export { Commit, type CommitOptions, type CommitResult, type DeleteResult, type ItemInput } from "./commit";
export { Variants } from "./variants";
export {
  BoardJobs,
  Job,
  SchematicJobs,
  type JobOptions,
  type JobOutput,
  type JobProgressInfo,
  type JobResult,
  type JobWaitOptions,
} from "./jobs";
export { BoardDrc, SchematicErc, activeMarkers, type DrcRunOptions, type SeveritySettings } from "./checks";
export {
  decodeEmbeddedFileData,
  embeddedFileContent,
  encodeEmbeddedFileData,
  hasZstd,
  toEmbeddedFile,
  type EmbeddedFileInput,
} from "./embedded";
