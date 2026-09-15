import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findStockData, targetSpec, validateFabRouterSource, validateJsAutorouterSource, validateRelocatableSymlinks } from "./bundle-lib";

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

describe("fab_router source", () => {
  test("requires its manifest, entry point and runtime settings module", async () => {
    const root = await mkdtemp(join(tmpdir(), "fp-pcb-fab-router-"));
    await expect(validateFabRouterSource(root)).rejects.toThrow(/package.json/);
    await Bun.write(join(root, "package.json"), '{"name":"@fabplane/fab-router","private":true}\n');
    await expect(validateFabRouterSource(root)).rejects.toThrow(/src\/api.ts/);
    await mkdir(join(root, "src"));
    await Bun.write(join(root, "src", "api.ts"), "export {};\n");
    await expect(validateFabRouterSource(root)).rejects.toThrow(/spec\/types\/settings.ts/);
    await mkdir(join(root, "spec", "types"), { recursive: true });
    await Bun.write(join(root, "spec", "types", "settings.ts"), "export {};\n");
    await expect(validateFabRouterSource(root)).resolves.toBeUndefined();
  });

  test("the backend release checks out and bundles the pin on every native platform", () => {
    const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/backend-release.yml"), "utf8");
    expect(workflow.match(/packages\/router\/FAB_ROUTER_COMMIT/g)).toHaveLength(3);
    expect(workflow.match(/FP_PCB_FAB_ROUTER_SOURCE:/g)).toHaveLength(3);
    expect(workflow.match(/repository: fabPlane\/fab_router/g)).toHaveLength(3);
    expect(workflow.match(/token: \$\{\{ secrets\.FAB_ROUTER_READ_TOKEN \}\}/g)).toHaveLength(3);
    expect(workflow).toContain("FabRouter-enabled FabPlane PCB native backends");
    expect(workflow).not.toContain("router-free");
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

describe("relocatable backend links", () => {
  test("accepts internal relative links and rejects absolute, escaping, and broken links", async () => {
    const good = await mkdtemp(join(tmpdir(), "fp-pcb-links-good-"));
    await Bun.write(join(good, "library.1"), "library\n");
    await symlink("library.1", join(good, "library"));
    await expect(validateRelocatableSymlinks(good)).resolves.toBeUndefined();

    const absolute = await mkdtemp(join(tmpdir(), "fp-pcb-links-absolute-"));
    await Bun.write(join(absolute, "library.1"), "library\n");
    await symlink(join(absolute, "library.1"), join(absolute, "library"));
    await expect(validateRelocatableSymlinks(absolute)).rejects.toThrow(/absolute symlink/);

    const escaping = await mkdtemp(join(tmpdir(), "fp-pcb-links-escaping-"));
    await symlink("../outside", join(escaping, "library"));
    await expect(validateRelocatableSymlinks(escaping)).rejects.toThrow(/escapes bundle/);

    const broken = await mkdtemp(join(tmpdir(), "fp-pcb-links-broken-"));
    await symlink("missing", join(broken, "library"));
    await expect(validateRelocatableSymlinks(broken)).rejects.toThrow(/broken symlink/);
  });
});
