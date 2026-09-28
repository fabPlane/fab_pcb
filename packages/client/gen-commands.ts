#!/usr/bin/env bun
/**
 * Generates `src/commands-data.ts` (the coverage table as typed data) and `src/commands.ts` (one typed
 * wrapper per command) from `tooling/coverage/commands.json` and the protobuf descriptors in
 * `@fp-pcb/proto`. Run `bun run gen` in packages/client after `bun run coverage` at the root.
 *
 * Every request/response type name in commands.json is resolved against the flat exports of
 * `@fp-pcb/proto`, so a schema drift (renamed message, missing export) fails generation rather
 * than producing a wrapper that does not compile.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DescMessage } from "@bufbuild/protobuf";
import * as proto from "@fp-pcb/proto";

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(PKG_DIR, "..", "..");
const COMMANDS_JSON = join(REPO_DIR, "tooling", "coverage", "commands.json");
const KICAD_COMMIT_FILE = join(REPO_DIR, "packages", "proto", "KICAD_COMMIT");

export type Headless = "ok" | "gui-only" | "partial" | "unregistered";

export interface CommandRow {
  command: string;
  group: string;
  requestType: string;
  responseType: string | null;
  handlers: string[];
  headless: Headless;
}

const EMPTY = "google.protobuf.Empty";

/** Finds the flat export name (`XxxSchema`) whose descriptor has the given full type name. */
function schemaExportFor(typeName: string): string {
  if (typeName === EMPTY) return "EmptySchema";
  const simple = typeName.slice(typeName.lastIndexOf(".") + 1);
  const candidates = [simple, `Board${simple}`, `Schematic${simple}`];
  const all = proto as unknown as Record<string, unknown>;
  for (const c of candidates) {
    const s = all[`${c}Schema`] as DescMessage | undefined;
    if (s && typeof s === "object" && "typeName" in s && s.typeName === typeName) return `${c}Schema`;
  }
  throw new Error(`no exported schema for ${typeName} in @fp-pcb/proto (tried ${candidates.join(", ")})`);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function referencedTypes(schema: DescMessage): string[] {
  const out = new Set<string>();
  const visit = (message: DescMessage) => {
    if (out.has(message.typeName)) return;
    out.add(message.typeName);
    for (const field of message.fields) {
      if (field.fieldKind === "message") visit(field.message);
      else if (field.fieldKind === "list" && field.listKind === "message") visit(field.message);
      else if (field.fieldKind === "map" && field.mapKind === "message") visit(field.message);
    }
  };
  visit(schema);
  return [...out].sort();
}

function descriptorShape(schema: DescMessage): unknown {
  return {
    type: schema.typeName,
    fields: schema.fields.map((field) => ({
      name: field.name,
      jsonName: field.jsonName,
      number: field.number,
      kind: field.fieldKind,
      value:
        field.fieldKind === "scalar"
          ? field.scalar
          : field.fieldKind === "enum"
            ? { type: field.enum.typeName, values: field.enum.values.map((v) => [v.name, v.number]) }
            : field.fieldKind === "message"
              ? field.message.typeName
              : field.fieldKind === "list"
                ? field.listKind === "scalar"
                  ? field.scalar
                  : field.listKind === "enum"
                    ? { type: field.enum.typeName, values: field.enum.values.map((v) => [v.name, v.number]) }
                    : field.message.typeName
                : field.mapKind === "scalar"
                  ? field.scalar
                  : field.mapKind === "enum"
                    ? { type: field.enum.typeName, values: field.enum.values.map((v) => [v.name, v.number]) }
                    : field.message.typeName,
      presence: field.presence,
      oneof: field.oneof?.name ?? null,
      deprecated: field.deprecated,
    })),
  };
}

function documentTypes(row: CommandRow): string[] {
  const values = new Set<string>();
  if (row.group.startsWith("board/")) values.add("pcb");
  if (row.group.startsWith("sch/")) values.add("schematic");
  if (row.handlers.some((h) => h === "pcb" || h === "board")) values.add("pcb");
  if (row.handlers.includes("sch")) values.add("schematic");
  if (row.handlers.some((h) => h === "footprint" || h === "fplib")) values.add("footprint");
  if (row.handlers.includes("symlib")) values.add("symbol");
  if (row.group === "common/project" || row.command.includes("Document")) {
    for (const value of ["project", "pcb", "schematic", "footprint", "symbol"]) values.add(value);
  }
  if (values.size === 0) values.add("global");
  return [...values].sort();
}

function catalogEntry(row: CommandRow) {
  const request = proto.kiapiRegistry.getMessage(row.requestType);
  const response = proto.kiapiRegistry.getMessage(row.responseType ?? EMPTY);
  if (!request || !response) throw new Error(`missing descriptor for ${row.command}`);
  const refs = [...new Set([...referencedTypes(request), ...referencedTypes(response)])];
  const objectTypes = refs
    .filter((type) => /kiapi\.(board|schematic)\.types\./.test(type))
    .map((type) => type.slice(type.lastIndexOf(".") + 1))
    .filter((type) => !/^(Document|Board|Schematic)$/.test(type))
    .sort();
  const capabilities = [...new Set([...words(row.command), ...words(row.group), ...row.handlers])].sort();
  const schemaShape = { request: descriptorShape(request), response: descriptorShape(response) };
  return {
    operation: row.command,
    group: row.group,
    requestType: row.requestType,
    responseType: row.responseType ?? EMPTY,
    handlers: row.handlers,
    headless: row.headless,
    documentTypes: documentTypes(row),
    objectTypes,
    capabilities,
    summary: `${row.command} via ${row.handlers.length ? row.handlers.join(", ") : "no registered"} handler${row.handlers.length === 1 ? "" : "s"}.`,
    schemaHash: createHash("sha256").update(JSON.stringify(schemaShape)).digest("hex"),
  };
}

export async function generate(): Promise<{ data: string; commands: string; catalog: string; rows: CommandRow[] }> {
  const rows = JSON.parse(await readFile(COMMANDS_JSON, "utf8")) as CommandRow[];
  const commit = (await readFile(KICAD_COMMIT_FILE, "utf8")).trim();
  const header = `// @generated by packages/client/gen-commands.ts from tooling/coverage/commands.json (KiCad ${commit.slice(0, 10)}) -- do not edit; run \`bun run gen\`.`;

  // --- commands-data.ts ---
  const data = [
    header,
    "",
    'export type HeadlessStatus = "ok" | "gui-only" | "partial" | "unregistered";',
    "",
    "export interface CommandInfo {",
    "  /** Simple command name, e.g. `GetVersion`. */",
    "  command: string;",
    "  /** Proto group, e.g. `common/base`, `board/commands`. */",
    "  group: string;",
    "  requestType: string;",
    "  /** null when no KiCad handler registers the command. */",
    "  responseType: string | null;",
    "  /** KiCad handler classes that serve it (common, editor, board, pcb, footprint, sch, server). */",
    "  handlers: string[];",
    "  headless: HeadlessStatus;",
    "}",
    "",
    `/** KiCad commit the table was generated from. */`,
    `export const KICAD_COMMIT = ${JSON.stringify(commit)};`,
    "",
    "/** Every command in the KiCad IPC API, in proto order. */",
    "export const COMMANDS: readonly CommandInfo[] = [",
    ...rows.map((r) => `  ${JSON.stringify(r)},`),
    "];",
    "",
    "export const COMMAND_BY_NAME: ReadonlyMap<string, CommandInfo> = new Map(COMMANDS.map((c) => [c.command, c]));",
    "export const COMMAND_BY_REQUEST_TYPE: ReadonlyMap<string, CommandInfo> = new Map(COMMANDS.map((c) => [c.requestType, c]));",
    "",
    "/** Commands that work against `kicad-cli api-server` (no GUI frame). */",
    'export const HEADLESS_COMMANDS: readonly CommandInfo[] = COMMANDS.filter((c) => c.headless === "ok");',
    "",
  ].join("\n");

  // --- commands.ts ---
  const imports = new Set<string>();
  const fns: string[] = [];
  const schemaEntries: string[] = [];
  const names: string[] = [];
  let currentGroup = "";
  for (const r of rows) {
    const reqSchema = schemaExportFor(r.requestType);
    const resSchema = schemaExportFor(r.responseType ?? EMPTY);
    imports.add(reqSchema);
    imports.add(resSchema);
    const fn = lowerFirst(r.command);
    names.push(r.command);
    if (r.group !== currentGroup) {
      currentGroup = r.group;
      fns.push(`// ---- ${r.group} ${"-".repeat(Math.max(4, 90 - r.group.length))}`, "");
    }
    const headlessNote =
      r.headless === "ok"
        ? "Headless: yes."
        : r.headless === "gui-only"
          ? "Headless: NO (GUI-only; `kicad-cli api-server` answers AS_UNIMPLEMENTED)."
          : r.headless === "partial"
            ? "Headless: partial (only some handlers)."
            : "Headless: n/a (no KiCad handler registers this command; expect AS_UNHANDLED).";
    const reqIsEmpty = proto.kiapiRegistry.getMessage(r.requestType)?.fields.length === 0;
    fns.push(
      "/**",
      ` * \`${r.command}\` (${r.group}) — handlers: ${r.handlers.length ? r.handlers.join(", ") : "none"}. ${headlessNote}`,
      ` * Request \`${r.requestType}\`, response \`${r.responseType ?? EMPTY}\`.`,
      " */",
      `export function ${fn}(`,
      "  client: KiCadClient,",
      `  req: MessageInitShape<typeof ${reqSchema}>${reqIsEmpty ? " = {}" : ""},`,
      "  opts?: CallOptions,",
      `): Promise<MessageShape<typeof ${resSchema}>> {`,
      `  return client.call(${reqSchema}, req, ${resSchema}, { command: ${JSON.stringify(r.command)}, ...opts });`,
      "}",
      "",
    );
    schemaEntries.push(
      `  ${r.command}: { request: ${reqSchema}, response: ${resSchema}, info: COMMAND_BY_NAME.get(${JSON.stringify(r.command)})! },`,
    );
  }
  const commands = [
    header,
    "",
    'import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";',
    `import { ${[...imports].sort().join(", ")} } from "@fp-pcb/proto";`,
    'import type { CallOptions, KiCadClient } from "./client";',
    'import { COMMAND_BY_NAME, type CommandInfo } from "./commands-data";',
    "",
    `export type CommandName = ${names.map((n) => JSON.stringify(n)).join(" | ")};`,
    "",
    "export interface CommandSchemas {",
    "  request: DescMessage;",
    "  response: DescMessage;",
    "  info: CommandInfo;",
    "}",
    "",
    "/** Request/response descriptors for every command, keyed by simple name (for generic/dynamic callers). */",
    "export const COMMAND_SCHEMAS: Readonly<Record<CommandName, CommandSchemas>> = {",
    ...schemaEntries,
    "};",
    "",
    "/** Looks up a command's schemas by simple name or full request type name. */",
    "export function commandSchemas(command: string): CommandSchemas | undefined {",
    "  const byName = (COMMAND_SCHEMAS as Record<string, CommandSchemas>)[command];",
    "  if (byName) return byName;",
    "  return Object.values(COMMAND_SCHEMAS).find((c) => c.request.typeName === command);",
    "}",
    "",
    ...fns,
  ].join("\n");

  const entries = rows.map(catalogEntry);
  const schemaShapes = [...proto.kiapiRegistry]
    .filter(
      (desc): desc is DescMessage =>
        desc.kind === "message" && (desc.typeName.startsWith("kiapi.") || desc.typeName.startsWith("google.protobuf.")),
    )
    .map(descriptorShape)
    .sort((a, b) => String((a as { type: string }).type).localeCompare(String((b as { type: string }).type)));
  const catalogHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const schemaHash = createHash("sha256").update(JSON.stringify(schemaShapes)).digest("hex");
  const catalog = [
    header,
    "",
    'import type { HeadlessStatus } from "./commands-data";',
    "",
    "export interface IpcCatalogEntry {",
    "  operation: string; group: string; requestType: string; responseType: string; handlers: string[];",
    "  headless: HeadlessStatus; documentTypes: string[]; objectTypes: string[]; capabilities: string[];",
    "  summary: string; schemaHash: string;",
    "}",
    "",
    'export const IPC_CATALOG_VERSION = "direct-kicad-ipc/1.0.0";',
    `export const IPC_CATALOG_SHA256 = ${JSON.stringify(catalogHash)};`,
    `export const IPC_SCHEMA_SHA256 = ${JSON.stringify(schemaHash)};`,
    "export const IPC_CATALOG: readonly IpcCatalogEntry[] = [",
    ...entries.map((entry) => `  ${JSON.stringify(entry)},`),
    "];",
    "",
  ].join("\n");

  return { data, commands, catalog, rows };
}

if (import.meta.main) {
  const { data, commands, catalog, rows } = await generate();
  await writeFile(join(PKG_DIR, "src", "commands-data.ts"), data);
  await writeFile(join(PKG_DIR, "src", "commands.ts"), commands);
  await writeFile(join(PKG_DIR, "src", "ipc-catalog-data.ts"), catalog);
  const ok = rows.filter((r) => r.headless === "ok").length;
  console.log(`wrote commands and IPC catalog: ${rows.length} commands (${ok} headless)`);
}
