/**
 * Freerouting adapter: log parsing always; the builtin DSN -> jar -> SES round trip on the synthetic
 * board when the vendored jar and a Java are present (no KiCad needed).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board } from "@fp-pcb/client";
import { DEFAULT_JAR, FreeroutingRouter, exportDsnViaKicad, findJava, parseFreeroutingLine, resolveFreerouting } from "../src/freerouting";
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

describe("resolveFreerouting", () => {
  test("defaults to the vendored jar and reports a missing one with the fetch command", () => {
    const r = resolveFreerouting({ FREEROUTING_JAR: "/nonexistent/fr.jar" });
    expect(r.ok).toBe(false);
    expect(r.jar).toBe("/nonexistent/fr.jar");
    expect(r.reason).toMatch(/fetch-freerouting\.ts --jdk|FREEROUTING_JAR/);
    expect(resolveFreerouting({}).jar).toBe(DEFAULT_JAR);
  });
  test("FP_PCB_JAVA wins over FREEROUTING_JAVA and must exist", () => {
    const jar = existsSync(DEFAULT_JAR) ? DEFAULT_JAR : undefined;
    const r = resolveFreerouting({ FREEROUTING_JAR: jar, FP_PCB_JAVA: "/nonexistent/java", FREEROUTING_JAVA: "/usr/bin/java" });
    if (!jar) {
      expect(r.ok).toBe(false);
      return;
    }
    expect(r.ok).toBe(false);
    expect(r.java).toBeUndefined();
    expect(r.reason).toMatch(/FP_PCB_JAVA/);
    const sys = Bun.which("java");
    if (sys) expect(resolveFreerouting({ FREEROUTING_JAR: jar, FP_PCB_JAVA: sys })).toMatchObject({ ok: true, java: sys });
  });
});

describe("runFreerouting cancellation", () => {
  const paths = resolveFreerouting();
  test.skipIf(!paths.ok)(
    "an abort kills the java process and the adapter rejects with RouteCancelled",
    async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = await mkdtemp(join(tmpdir(), "fp-pcb-fr-cancel-"));
      try {
        const router = new FreeroutingRouter({}, { mode: "builtin", jar: paths.jar, java: paths.java, workDir: dir, passes: 100 });
        const ac = new AbortController();
        const t0 = performance.now();
        // abort as soon as the jar is started (the JVM is still coming up): the process must go
        const p = router.route(twoNetBoard(), { signal: ac.signal }, (pr) => {
          if (pr.phase === "freerouting") setTimeout(() => ac.abort(), 300);
        });
        await expect(p).rejects.toMatchObject({ name: "RouteCancelled" });
        expect(performance.now() - t0).toBeLessThan(20_000);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("exportDsnViaKicad", () => {
  /** A board whose export job answers `res`, on a project in `dir`. */
  const fakeBoard = (dir: string, res: unknown, calls: string[]) =>
    ({
      client: { call: async () => res },
      specifier: {},
      fileName: "b.kicad_pcb",
      kicad: { projectInfo: async () => ({ kicadProPath: join(dir, "b.kicad_pro") }) },
      save: async () => {
        calls.push("save");
      },
    }) as unknown as Board;

  test("inline output from the job wins; a file the job wrote is read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fp-pcb-dsn-"));
    try {
      const calls: string[] = [];
      const inline = fakeBoard(dir, { status: 0, outputs: [{ path: "", data: new TextEncoder().encode("(pcb inline)") }] }, calls);
      expect(await exportDsnViaKicad(inline, join(dir, "a.dsn"))).toBe("(pcb inline)");
      expect(calls).toEqual(["save"]);
      await Bun.write(join(dir, "b.dsn"), "(pcb file)");
      const file = fakeBoard(dir, { status: 0, outputPaths: [join(dir, "b.dsn")] }, calls);
      expect(await exportDsnViaKicad(file, join(dir, "other.dsn"))).toBe("(pcb file)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a job that returns nothing falls back to kicad-cli on the saved board (G34)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fp-pcb-dsn-"));
    try {
      const cli = join(dir, "kicad-cli");
      await Bun.write(
        cli,
        '#!/bin/sh\nout=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { out="$2"; shift; }; board="$1"; shift; done\nprintf "(pcb from-cli %s %s)" "$out" "$board" > "$out"\n',
      );
      await chmod(cli, 0o755);
      const calls: string[] = [];
      const board = fakeBoard(dir, { status: 0 }, calls);
      const out = join(dir, "board.dsn");
      const log: string[] = [];
      expect(await exportDsnViaKicad(board, out, { kicadCli: cli, log: (l) => log.push(l) })).toBe(
        `(pcb from-cli ${out} ${join(dir, "b.kicad_pcb")})`,
      );
      expect(log[0]).toMatch(/returned no output .*G34.*kicad-cli instead/);
      // Without a fallback the failure names the gap instead of an ENOENT on the missing file.
      await expect(exportDsnViaKicad(board, join(dir, "none.dsn"))).rejects.toThrow(/G34.*no kicad-cli/);
      // A CLI that fails is reported with its exit code.
      await Bun.write(cli, "#!/bin/sh\necho 'no board' >&2; exit 3\n");
      await expect(exportDsnViaKicad(board, join(dir, "fail.dsn"), { kicadCli: cli })).rejects.toThrow(/failed \(exit 3\): no board/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
