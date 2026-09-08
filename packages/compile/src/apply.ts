/**
 * `applyNetlist(board, netlist, opts)`: the KiCad half of a compile. Writes the IR out as a
 * `.net` file and hands it to `ImportNetlist` — how eeschema pushes a schematic to a board — so
 * footprint matching, field updates and net assignment are KiCad's code, not ours.
 *
 * The order, each step checked against the fork at 280274cc3d:
 *
 *   1. `ImportNetlist` with `dryRun`. It resolves every footprint against the real `fp-lib-table`,
 *      which `validateNetlist` cannot. Any error stops here and the board is untouched.
 *   2. The outline commit, when the board has none. It must come before placing:
 *      `AutoplaceFootprints` answers `APR_NO_BOARD_OUTLINE` without one — the outline *is* the
 *      placement box; there is no bounding-box parameter.
 *   3. `ImportNetlist` for real. Headless KiCad spreads the new footprints from the origin
 *      (`HEADLESS_PCB_CONTEXT::OnNetlistChanged` → `SpreadFootprints(…, {0,0})`), i.e. inside
 *      the rectangle `outlinePoints` draws.
 *   4. `AutoplaceFootprints` on exactly the footprints step 3 added, with `includeOffboard`. An
 *      empty id list means "offboard only" in the handler, so footprints spread inside the outline
 *      would otherwise never move.
 *
 * KiCad's import report is free text with no severity (`WX_STRING_REPORTER::Report` drops it;
 * the failures read `Cannot add R1 (footprint 'X' not found).`), so outcomes are graded by the
 * response's counts and the text is carried as detail.
 *
 * `netlistPath` is where *we* write; `serverNetlistPath` is what the KiCad server is told to
 * read (absolute, or relative to the open project — the handler resolves it with
 * `PROJECT::AbsolutePath`). They differ only when the server's filesystem is not ours.
 *
 * A compile is three undo entries: the outline, KiCad's own "Update Netlist", and the autoplace.
 * Nothing here saves the document; a job does that, so the library stays free of persistence the
 * way the router's `applyRouteResult` is.
 */
import { create } from "@bufbuild/protobuf";
import { BoardGraphicShapeSchema, BoardLayer, KiCadObjectType } from "@fp-pcb/proto";
import { BoardShape, mm, toVector2, type Board, type Vec2 } from "@fp-pcb/client";
import { emitKicadNetlist, type EmitOptions } from "./netlist";
import { hasErrors, type BoardSpec, type Diagnostic, type MatchMode, type Netlist } from "./types";

export interface ApplyOptions extends EmitOptions {
  /** Where the netlist is written, on our filesystem. */
  netlistPath: string;
  /** Path the KiCad server reads; defaults to `netlistPath`. Project-relative when the server is elsewhere. */
  serverNetlistPath?: string;
  /**
   * How `ImportNetlist` matches components to existing footprints. Default `reference`: a
   * compiled design has no schematic UUIDs, so `uuid` mode would treat every import as a fresh
   * set of components.
   */
  matchMode?: MatchMode;
  /**
   * Remove footprints on the board that the netlist no longer names. Default **true** — the
   * source is the truth here, unlike "update PCB from schematic" where KiCad defaults this off.
   */
  deleteExtraFootprints?: boolean;
  /** Re-pull a footprint from the library when the netlist names a different one. Default **true**, same reasoning. */
  updateFootprints?: boolean;
  /** Board setup to establish before placing. Only the outline is used today. */
  board?: BoardSpec;
  /** Run `AutoplaceFootprints` on the footprints the import added. Off by default in the library; the job turns it on. */
  autoplace?: boolean;
  /** Commit message for the outline commit, shown in KiCad's undo history. */
  message?: string;
}

export interface ApplyOutcome {
  diagnostics: Diagnostic[];
  /** The path the server was given. */
  netlistPath: string;
  /** KiCad's import report, verbatim, for logs. */
  report: string;
  /** Footprints the import created, measured as the id diff around the import (not KiCad's own count). */
  addedFootprintIds: string[];
  footprintsAdded: number;
  footprintsPlaced: number;
}

const diag = (severity: Diagnostic["severity"], message: string, code: string): Diagnostic => ({ severity, stage: "apply", code, message });

/** The outline polygon in nanometres, or `null` when the spec does not describe one. */
export function outlinePoints(spec: BoardSpec | undefined): Vec2[] | null {
  if (!spec) return null;
  if (spec.outline?.length) return spec.outline.map((p) => ({ x: Math.round(mm(p.x)), y: Math.round(mm(p.y)) }));
  const { widthMm: w, heightMm: h } = spec;
  if (!w || !h) return null;
  const [x, y] = [Math.round(mm(w)), Math.round(mm(h))];
  return [
    { x: 0, y: 0 },
    { x, y: 0 },
    { x, y },
    { x: 0, y },
  ];
}

/** True when the board already has any graphic on `Edge.Cuts`. */
export async function hasOutline(board: Board): Promise<boolean> {
  const shapes = await board.getShapes();
  return shapes.some((s) => s.proto.layer === BoardLayer.BL_Edge_Cuts);
}

/** Closed polygon as `Edge.Cuts` segments, one item per side. */
export function outlineItems(points: readonly Vec2[]): BoardShape[] {
  return points.map((start, i) => {
    const end = points[(i + 1) % points.length]!;
    return new BoardShape(
      create(BoardGraphicShapeSchema, {
        layer: BoardLayer.BL_Edge_Cuts,
        shape: { geometry: { case: "segment", value: { start: toVector2(start), end: toVector2(end) } } },
      }),
    );
  });
}

/**
 * Draws the outline when the board has none. A board that already has one is left alone — the
 * author may have shaped it by hand, and a compile should not flatten that.
 */
export async function ensureOutline(board: Board, spec: BoardSpec | undefined, message = "Compile: board outline"): Promise<Diagnostic[]> {
  const points = outlinePoints(spec);
  if (!points) return [];
  if (await hasOutline(board)) return [];
  if (points.length < 3) return [diag("error", `Board outline needs at least 3 points, got ${points.length}.`, "bad_outline")];
  await board.commit(message, (tx) => tx.create(outlineItems(points)));
  return [];
}

/**
 * Grades an `ImportNetlist` response. Only the counts carry severity; the report is one block of
 * detail on a single diagnostic rather than a line each, because its lines cannot be told apart.
 * A clean import yields nothing — "Added footprint R1" is a log line, not a problem.
 */
export function reportDiagnostics(report: string, errorCount: number, warningCount: number): Diagnostic[] {
  const detail = report.trim();
  const withDetail = (head: string) => (detail ? `${head}\n${detail}` : head);
  if (errorCount > 0) return [diag("error", withDetail(`ImportNetlist reported ${errorCount} error(s).`), "import_failed")];
  if (warningCount > 0) return [diag("warning", withDetail(`ImportNetlist reported ${warningCount} warning(s).`), "import_warnings")];
  return [];
}

/** Ids of the footprints on the board right now. */
export async function footprintIds(board: Board): Promise<string[]> {
  return (await board.getItems(KiCadObjectType.KOT_PCB_FOOTPRINT)).map((i) => i.id);
}

export async function applyNetlist(board: Board, netlist: Netlist, opts: ApplyOptions): Promise<ApplyOutcome> {
  const serverPath = opts.serverNetlistPath ?? opts.netlistPath;
  const untouched = (diagnostics: Diagnostic[], report: string): ApplyOutcome => ({
    diagnostics,
    netlistPath: serverPath,
    report,
    addedFootprintIds: [],
    footprintsAdded: 0,
    footprintsPlaced: 0,
  });

  await Bun.write(opts.netlistPath, emitKicadNetlist(netlist, opts.date ? { date: opts.date } : {}));
  const importOptions = {
    matchMode: opts.matchMode ?? "reference",
    deleteExtraFootprints: opts.deleteExtraFootprints ?? true,
    updateFootprints: opts.updateFootprints ?? true,
  } as const;

  // 1. Dry run: the only check that sees the server's library tables.
  const dry = await board.importNetlist(serverPath, { ...importOptions, dryRun: true });
  if (dry.errorCount > 0) return untouched(reportDiagnostics(dry.report, dry.errorCount, dry.warningCount), dry.report);

  // 2. Outline, before anything is placed.
  const diagnostics = await ensureOutline(board, opts.board, opts.message);
  if (hasErrors(diagnostics)) return untouched(diagnostics, dry.report);

  // 3. The import, bracketed by footprint ids so we know what it created.
  const before = new Set(await footprintIds(board));
  const imported = await board.importNetlist(serverPath, importOptions);
  diagnostics.push(...reportDiagnostics(imported.report, imported.errorCount, imported.warningCount));
  const added = (await footprintIds(board)).filter((id) => !before.has(id));

  // 4. Place what was added; an empty list would mean "offboard only" to KiCad.
  let footprintsPlaced = 0;
  if (opts.autoplace && added.length) {
    const outcome = await board.autoplace(added, { includeOffboard: true });
    footprintsPlaced = outcome.placedCount;
    // Every non-completed result comes back as APR_NO_BOARD_OUTLINE, so the wording stays broad.
    if (!outcome.ok)
      diagnostics.push(
        diag("warning", "Autoplace did not complete (KiCad reports no board outline or a placement failure).", "autoplace_failed"),
      );
  }

  return {
    diagnostics,
    netlistPath: serverPath,
    report: imported.report,
    addedFootprintIds: added,
    footprintsAdded: added.length,
    footprintsPlaced,
  };
}
