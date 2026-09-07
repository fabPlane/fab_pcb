/** The compile job routes on the bridge without a KiCad binary; the run against kicad-cli is compile.kicad.test.ts. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, startBridge, type BridgeServer } from "../src/index";

describe("compile jobs without KiCad", () => {
  let bridge: BridgeServer;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fp-pcb-compile-"));
    bridge = await startBridge(configFromEnv({}, { port: 0, kicadCli: "/nonexistent/kicad-cli", workspaceRoot: dir, log: () => {} }));
  });
  afterAll(async () => {
    await bridge?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("/health lists the frontends", async () => {
    const h = (await (await fetch(`${bridge.url}/health`)).json()) as { compile: { frontends: string[] } };
    expect(h.compile.frontends).toEqual(["netlist-json"]);
  });

  test("unknown session is a 404 on every method, and the path is CORS-enabled", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await fetch(`${bridge.url}/sessions/nope/compile`, { method, body: method === "POST" ? "{}" : undefined });
      expect(res.status).toBe(404);
    }
    expect((await fetch(`${bridge.url}/sessions/nope/compile/j1`)).status).toBe(404);
    const pre = await fetch(`${bridge.url}/sessions/nope/compile`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
  });
});
