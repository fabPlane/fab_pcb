import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyThermalBundle, postprocess } from "../bench/native-thermal-postprocess";
const hash = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
async function fixture(run: (f: { root: string; source: string; routed: string; bundle: string; payload: any }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "thermal-postprocess-"));
  try {
    const source = join(root, "source.kicad_pcb"),
      routed = join(root, "routed.kicad_pcb"),
      bundle = join(root, "accepted.json");
    for (const [board, content] of [
      [source, "authored board"],
      [routed, "routed board"],
    ]) {
      await writeFile(board!, content!);
      await writeFile(board!.replace(".kicad_pcb", ".kicad_pro"), "native project");
    }
    const files = (board: string) =>
      [Buffer.from(board), Buffer.from("native project")].map((bytes, i) => ({
        name: i ? "board.kicad_pro" : "board.kicad_pcb",
        sha256: hash(bytes),
        base64: bytes.toString("base64"),
      }));
    const payload = {
      format: "fab-router-native-repair-v1",
      input: files("authored board"),
      routed: files("routed board"),
      candidate: files("repaired board"),
      validation: {
        accepted: true,
        newErrors: [],
        lostTerminalPairs: 0,
        inputSha256: hash(Buffer.from("authored board")),
        candidateSha256: hash(Buffer.from("repaired board")),
        repair: { accepted: true, lostTerminalPairs: 0, routedSha256: hash(Buffer.from("routed board")) },
      },
    };
    await writeFile(bundle, JSON.stringify(payload));
    await run({ root, source, routed, bundle, payload });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("offline handoff applies exact checked board bytes and preserves authored source and rules", async () => {
  await fixture(async ({ root, source, routed, bundle }) => {
    await applyThermalBundle(source, routed, bundle, join(root, "staging"));
    expect(await readFile(routed, "utf8")).toBe("repaired board");
    expect(await readFile(source, "utf8")).toBe("authored board");
    expect(await readFile(routed.replace(".kicad_pcb", ".kicad_pro"), "utf8")).toBe("native project");
  });
});
for (const change of ["source", "routed", "rules", "added-rules", "bundle-hash", "validation-hash", "lost-pairs", "candidate-rules"])
  test(`offline handoff refuses ${change} drift`, async () => {
    await fixture(async ({ root, source, routed, bundle, payload }) => {
      if (change === "source") await writeFile(source, "changed source");
      if (change === "routed") await writeFile(routed, "changed route");
      if (change === "rules") await writeFile(routed.replace(".kicad_pcb", ".kicad_pro"), "changed rules");
      if (change === "added-rules") await writeFile(routed.replace(".kicad_pcb", ".kicad_dru"), "new rules");
      if (change === "bundle-hash") payload.candidate[0].base64 = Buffer.from("unchecked").toString("base64");
      if (change === "validation-hash") payload.validation.candidateSha256 = "wrong";
      if (change === "lost-pairs") payload.validation.repair.lostTerminalPairs = 2;
      if (change === "candidate-rules") {
        const bytes = Buffer.from("changed rules");
        payload.candidate[1] = { name: "board.kicad_pro", sha256: hash(bytes), base64: bytes.toString("base64") };
      }
      await writeFile(bundle, JSON.stringify(payload));
      const before = await readFile(routed);
      await expect(applyThermalBundle(source, routed, bundle, join(root, "staging"))).rejects.toThrow();
      expect(await readFile(routed)).toEqual(before);
    });
  });
for (const code of [1, 2])
  test(`declined search exit ${code} retains original output and explicit evidence`, async () => {
    await fixture(async ({ root, source, routed }) => {
      await mkdir(join(root, "tools"));
      await writeFile(join(root, "tools/native-thermal-search.ts"), `console.error("retained diagnostic"); process.exit(${code});`);
      const work = join(root, "work");
      const result = await postprocess(source, routed, root, work);
      expect(result.applied).toBe(false);
      expect(result.status).toBe(code === 1 ? "rejected" : "search-failed");
      expect(await readFile(routed, "utf8")).toBe("routed board");
      expect(await readFile(join(work, "search.stderr.log"), "utf8")).toContain("retained diagnostic");
      expect(JSON.parse(await readFile(join(work, "postprocess.json"), "utf8"))).toEqual(result);
    });
  });

test("offline handoff refuses directory aliases of the authored source", async () => {
  await fixture(async ({ root, source, bundle }) => {
    await symlink(root, join(root, "alias"), "dir");
    await expect(applyThermalBundle(source, join(root, "alias/source.kicad_pcb"), bundle, join(root, "staging"))).rejects.toThrow("alias");
    expect(await readFile(source, "utf8")).toBe("authored board");
  });
});

// Native integration is opt-in because released engine checkouts need not yet
// contain the offline search tools. Pure handoff tests above always run.
const nativeEngine = process.env.FAB_ROUTER_NATIVE_SEARCH_SOURCE;
test.skipIf(!nativeEngine)(
  "native post-import pipeline removes a real thermal before independent scoring",
  async () => {
    const { gunzipSync } = await import("node:zlib");
    const root = await mkdtemp(join(tmpdir(), "native-thermal-integration-"));
    const fixtures = new URL("./fixtures/native-thermal-j4/", import.meta.url);
    try {
      for (const role of ["source", "routed"]) {
        await writeFile(join(root, role + ".kicad_pcb"), gunzipSync(await readFile(new URL(role + ".kicad_pcb.gz", fixtures))));
        for (const ext of [".kicad_pro", ".kicad_dru"])
          await writeFile(join(root, role + ext), await readFile(new URL("board" + ext, fixtures)));
      }
      const source = join(root, "source.kicad_pcb"),
        routed = join(root, "routed.kicad_pcb"),
        work = join(root, "work");
      const original = { source: await readFile(source), routed: await readFile(routed) };
      const result = await postprocess(source, routed, nativeEngine!, work);
      const baseline = JSON.parse(await readFile(join(work, "search/baseline.json"), "utf8"));
      expect(baseline.newErrors.map((e: { type: string }) => e.type)).toEqual(["starved_thermal"]);
      expect(result.applied).toBe(true);
      const bundle = JSON.parse(await readFile(join(work, "accepted.json"), "utf8"));
      expect(bundle.validation.newErrors).toHaveLength(0);
      expect(bundle.validation.opensAfter).toBe(0);
      expect(bundle.validation.lostTerminalPairs).toBe(0);
      expect(bundle.validation.repair.lostTerminalPairs).toBe(0);
      expect(await readFile(source)).toEqual(original.source);
      expect(await readFile(routed)).not.toEqual(original.routed);
      expect(await readFile(routed)).toEqual(Buffer.from(bundle.candidate[0].base64, "base64"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
