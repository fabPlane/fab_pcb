/** Opt-in disposable-board postprocessor. Never use against an editor-owned file. */
import { readFile, writeFile, mkdir, rename, rm, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

type FileSnapshot = { name: string; sha256: string; base64: string };
const hash = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const extensions = [".kicad_pcb", ".kicad_pro", ".kicad_dru"];
async function snapshots(board: string) {
  const files = [];
  for (const ext of extensions) {
    const path = board.replace(/\.kicad_pcb$/, ext);
    try {
      if (!(await lstat(path)).isFile()) throw new Error("Expected regular board/rule file");
      files.push({ name: "board" + ext, bytes: await readFile(path) });
    } catch (e) { if (ext !== ".kicad_dru" || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return files;
}
function decode(files: FileSnapshot[]) {
  if (!Array.isArray(files) || ![2, 3].includes(files.length)) throw new Error("Incomplete snapshot");
  return files.map((file, index) => {
    if (file.name !== "board" + extensions[index]) throw new Error("Unexpected snapshot member");
    const bytes = Buffer.from(file.base64, "base64");
    if (hash(bytes) !== file.sha256) throw new Error("Snapshot hash mismatch");
    return { name: file.name, bytes };
  });
}
/** Bundles are local output of the selected search process, not signed attestations. */
export async function applyThermalBundle(source: string, routed: string, bundlePath: string, staging: string) {
  if (await realpath(source) === await realpath(routed)) throw new Error("Source and routed board alias");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  if (bundle.format !== "fab-router-native-repair-v1" || bundle.validation?.accepted !== true || bundle.validation.newErrors?.length !== 0
    || bundle.validation.lostTerminalPairs !== 0 || bundle.validation.repair?.accepted !== true || bundle.validation.repair.lostTerminalPairs !== 0) throw new Error("Unaccepted repair bundle");
  const input = decode(bundle.input), original = decode(bundle.routed), candidate = decode(bundle.candidate);
  for (const [path, expected] of [[source, input], [routed, original]] as const) {
    const actual = await snapshots(path);
    if (actual.length !== expected.length || actual.some((f, i) => f.name !== expected[i]!.name || !f.bytes.equals(expected[i]!.bytes))) throw new Error("Caller board or rules changed during search");
  }
  if (candidate.length !== input.length || candidate.slice(1).some((file, i) => !file.bytes.equals(input[i + 1]!.bytes))) throw new Error("Repair changed native sidecars");
  if (hash(input[0]!.bytes) !== bundle.validation.inputSha256 || hash(original[0]!.bytes) !== bundle.validation.repair.routedSha256 || hash(candidate[0]!.bytes) !== bundle.validation.candidateSha256) throw new Error("Validation snapshot mismatch");
  // Stage beside the board for a single-filesystem atomic rename. Rule sidecars are
  // already byte-identical and stay in place. Caller guarantees exclusive ownership.
  await writeFile(staging, candidate[0]!.bytes, { flag: "wx" });
  try { await rename(staging, routed); } finally { await rm(staging, { force: true }); }
}

export async function postprocess(source: string, routed: string, engine: string, work: string) {
  if (![source, routed].every(p => p.endsWith(".kicad_pcb")) || resolve(source) === resolve(routed)) throw new Error("Expected distinct disposable native boards");
  if (await realpath(source) === await realpath(routed)) throw new Error("Source and routed board alias");
  await mkdir(work); // exclusive; keep all logs and proposals
  const bundle = join(work, "accepted.json");
  const child = Bun.spawn(["timeout", "--kill-after=5s", "600s", process.execPath, join(resolve(engine), "tools/native-thermal-search.ts"), resolve(source), resolve(routed), resolve(bundle), resolve(join(work, "search"))], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await writeFile(join(work, "search.stdout.log"), stdout, { flag: "wx" });
  await writeFile(join(work, "search.stderr.log"), stderr, { flag: "wx" });
  const result = { applied: false, searchExitCode: exitCode, status: exitCode === 1 ? "rejected" : exitCode === 0 ? "accepted" : "search-failed" };
  if (exitCode === 0) {
    await applyThermalBundle(source, routed, bundle, routed + ".thermal-staging");
    result.applied = true;
  }
  // A declined/failed search is explicit evidence, not an accepted repair. Leave
  // the original router result for the independent benchmark checker to score.
  await writeFile(join(work, "postprocess.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}
if (import.meta.main) {
  const [source, routed, engine, work] = process.argv.slice(2);
  if (!source || !routed || !engine || !work || process.argv.length !== 6) throw new Error("Usage: bun native-thermal-postprocess.ts source.kicad_pcb routed.kicad_pcb engine-directory new-work-directory");
  console.log(JSON.stringify(await postprocess(source, routed, engine, work)));
}
