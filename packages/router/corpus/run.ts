#!/usr/bin/env bun
import { resolve } from "node:path";
import { corpusCases, type CorpusTier } from "./cases";

export interface CorpusResult {
  id: string;
  quality: "gate" | "observe";
  result?: { elapsedMs: number; timedOut: boolean; totalConnections: number; unrouted: number; tracks: number; vias: number };
  violations?: Array<{ rule: string; detail: string }>;
  failures: string[];
  observations: string[];
}

export async function runCorpus(tier: CorpusTier): Promise<CorpusResult[]> {
  const results: CorpusResult[] = [];
  for (const testCase of corpusCases(tier)) {
    const proc = Bun.spawn(["bun", resolve(import.meta.dir, "worker.ts"), testCase.id], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), testCase.hardTimeoutMs);
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(timer);
    if (code !== 0) {
      results.push({
        id: testCase.id,
        quality: testCase.quality,
        failures: [`router worker exited ${code}: ${stderr.trim() || "hard timeout"}`],
        observations: [],
      });
      continue;
    }
    const row = JSON.parse(stdout) as Omit<CorpusResult, "failures" | "observations">;
    const failures: string[] = [];
    const observations: string[] = [];
    if (row.result?.timedOut) (testCase.quality === "gate" ? failures : observations).push("router reported a timeout");
    if (testCase.requireAllRouted && row.result?.unrouted) failures.push(`${row.result.unrouted} connection(s) remained open`);
    if (row.violations?.length) {
      const counts = new Map<string, number>();
      for (const violation of row.violations) counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
      const message = [...counts].map(([rule, count]) => `${count} ${rule}`).join(", ");
      (testCase.quality === "gate" ? failures : observations).push(message);
    }
    results.push({ ...row, failures, observations });
  }
  return results;
}

if (import.meta.main) {
  const tier = (process.argv.includes("--nightly") ? "nightly" : "pr") as CorpusTier;
  const results = await runCorpus(tier);
  console.log(JSON.stringify({ schema: 1, tier, results }, null, 2));
  process.exit(results.every((result) => result.failures.length === 0) ? 0 : 1);
}
