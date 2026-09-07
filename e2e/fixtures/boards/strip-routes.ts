#!/usr/bin/env bun
/**
 * Makes the "placed but unrouted" variant of a board: `<name>.unrouted.kicad_pcb` next to
 * `<name>.kicad_pcb`, with every top-level `(segment …)`, `(arc …)` (track arcs) and `(via …)`
 * removed and every zone's `(filled_polygon …)` / `(fill_segments …)` dropped while its outline
 * and fill settings stay, so `RefillZones` can fill it again. Nothing else is touched: the
 * writer slices the original text (no re-serialisation), so the output is byte-deterministic
 * and diffs against the source stay readable. The matching `<name>.kicad_pro` is copied to
 * `<name>.unrouted.kicad_pro` so the variant opens with the same design rules and net classes.
 *
 *   bun e2e/fixtures/boards/strip-routes.ts            # every <dir>/<name>.kicad_pcb under this directory
 *   bun e2e/fixtures/boards/strip-routes.ts a.kicad_pcb # one board
 *   bun e2e/fixtures/boards/strip-routes.ts --check     # exit 1 when a variant is stale
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface Node {
  head: string;
  start: number;
  end: number; // exclusive
  depth: number;
  children: Node[];
}

/** Parses the s-expression into a tree of byte ranges (quoted strings are respected). */
export function parse(text: string): Node {
  const root: Node = { head: "<root>", start: 0, end: text.length, depth: -1, children: [] };
  const stack: Node[] = [root];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "(") {
      let j = i + 1;
      while (j < text.length && !/[\s()"]/.test(text[j]!)) j++;
      const node: Node = { head: text.slice(i + 1, j), start: i, end: -1, depth: stack.length - 1, children: [] };
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
      i = j;
      continue;
    }
    if (c === ")") {
      const node = stack.pop();
      if (!node || node === root) throw new Error(`unbalanced ')' at ${i}`);
      node.end = i + 1;
      i++;
      continue;
    }
    i++;
  }
  if (stack.length !== 1) throw new Error(`unbalanced '(' (${stack.length - 1} open at end of file)`);
  return root;
}

const TOP_LEVEL = new Set(["segment", "arc", "via"]);
const ZONE_FILL = new Set(["filled_polygon", "fill_segments"]);

export interface StripResult {
  text: string;
  removed: Record<string, number>;
}

/** Removes the routing from a `.kicad_pcb` text; see the file header. */
export function stripRoutes(text: string): StripResult {
  const root = parse(text);
  const pcb = root.children.find((n) => n.head === "kicad_pcb");
  if (!pcb) throw new Error("not a kicad_pcb file");
  const cut: Node[] = [];
  const removed: Record<string, number> = {};
  for (const n of pcb.children) {
    if (TOP_LEVEL.has(n.head)) cut.push(n);
    else if (n.head === "zone") for (const z of n.children) if (ZONE_FILL.has(z.head)) cut.push(z);
  }
  cut.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const n of cut) {
    removed[n.head] = (removed[n.head] ?? 0) + 1;
    // take the node's leading whitespace (the line break + indent before it) with it
    let from = n.start;
    while (from > pos && /[ \t]/.test(text[from - 1]!)) from--;
    if (from > pos && text[from - 1] === "\n") from--;
    out += text.slice(pos, from);
    pos = n.end;
  }
  out += text.slice(pos);
  return { text: out, removed };
}

function variantPath(pcb: string): string {
  return join(dirname(pcb), basename(pcb, ".kicad_pcb") + ".unrouted.kicad_pcb");
}

function findBoards(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...findBoards(p));
    else if (e.endsWith(".kicad_pcb") && !e.endsWith(".unrouted.kicad_pcb")) out.push(p);
  }
  return out.sort();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const files = args.filter((a) => !a.startsWith("--"));
  const boards = files.length ? files : findBoards(import.meta.dir);
  let stale = 0;
  for (const pcb of boards) {
    const { text, removed } = stripRoutes(readFileSync(pcb, "utf8"));
    const target = variantPath(pcb);
    const pro = pcb.replace(/\.kicad_pcb$/, ".kicad_pro");
    const proTarget = target.replace(/\.kicad_pcb$/, ".kicad_pro");
    const summary = Object.entries(removed)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    if (check) {
      const same = existsSync(target) && readFileSync(target, "utf8") === text;
      if (!same) stale++;
      console.log(`${same ? "ok   " : "STALE"} ${target}`);
      continue;
    }
    writeFileSync(target, text);
    if (existsSync(pro)) copyFileSync(pro, proTarget);
    console.log(`${basename(target)}: removed ${summary || "nothing"}`);
  }
  if (stale) process.exit(1);
}
