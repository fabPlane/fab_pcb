/**
 * `compile(source, board, opts)`: frontend -> validate -> apply, in that order.
 *
 * The ordering is the contract. Nothing touches the board until the netlist is known to be good
 * — structurally here, and against the server's library tables by the dry run inside
 * `applyNetlist` — so a compile that fails leaves the board exactly as it was; an author fixing
 * errors never has to undo a half-applied import first.
 */
import { applyNetlist, type ApplyOptions, type ApplyStage } from "./apply";
import { validateNetlist } from "./netlist";
import {
  hasErrors,
  type CompileCounts,
  type CompileResult,
  type CompileSource,
  type Diagnostic,
  type Frontend,
  type FrontendResult,
  type BoardSpec,
  type Netlist,
} from "./types";
import type { Board } from "@fp-pcb/client";

export type CompileStageName = "frontend" | "validating" | ApplyStage | "schematic";

export interface CompileOptions extends ApplyOptions {
  /** Turns `source` into a netlist. See `Frontend` in `types.ts`. */
  frontend: Frontend;
  /** Called as each stage starts; the bridge job turns these into its states. */
  onStage?: (stage: CompileStageName) => void;
  /**
   * Runs after the frontend succeeded and before anything touches the board — where a caller
   * registers the frontend's libraries so the dry run can resolve them.
   */
  beforeApply?: (built: FrontendResult) => Promise<void>;
  /** Runs after a successful board import; the bridge uses it to rebuild generated schematic items. */
  afterApply?: (built: FrontendResult) => Promise<Diagnostic[]>;
}

/** Thrown when `signal` aborts between stages; `CompileCancelled.is(e)` for callers that rethrow. */
export class CompileCancelled extends Error {
  constructor() {
    super("compile cancelled");
    this.name = "CompileCancelled";
  }
  static is(e: unknown): e is CompileCancelled {
    return e instanceof CompileCancelled || (e instanceof Error && e.name === "CompileCancelled");
  }
}

const ZERO: CompileCounts = { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0, viasAdded: 0, holesAdded: 0 };

function done(diagnostics: Diagnostic[], counts: CompileCounts, started: number, netlistPath?: string): CompileResult {
  return {
    ok: !hasErrors(diagnostics),
    diagnostics,
    counts,
    ...(netlistPath ? { netlistPath } : {}),
    durationMs: Math.round(performance.now() - started),
  };
}

/** Validate optional author placement even when `BoardSpec` came from a bridge override. */
export function validatePlacements(netlist: Netlist, board: BoardSpec | undefined): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const refs = new Set(netlist.components.map((component) => component.ref));
  const seen = new Set<string>();
  for (const [index, placement] of (board?.placements ?? []).entries()) {
    const prefix = `/board/placements/${index}`;
    if (!placement || typeof placement !== "object" || typeof placement.ref !== "string") {
      diagnostics.push({ severity: "error", stage: "netlist", code: "bad_placement", message: `${prefix}: ref must be a string.` });
      continue;
    }
    const position = placement.position;
    if (
      !position ||
      typeof position !== "object" ||
      typeof position.x !== "number" ||
      !Number.isFinite(position.x) ||
      typeof position.y !== "number" ||
      !Number.isFinite(position.y)
    ) {
      diagnostics.push({
        severity: "error",
        stage: "netlist",
        code: "bad_placement_position",
        message: `${prefix}/position: x and y must be finite numbers in millimetres.`,
      });
    }
    if (!refs.has(placement.ref)) {
      diagnostics.push({
        severity: "error",
        stage: "netlist",
        code: "unknown_placement_reference",
        message: `${prefix}/ref: unknown component reference ${JSON.stringify(placement.ref)}.`,
      });
    }
    if (seen.has(placement.ref)) {
      diagnostics.push({
        severity: "error",
        stage: "netlist",
        code: "duplicate_placement_reference",
        message: `${prefix}/ref: ${JSON.stringify(placement.ref)} is placed more than once.`,
      });
    }
    seen.add(placement.ref);
  }
  return diagnostics;
}

export async function compile(source: CompileSource, board: Board, opts: CompileOptions): Promise<CompileResult> {
  const started = performance.now();
  const diagnostics: Diagnostic[] = [];
  const cancelled = () => {
    if (opts.signal?.aborted) throw new CompileCancelled();
  };
  cancelled();

  if (opts.frontend.kind !== source.kind) {
    diagnostics.push({
      severity: "error",
      stage: "frontend",
      code: "frontend_mismatch",
      message: `Source is ${JSON.stringify(source.kind)} but the frontend handles ${JSON.stringify(opts.frontend.kind)}.`,
    });
    return done(diagnostics, ZERO, started);
  }

  opts.onStage?.("frontend");
  const built = await opts.frontend.build(source, opts.signal ? { signal: opts.signal } : {});
  diagnostics.push(...built.diagnostics);
  if (!built.netlist || hasErrors(diagnostics)) return done(diagnostics, ZERO, started);

  const netlist = built.netlist;
  const counts: CompileCounts = { ...ZERO, components: netlist.components.length, nets: netlist.nets.length };

  opts.onStage?.("validating");
  const boardSpec = opts.board ?? built.board;
  diagnostics.push(...validateNetlist(netlist), ...validatePlacements(netlist, boardSpec));
  if (hasErrors(diagnostics)) return done(diagnostics, counts, started);

  cancelled();
  await opts.beforeApply?.(built);
  cancelled();
  const applied = await applyNetlist(board, netlist, {
    ...opts,
    ...(boardSpec ? { board: boardSpec } : {}),
  });
  diagnostics.push(...applied.diagnostics);
  if (!hasErrors(diagnostics) && opts.afterApply) {
    cancelled();
    opts.onStage?.("schematic");
    diagnostics.push(...(await opts.afterApply(built)));
  }

  return done(
    diagnostics,
    { ...counts, footprintsAdded: applied.footprintsAdded, footprintsPlaced: applied.footprintsPlaced, viasAdded: applied.viasAdded, holesAdded: applied.holesAdded },
    started,
    applied.netlistPath,
  );
}
