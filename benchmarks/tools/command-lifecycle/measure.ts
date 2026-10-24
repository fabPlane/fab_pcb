import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, beforePath, afterPath, output, dsn] = process.argv.slice(2);
if (!mode || !beforePath || !afterPath || !output || !["command", "session"].includes(mode)) {
  throw new Error("usage: measure.ts command|session BEFORE_MODULE AFTER_MODULE FRESH_OUTPUT [DSN]");
}
const out = resolve(output);
mkdirSync(out, { recursive: false });
const before = await import(pathToFileURL(resolve(beforePath)).href);
const after = await import(pathToFileURL(resolve(afterPath)).href);
const rows: Record<string, unknown>[] = [];
for (let repeat = 1; repeat <= 3; repeat++)
  for (const state of ["success", "nonzero", "timeout"]) {
    for (const [label, module] of [
      ["before", before],
      ["after", after],
    ] as const) {
      const dir = join(out, `${state}-${repeat}-${label}`);
      mkdirSync(dir);
      const marker = join(dir, "child-survived");
      const executable = join(dir, "engine");
      // All deliberately constructed processes finish themselves even if a
      // baseline wrapper fails to clean up. No process outside this run is killed.
      const child = `import time; from pathlib import Path; time.sleep(0.8); Path(${JSON.stringify(marker)}).write_text('alive')`;
      writeFileSync(
        executable,
        `#!/usr/bin/python3
import subprocess, sys, time
subprocess.Popen([sys.executable, '-c', ${JSON.stringify(child)}])
print('parent done', flush=True)
print('diagnostic', file=sys.stderr, flush=True)
${state === "timeout" ? "time.sleep(2)" : ""}
sys.exit(${state === "nonzero" ? 3 : 0})
`,
        { mode: 0o755 },
      );
      const start = performance.now();
      const result =
        mode === "command"
          ? await module.runCommand([executable], { timeoutMs: 250 })
          : await module.runFreerouting(join(dir, "in.dsn"), join(dir, "out.ses"), {
              java: executable,
              jar: "unused",
              passes: 1,
              maxTimeMs: 250,
            });
      const wallMs = performance.now() - start;
      await Bun.sleep(950);
      rows.push({
        repeat,
        state,
        version: label,
        code: result.code ?? result.exitCode,
        timed_out: result.timedOut,
        child_survived: existsSync(marker),
        wall_ms: wallMs,
        parent_output: mode === "command" ? result.stdout.includes("parent done") : result.log.includes("parent done"),
      });
    }
  }
writeFileSync(join(out, "controls.json"), JSON.stringify(rows, null, 2) + "\n");
for (const row of rows.filter((r) => r.version === "after")) {
  if (
    row.child_survived ||
    !row.parent_output ||
    row.timed_out !== (row.state === "timeout") ||
    (row.state === "success" && row.code !== 0) ||
    (row.state === "nonzero" && row.code !== 3)
  ) {
    throw new Error(`after control failed: ${JSON.stringify(row)}`);
  }
}
if (dsn) {
  const jar = process.env.FREEROUTING_JAR;
  if (!jar) throw new Error("FREEROUTING_JAR required");
  const native: Record<string, unknown>[] = [];
  for (let repeat = 1; repeat <= 3; repeat++)
    for (const [label, module] of [
      ["before", before],
      ["after", after],
    ] as const) {
      const dir = join(out, `real-${repeat}-${label}`);
      mkdirSync(dir);
      const session = join(dir, "out.ses");
      const start = performance.now();
      const result =
        mode === "command"
          ? await module.runCommand(
              [
                "java",
                "-Djava.awt.headless=true",
                "-jar",
                jar,
                "-de",
                resolve(dsn),
                "-do",
                session,
                "-mp",
                "1",
                "-mt",
                "1",
                "--gui.enabled=false",
              ],
              { timeoutMs: 30000 },
            )
          : await module.runFreerouting(resolve(dsn), session, { java: "java", jar, passes: 1, threads: 1, maxTimeMs: 30000 });
      writeFileSync(join(dir, "log.txt"), result.stdout ?? result.log.join("\n"));
      if (result.timedOut || (result.code ?? result.exitCode) !== 0 || !existsSync(session)) throw new Error("real engine failed");
      native.push({ repeat, version: label, code: result.code ?? result.exitCode, session, wall_ms: performance.now() - start });
    }
  writeFileSync(join(out, "native.json"), JSON.stringify(native, null, 2) + "\n");
}
console.log(`${rows.length} constructed subprocess controls verified; real sessions=${dsn ? 6 : 0}`);
