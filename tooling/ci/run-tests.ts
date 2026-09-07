#!/usr/bin/env bun
/**
 * Runs `bun test` in every workspace package, one process per package, split into
 *
 *   unit         every *.test.ts(x) except integration files
 *   integration  *.kicad.test.ts(x) only — tests that spawn a real `kicad-cli api-server`
 *
 * Why one process per package: `bun test` at the repo root loads every file into one process, and
 * apps/web's tests register happy-dom as the global DOM (fetch, WebSocket, ...), which then breaks the
 * bridge and client tests that run after them. Each package also has its own bunfig.toml preload.
 *
 * Integration files follow the naming convention `<name>.kicad.test.ts` (packages/client/test,
 * packages/bridge/test); every test file under a `conformance/` directory is integration too
 * (packages/client/test/conformance, the API conformance suite). They skip themselves with a message
 * when the binary named by KICAD_CLI (or the default ../kicad/build/release/... path) does not exist;
 * `integration` additionally warns up front when KICAD_CLI is unset, so a CI job cannot silently pass
 * with every test skipped. Set KICAD_INTEGRATION_REQUIRED=1 to turn that warning into a failure.
 *
 *   bun tooling/ci/run-tests.ts unit [--filter <name>] [-- extra bun test args]
 *   bun tooling/ci/run-tests.ts integration
 *   bun tooling/ci/run-tests.ts list          # print the classification and exit
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INTEGRATION = /\.kicad\.test\.[cm]?[jt]sx?$|(^|\/)conformance\/.*\.test\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-tsc", ".git", "e2e", "output", "test-results", "playwright-report"]);

type Mode = "unit" | "integration" | "list";

interface Workspace {
  name: string;
  dir: string;
  unit: string[];
  integration: string[];
}

async function workspaces(): Promise<Workspace[]> {
  const root = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as { workspaces: string[] };
  const dirs: string[] = [];
  for (const pattern of root.workspaces) {
    for await (const p of new Bun.Glob(pattern.endsWith("/*") ? `${pattern}/package.json` : `${pattern}/package.json`).scan({
      cwd: REPO,
      onlyFiles: true,
    })) {
      dirs.push(dirname(join(REPO, p)));
    }
  }
  const out: Workspace[] = [];
  for (const dir of dirs.sort()) {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name: string };
    if (pkg.name === "@fp-pcb/e2e") continue; // Playwright, not bun test
    const files = await collectTests(dir);
    if (files.length === 0) continue;
    out.push({
      name: pkg.name,
      dir,
      unit: files.filter((f) => !INTEGRATION.test(f)),
      integration: files.filter((f) => INTEGRATION.test(f)),
    });
  }
  return out;
}

async function collectTests(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await collectTests(join(dir, e.name))));
    } else if (TEST_FILE.test(e.name)) out.push(join(dir, e.name));
  }
  return out.sort();
}

function parseArgs(argv: string[]): { mode: Mode; filter: string | null; extra: string[] } {
  const mode = (argv[0] ?? "unit") as Mode;
  if (!["unit", "integration", "list"].includes(mode)) {
    console.error(`unknown mode '${mode}'; expected unit | integration | list`);
    process.exit(2);
  }
  let filter: string | null = null;
  const extra: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--filter") filter = argv[++i] ?? null;
    else if (a === "--") (extra.push(...argv.slice(i + 1)), (i = argv.length));
    else extra.push(a);
  }
  return { mode, filter, extra };
}

const { mode, filter, extra } = parseArgs(process.argv.slice(2));
const all = (await workspaces()).filter((w) => !filter || w.name.includes(filter) || relative(REPO, w.dir).includes(filter));

if (mode === "list") {
  for (const w of all) {
    console.log(`${w.name} (${relative(REPO, w.dir)})`);
    for (const f of w.unit) console.log(`  unit         ${relative(w.dir, f)}`);
    for (const f of w.integration) console.log(`  integration  ${relative(w.dir, f)}`);
  }
  process.exit(0);
}

if (mode === "integration") {
  const cli = process.env.KICAD_CLI;
  if (!cli) {
    const msg = "KICAD_CLI is not set; integration tests fall back to ../kicad/build/release/... and skip when it is missing";
    if (process.env.KICAD_INTEGRATION_REQUIRED === "1") {
      console.error(`error: ${msg}`);
      process.exit(1);
    }
    console.warn(`warning: ${msg}`);
  } else if (!existsSync(cli)) {
    console.error(`error: KICAD_CLI=${cli} does not exist`);
    process.exit(1);
  } else {
    console.log(`KICAD_CLI=${cli}`);
  }
}

let failed = 0;
let ran = 0;
const t0 = performance.now();
for (const w of all) {
  const files = mode === "unit" ? w.unit : w.integration;
  if (files.length === 0) continue;
  ran++;
  const rel = files.map((f) => relative(w.dir, f));
  console.log(`\n▶ ${w.name}  (${rel.length} ${mode} file${rel.length === 1 ? "" : "s"})`);
  const proc = Bun.spawn(["bun", "test", ...extra, ...rel], {
    cwd: w.dir,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
  });
  const code = await proc.exited;
  if (code !== 0) {
    failed++;
    console.error(`✗ ${w.name}: bun test exited with ${code}`);
  }
}
const secs = ((performance.now() - t0) / 1000).toFixed(1);
if (ran === 0) console.log(`no ${mode} test files found${filter ? ` for filter '${filter}'` : ""}`);
console.log(`\n${mode}: ${ran - failed}/${ran} package(s) passed in ${secs}s`);
process.exit(failed ? 1 : 0);
