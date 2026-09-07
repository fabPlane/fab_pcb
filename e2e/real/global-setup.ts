/**
 * Starts the bridge for the real-server suite when nothing answers on BRIDGE_URL, and stops it
 * again in the returned teardown. Needs KICAD_CLI (the suite is skipped without it, so this is
 * a no-op then).
 *
 * The bridge is rooted in a throw-away workspace (removed with the teardown) unless WORKSPACE_ROOT
 * says otherwise: the specs copy their projects into the workspace root, and the bridge's own
 * default root is the KiCad checkout's `qa/data`, which a run must not write into.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://127.0.0.1:4020";

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BRIDGE_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!process.env.KICAD_CLI) return async () => {};
  if (await healthy()) return async () => {};
  const port = new URL(BRIDGE_URL).port || "4020";
  const tempRoot = process.env.WORKSPACE_ROOT ? null : mkdtempSync(join(tmpdir(), "fp-pcb-e2e-ws-"));
  const child: ChildProcess = spawn("bun", ["run", "src/main.ts"], {
    cwd: resolve(import.meta.dirname, "..", "..", "packages", "bridge"),
    env: { ...process.env, PORT: port, ...(tempRoot ? { WORKSPACE_ROOT: tempRoot } : {}) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(await healthy())) await new Promise((r) => setTimeout(r, 300));
  if (!(await healthy())) {
    child.kill("SIGTERM");
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`bridge did not answer on ${BRIDGE_URL} within 30 s`);
  }
  return async () => {
    child.kill("SIGTERM");
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  };
}
