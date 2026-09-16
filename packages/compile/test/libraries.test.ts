import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLibraries, libraryRow } from "../src/libraries";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("bundled libraries", () => {
  test("discovers sorted footprint and symbol table rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "fp-pcb-libraries-"));
    roots.push(root);
    await mkdir(join(root, "Z.pretty"));
    await mkdir(join(root, "A.pretty"));
    await writeFile(join(root, "Device.kicad_sym"), "(kicad_symbol_lib)");
    await writeFile(join(root, "README"), "ignored");

    expect((await discoverLibraries("footprint", root)).map((library) => library.nickname)).toEqual(["A", "Z"]);
    expect(await discoverLibraries("symbol", root)).toEqual([
      { kind: "symbol", nickname: "Device", uri: join(root, "Device.kicad_sym"), description: "Bundled KiCad symbol library" },
    ]);
  });

  test("rows are enabled and replaceable in a clean headless project", () => {
    expect(libraryRow({ kind: "footprint", nickname: "Device", uri: "/bundle/Device.pretty" })).toMatchObject({
      nickname: "Device",
      type: "KiCad",
      enabled: true,
      hidden: false,
    });
  });
});
