import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findStockData, targetSpec, validateJsAutorouterSource } from "./bundle-lib";

describe("backend bundle targets", () => {
  test("uses IPC on Unix and KiCad WebSockets on Windows", () => {
    expect(targetSpec("linux-x64")).toMatchObject({ bunTarget: "bun-linux-x64", socketTransport: "ipc", kicadCliName: "kicad-cli" });
    expect(targetSpec("darwin-arm64")).toMatchObject({ bunTarget: "bun-darwin-arm64", socketTransport: "ipc" });
    expect(targetSpec("windows-x64")).toMatchObject({ bunTarget: "bun-windows-x64", socketTransport: "ws", kicadCliName: "kicad-cli.exe" });
    expect(() => targetSpec("plan9-x64")).toThrow(/unsupported bundle target/);
  });
});

describe("private js_autorouter source", () => {
  test("requires the package manifest and TypeScript entry point", async () => {
    const root = await mkdtemp(join(tmpdir(), "fp-pcb-js-autorouter-"));
    await expect(validateJsAutorouterSource(root)).rejects.toThrow(/package.json/);
    await Bun.write(join(root, "package.json"), "{}\n");
    await expect(validateJsAutorouterSource(root)).rejects.toThrow(/src\/index.ts/);
    await mkdir(join(root, "src"));
    await Bun.write(join(root, "src", "index.ts"), "export {};\n");
    await expect(validateJsAutorouterSource(root)).resolves.toBeUndefined();
  });
});

describe("KiCad stock data", () => {
  test("recognizes installed and macOS bundle layouts", async () => {
    const installed = await mkdtemp(join(tmpdir(), "fp-pcb-stock-installed-"));
    await mkdir(join(installed, "share", "kicad"), { recursive: true });
    expect(await findStockData(installed)).toBe(join(installed, "share", "kicad"));

    const mac = await mkdtemp(join(tmpdir(), "fp-pcb-stock-mac-"));
    await mkdir(join(mac, "KiCad.app", "Contents", "SharedSupport"), { recursive: true });
    expect(await findStockData(mac)).toBe(join(mac, "KiCad.app", "Contents", "SharedSupport"));
  });
});
