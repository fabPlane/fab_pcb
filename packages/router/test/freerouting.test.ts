/**
 * Freerouting adapter: log parsing always; the builtin DSN -> jar -> SES round trip on the synthetic
 * board when the vendored jar and a Java are present (no KiCad needed).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DEFAULT_JAR, FreeroutingRouter, findJava, parseFreeroutingLine } from "../src/freerouting";
import type { RouteProgress } from "../src/types";
import { twoNetBoard, F, B } from "./fixtures";

describe("parseFreeroutingLine", () => {
  test("auto-routing and optimizer passes", () => {
    const pass = parseFreeroutingLine(
      "2026-09-07 06:39:19.372 INFO   [8DDDD5\\E83CD1] Auto-routing pass #3 on board 'abc' was completed in 0.17 seconds with score 974.60 (3 unrouted and 1 violations).",
    );
    expect(pass).toMatchObject({ kind: "pass", pass: 3, score: 974.6, unrouted: 3, violations: 1 });
    const opt = parseFreeroutingLine(
      "... Optimizer pass #1 on board 'x' was completed in 0.00 seconds with the score of 1000.00 (0 unrouted and 0 violations).",
    );
    expect(opt).toMatchObject({ kind: "optimizer", pass: 1, unrouted: 0, violations: 0 });
  });
  test("stages, completion, saved file, errors, other", () => {
    expect(parseFreeroutingLine("INFO   [x] Auto-routing stage started on board 'y' for 14 unrouted items.")).toMatchObject({
      kind: "stage",
      unrouted: 14,
    });
    expect(parseFreeroutingLine("INFO   [x] Job 'x' finished with state: COMPLETED (elapsed: 0.27 seconds).")).toMatchObject({
      kind: "finished",
      state: "COMPLETED",
    });
    expect(parseFreeroutingLine("INFO   Successfully saved output file '/tmp/a.ses' (5605 bytes).").kind).toBe("saved");
    expect(parseFreeroutingLine("Exception in thread main: java.lang.OutOfMemoryError").kind).toBe("error");
    expect(parseFreeroutingLine("INFO   Freerouting v2.4.1 (build-date: 2026-09-03)").kind).toBe("other");
  });
});

describe("FreeroutingRouter.available", () => {
  test("reports a missing jar", async () => {
    const r = new FreeroutingRouter({}, { jar: "/nonexistent/freerouting.jar", mode: "builtin" });
    const a = await r.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/jar not found/);
  });
  test("kicad mode needs a board", async () => {
    const r = new FreeroutingRouter({}, { mode: "kicad", jar: DEFAULT_JAR });
    const a = await r.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/jar not found|needs a Board/);
  });
  test("auto mode without a board resolves to builtin", async () => {
    expect(await new FreeroutingRouter({}, { jar: DEFAULT_JAR }).resolveMode()).toBe("builtin");
  });
});

const haveJar = existsSync(DEFAULT_JAR) && !!findJava();
if (!haveJar) console.log(`[skip] Freerouting jar/java not found (${DEFAULT_JAR}); run bun bench/fetch-freerouting.ts --jdk`);

describe.skipIf(!haveJar)("FreeroutingRouter builtin round trip", () => {
  test("routes the synthetic two-net board through the jar and reads the session back", async () => {
    const progress: RouteProgress[] = [];
    const r = new FreeroutingRouter({}, { mode: "builtin", passes: 10 });
    const res = await r.route(twoNetBoard(), {}, (p) => progress.push(p));
    expect(res.router).toBe("freerouting-builtin");
    expect(res.timedOut).toBe(false);
    expect(res.unrouted).toEqual([]);
    expect(res.tracks.length).toBeGreaterThan(0);
    for (const t of res.tracks) {
      expect([F, B]).toContain(t.layer);
      expect(["A", "B"]).toContain(t.net);
      expect(t.width).toBe(250_000);
    }
    for (const v of res.vias) expect(v).toMatchObject({ diameter: 800_000, drill: 400_000, layers: [F, B] });
    expect(progress.map((p) => p.phase)).toContain("export");
    expect(progress.some((p) => /^pass \d+/.test(p.phase))).toBe(true);
    expect(progress[progress.length - 1]).toMatchObject({ phase: "done", routed: 2, total: 2 });
    expect(res.log.some((l) => /^freerouting: .*finished with state: COMPLETED/.test(l))).toBe(true);
  }, 120_000);
});
