/**
 * `LibrarySpec` → a row in the project's library table. Headless servers ship no libraries, so a
 * frontend that generates footprints says where it put them and the job registers them here
 * before the dry-run import resolves anything. `AddLibraryTableRow` with `replace` is idempotent,
 * which is what a re-compile needs; the table is saved by KiCad next to the project.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { KiCad, TableRowInput } from "@fp-pcb/client";
import type { LibrarySpec } from "./types";

export function libraryRow(spec: LibrarySpec): TableRowInput {
  return {
    nickname: spec.nickname,
    uri: spec.uri,
    type: "KiCad",
    options: "",
    description: spec.description ?? "",
    // The proto defaults to false and KiCad stores that as `(disabled)`, which the importer then
    // refuses as "no enabled footprint library"; say it explicitly.
    enabled: true,
    hidden: false,
  };
}

export async function registerLibraries(kicad: KiCad, specs: readonly LibrarySpec[]): Promise<void> {
  for (const spec of specs) await kicad.libraries.addTableRow(spec.kind, "project", libraryRow(spec), true);
}

/** Turn a bundled KiCad library directory into project table rows. Missing directories are explicit. */
export async function discoverLibraries(kind: LibrarySpec["kind"], root: string): Promise<LibrarySpec[]> {
  const entries = await readdir(root, { withFileTypes: true });
  if (kind === "footprint") {
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".pretty"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        kind,
        nickname: entry.name.slice(0, -".pretty".length),
        uri: join(root, entry.name),
        description: "Bundled KiCad footprint library",
      }));
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".kicad_sym"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      kind,
      nickname: entry.name.slice(0, -".kicad_sym".length),
      uri: join(root, entry.name),
      description: "Bundled KiCad symbol library",
    }));
}
