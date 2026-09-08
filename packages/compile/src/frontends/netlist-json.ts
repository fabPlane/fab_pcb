/**
 * `netlist-json`: the IR itself as a file, `circuit.netlist.json` = `{ netlist, board?, libraries? }`.
 *
 * The simplest possible frontend — parse, shape-check, hand over — and the one that exercises the
 * whole apply path with no other dependency, which is why it ships first. Diagnostics name the
 * file and a JSON pointer (`/netlist/components/2/ref`); line numbers wait for a positional
 * parser, if one ever earns its keep.
 */
import type { BoardSpec, CompileSource, Diagnostic, Frontend, FrontendResult, LibrarySpec, Netlist } from "../types";

export const NETLIST_JSON_KIND = "netlist-json";
export const NETLIST_JSON_ENTRYPOINT = "circuit.netlist.json";

/** What a `circuit.netlist.json` file holds. */
export interface NetlistJsonFile {
  netlist: Netlist;
  board?: BoardSpec;
  /** Libraries the footprints resolve against; registered in the project tables before the import. */
  libraries?: LibrarySpec[];
}

type Check = (value: unknown, path: string) => void;

class ShapeErrors {
  readonly diagnostics: Diagnostic[] = [];
  constructor(private readonly file: string) {}
  error(path: string, message: string): void {
    this.diagnostics.push({ severity: "error", stage: "frontend", code: "bad_shape", file: this.file, message: `${path}: ${message}` });
  }
  get ok(): boolean {
    return this.diagnostics.length === 0;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Structural check of the file, one diagnostic per problem; semantic checks are `validateNetlist`'s. */
export function checkNetlistJson(value: unknown, file: string): { file: NetlistJsonFile | null; diagnostics: Diagnostic[] } {
  const errs = new ShapeErrors(file);
  const str =
    (required: boolean): Check =>
    (v, path) => {
      if (v === undefined) {
        if (required) errs.error(path, "is required");
      } else if (typeof v !== "string") errs.error(path, "must be a string");
    };
  const num = (): Check => (v, path) => {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) errs.error(path, "must be a finite number");
  };
  const arr =
    (each: Check): Check =>
    (v, path) => {
      if (!Array.isArray(v)) return errs.error(path, "must be an array");
      v.forEach((item, i) => each(item, `${path}/${i}`));
    };
  const obj =
    (fields: Record<string, Check>, required = true): Check =>
    (v, path) => {
      if (v === undefined && !required) return;
      if (!isRecord(v)) return errs.error(path, "must be an object");
      for (const [key, check] of Object.entries(fields)) check(v[key], `${path}/${key}`);
    };

  const component = obj({
    ref: str(true),
    value: str(true),
    footprint: str(true),
    uuid: str(false),
    fields: (v, path) => {
      if (v === undefined) return;
      if (!isRecord(v)) return errs.error(path, "must be an object of strings");
      for (const [k, fv] of Object.entries(v)) if (typeof fv !== "string") errs.error(`${path}/${k}`, "must be a string");
    },
    libSource: obj({ lib: str(true), part: str(true), description: str(false) }, false),
  });
  const node = obj({ ref: str(true), pin: str(true), pinFunction: str(false), pinType: str(false) });
  const net = obj({ name: str(true), code: num(), nodes: arr(node) });
  const point = obj({ x: num(), y: num() });
  const library = obj({
    kind: (v, path) => {
      if (v !== "footprint" && v !== "symbol") errs.error(path, 'must be "footprint" or "symbol"');
    },
    nickname: str(true),
    uri: str(true),
    description: str(false),
  });

  obj({
    netlist: obj({
      components: arr(component),
      nets: arr(net),
      design: obj({ source: str(false), date: str(false), tool: str(false) }, false),
    }),
    board: obj(
      {
        outline: (v, path) => v !== undefined && arr(point)(v, path),
        widthMm: num(),
        heightMm: num(),
        copperLayers: num(),
      },
      false,
    ),
    libraries: (v, path) => v !== undefined && arr(library)(v, path),
  })(value, "");

  return { file: errs.ok ? (value as NetlistJsonFile) : null, diagnostics: errs.diagnostics };
}

async function build(source: CompileSource): Promise<FrontendResult> {
  const file = source.entrypoint || NETLIST_JSON_ENTRYPOINT;
  const text = source.files[file];
  if (text === undefined) {
    return {
      netlist: null,
      diagnostics: [
        { severity: "error", stage: "frontend", code: "missing_entrypoint", file, message: `${file} not found in the source files.` },
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { netlist: null, diagnostics: [{ severity: "error", stage: "frontend", code: "json_syntax", file, message }] };
  }
  const { file: checked, diagnostics } = checkNetlistJson(parsed, file);
  if (!checked) return { netlist: null, diagnostics };
  return {
    netlist: checked.netlist,
    ...(checked.board ? { board: checked.board } : {}),
    ...(checked.libraries ? { libraries: checked.libraries } : {}),
    diagnostics,
  };
}

export const netlistJsonFrontend: Frontend = { kind: NETLIST_JSON_KIND, build };
