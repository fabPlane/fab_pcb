import { describe, expect, test } from "bun:test";

/** The integration-file convention the runner and CI rely on. */
const INTEGRATION = /\.kicad\.test\.[cm]?[jt]sx?$|(^|\/)conformance\/.*\.test\.[cm]?[jt]sx?$/;

describe("integration test naming convention", () => {
  test("*.kicad.test.ts and conformance/**/*.test.ts are integration, everything else is unit", () => {
    expect(INTEGRATION.test("bridge.kicad.test.ts")).toBe(true);
    expect(INTEGRATION.test("conformance/board.kicad.test.tsx")).toBe(true);
    expect(INTEGRATION.test("/repo/packages/client/test/conformance/commands.test.ts")).toBe(true);
    expect(INTEGRATION.test("bridge.test.ts")).toBe(false);
    expect(INTEGRATION.test("kicad-fixtures.ts")).toBe(false);
    expect(INTEGRATION.test("conformance-helpers.test.ts")).toBe(false);
    expect(INTEGRATION.test("test/conformance/kicad-server.ts")).toBe(false);
  });

  test("list mode enumerates workspaces with their split", async () => {
    const proc = Bun.spawn(["bun", "run-tests.ts", "list"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("@fp-pcb/bridge");
    expect(out).toMatch(/integration\s+test\/bridge\.kicad\.test\.ts/);
    expect(out).toMatch(/unit\s+test\/bridge\.test\.ts/);
    expect(out).toMatch(/integration\s+test\/conformance\/\S+\.test\.ts/);
    expect(out).not.toMatch(/unit\s+test\/conformance\//);
    expect(out).not.toContain("dist/");
  });
});
