# IPC API coverage matrix (KiCad 10.99, commit 1ca7f148a5)

Generated from `api/proto/**/*.proto` versus `registerHandler<...>` calls in the KiCad sources. "Handlers" names the C++ handler class that serves the command: server = API_HANDLER_SERVER (inside the API server, always loaded), common = API_HANDLER_COMMON (always loaded), editor = API_HANDLER_EDITOR, board = API_HANDLER_BOARD, pcb = API_HANDLER_PCB, footprint = API_HANDLER_FOOTPRINT, sch = API_HANDLER_SCH.

| Status | Count | Meaning |
|---|---:|---|
| OK | 113 | works in `kicad-cli api-server` |
| GUI-ONLY | 16 | handler returns "not available in headless mode" |
| PARTIAL | 0 | headless in some handlers only |
| UNREGISTERED | 0 | defined in .proto, no handler anywhere |
| **Total** | **129** | request messages defined in the command protos |


## common/base

| Command | Handlers | Headless | Notes |
|---|---|---|---|
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
| `ExpandTextVariables` | common, board, sch | yes |  |
| `GetNetClasses` | common | yes |  |
| `GetProjectInfo` | common | yes |  |
| `GetTextVariables` | common | yes |  |
| `NewDocument` | common | yes |  |
| `NewProject` | common | yes |  |
| `OpenDocument` | common | yes |  |
| `SaveDocument` | pcb, footprint, sch | yes |  |
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
| `GetBoundingBox` | board | yes |  |
| `GetDocumentRevision` | editor | yes |  |
| `GetItems` | pcb, footprint, sch | yes |  |
| `GetItemsById` | board, sch | yes |  |
| `GetOpenDocuments` | pcb, footprint, sch | yes |  |
| `GetPageSettings` | pcb, sch | yes |  |
| `GetSelection` | board, sch | no | gated by checkForHeadless in board, sch |
| `GetTitleBlockInfo` | editor | yes |  |
| `HitTest` | editor | yes |  |
| `OpenLibraryItem` | footprint | yes |  |
| `ParseAndCreateItemsFromString` | board | yes |  |
| `RefreshEditor` | editor | yes |  |
| `RemoveFromSelection` | board, sch | no | gated by checkForHeadless in board, sch |
| `RevertDocument` | pcb, footprint, sch | no | gated by checkForHeadless in pcb, footprint, sch |
| `RunAction` | board | no | gated by checkForHeadless in board |
| `SaveCopyOfDocument` | pcb, footprint, sch | yes |  |
| `SaveDocumentToString` | board | yes |  |
| `SaveItemsToString` | board | yes |  |
| `SaveSelectionToString` | board | no | gated by checkForHeadless in board |
| `SetPageSettings` | pcb, sch | yes |  |
| `SetTitleBlockInfo` | editor | yes |  |
| `UpdateItems` | editor | yes |  |

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
| `GetNets` | pcb | yes |  |
| `GetPadShapeAsPolygon` | board | yes |  |
| `GetVisibleLayers` | board | no | gated by checkForHeadless in board |
| `ImportNetlist` | pcb | yes |  |
| `InjectDrcError` | pcb | yes |  |
| `InteractiveMoveItems` | board | no | gated by checkForHeadless in board |
| `RefillZones` | pcb | yes |  |
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
| `SetVisibleLayers` | board | no | gated by checkForHeadless in board |
| `UpdateBoardStackup` | pcb | yes |  |

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
| `RunBoardJobExportPosition` | pcb | yes |  |
| `RunBoardJobExportPs` | pcb | yes |  |
| `RunBoardJobExportRender` | pcb | yes |  |
| `RunBoardJobExportStats` | pcb | yes |  |
| `RunBoardJobExportSvg` | pcb | yes |  |

## sch/commands

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `GetErcMarkers` | sch | yes |  |
| `GetErcSeverities` | sch | yes |  |
| `GetSchematicHierarchy` | sch | yes |  |
| `GetSchematicNetlist` | sch | yes |  |
| `RunSchematicJobErc` | sch | yes |  |
| `SetErcMarkerExcluded` | sch | yes |  |
| `SetErcSeverities` | sch | yes |  |

## sch/jobs

| Command | Handlers | Headless | Notes |
|---|---|---|---|
| `RunSchematicJobExportBOM` | sch | yes |  |
| `RunSchematicJobExportDxf` | sch | yes |  |
| `RunSchematicJobExportNetlist` | sch | yes |  |
| `RunSchematicJobExportPdf` | sch | yes |  |
| `RunSchematicJobExportPs` | sch | yes |  |
| `RunSchematicJobExportSvg` | sch | yes |  |

## Not expressible at all (no proto message exists)

See [04-ipc-gaps.md](04-ipc-gaps.md) for the full list: run DRC/ERC and read markers, library browsing, annotation, schematic-to-board sync in one call, ratsnest/unrouted connections, undo/redo, events/notifications, new project/document creation, symbol and drawing-sheet documents, capability discovery, non-IPC transports.
