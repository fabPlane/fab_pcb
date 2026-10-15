import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeroutingRuleInput } from "../src/specctra/board-rule-floors";
import { writeDsn } from "../src/specctra/dsn";
import { overlayDsnRules } from "../src/specctra/rule-overlay";
import { child, children, parseSExpr, type SExpr } from "../src/specctra/sexpr";
import { FreeroutingRouter } from "../src/freerouting";
import { twoNetBoard } from "./fixtures";

test("minimum width, independent hole clearance and via constraints floor every class without mutating input", () => {
  const input = twoNetBoard();
  input.rules.minTrackWidth = 300_000;
  input.rules.holeClearance = 400_000;
  input.rules.minViaDrill = 500_000;
  input.rules.minViaAnnularWidth = 200_000;
  const effective = freeroutingRuleInput(input);
  expect(effective.rules.default).toMatchObject({ trackWidth: 300_000, clearance: 400_000, viaDrill: 500_000, viaDiameter: 900_000 });
  expect(effective.rules.perNet.get("A")).toEqual(effective.rules.default);
  expect(input.rules.default.trackWidth).toBe(250_000);
  for (const dsn of [writeDsn(effective), overlayDsnRules(writeDsn(input), effective)]) {
    const pcb = parseSExpr(dsn)[0] as SExpr[];
    const rule = child(child(pcb, "structure"), "rule");
    expect(child(rule, "width")![1]).toBe("300");
    for (const clearance of children(rule, "clearance")) expect(Number(clearance[1])).toBeGreaterThanOrEqual(400);
    for (const cls of children(child(pcb, "network"), "class")) {
      if (cls[1]?.toString().startsWith("fabdesk_rule_")) {
        expect(child(child(cls, "rule"), "width")![1]).toBe("300");
        expect(child(child(cls, "rule"), "clearance")![1]).toBe("400");
      }
    }
  }
});

test("explicit widths above the minimum remain exact", () => {
  const input = twoNetBoard();
  input.rules.perNet.set("A", { ...input.rules.default, trackWidth: 550_000 });
  expect(freeroutingRuleInput(input).rules.perNet.get("A")!.trackWidth).toBe(550_000);
});

test("no-width adapter disables both neckdown paths when the board has a minimum", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fr-minimum-"));
  try {
    const java = join(dir, "java"),
      jar = join(dir, "fake.jar");
    await Bun.write(jar, "fake");
    await Bun.write(
      java,
      `#!/bin/sh
printf '%s\\n' "$@" > '${dir}/args'
while [ $# -gt 0 ]; do if [ "$1" = "-do" ]; then out="$2"; fi; shift; done
printf '%s' '(session board (routes (resolution um 10) (network_out)))' > "$out"
`,
    );
    await chmod(java, 0o755);
    await new FreeroutingRouter({}, { mode: "builtin", jar, java, workDir: dir }).route(twoNetBoard(), {});
    const args = await readFile(join(dir, "args"), "utf8");
    expect(args).toContain("--router.automatic_neckdown=false");
    expect(args).toContain("--router.fanout.enabled=false");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
