/**
 * `emitKicadNetlist(netlist)`: the IR as KiCad's own netlist format — the s-expression eeschema
 * writes and `ImportNetlist` reads. Pure string work, no protobuf and no server, so the whole
 * format is unit-testable on hand-written input.
 *
 * The shape KiCad expects (`(export (version "E") ...)`):
 *
 *   (export (version "E")
 *     (design (source "...") (date "...") (tool "..."))
 *     (components (comp (ref "R1") (value "1k") (footprint "lib:fp") ...))
 *     (nets (net (code "1") (name "GND") (node (ref "R1") (pin "2")))))
 *
 * `libparts` is omitted: `BOARD_NETLIST_UPDATER` does not read it, and a compiled design has no
 * symbol library to describe. That makes the output valid for `ImportNetlist` but *not* a
 * drop-in replacement for an eeschema netlist in tools that want library detail.
 */
import type { Diagnostic, Netlist, NetlistComponent } from "./types";

/** KiCad netlist format version this emitter writes. */
export const NETLIST_VERSION = "E";
export const TOOL_NAME = "@fp-pcb/compile";

/** A quoted s-expression atom. KiCad escapes only backslash and double-quote inside strings. */
function q(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function comp(c: NetlistComponent, indent: string): string {
  const lines = [`${indent}(comp (ref ${q(c.ref)})`];
  const inner = `${indent}  `;
  lines.push(`${inner}(value ${q(c.value)})`);
  if (c.footprint) lines.push(`${inner}(footprint ${q(c.footprint)})`);
  const fields = Object.entries(c.fields ?? {});
  if (fields.length) {
    lines.push(`${inner}(fields`);
    // KiCad writes a field's value as a bare atom after the name, not as `(value ...)`.
    for (const [name, value] of fields) lines.push(`${inner}  (field (name ${q(name)}) ${q(value)})`);
    lines.push(`${inner})`);
  }
  if (c.libSource) {
    const { lib, part, description } = c.libSource;
    const desc = description ? ` (description ${q(description)})` : "";
    lines.push(`${inner}(libsource (lib ${q(lib)}) (part ${q(part)})${desc})`);
  }
  if (c.uuid) lines.push(`${inner}(tstamps ${q(`/${c.uuid}`)})`);
  lines[lines.length - 1] += ")";
  return lines.join("\n");
}

export interface EmitOptions {
  /** Value for `(design (date ...))`. Defaults to now, ISO-8601. Pass a fixed value for reproducible output. */
  date?: string;
}

/**
 * Serialises the IR. Does not validate — run `validateNetlist` first if the input is untrusted;
 * this function will happily emit a netlist KiCad rejects.
 */
export function emitKicadNetlist(netlist: Netlist, opts: EmitOptions = {}): string {
  const design = netlist.design ?? {};
  const out: string[] = [`(export (version ${q(NETLIST_VERSION)})`];

  out.push("  (design");
  out.push(`    (source ${q(design.source ?? "")})`);
  out.push(`    (date ${q(opts.date ?? design.date ?? new Date().toISOString())})`);
  out.push(`    (tool ${q(design.tool ?? TOOL_NAME)}))`);

  out.push("  (components");
  for (const c of netlist.components) out.push(comp(c, "    "));
  out.push("  )");

  out.push("  (nets");
  netlist.nets.forEach((net, i) => {
    out.push(`    (net (code ${q(String(net.code ?? i + 1))}) (name ${q(net.name)})`);
    for (const n of net.nodes) {
      const fn = n.pinFunction ? ` (pinfunction ${q(n.pinFunction)})` : "";
      const pt = n.pinType ? ` (pintype ${q(n.pinType)})` : "";
      out.push(`      (node (ref ${q(n.ref)}) (pin ${q(n.pin)})${fn}${pt})`);
    }
    out[out.length - 1] += ")";
  });
  out.push("  )");

  out.push(")");
  return `${out.join("\n")}\n`;
}

/**
 * Everything that would make `ImportNetlist` fail or silently do nothing useful. Cheap to run and
 * it produces far better messages than KiCad's importer, which reports problems against the
 * generated file rather than against the source the author wrote.
 */
export function validateNetlist(netlist: Netlist): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const err = (message: string, code: string) => diagnostics.push({ severity: "error", stage: "netlist", code, message });
  const warn = (message: string, code: string) => diagnostics.push({ severity: "warning", stage: "netlist", code, message });

  const seen = new Set<string>();
  for (const c of netlist.components) {
    if (!c.ref) {
      err(`Component with value ${JSON.stringify(c.value)} has no reference designator.`, "missing_ref");
      continue;
    }
    if (seen.has(c.ref)) err(`Duplicate reference designator ${c.ref}.`, "duplicate_ref");
    seen.add(c.ref);
    if (!c.footprint) warn(`${c.ref} has no footprint; ImportNetlist will not place it on the board.`, "missing_footprint");
  }

  const netNames = new Set<string>();
  const connectedPins = new Map<string, string>();
  for (const net of netlist.nets) {
    if (!net.name) {
      err("Net with no name.", "unnamed_net");
    } else if (netNames.has(net.name)) {
      err(`Duplicate net name ${net.name}.`, "duplicate_net");
    } else if (/[{}]/.test(net.name)) {
      // KiCad's own netlist export writes a label's "/" as {slash} (and {colon}, {space}, …). The
      // fork imports such a name, but once SetNetClasses has run in the session its next
      // SaveDocument fails with nothing more than "basic_string" (gap G30). The IR carries literal
      // names; a converter from KiCad's format has to unescape or rename before it gets here.
      err(
        `Net name ${net.name} contains "{" or "}" (KiCad's escape sequences such as {slash}); after SetNetClasses the fork cannot save a board with such a net. Use the literal character or "_".`,
        "net_name_escape",
      );
    }
    netNames.add(net.name);

    if (net.nodes.length < 2) {
      warn(`Net ${net.name || "(unnamed)"} has ${net.nodes.length} node(s); it connects nothing.`, "single_node_net");
    }
    for (const n of net.nodes) {
      if (!seen.has(n.ref)) err(`Net ${net.name} references unknown component ${n.ref}.`, "unknown_ref");
      const pin = `${n.ref}:${n.pin}`;
      const priorNet = connectedPins.get(pin);
      if (priorNet && priorNet !== net.name)
        err(`${n.ref} pin ${n.pin} belongs to both ${priorNet} and ${net.name}.`, "pin_in_multiple_nets");
      else connectedPins.set(pin, net.name);
    }
  }

  const noConnectPins = new Set<string>();
  for (const n of netlist.noConnects ?? []) {
    const pin = `${n.ref}:${n.pin}`;
    if (!seen.has(n.ref)) err(`No-connect references unknown component ${n.ref}.`, "unknown_no_connect_ref");
    if (noConnectPins.has(pin)) err(`Duplicate no-connect declaration for ${n.ref} pin ${n.pin}.`, "duplicate_no_connect");
    noConnectPins.add(pin);
    const net = connectedPins.get(pin);
    if (net) err(`${n.ref} pin ${n.pin} is both on net ${net} and marked no-connect.`, "connected_no_connect");
  }

  return diagnostics;
}
