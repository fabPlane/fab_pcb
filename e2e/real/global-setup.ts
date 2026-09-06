/**
 * Starts the bridge for the real-server suite when nothing answers on BRIDGE_URL, and stops it
 * again in the returned teardown. Needs KICAD_CLI (the suite is skipped without it, so this is
 * a no-op then).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

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
  const child: ChildProcess = spawn("bun", ["run", "src/main.ts"], {
    cwd: resolve(import.meta.dirname, "..", "..", "packages", "bridge"),
    env: { ...process.env, PORT: port },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !(await healthy())) await new Promise((r) => setTimeout(r, 300));
  if (!(await healthy())) {
    child.kill("SIGTERM");
    throw new Error(`bridge did not answer on ${BRIDGE_URL} within 30 s`);
  }
  return async () => {
    child.kill("SIGTERM");
  };
}
