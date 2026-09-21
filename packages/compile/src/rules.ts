/**
 * `BoardSpec.rules` onto the open project. Two places hold design rules in KiCad and both are
 * set: the board's minimum constraints (`SetBoardDesignRules`, which KiCad merges field by field;
 * `applyBoardConstraints`) and the `Default` net class (`SetNetClasses` in merge mode;
 * `applyDefaultNetClass`) — the net class is what the router and KiCad's own tools read track
 * width, clearance and via sizes from. Fields the spec leaves out keep their values. The two are
 * separate because of the ordering constraint documented on `applyDefaultNetClass`.
 */
import { create } from "@bufbuild/protobuf";
import {
  BoardLayer,
  DocumentSpecifierSchema,
  DocumentType,
  DrillShape,
  MapMergeMode,
  NetClassType,
  PadStackShape,
  PadStackType,
  type NetClass,
} from "@fp-pcb/proto";
import { Project, mm, toDistance, toVector2, type Board, type KiCad } from "@fp-pcb/client";
import type { BoardRules } from "./types";

const dist = (v: number) => toDistance(Math.round(mm(v)));
const square = (v: number) => toVector2({ x: Math.round(mm(v)), y: Math.round(mm(v)) });

export function hasRules(rules: BoardRules | undefined): rules is BoardRules {
  return !!rules && Object.values(rules).some((v) => v !== undefined);
}

/** The `Default` net class as the project holds it. */
export async function defaultNetClass(kicad: KiCad): Promise<NetClass | undefined> {
  const project = new Project(kicad, create(DocumentSpecifierSchema, { type: DocumentType.DOCTYPE_PROJECT }));
  return (await project.netClasses()).find((c) => c.name === "Default");
}

/**
 * The board's minimum constraints (`SetBoardDesignRules`). Safe at any time; the job runs it before
 * the apply so DRC-relevant minimums are in place when footprints land. The current constraints
 * are read first and sent back whole: a `MinimumConstraints` with only some fields set zeroes the
 * others (copper-to-edge clearance included) on the fork.
 */
export async function applyBoardConstraints(board: Board, rules: BoardRules): Promise<string[]> {
  const given = {
    ...(rules.clearanceMm !== undefined ? { minClearance: dist(rules.clearanceMm) } : {}),
    ...(rules.trackWidthMm !== undefined ? { minTrackWidth: dist(rules.trackWidthMm) } : {}),
    ...(rules.viaDiameterMm !== undefined ? { minViaSize: dist(rules.viaDiameterMm) } : {}),
    ...(rules.viaDrillMm !== undefined ? { minThroughDrill: dist(rules.viaDrillMm) } : {}),
  };
  if (!Object.keys(given).length) return [];
  const { rules: current } = await board.designRules();
  const { $typeName: _t, ...constraints } = current.constraints ?? {};
  await board.setDesignRules({ constraints: { ...constraints, ...given } });
  return Object.keys(given).map((k) => `constraint ${k}`);
}

/**
 * The `Default` net class (`SetNetClasses`, merge mode; fields the spec leaves out keep their
 * values). It runs after placing: in the fork at `280274cc3d`, once `SetNetClasses` had run in a
 * session, `AutoplaceFootprints` failed with `basic_string` on every footprint imported afterwards
 * — gap G29 in `docs/04-ipc-gaps.md`. Upstream `895541a847` (2026-09-21 sync) fixed that: the
 * board handler is now told when the project's net settings change. The ordering is kept because
 * it is harmless, and `applyNetlist` still turns a failed autoplace into the `autoplace_failed`
 * warning.
 */
export async function applyDefaultNetClass(kicad: KiCad, rules: BoardRules): Promise<string[]> {
  const lines: string[] = [];
  const project = new Project(kicad, create(DocumentSpecifierSchema, { type: DocumentType.DOCTYPE_PROJECT }));
  const current = (await project.netClasses()).find((c) => c.name === "Default");
  // The message's own fields, minus `$typeName`, so it reads as an init shape again.
  const { $typeName: _t, ...currentBoard } = current?.board ?? {};
  const via = current?.board?.viaStack;
  const viaSize = rules.viaDiameterMm !== undefined ? square(rules.viaDiameterMm) : via?.copperLayers[0]?.size;
  const viaDrill = rules.viaDrillMm !== undefined ? square(rules.viaDrillMm) : via?.drill?.diameter;
  const viaStack =
    rules.viaDiameterMm !== undefined || rules.viaDrillMm !== undefined
      ? {
          type: PadStackType.PST_NORMAL,
          layers: via?.layers.length ? [...via.layers] : [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
          drill: {
            startLayer: via?.drill?.startLayer ?? BoardLayer.BL_F_Cu,
            endLayer: via?.drill?.endLayer ?? BoardLayer.BL_B_Cu,
            shape: via?.drill?.shape ?? DrillShape.DS_CIRCLE,
            ...(viaDrill ? { diameter: viaDrill } : {}),
          },
          copperLayers: [{ layer: BoardLayer.BL_F_Cu, shape: PadStackShape.PSS_CIRCLE, ...(viaSize ? { size: viaSize } : {}) }],
        }
      : via;
  await project.setNetClasses(
    [
      {
        name: "Default",
        type: NetClassType.NCT_EXPLICIT,
        ...(current?.priority !== undefined ? { priority: current.priority } : {}),
        board: {
          ...currentBoard,
          ...(rules.clearanceMm !== undefined ? { clearance: dist(rules.clearanceMm) } : {}),
          ...(rules.trackWidthMm !== undefined ? { trackWidth: dist(rules.trackWidthMm) } : {}),
          ...(viaStack ? { viaStack } : {}),
        },
      },
    ],
    MapMergeMode.MMM_MERGE,
  );
  if (rules.clearanceMm !== undefined) lines.push(`clearance ${rules.clearanceMm} mm`);
  if (rules.trackWidthMm !== undefined) lines.push(`track width ${rules.trackWidthMm} mm`);
  if (rules.viaDiameterMm !== undefined) lines.push(`via diameter ${rules.viaDiameterMm} mm`);
  if (rules.viaDrillMm !== undefined) lines.push(`via drill ${rules.viaDrillMm} mm`);
  return lines;
}

/**
 * The `Default` net class into `<project>.kicad_pro` on disk. `SetNetClasses` changes the class the
 * session holds, but the fork's project save writes `"classes": []` (gap G33), so `kicad-cli pcb drc`
 * and every other file-based reader judge the board at KiCad's stock 0.2 mm. Called after the job's
 * save; only the fields the rules name change, other classes and keys stay. `false` when there is no
 * readable project file.
 */
export async function persistNetClassFile(proPath: string, rules: BoardRules): Promise<boolean> {
  const file = Bun.file(proPath);
  if (!(await file.exists())) return false;
  let pro: Record<string, unknown>;
  try {
    pro = (await file.json()) as Record<string, unknown>;
  } catch {
    return false;
  }
  const settings = (pro["net_settings"] ??= {}) as Record<string, unknown>;
  const classes = (settings["classes"] ??= []) as Array<Record<string, unknown>>;
  let cls = classes.find((c) => c["name"] === "Default");
  if (!cls) {
    cls = { name: "Default", priority: 2147483647 };
    classes.unshift(cls);
  }
  if (rules.clearanceMm !== undefined) cls["clearance"] = rules.clearanceMm;
  if (rules.trackWidthMm !== undefined) cls["track_width"] = rules.trackWidthMm;
  if (rules.viaDiameterMm !== undefined) cls["via_diameter"] = rules.viaDiameterMm;
  if (rules.viaDrillMm !== undefined) cls["via_drill"] = rules.viaDrillMm;
  await Bun.write(proPath, `${JSON.stringify(pro, null, 2)}\n`);
  return true;
}

/** Both halves, for callers with nothing to place afterwards (tests, scripts). */
export async function applyBoardRules(kicad: KiCad, board: Board, rules: BoardRules): Promise<string[]> {
  await applyBoardConstraints(board, rules);
  return applyDefaultNetClass(kicad, rules);
}
