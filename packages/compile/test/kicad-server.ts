/**
 * Spawns a bare fork `kicad-cli api-server` (no project) for the integration tests and creates
 * projects whose `fp-lib-table` points at the KiCad checkout's `qa/data/libraries`, the repo's
 * convention for fixtures that must match the pinned `KICAD_COMMIT` (see e2e/fixtures/NOTICE).
 * The two footprints the tests use, `R_0402_1005Metric` and `R_0603_1608Metric`, live there.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KiCad, NngIpcTransport, type Board, type Transport } from "@fp-pcb/client";
import type { LibrarySpec, Netlist } from "../src/types";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..", "..");
export const KICAD_ROOT = process.env.KICAD_SRC ? resolve(process.env.KICAD_SRC) : resolve(REPO, "..", "kicad");
export const KICAD_CLI = process.env.KICAD_CLI ?? `${KICAD_ROOT}/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli`;
export const QA_LIBRARIES = `${KICAD_ROOT}/qa/data/libraries`;

export function haveKicad(): boolean {
  return existsSync(KICAD_CLI) && existsSync(join(QA_LIBRARIES, "Resistor_SMD.pretty"));
}

/** Two resistors from `qa/data/libraries/Resistor_SMD.pretty`, two nets. */
export const NETLIST: Netlist = {
  components: [
    { ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric" },
    { ref: "R2", value: "2k2", footprint: "Resistor_SMD:R_0603_1608Metric" },
  ],
  nets: [
    {
      name: "N1",
      nodes: [
        { ref: "R1", pin: "1" },
        { ref: "R2", pin: "1" },
      ],
    },
    {
      name: "N2",
      nodes: [
        { ref: "R1", pin: "2" },
        { ref: "R2", pin: "2" },
      ],
    },
  ],
};

export const RESISTOR_LIBRARY: LibrarySpec = {
  kind: "footprint",
  nickname: "Resistor_SMD",
  uri: join(QA_LIBRARIES, "Resistor_SMD.pretty"),
  description: "qa copy",
};

export interface RunningServer {
  kicad: KiCad;
  transport: Transport;
  socketPath: string;
  stderr(): string;
  stop(): Promise<void>;
}

export async function startBareServer(prefix = "compile"): Promise<RunningServer> {
  await mkdir("/tmp/kicad", { recursive: true });
  const socketPath = `/tmp/kicad/${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
  await rm(socketPath, { force: true });
  const { KICAD10_FOOTPRINT_DIR: _drop, ...env } = process.env;
  const proc = Bun.spawn([KICAD_CLI, "api-server", "--socket", socketPath], { stdout: "ignore", stderr: "pipe", env });
  const err: string[] = [];
  void (async () => {
    const r = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      err.push(new TextDecoder().decode(value));
    }
  })().catch(() => {});
  const deadline = Date.now() + 60_000;
  while (!existsSync(socketPath)) {
    if (proc.exitCode !== null) throw new Error(`kicad-cli exited ${proc.exitCode} before listening:\n${err.join("")}`);
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`kicad-cli did not create ${socketPath} within 60 s`);
    }
    await Bun.sleep(50);
  }
  const transport = await NngIpcTransport.connect({ path: socketPath, defaultTimeoutMs: 120_000 });
  const kicad = await KiCad.connect(transport, { clientName: `fp-pcb/compile-test-${process.pid}`, readyTimeoutMs: 120_000 });
  return {
    kicad,
    transport,
    socketPath,
    stderr: () => err.join(""),
    async stop() {
      await transport.close().catch(() => {});
      proc.kill("SIGTERM");
      const k = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      await proc.exited;
      clearTimeout(k);
      await rm(socketPath, { force: true });
    },
  };
}

/** Writes a project-local `fp-lib-table` for the qa resistor library into `dir`. */
export async function writeLibraryTable(dir: string, libs: readonly LibrarySpec[] = [RESISTOR_LIBRARY]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const rows = libs
    .map((l) => `  (lib (name "${l.nickname}") (type "KiCad") (uri "${l.uri}") (options "") (descr "${l.description ?? ""}"))`)
    .join("\n");
  await writeFile(join(dir, "fp-lib-table"), `(fp_lib_table\n  (version 7)\n${rows}\n)\n`);
}

/** A new project in `<root>/<name>/<name>.kicad_pro` with the qa library table, its board open. */
export async function newProjectWithLibraries(
  kicad: KiCad,
  root: string,
  name: string,
): Promise<{ board: Board; projectDir: string; pcbPath: string }> {
  const projectDir = join(root, name);
  await writeLibraryTable(projectDir);
  await mkdir(join(projectDir, ".fp-pcb"), { recursive: true });
  const project = await kicad.newProject(join(projectDir, `${name}.kicad_pro`));
  const board = (await kicad.currentBoard()) ?? (await project.openBoard());
  return { board, projectDir, pcbPath: join(projectDir, `${name}.kicad_pcb`) };
}
