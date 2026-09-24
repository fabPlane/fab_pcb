# IPC API coverage matrix (KiCad 10.99, commit 329aba9ff0)

Generated from `api/proto/**/*.proto` versus `registerHandler<...>` calls in the KiCad sources. "Handlers" names the C++ handler class that serves the command: server = API_HANDLER_SERVER (inside the API server, always loaded), common = API_HANDLER_COMMON (always loaded), editor = API_HANDLER_EDITOR, library = API_HANDLER_LIBRARY (base of the footprint and symbol library handlers), libraries = API_HANDLER_LIBRARIES (upstream library status and query commands), board = API_HANDLER_BOARD, pcb = API_HANDLER_PCB, footprint = API_HANDLER_FOOTPRINT, fplib = API_HANDLER_FOOTPRINT_LIBRARY, symlib = API_HANDLER_SYMBOL_LIBRARY, sch = API_HANDLER_SCH.

| Status | Count | Meaning |
|---|---:|---|
| OK | 165 | works in `kicad-cli api-server` |
| GUI-ONLY | 15 | handler returns "not available in headless mode" |
| PARTIAL | 1 | headless in some handlers only |
| UNREGISTERED | 2 | defined in .proto, no handler anywhere |
| **Total** | **183** | request messages defined in the command protos |


## common/base

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `GetJobStatus` | common | yes |  |
| `GetKiCadBinaryPath` | common | yes |  |
| `GetPaths` | common | yes |  |
| `GetPluginSettingsPath` | common | yes |  |
| `GetServerInfo` | server | yes |  |
| `GetSupportedCommands` | server | yes |  |
| `GetTextAsShapes` | common | yes |  |
| `GetTextExtents` | common | yes |  |
| `GetVersion` | common | yes |  |
| `Ping` | common | yes |  |

## common/project

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `CloseAllDocuments` | common | yes |  |
| `CloseDocument` | common | yes |  |
| `CreateDocument` | common | yes |  |
| `ExpandTextVariables` | common, board, sch | yes |  |
| `GetNetClassAssignments` | common | yes |  |
| `GetNetClasses` | common | yes |  |
| `GetProjectInfo` | common | yes |  |
| `GetTextVariables` | common | yes |  |
| `NewDocument` | common | yes |  |
| `NewProject` | common | yes |  |
| `OpenDocument` | common | yes |  |
| `SaveDocument` | pcb, footprint, sch | yes |  |
| `SetNetClassAssignments` | common | yes |  |
| `SetNetClasses` | common | yes |  |
| `SetTextVariables` | common | yes |  |

## common/editor

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `AddToSelection` | board, sch | no | gated by checkForHeadless in board, sch |
| `BeginCommit` | editor | yes |  |
| `ClearSelection` | board, sch | no | gated by checkForHeadless in board, sch |
| `CreateItems` | editor | yes |  |
| `DeleteItems` | editor | yes |  |
| `EndCommit` | editor | yes |  |
| `FocusOnItems` | board, sch | no | gated by checkForHeadless in board, sch |
| `GetActions` | editor | yes |  |
| `GetBoundingBox` | board | yes |  |
| `GetDocumentModifiedState` | editor | yes |  |
| `GetDocumentRevision` | editor | yes |  |
| `GetItemCounts` | editor | yes |  |
| `GetItems` | pcb, footprint, sch | yes |  |
| `GetItemsById` | board, sch | yes |  |
| `GetOpenDocuments` | server, pcb, footprint, sch | yes |  |
| `GetPageSettings` | pcb, sch | yes |  |
| `GetSelection` | board, sch | no | gated by checkForHeadless in board, sch |
| `GetTitleBlockInfo` | editor | yes |  |
| `GetUndoStack` | editor | yes |  |
| `HitTest` | editor | yes |  |
| `OpenLibraryItem` | footprint | yes |  |
| `ParseAndCreateItemsFromString` | board, sch | yes |  |
| `Redo` | editor | yes |  |
| `RefreshEditor` | editor | yes |  |
| `RemoveFromSelection` | board, sch | no | gated by checkForHeadless in board, sch |
| `RevertDocument` | pcb, footprint, sch | partial | headless-gated in footprint; pcb, sch handlers serve it |
| `RunAction` | editor | yes |  |
| `SaveCopyOfDocument` | pcb, footprint, sch | yes |  |
| `SaveDocumentToString` | board, sch | yes |  |
| `SaveItemsToString` | board, sch | yes |  |
| `SaveSelectionToString` | board, sch | no | gated by checkForHeadless in board, sch |
| `SetPageSettings` | pcb, sch | yes |  |
| `SetTitleBlockInfo` | editor | yes |  |
| `Undo` | editor | yes |  |
| `UpdateItems` | editor | yes |  |

## common/library

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `AddLibraryTableRow` | library | yes |  |
| `CreateLibrary` | library | yes |  |
| `DeleteLibraryItem` | library | yes |  |
| `GetItemsFromLibrary` | libraries | yes |  |
| `GetLibraryItem` | library | yes |  |
| `GetLibraryItems` | libraries | yes |  |
| `GetLibraryStatuses` | libraries | yes |  |
| `GetLibraryTable` | - | n/a | no registerHandler call in any handler |
| `GetLibraryTables` | library | yes |  |
| `ListLibraryEntries` | library | yes |  |
| `ListWizards` | fplib | yes |  |
| `LoadAllLibraries` | libraries | yes |  |
| `ReloadLibrary` | libraries | yes |  |
| `RemoveLibraryTableRow` | library | yes |  |
| `RunWizard` | fplib | yes |  |
| `SaveLibraryItem` | library | yes |  |
| `SearchLibraries` | - | n/a | no registerHandler call in any handler |

## common/settings

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `GetAppSettings` | common | yes |  |
| `GetColorTheme` | common | yes |  |
| `ListColorThemes` | common | yes |  |

## common/variant

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `AddVariant` | pcb, sch | yes |  |
| `CopyVariant` | pcb, sch | yes |  |
| `DeleteVariant` | pcb, sch | yes |  |
| `GetCurrentVariant` | pcb, sch | yes |  |
| `GetVariants` | pcb, sch | yes |  |
| `RenameVariant` | pcb, sch | yes |  |
| `SetCurrentVariant` | pcb, sch | yes |  |
| `SetVariantDescription` | pcb, sch | yes |  |

## common/crossprobe

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `CrossProbeAnnounce` | pcb, sch | yes |  |
| `FocusOnItem` | editor | yes |  |
| `HighlightNets` | pcb, sch | no | gated by checkForHeadless in pcb, sch |
| `SyncSelection` | pcb, sch | no | gated by checkForHeadless in pcb, sch |

## board/commands

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `AddEmbeddedFiles` | pcb | yes |  |
| `AutoplaceFootprints` | pcb | yes |  |
| `CheckPadstackPresenceOnLayers` | board | yes |  |
| `FlipItems` | board | yes |  |
| `GetActiveLayer` | board | no | gated by checkForHeadless in board |
| `GetBoardDesignRules` | pcb | yes |  |
| `GetBoardEditorAppearanceSettings` | pcb | no | gated by checkForHeadless in pcb |
| `GetBoardEnabledLayers` | board | yes |  |
| `GetBoardLayerByName` | pcb | yes |  |
| `GetBoardLayerName` | pcb | yes |  |
| `GetBoardOrigin` | pcb | yes |  |
| `GetBoardPlotSettings` | pcb | yes |  |
| `GetBoardStackup` | board | yes |  |
| `GetConnectedItems` | pcb | yes |  |
| `GetCustomDesignRules` | pcb | yes |  |
| `GetDrcMarkers` | pcb | yes |  |
| `GetDrcSeverities` | pcb | yes |  |
| `GetEmbeddedFiles` | pcb | yes |  |
| `GetGraphicsDefaults` | board | yes |  |
| `GetItemsByNet` | pcb | yes |  |
| `GetItemsByNetClass` | pcb | yes |  |
| `GetNetClassForNets` | pcb | yes |  |
| `GetNetLengths` | pcb | yes |  |
| `GetNets` | pcb | yes |  |
| `GetPadShapeAsPolygon` | board | yes |  |
| `GetRatsnest` | pcb | yes |  |
| `GetUnroutedCount` | pcb | yes |  |
| `GetVisibleLayers` | board | no | gated by checkForHeadless in board |
| `GlobalDeletion` | pcb | yes |  |
| `ImportNetlist` | pcb | yes |  |
| `ImportSpecctraSession` | pcb | yes |  |
| `InjectDrcError` | pcb | yes |  |
| `InteractiveMoveItems` | board | no | gated by checkForHeadless in board |
| `PlaceFootprintFromLibrary` | pcb | yes |  |
| `RefillZones` | pcb | yes |  |
| `RemoveTeardrops` | pcb | yes |  |
| `RunBoardJobDrc` | pcb | yes |  |
| `SetActiveLayer` | board | no | gated by checkForHeadless in board |
| `SetBoardDesignRules` | pcb | yes |  |
| `SetBoardEditorAppearanceSettings` | pcb | no | gated by checkForHeadless in pcb |
| `SetBoardEnabledLayers` | pcb | yes |  |
| `SetBoardOrigin` | pcb | yes |  |
| `SetBoardPlotSettings` | pcb | yes |  |
| `SetCustomDesignRules` | pcb | yes |  |
| `SetDrcMarkerExcluded` | pcb | yes |  |
| `SetDrcSeverities` | pcb | yes |  |
| `SetEmbeddedFiles` | pcb | yes |  |
| `SetGraphicsDefaults` | pcb | yes |  |
| `SetTeardrops` | pcb | yes |  |
| `SetVisibleLayers` | board | no | gated by checkForHeadless in board |
| `UpdateBoardStackup` | pcb | yes |  |
| `UpdateFootprintsFromLibrary` | pcb | yes |  |

## board/jobs

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `RunBoardJobExport3D` | pcb | yes |  |
| `RunBoardJobExportDrill` | pcb | yes |  |
| `RunBoardJobExportDxf` | pcb | yes |  |
| `RunBoardJobExportGencad` | pcb | yes |  |
| `RunBoardJobExportGerbers` | pcb | yes |  |
| `RunBoardJobExportIpc2581` | pcb | yes |  |
| `RunBoardJobExportIpcD356` | pcb | yes |  |
| `RunBoardJobExportODB` | pcb | yes |  |
| `RunBoardJobExportPdf` | pcb | yes |  |
| `RunBoardJobExportPng` | pcb | yes |  |
| `RunBoardJobExportPosition` | pcb | yes |  |
| `RunBoardJobExportPs` | pcb | yes |  |
| `RunBoardJobExportRender` | pcb | yes |  |
| `RunBoardJobExportSpecctra` | pcb | yes |  |
| `RunBoardJobExportStats` | pcb | yes |  |
| `RunBoardJobExportSvg` | pcb | yes |  |

## sch/commands

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `Annotate` | sch | yes |  |
| `AssignFootprints` | sch | yes |  |
| `ClearAnnotation` | sch | yes |  |
| `GetErcMarkers` | sch | yes |  |
| `GetErcSeverities` | sch | yes |  |
| `GetSchematicHierarchy` | sch | yes |  |
| `GetSchematicNetlist` | sch | yes |  |
| `GetSchematicSettings` | sch | yes |  |
| `GetSymbolFieldsTable` | sch | yes |  |
| `PlaceSymbolFromLibrary` | sch | yes |  |
| `RunSchematicJobErc` | sch | yes |  |
| `SetErcMarkerExcluded` | sch | yes |  |
| `SetErcSeverities` | sch | yes |  |
| `SetSchematicSettings` | sch | yes |  |
| `SetSymbolFields` | sch | yes |  |
| `SyncSchematicToBoard` | sch | yes |  |

## sch/jobs

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `RunSchematicJobExportBOM` | sch | yes |  |
| `RunSchematicJobExportDxf` | sch | yes |  |
| `RunSchematicJobExportNetlist` | sch | yes |  |
| `RunSchematicJobExportPdf` | sch | yes |  |
| `RunSchematicJobExportPng` | sch | yes |  |
| `RunSchematicJobExportPs` | sch | yes |  |
| `RunSchematicJobExportSvg` | sch | yes |  |

## Not expressible at all (no proto message exists)

See [04-ipc-gaps.md](04-ipc-gaps.md) for the full list: run DRC/ERC and read markers, library browsing, annotation, schematic-to-board sync in one call, ratsnest/unrouted connections, undo/redo, events/notifications, new project/document creation, symbol and drawing-sheet documents, capability discovery, non-IPC transports.
