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
} from "./types";
import type { Board } from "@fp-pcb/client";

export type CompileStageName = "frontend" | "validating" | ApplyStage;

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
  diagnostics.push(...validateNetlist(netlist));
  if (hasErrors(diagnostics)) return done(diagnostics, counts, started);

  cancelled();
  await opts.beforeApply?.(built);
  cancelled();
  const applied = await applyNetlist(board, netlist, {
    ...opts,
    ...((opts.board ?? built.board) ? { board: opts.board ?? built.board } : {}),
  });
  diagnostics.push(...applied.diagnostics);

  return done(
    diagnostics,
    {
      ...counts,
      footprintsAdded: applied.footprintsAdded,
      footprintsPlaced: applied.footprintsPlaced,
      viasAdded: applied.viasAdded,
      holesAdded: applied.holesAdded,
    },
    started,
    applied.netlistPath,
  );
}
