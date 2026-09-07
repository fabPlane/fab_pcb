/**
 * A Specctra DSN writer fed from `RouteInput` — the fallback for servers without
 * `RunBoardJobExportSpecctra`. It follows the layout of KiCad's own exporter
 * (`pcbnew/specctra_import_export/specctra_export.cpp`): µm with `(resolution um 10)`, y negated
 * (Specctra is y-up), layers by their user names, KiCad-style padstack and via names.
 *
 * Simplifications versus KiCad's exporter, all deliberate:
 * - every pad is its own one-pin component (`<ref>-<pad>`), so footprint rotation and flipping
 *   never have to be undone; the session that comes back is applied by `parseSes()` +
 *   `applyRouteResult()`, not by KiCad's importer (which matches by reference and pad number);
 * - pad shapes: circle, rect, oval (as a Specctra `path` with round ends) and rounded/chamfered
 *   rects as plain rects; custom pads become their bounding rect;
 * - copper text and graphics are exported as keepouts (KiCad's exporter drops them);
 * - copper zones become `plane`s (like KiCad), rule areas become `keepout`s.
 */
import { BoardLayer } from "@fp-pcb/proto";
import type { Vec2 } from "@fp-pcb/client";
import { copperLayersInOrder, rulesForNet } from "../extract";
import type { RouteInput, RouteLayer, RouteOptions, RoutePad } from "../types";
import { num, quote } from "./sexpr";

/** nm -> µm, the DSN unit. */
export const um = (nm: number): string => num(Math.round(nm / 100) / 10);
/** A point in DSN coordinates (µm, y up). */
export const pt = (v: Vec2): string => `${um(v.x)} ${um(-v.y)}`;

export function viaPadstackName(diameter: number, drill: number, layerCount: number): string {
  return `Via[0-${layerCount - 1}]_${Math.round(diameter / 1000)}:${Math.round(drill / 1000)}_um`;
}

function padstackName(pad: RoutePad, front: boolean, back: boolean): string {
  const side = front && back ? "A" : front ? "T" : "B";
  const w = Math.round(pad.size.x / 1000);
  const h = Math.round(pad.size.y / 1000);
  switch (pad.shape) {
    case "circle":
      return `Round[${side}]Pad_${w}_um`;
    case "oval":
      return `Oval[${side}]Pad_${w}x${h}_um`;
    case "roundrect":
      return `RoundRect[${side}]Pad_${w}x${h}_um`;
    case "chamferedrect":
      return `ChamferedRect[${side}]Pad_${w}x${h}_um`;
    default:
      return `Rect[${side}]Pad_${w}x${h}_um`;
  }
}

/** The `(shape ...)` lines of a pad stack on one layer, pad centred on the origin. */
function padShapes(pad: RoutePad, layer: string): string {
  const w = pad.size.x;
  const h = pad.size.y;
  switch (pad.shape) {
    case "circle":
      return `(shape (circle ${layer} ${um(Math.max(w, h))}))`;
    case "oval": {
      if (Math.abs(w - h) < 1000) return `(shape (circle ${layer} ${um(w)}))`;
      // A path with round ends: aperture = the smaller side, from one focus to the other.
      const d = Math.min(w, h);
      const half = (Math.max(w, h) - d) / 2;
      const a = w > h ? `${um(-half)} 0 ${um(half)} 0` : `0 ${um(-half)} 0 ${um(half)}`;
      return `(shape (path ${layer} ${um(d)} ${a}))`;
    }
    default:
      return `(shape (rect ${layer} ${um(-w / 2)} ${um(-h / 2)} ${um(w / 2)} ${um(h / 2)}))`;
  }
}

export interface DsnOptions {
  /** Design name written into the file. Default: the board file name. */
  name?: string;
  /** Copper layers to publish (default: every layer of the input). */
  layers?: BoardLayer[];
}

/** Writes the DSN. Pure; unit-tested on hand-written inputs. */
export function writeDsn(input: RouteInput, opts: DsnOptions = {}): string {
  const layerIds = copperLayersInOrder(opts.layers ?? input.copperLayers.map((l) => l.id));
  const layers: RouteLayer[] = layerIds.map(
    (id) =>
      input.copperLayers.find((l) => l.id === id) ?? {
        id,
        name: BoardLayer[id] ?? String(id),
        userName: BoardLayer[id] ?? String(id),
        index: 0,
      },
  );
  const layerName = new Map(layers.map((l) => [l.id, l.userName]));
  const lname = (id: BoardLayer) => layerName.get(id);
  const rules = input.rules.default;
  const out: string[] = [];
  const name = opts.name ?? input.boardName ?? "board";

  out.push(`(pcb ${quote(name)}`);
  out.push(`  (parser`);
  out.push(`    (string_quote ")`);
  out.push(`    (space_in_quoted_tokens on)`);
  // Freerouting keys compatibility quirks on the host name/version; we write KiCad-shaped files.
  out.push(`    (host_cad "KiCad's Pcbnew")`);
  out.push(`    (host_version "9.0.0")`);
  out.push(`  )`);
  out.push(`  (resolution um 10)`);
  out.push(`  (unit um)`);

  // --- structure ---------------------------------------------------------------------------------
  out.push(`  (structure`);
  layers.forEach((l, i) => out.push(`    (layer ${quote(l.userName)} (type signal) (property (index ${i})))`));
  if (input.outline.length) {
    const outer = input.outline[0]!;
    out.push(`    (boundary (path pcb 0 ${outer.map(pt).join(" ")}))`);
  } else {
    const b = input.bounds;
    out.push(`    (boundary (rect pcb ${um(b.x)} ${um(-(b.y + b.h))} ${um(b.x + b.w)} ${um(-b.y)}))`);
  }
  for (const z of input.zones) {
    if (!z.net) continue;
    for (const l of z.layers) {
      const ln = lname(l);
      if (ln) out.push(`    (plane ${quote(z.net)} (polygon ${quote(ln)} 0 ${z.polygon.map(pt).join(" ")}))`);
    }
  }
  for (const k of input.keepouts) {
    if (!k.tracks && !k.copper && !k.vias) continue;
    const kind = k.copper || (k.tracks && k.vias) ? "keepout" : k.tracks ? "wire_keepout" : "via_keepout";
    const ls = k.layers.length ? k.layers : layerIds;
    for (const l of ls) {
      const ln = lname(l);
      if (ln) out.push(`    (${kind} ${quote(k.name || k.id)} (polygon ${quote(ln)} 0 ${k.polygon.map(pt).join(" ")}))`);
    }
  }
  for (const g of input.obstacles) {
    for (const l of g.layers) {
      const ln = lname(l);
      if (!ln) continue;
      const b = g.bounds;
      out.push(
        `    (keepout ${quote(`${g.kind}-${g.id}`)} (rect ${quote(ln)} ${um(b.x)} ${um(-(b.y + b.h))} ${um(b.x + b.w)} ${um(-b.y)}))`,
      );
    }
  }
  // Via padstacks: one per distinct (diameter, drill) among the net classes.
  const viaNames = new Map<string, { diameter: number; drill: number }>();
  const viaFor = (d: number, drill: number) => {
    const n = viaPadstackName(d, drill, layers.length);
    viaNames.set(n, { diameter: d, drill });
    return n;
  };
  const defaultVia = viaFor(rules.viaDiameter, rules.viaDrill);
  for (const r of input.rules.perNet.values()) viaFor(r.viaDiameter, r.viaDrill);
  out.push(`    (via ${[...viaNames.keys()].map(quote).join(" ")})`);
  out.push(
    `    (rule (width ${um(rules.trackWidth)}) (clearance ${um(rules.clearance)}) (clearance ${um(rules.clearance)} (type default_smd)) (clearance ${um(Math.min(rules.clearance, 100_000))} (type smd_smd)))`,
  );
  out.push(`  )`);

  // --- placement & library: one component per pad ------------------------------------------
  const pads = input.pads.filter((p) => p.layers.some((l) => layerName.has(l)) && p.size.x > 0 && p.size.y > 0);
  // No '-' in component names: Specctra pin references are `<component>-<pin>` and Freerouting
  // splits them at the first hyphen.
  const compName = (p: RoutePad) => `${p.footprint || "PAD"}_${p.number || p.id.slice(0, 8)}`.replace(/-/g, "_");
  const seen = new Map<string, number>();
  const compOf = new Map<string, string>();
  for (const p of pads) {
    let n = compName(p);
    const k = seen.get(n) ?? 0;
    seen.set(n, k + 1);
    if (k) n = `${n}_${k}`;
    compOf.set(p.id, n);
  }
  const imageOf = (p: RoutePad) => {
    const front = p.layers.includes(layerIds[0]!);
    const back = p.layers.includes(layerIds[layerIds.length - 1]!);
    return padstackName(p, front, back) + (p.rotation ? `_r${Math.round(p.rotation * 100) / 100}` : "");
  };
  const images = new Map<string, RoutePad>();
  for (const p of pads) if (!images.has(imageOf(p))) images.set(imageOf(p), p);

  out.push(`  (placement`);
  for (const p of pads) {
    // Custom pads carry their real bounding box; place the (rect) image at its centre.
    const at = p.bounds ? { x: p.bounds.x + p.bounds.w / 2, y: p.bounds.y + p.bounds.h / 2 } : p.position;
    out.push(`    (component ${quote(imageOf(p))} (place ${quote(compOf.get(p.id)!)} ${pt(at)} front 0))`);
  }
  out.push(`  )`);

  out.push(`  (library`);
  for (const [img, p] of images) {
    const stack = padstackName(p, p.layers.includes(layerIds[0]!), p.layers.includes(layerIds[layerIds.length - 1]!));
    const rot = p.rotation ? ` (rotate ${num(Math.round(p.rotation * 100) / 100)})` : "";
    out.push(`    (image ${quote(img)} (pin ${quote(stack)}${rot} 1 0 0))`);
  }
  const stacks = new Map<string, RoutePad>();
  for (const p of pads) stacks.set(padstackName(p, p.layers.includes(layerIds[0]!), p.layers.includes(layerIds[layerIds.length - 1]!)), p);
  for (const [sname, p] of stacks) {
    const shapes = p.layers
      .map(lname)
      .filter((l): l is string => !!l)
      .map((l) => padShapes(p, quote(l)));
    out.push(`    (padstack ${quote(sname)} ${shapes.join(" ")} (attach off))`);
  }
  for (const [vname, v] of viaNames) {
    const shapes = layers.map((l) => `(shape (circle ${quote(l.userName)} ${um(v.diameter)}))`);
    out.push(`    (padstack ${quote(vname)} ${shapes.join(" ")} (attach off))`);
  }
  out.push(`  )`);

  // --- network -----------------------------------------------------------------------------------
  const pinsByNet = new Map<string, string[]>();
  for (const p of pads) {
    if (!p.net) continue;
    let list = pinsByNet.get(p.net);
    if (!list) pinsByNet.set(p.net, (list = []));
    list.push(`${compOf.get(p.id)!}-1`);
  }
  out.push(`  (network`);
  for (const [net, pins] of pinsByNet) out.push(`    (net ${quote(net)} (pins ${pins.map(quote).join(" ")}))`);
  const byClass = new Map<string, { nets: string[]; rules: ReturnType<typeof rulesForNet> }>();
  for (const net of pinsByNet.keys()) {
    const r = rulesForNet(input, net);
    let c = byClass.get(r.netClass);
    if (!c) byClass.set(r.netClass, (c = { nets: [], rules: r }));
    c.nets.push(net);
  }
  for (const [cls, c] of byClass) {
    const via = viaFor(c.rules.viaDiameter, c.rules.viaDrill) || defaultVia;
    out.push(
      `    (class ${quote(cls === "Default" ? "kicad_default" : cls)} ${c.nets.map(quote).join(" ")} (circuit (use_via ${quote(via)})) (rule (width ${um(c.rules.trackWidth)}) (clearance ${um(c.rules.clearance)})))`,
    );
  }
  out.push(`  )`);

  // --- wiring: existing copper, protected ---------------------------------------------------------
  out.push(`  (wiring`);
  for (const t of input.tracks) {
    const ln = lname(t.layer);
    if (!ln) continue;
    out.push(
      `    (wire (path ${quote(ln)} ${um(t.width)} ${pt(t.start)} ${pt(t.end)})${t.net ? ` (net ${quote(t.net)})` : ""} (type protect))`,
    );
  }
  for (const v of input.vias) {
    out.push(`    (via ${quote(viaFor(v.diameter, v.drill))} ${pt(v.position)}${v.net ? ` (net ${quote(v.net)})` : ""} (type protect))`);
  }
  out.push(`  )`);
  out.push(`)`);
  return out.join("\n") + "\n";
}

/** Layers a `RouteOptions` restricts routing to, resolved against the input. */
export function dsnLayers(input: RouteInput, opts: RouteOptions): BoardLayer[] {
  return copperLayersInOrder(opts.layers ?? input.copperLayers.map((l) => l.id));
}
