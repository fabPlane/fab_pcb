/**
 * Rule checkers (KiCad >= 11.0): `BoardDrc` wraps `RunBoardJobDrc` / `GetDrcMarkers` /
 * `SetDrcMarkerExcluded` / `Get|SetDrcSeverities`, `SchematicErc` the ERC equivalents. Runs are
 * synchronous on the server and replace the document's markers; marker ids are rebuilt on every
 * run, so re-read them before excluding. Counts (`errorCount`, `warningCount`, ...) are by
 * effective severity — excluded markers count only in `exclusionCount`.
 */
import {
  RuleSeverity,
  type DrcErrorType,
  type DrcMarker,
  type DrcResultsResponse,
  type ErcErrorType,
  type ErcMarker,
  type ErcResultsResponse,
} from "@kicad-web/proto";
import * as cmd from "../commands";
import type { Board } from "./board";
import type { Schematic } from "./schematic";

export interface DrcRunOptions {
  /** Refill all zones before running the check. */
  refillZones?: boolean;
  /** Report every track clearance error instead of only the first per track. */
  reportAllTrackErrors?: boolean;
  /** Schematic parity checks; needs `schematicNetlistPath` or a schematic next to the board. */
  testFootprintsAgainstSchematic?: boolean;
  /** Netlist file to use for the parity checks instead of netlisting the project's schematic. */
  schematicNetlistPath?: string;
}

/** `[ruleType, severity]` pairs; a `Map` works directly. Only error, warning and ignore are accepted by KiCad. */
export type SeveritySettings<T extends number> = Iterable<readonly [T, RuleSeverity]>;

function markerIds(markers: readonly (string | { id?: { value: string } })[]): { value: string }[] {
  return markers.map((m) => ({ value: typeof m === "string" ? m : (m.id?.value ?? "") })).filter((k) => k.value);
}

function toSettings<T extends number>(settings: SeveritySettings<T>): { ruleType: T; severity: RuleSeverity }[] {
  return [...settings].map(([ruleType, severity]) => ({ ruleType, severity }));
}

function toMap<T extends number>(rows: readonly { ruleType: T; severity: RuleSeverity }[]): Map<T, RuleSeverity> {
  return new Map(rows.map((r) => [r.ruleType, r.severity]));
}

/** Markers whose effective severity is error / warning (skips excluded and ignored ones). */
export function activeMarkers<M extends { severity: RuleSeverity; excluded: boolean }>(markers: readonly M[]): M[] {
  return markers.filter((m) => !m.excluded && (m.severity === RuleSeverity.RS_ERROR || m.severity === RuleSeverity.RS_WARNING));
}

export class BoardDrc {
  constructor(readonly board: Board) {}

  /** Runs the design rule checker (like `kicad-cli pcb drc`) and returns every marker with counts. */
  run(opts: DrcRunOptions = {}): Promise<DrcResultsResponse> {
    return cmd.runBoardJobDrc(this.board.client, {
      board: this.board.specifier,
      refillZones: opts.refillZones ?? false,
      reportAllTrackErrors: opts.reportAllTrackErrors ?? false,
      testFootprintsAgainstSchematic: opts.testFootprintsAgainstSchematic ?? false,
      schematicNetlistPath: opts.schematicNetlistPath ?? "",
    });
  }

  /** The markers currently on the board (including excluded ones) without running the checker. */
  markers(): Promise<DrcResultsResponse> {
    return cmd.getDrcMarkers(this.board.client, { board: this.board.specifier });
  }

  /** Sets or clears the exclusion of the given markers (by id or marker); persists with the project. */
  async setExcluded(markers: readonly (string | DrcMarker)[], excluded: boolean, comment = ""): Promise<void> {
    const ids = markerIds(markers);
    if (!ids.length) return;
    await cmd.setDrcMarkerExcluded(this.board.client, { board: this.board.specifier, markers: ids, excluded, comment });
  }

  exclude(markers: readonly (string | DrcMarker)[], comment = ""): Promise<void> {
    return this.setExcluded(markers, true, comment);
  }

  /** Clears an exclusion. */
  include(markers: readonly (string | DrcMarker)[]): Promise<void> {
    return this.setExcluded(markers, false);
  }

  /** Severity of every DRC rule type for the open board. */
  async severities(): Promise<Map<DrcErrorType, RuleSeverity>> {
    return toMap((await cmd.getDrcSeverities(this.board.client, { board: this.board.specifier })).severities);
  }

  /** Sets the severity of the given rule types (others keep theirs); returns the full resulting set. */
  async setSeverities(settings: SeveritySettings<DrcErrorType>): Promise<Map<DrcErrorType, RuleSeverity>> {
    const res = await cmd.setDrcSeverities(this.board.client, { board: this.board.specifier, severities: toSettings(settings) });
    return toMap(res.severities);
  }
}

export class SchematicErc {
  constructor(readonly schematic: Schematic) {}

  /** Runs the electrical rules checker (like `kicad-cli sch erc`) over the whole hierarchy. */
  run(): Promise<ErcResultsResponse> {
    return cmd.runSchematicJobErc(this.schematic.client, { schematic: this.schematic.specifier });
  }

  /** The markers currently in the schematic (including excluded ones) without running the checker. */
  markers(): Promise<ErcResultsResponse> {
    return cmd.getErcMarkers(this.schematic.client, { schematic: this.schematic.specifier });
  }

  async setExcluded(markers: readonly (string | ErcMarker)[], excluded: boolean, comment = ""): Promise<void> {
    const ids = markerIds(markers);
    if (!ids.length) return;
    await cmd.setErcMarkerExcluded(this.schematic.client, { schematic: this.schematic.specifier, markers: ids, excluded, comment });
  }

  exclude(markers: readonly (string | ErcMarker)[], comment = ""): Promise<void> {
    return this.setExcluded(markers, true, comment);
  }

  include(markers: readonly (string | ErcMarker)[]): Promise<void> {
    return this.setExcluded(markers, false);
  }

  async severities(): Promise<Map<ErcErrorType, RuleSeverity>> {
    return toMap((await cmd.getErcSeverities(this.schematic.client, { schematic: this.schematic.specifier })).severities);
  }

  async setSeverities(settings: SeveritySettings<ErcErrorType>): Promise<Map<ErcErrorType, RuleSeverity>> {
    const res = await cmd.setErcSeverities(this.schematic.client, {
      schematic: this.schematic.specifier,
      severities: toSettings(settings),
    });
    return toMap(res.severities);
  }
}
