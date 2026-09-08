/**
 * The compile contract: a **design source** becomes a **KiCad project**.
 *
 * Two stages, deliberately split so they can move independently:
 *
 *   source --[Frontend]--> Netlist --[emit + apply]--> KiCad board
 *
 * The `Frontend` is the half that changes. Whatever the author writes — a netlist by hand, an
 * agent-generated one, a higher-level DSL — becomes a `Netlist`. The half to the right of the
 * arrow is stable: it serialises the IR to KiCad's own `.net` format and hands it to
 * `ImportNetlist`, which is how eeschema updates a board. Nothing downstream knows what the
 * frontend was.
 *
 * `Netlist` deliberately carries no geometry. A netlist says what exists and what connects to
 * what; where things sit on the board is KiCad's job (`AutoplaceFootprints`) or the author's.
 * Board *outline* is the exception — the autoplacer needs one — so it rides along in `BoardSpec`.
 *
 * Lengths in `BoardSpec` are millimetres (this is authoring input, written by humans and agents).
 * Everything past `apply.ts` is nanometres, the client's convention.
 */

/** Where a diagnostic came from, so a UI can group them and a tool can decide what to retry. */
export type CompileStage = "frontend" | "netlist" | "apply";

/**
 * One problem, placed in the source when the frontend knows where. Shaped for an editor squiggle
 * and for the fix-and-retry loop an agent runs: `file`/`line`/`column` are what make a diagnostic
 * actionable rather than merely true.
 */
export interface Diagnostic {
  severity: "error" | "warning";
  stage: CompileStage;
  message: string;
  /** Stable identifier for the rule, e.g. `missing_footprint`. Free-form per frontend. */
  code?: string;
  /** Project-relative posix path. */
  file?: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
}

/** A component instance. One `comp` entry in the emitted netlist. */
export interface NetlistComponent {
  /**
   * Reference designator (`R1`). Required: `ImportNetlist` in `reference` match mode keys on it,
   * and KiCad will not invent one. Frontends that allow unannotated designs must annotate before
   * emitting (see `validateNetlist`).
   */
  ref: string;
  value: string;
  /** KiCad footprint library id, `Resistor_SMD:R_0402_1005Metric`. Empty means "no footprint yet". */
  footprint: string;
  /** Symbol the component came from. The board ignores it; ERC and the BOM want it. */
  libSource?: { lib: string; part: string; description?: string };
  /** Extra fields (MPN, datasheet, tolerance) copied onto the footprint on import. */
  fields?: Record<string, string>;
  /** Stable id for `uuid` match mode. Frontends without stable ids should use `reference` mode. */
  uuid?: string;
}

/** One pin of one component, as a member of a net. */
export interface NetlistNode {
  ref: string;
  /** Pad/pin number as a string — `2`, `A1`, `GND` all occur. */
  pin: string;
  pinFunction?: string;
  pinType?: string;
}

export interface NetlistNet {
  name: string;
  /**
   * KiCad net code. Optional: `emitKicadNetlist` numbers unset codes from 1 in array order, which
   * is all `ImportNetlist` needs (it matches nets by name).
   */
  code?: number;
  nodes: NetlistNode[];
}

/** Provenance written into the netlist's `(design)` block; shows up in KiCad's dialogs. */
export interface NetlistDesign {
  source?: string;
  date?: string;
  tool?: string;
}

/** The intermediate representation: what exists, and what connects to what. */
export interface Netlist {
  components: NetlistComponent[];
  nets: NetlistNet[];
  design?: NetlistDesign;
}

/**
 * Board setup a netlist cannot express. Only the outline is load-bearing today:
 * `AutoplaceFootprints` answers `APR_NO_BOARD_OUTLINE` without one.
 */
export interface BoardSpec {
  /** Closed polygon in mm. Takes precedence over `widthMm`/`heightMm`. */
  outline?: { x: number; y: number }[];
  /** Rectangular outline in mm, top-left at the origin. */
  widthMm?: number;
  heightMm?: number;
  /** Copper layer count, when the frontend has an opinion. */
  copperLayers?: number;
  /** Design rules to establish on the board (minimum constraints and the `Default` net class). */
  rules?: BoardRules;
  /**
   * Vias a prefabricated blank already has (Opulo's Viagrid, say). Drawn with the outline as free
   * vias on no net; a router may claim them (`RouteOptions.preset: "laser-prefab"`) instead of
   * drilling its own. Same frame as the outline, mm.
   */
  vias?: PrefabVia[];
  /** Holes through the blank (mounting holes), drawn as circles on `Edge.Cuts` so DRC keeps copper clear of them. */
  holes?: PrefabHole[];
}

/** Rules in mm. Only the fields given change; the rest keep KiCad's project defaults. */
export interface BoardRules {
  clearanceMm?: number;
  trackWidthMm?: number;
  viaDiameterMm?: number;
  viaDrillMm?: number;
}

export interface PrefabVia {
  x: number;
  y: number;
  /** Annular pad diameter; default the `Default` net class via size. */
  diameterMm?: number;
  drillMm?: number;
}

export interface PrefabHole {
  x: number;
  y: number;
  diameterMm: number;
}

/** The project's source files, as the frontend sees them. */
export interface CompileSource {
  /** Which frontend understands these files, e.g. `netlist`. */
  kind: string;
  /** Project-relative posix path -> contents. */
  files: Record<string, string>;
  /** Key into `files` to start from. */
  entrypoint: string;
}

export interface FrontendOptions {
  signal?: AbortSignal;
}

/**
 * A library the netlist's footprints or symbols resolve against. Headless servers ship no
 * libraries, so a frontend that generates footprints (a project-local `.pretty`) must also say
 * where it put them; the apply side turns each into a project `fp-lib-table` / `sym-lib-table`
 * row before `ImportNetlist` runs. Not consumed by `applyNetlist` yet (see README).
 */
export interface LibrarySpec {
  kind: "footprint" | "symbol";
  /** The nickname the netlist uses before the colon, `fabdesk` in `fabdesk:R_0402`. */
  nickname: string;
  /** Path or `${KIPRJMOD}`-relative URI, as KiCad's library tables take it. */
  uri: string;
  description?: string;
}

export interface FrontendResult {
  /** `null` when the frontend failed; `diagnostics` then carries at least one error. */
  netlist: Netlist | null;
  board?: BoardSpec;
  libraries?: LibrarySpec[];
  diagnostics: Diagnostic[];
}

/**
 * Turns source into a `Netlist`. Implementations live in `src/frontends/`; a frontend must not
 * touch KiCad — it is a pure source-to-IR function so it can be unit-tested without a server.
 */
export interface Frontend {
  readonly kind: string;
  build(source: CompileSource, opts?: FrontendOptions): Promise<FrontendResult>;
}

/** How `ImportNetlist` matches incoming components to footprints already on the board. */
export type MatchMode = "reference" | "uuid";

export interface CompileCounts {
  components: number;
  nets: number;
  /** Footprints `ImportNetlist` added to the board. */
  footprintsAdded: number;
  /** Footprints the autoplacer moved; `0` when `autoplace` is off. */
  footprintsPlaced: number;
  /** Free vias drawn for a prefabricated blank (`BoardSpec.vias`), with the outline. */
  viasAdded: number;
  /** Cutouts drawn for `BoardSpec.holes`. */
  holesAdded: number;
}

export interface CompileResult {
  /** True when no diagnostic has severity `error`. */
  ok: boolean;
  diagnostics: Diagnostic[];
  counts: CompileCounts;
  /** Where the generated netlist was written, when it got that far. */
  netlistPath?: string;
  durationMs: number;
}

/** Convenience: the errors only, in stage order. */
export function errorsOf(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === "error");
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
