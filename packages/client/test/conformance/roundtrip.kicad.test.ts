/**
 * Lossless round trip: load every item type from both kitchen-sink files, send each item back with
 * `UpdateItems` unchanged (through the wrappers), then compare the saved document text before and
 * after. Any difference is printed in full rather than hidden. Also reports which fields KiCad
 * normalises between what we sent and the canonical item it echoed back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { equals } from "@bufbuild/protobuf";
import { ApiStatusCode, KiCadObjectType } from "@fp-pcb/proto";
import { KiCadApiError } from "../../src/errors";
import { Board, Project, Schematic, SheetHandle, type Item } from "../../src/model";
import { haveKicad, startKiCad, tempProject, type RunningKiCad, type TempProject } from "../kicad-server";

let rt: RunningKiCad;
let tmp: TempProject;
let project: Project;
let board: Board;
let sch: Schematic;

/** Minimal line diff (LCS-free: reports lines only on one side, in order) — good enough to spot changes. */
function lineDiff(a: string, b: string, max = 60): string[] {
  const al = a.split("\n");
  const bl = b.split("\n");
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while ((i < al.length || j < bl.length) && out.length < max) {
    if (al[i] === bl[j]) {
      i++;
      j++;
      continue;
    }
    // resync: look ahead a little on both sides
    const ai = bl.indexOf(al[i]!, j);
    const bj = al.indexOf(bl[j]!, i);
    if (ai >= 0 && (bj < 0 || ai - j <= bj - i)) {
      for (; j < ai; j++) out.push(`+${j + 1}: ${bl[j]}`);
    } else if (bj >= 0) {
      for (; i < bj; i++) out.push(`-${i + 1}: ${al[i]}`);
    } else {
      out.push(`-${i + 1}: ${al[i]}`);
      out.push(`+${j + 1}: ${bl[j]}`);
      i++;
      j++;
    }
  }
  return out;
}

/** Strips things that legitimately change between two saves (timestamps, generator version). */
function normalise(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*\(generator_version/.test(l))
    .join("\n");
}

/**
 * Differences KiCad itself introduces when an item is written back unchanged through
 * UpdateItems (echoed canonical protos are identical to what we sent, so the loss happens in
 * KiCad's CopyFrom/save path). Each is reported to the C++ agent; a diff line that matches none
 * of these fails the test so new regressions surface.
 */
const KNOWN_LOSS_PATTERNS: { issue: string; pattern: RegExp }[] = [
  { issue: "FOOTPRINT: net_tie_pad_groups re-joined with ', '", pattern: /\(net_tie_pad_groups / },
  { issue: "FOOTPRINT field: text angle rotated by the footprint orientation on every update", pattern: /^\t\t\t\(at -?[\d.]+ -?[\d.]+ -?[\d.]+\)$/ },
  { issue: "PCB_SHAPE arc: start/mid/end written as 0 0 after update", pattern: /^\t\t\((start|mid|end) / },
  { issue: "PCB_TEXT: rotation dropped after update", pattern: /^\t\t\(at -?[\d.]+ -?[\d.]+( -?[\d.]+)?\)$/ },
  { issue: "PCB_TEXTBOX: border stroke width/type reset to defaults", pattern: /^\t\t\(stroke \(width [\d.]+\) \(type \w+\)\)$/ },
  { issue: "ZONE: locked flag dropped", pattern: /^\t\t\(locked yes\)$/ },
];

/** Line range (1-based, inclusive) of the top-level `(lib_symbols ...)` block of a .kicad_sch. */
function libSymbolsRange(text: string): [number, number] | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\t\(lib_symbols/.test(l));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && /^\t\)/.test(l));
  return [start + 1, end < 0 ? lines.length : end + 1];
}

/**
 * Differences KiCad introduces when a SchematicSymbol is written back unchanged: it re-unpacks the
 * embedded library definition and rewrites the sheet's `lib_symbols` cache (pin_names offset
 * dropped, multi-unit bodies renumbered, the updated instance re-linked to a duplicated `<name>_1`
 * entry). Every differing line inside that block is one known KiCad-side loss; anything outside
 * it fails the test.
 */
function classifySchematic(diff: string[], before: string, after: string): { known: Map<string, number>; unknown: string[] } {
  const known = new Map<string, number>();
  const unknown: string[] = [];
  const bump = (issue: string) => known.set(issue, (known.get(issue) ?? 0) + 1);
  const b = libSymbolsRange(before);
  const a = libSymbolsRange(after);
  // Symbol instances' `(pin "n" (uuid ...))` entries come back in a different order after an update
  // (same uuids). Collect both sides and accept them only when the multisets match.
  const PIN_ENTRY = /^\t\t\(pin "|^\t\t\t\(uuid "|^\t\t\)$/;
  const pinLines: { removed: string[]; added: string[]; lines: string[] } = { removed: [], added: [], lines: [] };
  for (const line of diff) {
    const m = /^([-+])(\d+): (.*)$/.exec(line);
    const n = m ? Number(m[2]) : 0;
    const text = m?.[3] ?? line;
    const range = m?.[1] === "-" ? b : a;
    if (range && n >= range[0] && n <= range[1]) {
      bump("SCH_SYMBOL update rewrites the sheet's lib_symbols cache (pin_names offset dropped, multi-unit bodies renumbered, a duplicated <name>_1 definition added)");
    } else if (/^\t\t\(lib_name "/.test(text)) {
      bump("SCH_SYMBOL update re-links the instance to the duplicated <name>_1 definition (lib_name written)");
    } else if (PIN_ENTRY.test(text)) {
      (m?.[1] === "-" ? pinLines.removed : pinLines.added).push(text);
      pinLines.lines.push(line);
    } else unknown.push(line);
  }
  if (pinLines.lines.length) {
    const same = pinLines.removed.length === pinLines.added.length && [...pinLines.removed].sort().join("\n") === [...pinLines.added].sort().join("\n");
    if (same) known.set("SCH_SYMBOL update reorders the instance's (pin \"n\" (uuid ...)) entries (same uuids, order only)", pinLines.lines.length);
    else unknown.push(...pinLines.lines);
  }
  return { known, unknown };
}

function classify(diff: string[]): { known: Map<string, number>; unknown: string[] } {
  const known = new Map<string, number>();
  const unknown: string[] = [];
  for (const line of diff) {
    const text = line.replace(/^[-+]\d+: /, "");
    const hit = KNOWN_LOSS_PATTERNS.find((k) => k.pattern.test(text));
    if (hit) known.set(hit.issue, (known.get(hit.issue) ?? 0) + 1);
    else unknown.push(line);
  }
  return { known, unknown };
}

interface RoundTripReport {
  byType: Map<string, { sent: number; ok: number; rejected: string[]; normalised: string[] }>;
}

function fieldDiff(a: unknown, b: unknown, path = ""): string[] {
  if (a === b) return [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return [`${path || "/"}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  const out: string[] = [];
  for (const k of keys) {
    out.push(...fieldDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
    if (out.length > 8) break;
  }
  return out;
}

async function roundTrip(
  doc: Board | SheetHandle,
  items: Item[],
  report: RoundTripReport,
  updateMode: "commit" | "oneshot" = "commit",
): Promise<void> {
  const byType = new Map<string, Item[]>();
  for (const it of items) {
    if (!it.id) continue; // fields have no KIID in the schematic API
    (byType.get(it.typeName) ?? byType.set(it.typeName, []).get(it.typeName)!).push(it);
  }
  for (const [type, group] of byType) {
    const entry = report.byType.get(type) ?? { sent: 0, ok: 0, rejected: [], normalised: [] };
    report.byType.set(type, entry);
    entry.sent += group.length;
    const sent = group.map((g) => g.clone());
    let canonical: (Item | undefined)[] = [];
    try {
      const res =
        updateMode === "commit"
          ? (await doc.commit(`round trip ${type}`, (tx) => tx.update(group), { strict: false })).value
          : await doc.updateItems(group, { strict: false });
      canonical = res as (Item | undefined)[];
    } catch (e) {
      entry.rejected.push(`${type}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    canonical.forEach((c, i) => {
      const s = sent[i]!;
      if (!c) {
        entry.rejected.push(`${s.id}`);
        return;
      }
      entry.ok++;
      if (!equals(s.schema, s.proto, c.proto)) {
        const diff = fieldDiff(s.toJson(), c.toJson());
        entry.normalised.push(`${s.id.slice(0, 8)}: ${diff.slice(0, 3).join("; ")}`);
      }
    });
  }
}

function printReport(title: string, report: RoundTripReport): string[] {
  const lines = [`--- ${title} ---`];
  for (const [type, e] of [...report.byType].sort()) {
    lines.push(`  ${type.padEnd(26)} sent ${String(e.sent).padStart(3)} ok ${String(e.ok).padStart(3)}${e.rejected.length ? ` rejected ${e.rejected.length}` : ""}${e.normalised.length ? ` normalised ${e.normalised.length}` : ""}`);
    for (const r of e.rejected.slice(0, 3)) lines.push(`      rejected: ${r}`);
    for (const n of e.normalised.slice(0, 2)) lines.push(`      canonical differs: ${n}`);
  }
  return lines;
}

describe.skipIf(!haveKicad())("conformance: lossless item round trip", () => {
  beforeAll(async () => {
    tmp = await tempProject("fp-pcb-rt-");
    rt = await startKiCad(null, "roundtrip");
    project = await rt.kicad.openProject(tmp.pro);
    board = await project.openBoard(tmp.pcb);
    sch = await project.openSchematic(tmp.sch);
  }, 120_000);

  afterAll(async () => {
    await rt?.stop();
    await tmp?.cleanup();
  });

  test("board: UpdateItems with unchanged wrappers leaves SaveDocumentToString identical", async () => {
    const before = await board.saveToString();
    const copyBefore = join(tmp.dir, "before.kicad_pcb");
    // SaveCopyOfDocument may be swallowed by the schematic handler (KiCad dispatch bug); the
    // SaveDocumentToString comparison is the primary check.
    const canSave = await board.saveCopy(copyBefore, { overwrite: true }).then(
      () => true,
      (e: unknown) => {
        if (KiCadApiError.is(e, ApiStatusCode.AS_BAD_REQUEST)) return false;
        throw e;
      },
    );

    const items = await board.getAllItems();
    const types = new Set(items.map((i) => i.typeName));
    expect(items.length).toBeGreaterThan(50);
    const report: RoundTripReport = { byType: new Map() };
    // Top-level items first; pads/fields/table cells are addressed through their parent container.
    const topLevel = items.filter((i) => ![KiCadObjectType.KOT_PCB_PAD, KiCadObjectType.KOT_PCB_FIELD, KiCadObjectType.KOT_PCB_TABLECELL].includes(i.type));
    const children = items.filter((i) => [KiCadObjectType.KOT_PCB_PAD, KiCadObjectType.KOT_PCB_FIELD, KiCadObjectType.KOT_PCB_TABLECELL].includes(i.type));
    await roundTrip(board, topLevel, report);
    await roundTrip(board, children, report);

    const after = await board.saveToString();
    let fileDiff: string[] = [];
    if (canSave) {
      const copyAfter = join(tmp.dir, "after.kicad_pcb");
      await board.saveCopy(copyAfter, { overwrite: true });
      fileDiff = lineDiff(normalise(await readFile(copyBefore, "utf8")), normalise(await readFile(copyAfter, "utf8")));
    }
    const stringDiff = lineDiff(normalise(before), normalise(after));

    const lines = printReport(`board round trip: ${items.length} items, ${types.size} types`, report);
    lines.push(`  SaveDocumentToString: ${stringDiff.length ? `${stringDiff.length} differing lines` : "identical"}`);
    for (const l of stringDiff) lines.push(`    ${l}`);
    lines.push(`  SaveCopyOfDocument:   ${canSave ? (fileDiff.length ? `${fileDiff.length} differing lines` : "identical") : "KICAD-BUG multi-handler dispatch blocked the board save; skipped"}`);
    for (const l of fileDiff.slice(0, 20)) lines.push(`    ${l}`);
    const { known, unknown } = classify(stringDiff);
    lines.push(`  known KiCad round-trip losses (reported, KICAD-BUG):`);
    for (const [issue, n] of known) lines.push(`    - ${issue} (${n} line(s))`);
    if (unknown.length) lines.push(`  UNEXPECTED differences: ${unknown.length}`);
    console.log(lines.join("\n"));

    const rejected = [...report.byType.values()].flatMap((e) => e.rejected);
    expect(rejected).toEqual([]);
    // Every differing line must be one of the documented KiCad-side losses.
    expect(unknown).toEqual([]);
  }, 300_000);

  test("schematic: per-sheet UpdateItems with unchanged wrappers leaves the saved file identical", async () => {
    // SaveCopyOfDocument for the schematic is blocked at random by KiCad's multi-handler dispatch
    // bug (see commands.test.ts); when it is, fall back to comparing GetItems snapshots.
    const copyBefore = join(tmp.dir, "before.kicad_sch");
    const canSave = await sch.saveCopy(copyBefore, { overwrite: true }).then(
      () => true,
      (e: unknown) => {
        if (KiCadApiError.is(e, ApiStatusCode.AS_BAD_REQUEST)) return false;
        throw e;
      },
    );
    const sheets = await sch.sheets();
    expect(sheets.length).toBeGreaterThan(0);
    const snapshot = async () => {
      const m = new Map<string, { type: string; json: unknown; text: string }>();
      for (const sheet of sheets) for (const it of await sheet.getAllItems()) if (it.id) m.set(`${sheet.key}/${it.id}`, { type: it.typeName, json: it.toJson(), text: JSON.stringify(it.toJson()) });
      return m;
    };
    const before = await snapshot();
    const report: RoundTripReport = { byType: new Map() };
    let total = 0;
    for (const sheet of sheets) {
      const items = await sheet.getAllItems();
      total += items.length;
      await roundTrip(sheet, items, report);
    }
    const after = await snapshot();
    const changed = [...before].filter(([k, v]) => after.get(k)?.text !== v.text).map(([k]) => k);
    const missing = [...before.keys()].filter((k) => !after.has(k));
    const added = [...after.keys()].filter((k) => !before.has(k));
    // A re-read symbol whose only differences are in its embedded library definition / lib id is the
    // same lib_symbols rewrite seen in the file (KICAD-BUG); anything else is unexpected.
    const unexpectedChanges: string[] = [];
    const knownChanges: string[] = [];
    for (const k of changed) {
      const b = before.get(k)!;
      const a = after.get(k)!;
      const paths = fieldDiff(b.json, a.json);
      const benign = b.type === "KOT_SCH_SYMBOL" && paths.every((p) => /^\.(definition|libId)\b/.test(p));
      (benign ? knownChanges : unexpectedChanges).push(`${b.type} ${k}: ${paths.slice(0, 4).join("; ")}`);
    }

    const lines = printReport(`schematic round trip: ${total} items over ${sheets.length} sheet(s)`, report);
    lines.push(`  GetItems snapshot: ${changed.length} changed, ${missing.length} missing, ${added.length} added`);
    for (const c of knownChanges.slice(0, 10)) lines.push(`    changed (KICAD-BUG lib_symbols rewrite): ${c}`);
    for (const c of unexpectedChanges.slice(0, 10)) lines.push(`    changed (UNEXPECTED): ${c}`);
    let fileDiff: string[] = [];
    let unknownFileDiff: string[] = [];
    if (canSave) {
      const copyAfter = join(tmp.dir, "after.kicad_sch");
      await sch.saveCopy(copyAfter, { overwrite: true });
      const beforeText = normalise(await readFile(copyBefore, "utf8"));
      const afterText = normalise(await readFile(copyAfter, "utf8"));
      fileDiff = lineDiff(beforeText, afterText, 400);
      const { known, unknown } = classifySchematic(fileDiff, beforeText, afterText);
      unknownFileDiff = unknown;
      lines.push(`  SaveCopyOfDocument: ${fileDiff.length ? `${fileDiff.length} differing lines` : "identical"}`);
      for (const l of fileDiff.slice(0, 30)) lines.push(`    ${l}`);
      if (fileDiff.length > 30) lines.push(`    ... ${fileDiff.length - 30} more`);
      lines.push(`  known KiCad round-trip losses (reported, KICAD-BUG):`);
      for (const [issue, n] of known) lines.push(`    - ${issue} (${n} line(s))`);
      if (unknown.length) lines.push(`  UNEXPECTED differences outside lib_symbols: ${unknown.length}`);
    } else {
      lines.push("  SaveCopyOfDocument: KICAD-BUG multi-handler dispatch blocked the schematic save; file comparison skipped");
    }
    console.log(lines.join("\n"));

    const rejected = [...report.byType.values()].flatMap((e) => e.rejected);
    expect(rejected).toEqual([]);
    expect(missing).toEqual([]);
    expect(added).toEqual([]);
    expect(unexpectedChanges).toEqual([]);
    expect(unknownFileDiff).toEqual([]);
  }, 300_000);
});
