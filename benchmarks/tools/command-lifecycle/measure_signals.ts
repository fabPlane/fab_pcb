import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [beforePath, afterPath, output] = process.argv.slice(2);
if (!beforePath || !afterPath || !output) throw new Error("usage: measure_signals.ts BEFORE_MODULE AFTER_MODULE FRESH_OUTPUT");
const out = resolve(output);
mkdirSync(out, { recursive: false });
const modules = [await import(pathToFileURL(resolve(beforePath)).href), await import(pathToFileURL(resolve(afterPath)).href)];
const rows = [];
for (let repeat = 1; repeat <= 3; repeat++)
  for (const state of ["handled", "ignored", "invalid"]) {
    for (const [index, version] of ["before", "after"].entries()) {
      const marker = join(out, `${state}-${repeat}-${version}`);
      const module = modules[index];
      const start = performance.now();
      if (state === "invalid") {
        let rejected = false;
        try {
          await module.runOwnedCommand(
            [process.execPath, "--eval", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`],
            { killSignal: 9999 },
          );
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          rejected = true;
        }
        rows.push({ repeat, state, version, rejected, spawned: existsSync(marker), wall_ms: performance.now() - start });
      } else {
        const child = `import signal,time; from pathlib import Path; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(0.9); Path(${JSON.stringify(marker + ".child")}).write_text('alive')`;
        const code = `import signal,sys,time,subprocess
from pathlib import Path
def handled(signum, frame):
    Path(${JSON.stringify(marker)}).write_text('handled')
    sys.exit(7)
signal.signal(signal.SIGTERM, ${state === "handled" ? "handled" : "signal.SIG_IGN"})
subprocess.Popen([sys.executable, '-c', ${JSON.stringify(child)}])
print('ready', flush=True)
time.sleep(3)
`;
        const result = await module.runOwnedCommand(["/usr/bin/python3", "-c", code], { timeoutMs: 300, killSignal: 15 });
        await Bun.sleep(1000);
        rows.push({
          repeat,
          state,
          version,
          code: result.code,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          handled: existsSync(marker),
          child_survived: existsSync(marker + ".child"),
          wall_ms: result.wallMs,
        });
      }
    }
  }
writeFileSync(join(out, "signals.json"), JSON.stringify(rows, null, 2) + "\n");
for (const row of rows.filter((r) => r.version === "after")) {
  if (
    row.state === "invalid"
      ? !row.rejected || row.spawned
      : !row.timed_out ||
        row.code !== 124 ||
        row.child_survived ||
        row.handled !== (row.state === "handled") ||
        (row.state === "handled" && row.exit_code !== 7)
  )
    throw new Error(`failed: ${JSON.stringify(row)}`);
}
console.log(`${rows.length} signal controls retained and verified`);
