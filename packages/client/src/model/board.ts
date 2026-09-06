/** `Board` — a PCB document: `board_commands.proto` on top of `Document`. */
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  BoardDesignRulesSchema,
  BoardFlipDirection,
  BoardLayer,
  BoardOriginType,
  BoardPlotSettingsSchema,
  BoardStackupSchema,
  CustomRuleSchema,
  CustomRulesStatus,
  DrcSeverity,
  EmbeddedFilesSchema,
  GraphicsDefaultsSchema,
  ItemStatusCode,
  KiCadObjectType,
  LockFilter,
  NetSchema,
  NetlistMatchMode,
  AutoplaceResult,
  PadTeardropSettingsSchema,
  TeardropAction,
  type BoardDesignRules,
  type BoardPlotSettings,
  type BoardStackup,
  type CustomRule,
  type EmbeddedFile,
  type EmbeddedFileSchema,
  type GraphicsDefaults,
  type LibraryIdentifier,
  type Net,
  type NetClass,
  type NetLength,
  type PadstackPresence,
  type PolygonWithHoles,
} from "@kicad-web/proto";
import * as cmd from "../commands";
import { KiCadItemError, type ItemFailure } from "../errors";
import { nm, toVector2, vec2, type Vec2 } from "../units";
import { Document, checkItemRequestStatus, type DocumentKind, type ItemScope } from "./document";
import {
  Arc,
  BOARD_ITEM_TYPES,
  BoardGroup,
  BoardShape,
  BoardText,
  Dimension,
  Footprint,
  Pad,
  Track,
  Via,
  Zone,
  wrapAll,
  type Item,
} from "./items";
import { toEmbeddedFile, type EmbeddedFileInput } from "./embedded";
import { toLibraryId, type LibIdLike } from "./libraries";
import { BoardDrc } from "./checks";
import { BoardJobs } from "./jobs";
import { DocumentSync } from "../store/document-sync";
import type { ItemStore } from "../store/item-store";

export interface EnabledLayers {
  copperLayerCount: number;
  layers: BoardLayer[];
}

export interface CustomRules {
  status: CustomRulesStatus;
  rules: CustomRule[];
  /** Parser error text when `status` is CRS_INVALID. */
  errorText: string;
}

export interface NetlistImportResult {
  errorCount: number;
  warningCount: number;
  newFootprintCount: number;
  report: string;
}

/** One unrouted connection (airline) of the ratsnest, with positions in nanometres. */
export interface RatsnestEdge {
  net: string;
  netCode: number;
  /** KIID of the copper item (pad, via, track, zone) at each end. */
  source: string;
  target: string;
  sourcePosition: Vec2;
  targetPosition: Vec2;
  /** Straight-line distance between the ends, nanometres. */
  length: number;
}

export interface Ratsnest {
  edges: RatsnestEdge[];
  /** Unrouted connections on the whole board, not only the requested nets. */
  unroutedCount: number;
}

export interface UnroutedCount {
  unroutedCount: number;
  /** Nets with at least one unrouted connection. */
  unroutedNetCount: number;
}

export interface FootprintUpdateResult {
  updatedCount: number;
  /** Footprints left alone because they already matched the library (`onlyChanged`). */
  unchangedCount: number;
  /** References whose library footprint could not be loaded. */
  missing: string[];
  messages: string[];
}

/** Which pads and vias `setTeardrops` affects. Listing `items` replaces the kind flags. */
export interface TeardropTargets {
  vias?: boolean;
  pthPads?: boolean;
  smdPads?: boolean;
  trackToTrack?: boolean;
  /** Restrict to these pads and vias instead of the kinds above. */
  items?: readonly string[];
  /** Restrict to items on these nets. */
  nets?: readonly string[];
  roundShapesOnly?: boolean;
}

export interface AutoplaceOutcome {
  result: AutoplaceResult;
  placedCount: number;
  /** False when the board has no outline to place within (`APR_NO_BOARD_OUTLINE`). */
  ok: boolean;
}

export interface GlobalDeletionOptions {
  /** Item types to delete (footprints, tracks, arcs, vias, zones, shapes, texts, ...). */
  types: readonly KiCadObjectType[];
  /** Only items on these layers; empty means every layer. */
  layers?: readonly BoardLayer[];
  locked?: "all" | "locked" | "unlocked";
  /** Also delete board outline shapes (Edge.Cuts). */
  boardEdges?: boolean;
  /** Also delete teardrop zones when zones are listed. */
  teardrops?: boolean;
}

export class Board extends Document {
  readonly kind: DocumentKind = "board";
  readonly itemTypes = BOARD_ITEM_TYPES;
  readonly jobs = new BoardJobs(this);
  /** Design rule checker: `run()`, `markers()`, `exclude()`, `severities()` (KiCad >= 11.0). */
  readonly drc = new BoardDrc(this);
  private sync: DocumentSync | undefined;

  /** File name of the board (`foo.kicad_pcb`). */
  get fileName(): string {
    return this.specifier.identifier.case === "boardFilename" ? this.specifier.identifier.value : "";
  }

  /** Normalised item store fed by `GetItems` and kept in sync with commits made through this Board. */
  get store(): ItemStore {
    this.sync ??= new DocumentSync(this);
    return this.sync.store;
  }

  /** The `DocumentSync` behind `store` (call `load()` before first use). */
  get documentSync(): DocumentSync {
    this.sync ??= new DocumentSync(this);
    return this.sync;
  }

  // --- typed item getters ------------------------------------------------------------------------

  async getFootprints(): Promise<Footprint[]> {
    return (await this.getItems(KiCadObjectType.KOT_PCB_FOOTPRINT)).filter((i): i is Footprint => i instanceof Footprint);
  }
  async getPads(): Promise<Pad[]> {
    return (await this.getItems(KiCadObjectType.KOT_PCB_PAD)).filter((i): i is Pad => i instanceof Pad);
  }
  /** Tracks, arcs and vias. */
  async getTracks(): Promise<(Track | Arc | Via)[]> {
    const items = await this.getItems([KiCadObjectType.KOT_PCB_TRACE, KiCadObjectType.KOT_PCB_ARC, KiCadObjectType.KOT_PCB_VIA]);
    return items.filter((i): i is Track | Arc | Via => i instanceof Track || i instanceof Arc || i instanceof Via);
  }
  async getVias(): Promise<Via[]> {
    return (await this.getItems(KiCadObjectType.KOT_PCB_VIA)).filter((i): i is Via => i instanceof Via);
  }
  async getZones(): Promise<Zone[]> {
    return (await this.getItems(KiCadObjectType.KOT_PCB_ZONE)).filter((i): i is Zone => i instanceof Zone);
  }
  async getShapes(): Promise<BoardShape[]> {
    return (await this.getItems(KiCadObjectType.KOT_PCB_SHAPE)).filter((i): i is BoardShape => i instanceof BoardShape);
  }
  async getTexts(): Promise<BoardText[]> {
    return (await this.getItems(KiCadObjectType.KOT_PCB_TEXT)).filter((i): i is BoardText => i instanceof BoardText);
  }
  async getDimensions(): Promise<Dimension[]> {
    return (await this.getItems(KiCadObjectType.KOT_PCB_DIMENSION)).filter((i): i is Dimension => i instanceof Dimension);
  }
  async getGroups(): Promise<BoardGroup[]> {
    return (await this.getItems(KiCadObjectType.KOT_PCB_GROUP)).filter((i): i is BoardGroup => i instanceof BoardGroup);
  }

  // --- board setup ---------------------------------------------------------------------------------

  async stackup(): Promise<BoardStackup> {
    const res = await cmd.getBoardStackup(this.client, { board: this.specifier });
    return res.stackup ?? create(BoardStackupSchema);
  }

  /** `UpdateBoardStackup`; returns the stackup as KiCad now holds it. */
  async updateStackup(stackup: MessageInitShape<typeof BoardStackupSchema>): Promise<BoardStackup> {
    const res = await cmd.updateBoardStackup(this.client, { board: this.specifier, stackup: create(BoardStackupSchema, stackup) });
    return res.stackup ?? create(BoardStackupSchema);
  }

  async enabledLayers(): Promise<EnabledLayers> {
    const res = await cmd.getBoardEnabledLayers(this.client, { board: this.specifier });
    return { copperLayerCount: res.copperLayerCount, layers: res.layers };
  }

  async setEnabledLayers(layers: readonly BoardLayer[], copperLayerCount?: number): Promise<EnabledLayers> {
    const res = await cmd.setBoardEnabledLayers(this.client, {
      board: this.specifier,
      layers: [...layers],
      copperLayerCount: copperLayerCount ?? layers.filter((l) => l >= BoardLayer.BL_F_Cu && l <= BoardLayer.BL_B_Cu).length,
    });
    return { copperLayerCount: res.copperLayerCount, layers: res.layers };
  }

  /** User-visible layer name (respects renamed layers). */
  async layerName(layer: BoardLayer): Promise<string> {
    return (await cmd.getBoardLayerName(this.client, { board: this.specifier, layer })).name;
  }

  async layerByName(name: string): Promise<BoardLayer> {
    return (await cmd.getBoardLayerByName(this.client, { board: this.specifier, name })).layer;
  }

  async graphicsDefaults(): Promise<GraphicsDefaults | undefined> {
    return (await cmd.getGraphicsDefaults(this.client, { board: this.specifier })).defaults;
  }

  /**
   * `SetGraphicsDefaults` (Board Setup > Text & Graphics Defaults): replaces the defaults of the
   * layer classes present in `defaults`; classes left out keep theirs. Returns the resulting set.
   */
  async setGraphicsDefaults(defaults: MessageInitShape<typeof GraphicsDefaultsSchema>): Promise<GraphicsDefaults | undefined> {
    const res = await cmd.setGraphicsDefaults(this.client, {
      board: this.specifier,
      defaults: create(GraphicsDefaultsSchema, defaults),
    });
    return res.defaults;
  }

  async designRules(): Promise<{ rules: BoardDesignRules; customRulesStatus: CustomRulesStatus }> {
    const res = await cmd.getBoardDesignRules(this.client, { board: this.specifier });
    return { rules: res.rules ?? create(BoardDesignRulesSchema), customRulesStatus: res.customRulesStatus };
  }

  /** `SetBoardDesignRules`; only the fields present in `rules` change (KiCad merges). Returns the result. */
  async setDesignRules(rules: MessageInitShape<typeof BoardDesignRulesSchema>): Promise<BoardDesignRules> {
    const res = await cmd.setBoardDesignRules(this.client, { board: this.specifier, rules: create(BoardDesignRulesSchema, rules) });
    return res.rules ?? create(BoardDesignRulesSchema);
  }

  /** Structured custom (DRU) rules. */
  async customRules(): Promise<CustomRules> {
    const res = await cmd.getCustomDesignRules(this.client, { board: this.specifier });
    return { status: res.status, rules: res.rules, errorText: res.errorText };
  }

  /** Replaces the custom rules; returns KiCad's parsed result (`status` CRS_INVALID + `errorText` when rejected). */
  async setCustomRules(rules: readonly MessageInitShape<typeof CustomRuleSchema>[]): Promise<CustomRules> {
    const res = await cmd.setCustomDesignRules(this.client, {
      board: this.specifier,
      rules: rules.map((r) => create(CustomRuleSchema, r)),
    });
    return { status: res.status, rules: res.rules, errorText: res.errorText };
  }

  async origin(type: "grid" | "drill" = "grid"): Promise<Vec2> {
    const res = await cmd.getBoardOrigin(this.client, {
      board: this.specifier,
      type: type === "grid" ? BoardOriginType.BOT_GRID : BoardOriginType.BOT_DRILL,
    });
    return vec2(res);
  }

  async setOrigin(type: "grid" | "drill", origin: Vec2): Promise<void> {
    await cmd.setBoardOrigin(this.client, {
      board: this.specifier,
      type: type === "grid" ? BoardOriginType.BOT_GRID : BoardOriginType.BOT_DRILL,
      origin: toVector2(origin),
    });
  }

  async plotSettings(): Promise<BoardPlotSettings> {
    return (await cmd.getBoardPlotSettings(this.client, { board: this.specifier })).plotSettings ?? create(BoardPlotSettingsSchema);
  }

  async setPlotSettings(plotSettings: MessageInitShape<typeof BoardPlotSettingsSchema>): Promise<void> {
    await cmd.setBoardPlotSettings(this.client, { board: this.specifier, plotSettings: create(BoardPlotSettingsSchema, plotSettings) });
  }

  // --- nets & connectivity ---------------------------------------------------------------------------

  /** Board nets, optionally restricted to nets in the given net classes. */
  async nets(netclassFilter: readonly string[] = []): Promise<Net[]> {
    return (await cmd.getNets(this.client, { board: this.specifier, netclassFilter: [...netclassFilter] })).nets;
  }

  async netClassForNets(netNames: readonly string[]): Promise<Map<string, NetClass>> {
    const res = await cmd.getNetClassForNets(this.client, { net: netNames.map((name) => ({ name })) });
    return new Map(Object.entries(res.classes));
  }

  /** Connected items (pads, vias, tracks, arcs, shapes, zones by default) on the given nets. */
  async itemsByNet(netNames: readonly string[], types: readonly KiCadObjectType[] = []): Promise<Item[]> {
    const res = await cmd.getItemsByNet(this.client, {
      header: this.header(),
      types: [...types],
      nets: netNames.map((name) => ({ name })),
    });
    checkItemRequestStatus(res.status, "GetItemsByNet");
    return wrapAll(res.items);
  }

  async itemsByNetClass(netClasses: readonly string[], types: readonly KiCadObjectType[] = []): Promise<Item[]> {
    const res = await cmd.getItemsByNetClass(this.client, { header: this.header(), types: [...types], netClasses: [...netClasses] });
    checkItemRequestStatus(res.status, "GetItemsByNetClass");
    return wrapAll(res.items);
  }

  /** Items physically connected to the given items (through copper), optionally filtered by type. */
  async connectedItems(ids: readonly string[], types: readonly KiCadObjectType[] = []): Promise<Item[]> {
    const res = await cmd.getConnectedItems(this.client, {
      header: this.header(),
      items: ids.map((value) => ({ value })),
      types: [...types],
    });
    checkItemRequestStatus(res.status, "GetConnectedItems");
    return wrapAll(res.items);
  }

  /** Refill the given zones (all zones when empty). */
  async refillZones(zoneIds: readonly string[] = []): Promise<void> {
    await cmd.refillZones(this.client, { board: this.specifier, zones: zoneIds.map((value) => ({ value })) });
  }

  async importNetlist(
    netlistPath: string,
    opts: {
      dryRun?: boolean;
      matchMode?: "uuid" | "reference";
      deleteExtraFootprints?: boolean;
      updateFootprints?: boolean;
      transferGroups?: boolean;
      overrideLocks?: boolean;
    } = {},
  ): Promise<NetlistImportResult> {
    const res = await cmd.importNetlist(this.client, {
      board: this.specifier,
      netlistPath,
      dryRun: opts.dryRun ?? false,
      matchMode: opts.matchMode === "reference" ? NetlistMatchMode.NMM_REFERENCE : NetlistMatchMode.NMM_UUID,
      deleteExtraFootprints: opts.deleteExtraFootprints ?? false,
      updateFootprints: opts.updateFootprints ?? false,
      transferGroups: opts.transferGroups ?? false,
      overrideLocks: opts.overrideLocks ?? false,
    });
    return { errorCount: res.errorCount, warningCount: res.warningCount, newFootprintCount: res.newFootprintCount, report: res.report };
  }

  /**
   * `GetRatsnest`: the unrouted connections the connectivity engine computes, for `nets` or the
   * whole board. `unroutedCount` always counts the whole board, so it can exceed `edges.length`
   * when a net filter is given.
   */
  async ratsnest(nets: readonly string[] = []): Promise<Ratsnest> {
    const res = await cmd.getRatsnest(this.client, {
      board: this.specifier,
      nets: nets.map((name) => create(NetSchema, { name })),
    });
    return {
      unroutedCount: res.unroutedCount,
      edges: res.edges.map((e) => ({
        net: e.net?.name ?? "",
        netCode: e.net?.code?.value ?? 0,
        source: e.source?.value ?? "",
        target: e.target?.value ?? "",
        sourcePosition: vec2(e.sourcePosition),
        targetPosition: vec2(e.targetPosition),
        length: nm(e.length),
      })),
    };
  }

  /** `GetUnroutedCount`: the same figure as `ratsnest()` without serialising the edges. */
  async unroutedCount(): Promise<UnroutedCount> {
    const res = await cmd.getUnroutedCount(this.client, { board: this.specifier });
    return { unroutedCount: res.unroutedCount, unroutedNetCount: res.unroutedNetCount };
  }

  /**
   * `GetNetLengths`: the net inspector's figures (track / via / pad-to-die / unrouted lengths in
   * nanometres, per-layer breakdown, optional propagation delay) for `nets`, or every net with
   * pads when empty.
   */
  async netLengths(nets: readonly string[] = [], opts: { withDelays?: boolean } = {}): Promise<NetLength[]> {
    const res = await cmd.getNetLengths(this.client, {
      board: this.specifier,
      nets: nets.map((name) => create(NetSchema, { name })),
      withDelays: opts.withDelays ?? false,
    });
    return res.lengths;
  }

  /**
   * `UpdateFootprintsFromLibrary` ("Update Footprints from Library", or "Change Footprints" when
   * `newFootprint` names a replacement). `footprintIds` empty updates every footprint. Every
   * reset option defaults to true in KiCad except `resetTransform`; pass false to keep the
   * board's version of that aspect.
   */
  async updateFootprintsFromLibrary(
    footprintIds: readonly string[] = [],
    opts: {
      newFootprint?: LibIdLike;
      onlyChanged?: boolean;
      matchPadPositions?: boolean;
      deleteExtraTexts?: boolean;
      resetTextLayers?: boolean;
      resetTextEffects?: boolean;
      resetTextPositions?: boolean;
      resetTextContent?: boolean;
      resetFabricationAttributes?: boolean;
      resetClearanceOverrides?: boolean;
      reset3dModels?: boolean;
      resetTransform?: boolean;
    } = {},
  ): Promise<FootprintUpdateResult> {
    const res = await cmd.updateFootprintsFromLibrary(this.client, {
      board: this.specifier,
      footprints: footprintIds.map((value) => ({ value })),
      newFootprint: opts.newFootprint ? (toLibraryId(opts.newFootprint) as LibraryIdentifier) : undefined,
      onlyChanged: opts.onlyChanged ?? false,
      matchPadPositions: opts.matchPadPositions ?? false,
      deleteExtraTexts: opts.deleteExtraTexts,
      resetTextLayers: opts.resetTextLayers,
      resetTextEffects: opts.resetTextEffects,
      resetTextPositions: opts.resetTextPositions,
      resetTextContent: opts.resetTextContent,
      resetFabricationAttributes: opts.resetFabricationAttributes,
      resetClearanceOverrides: opts.resetClearanceOverrides,
      reset3dModels: opts.reset3dModels,
      resetTransform: opts.resetTransform ?? false,
    });
    return { updatedCount: res.updatedCount, unchangedCount: res.unchangedCount, missing: res.missing, messages: res.messages };
  }

  /**
   * `SetTeardrops`: enables (`settings` omitted), edits (`settings` given) or disables
   * (`remove()`, i.e. `action: "remove"`) teardrops on the chosen pads, vias and track joints, as
   * the global teardrop dialog does. Returns the number of pads and vias whose settings changed.
   */
  async setTeardrops(
    targets: TeardropTargets = {},
    settings?: MessageInitShape<typeof PadTeardropSettingsSchema>,
    action: "add" | "remove" | "set" = settings ? "set" : "add",
  ): Promise<number> {
    const res = await cmd.setTeardrops(this.client, {
      board: this.specifier,
      action: action === "remove" ? TeardropAction.TDA_REMOVE : action === "set" ? TeardropAction.TDA_SET : TeardropAction.TDA_ADD,
      vias: targets.vias ?? false,
      pthPads: targets.pthPads ?? false,
      smdPads: targets.smdPads ?? false,
      trackToTrack: targets.trackToTrack ?? false,
      items: (targets.items ?? []).map((value) => ({ value })),
      nets: (targets.nets ?? []).map((name) => create(NetSchema, { name })),
      roundShapesOnly: targets.roundShapesOnly ?? false,
      settings: settings ? create(PadTeardropSettingsSchema, settings) : undefined,
    });
    return res.itemCount;
  }

  /** `RemoveTeardrops`: drops every teardrop and disables them on every pad and via. */
  async removeTeardrops(): Promise<number> {
    const res = await cmd.removeTeardrops(this.client, { board: this.specifier });
    return res.itemCount;
  }

  /**
   * `AutoplaceFootprints`: the legacy autoplacer, which places footprints *inside the board
   * outline* (there is no bounding-box parameter in the API — the outline is the box). An empty
   * `footprintIds` places the footprints that are currently outside the outline; with a list,
   * `includeOffboard` adds those too. Answers `APR_NO_BOARD_OUTLINE` when the board has no outline.
   */
  async autoplace(footprintIds: readonly string[] = [], opts: { includeOffboard?: boolean } = {}): Promise<AutoplaceOutcome> {
    const res = await cmd.autoplaceFootprints(this.client, {
      board: this.specifier,
      footprints: footprintIds.map((value) => ({ value })),
      includeOffboard: opts.includeOffboard ?? false,
    });
    return { result: res.result, placedCount: res.placedCount, ok: res.result === AutoplaceResult.APR_COMPLETED };
  }

  /**
   * `GlobalDeletion`: deletes every item of the given types, as the Global Deletions dialog does.
   * Zones on Edge.Cuts and board outline shapes survive unless `boardEdges` is set.
   */
  async globalDeletion(opts: GlobalDeletionOptions): Promise<number> {
    const res = await cmd.globalDeletion(this.client, {
      board: this.specifier,
      types: [...opts.types],
      layers: [...(opts.layers ?? [])],
      locked: opts.locked === "locked" ? LockFilter.LF_LOCKED : opts.locked === "unlocked" ? LockFilter.LF_UNLOCKED : LockFilter.LF_ALL,
      boardEdges: opts.boardEdges ?? false,
      teardrops: opts.teardrops ?? false,
    });
    return res.deletedCount;
  }

  // --- geometry helpers --------------------------------------------------------------------------------

  /** Pad outlines on `layer` as polygons, keyed by pad KIID. */
  async padShapesAsPolygons(padIds: readonly string[], layer: BoardLayer): Promise<Map<string, PolygonWithHoles>> {
    const res = await cmd.getPadShapeAsPolygon(this.client, { board: this.specifier, pads: padIds.map((value) => ({ value })), layer });
    const out = new Map<string, PolygonWithHoles>();
    res.pads.forEach((k, i) => {
      const poly = res.polygons[i];
      if (poly) out.set(k.value, poly);
    });
    return out;
  }

  /** For each (item, layer): whether the pad stack has copper there. Keys are `${id}|${BoardLayer name}`. */
  async padstackPresence(ids: readonly string[], layers: readonly BoardLayer[]): Promise<Map<string, PadstackPresence>> {
    const res = await cmd.checkPadstackPresenceOnLayers(this.client, {
      board: this.specifier,
      items: ids.map((value) => ({ value })),
      layers: [...layers],
    });
    const out = new Map<string, PadstackPresence>();
    for (const e of res.entries) out.set(`${e.item?.value ?? ""}|${BoardLayer[e.layer]}`, e.presence);
    return out;
  }

  /**
   * Flips items to the other side. Outside a commit KiCad pushes "Flipped items via API" itself;
   * inside one, the flip joins the open commit. Returns the flipped canonical items.
   */
  async flip(ids: readonly string[], direction: "leftRight" | "topBottom" = "leftRight", scope?: ItemScope): Promise<Item[]> {
    const res = await cmd.flipItems(this.client, {
      header: this.header(scope),
      items: ids.map((value) => ({ value })),
      direction: direction === "leftRight" ? BoardFlipDirection.BFD_LEFT_RIGHT : BoardFlipDirection.BFD_TOP_BOTTOM,
    });
    checkItemRequestStatus(res.status, "FlipItems");
    const failures: ItemFailure[] = [];
    const items: Item[] = [];
    res.flippedItems.forEach((r, i) => {
      if (r.status?.code === ItemStatusCode.ISC_OK && r.item) {
        items.push(...wrapAll([r.item]));
      } else {
        failures.push({
          id: ids[i] ?? "",
          index: i,
          code: r.status?.code ?? 0,
          codeName: ItemStatusCode[r.status?.code ?? 0] ?? "",
          message: r.status?.errorMessage ?? "",
        });
      }
    });
    if (failures.length) throw new KiCadItemError("FlipItems", failures);
    this.emitChange({ kind: "update", phase: "applied", items, ids: items.map((i) => i.id), scope: scope ?? {}, commitId: "" });
    return items;
  }

  // --- embedded files & DRC -------------------------------------------------------------------------------

  async embeddedFiles(): Promise<EmbeddedFile[]> {
    return (await cmd.getEmbeddedFiles(this.client, { board: this.specifier })).files;
  }

  /**
   * Adds embedded files. Raw `data` is zstd-compressed and base64-encoded for you (KiCad's API
   * expects the on-disk form; see `model/embedded.ts`), unless `encoded` is set.
   */
  async addEmbeddedFiles(files: readonly (EmbeddedFileInput | MessageInitShape<typeof EmbeddedFileSchema>)[]): Promise<void> {
    await cmd.addEmbeddedFiles(this.client, {
      board: this.specifier,
      files: create(EmbeddedFilesSchema, { files: files.map(toEmbeddedFile) }),
    });
  }

  /** Replaces the embedded file set (an empty list clears it). */
  async setEmbeddedFiles(files: readonly (EmbeddedFileInput | MessageInitShape<typeof EmbeddedFileSchema>)[]): Promise<void> {
    await cmd.setEmbeddedFiles(this.client, {
      board: this.specifier,
      files: create(EmbeddedFilesSchema, { files: files.map(toEmbeddedFile) }),
    });
  }

  /** Adds a DRC marker from an external checker; returns the marker's KIID. */
  async injectDrcError(message: string, position: Vec2, opts: { severity?: DrcSeverity; items?: readonly string[] } = {}): Promise<string> {
    const res = await cmd.injectDrcError(this.client, {
      board: this.specifier,
      severity: opts.severity ?? DrcSeverity.DRS_ERROR,
      message,
      position: toVector2(position),
      items: (opts.items ?? []).map((value) => ({ value })),
    });
    return res.marker?.value ?? "";
  }
}
