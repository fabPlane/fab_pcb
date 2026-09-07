/**
 * Spawns `kicad-cli api-server <board> --socket /tmp/kicad/<unique>.sock` on a temporary copy of a
 * fixture directory and connects a `KiCad` handle. Shared by the bench and the integration tests.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KiCad, NngIpcTransport, type Board, type Transport } from "@fp-pcb/client";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..", "..");
export const KICAD_ROOT = process.env.KICAD_SRC ? resolve(process.env.KICAD_SRC) : resolve(REPO, "..", "kicad");
export const DEFAULT_KICAD_CLI = `${KICAD_ROOT}/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli`;
export const KICAD_CLI = process.env.KICAD_CLI ?? DEFAULT_KICAD_CLI;
export const FIXTURE_BOARDS = join(REPO, "e2e", "fixtures", "boards");

export function haveKicad(): boolean {
  return existsSync(KICAD_CLI);
}

export interface FixtureBoard {
  name: string;
  dir: string;
  /** File name of the placed-but-unrouted variant. */
  unrouted: string;
  /** File name of the original, routed board. */
  routed: string;
}

/** The practice boards under e2e/fixtures/boards that have an `*.unrouted.kicad_pcb` variant. */
export async function fixtureBoards(): Promise<FixtureBoard[]> {
  const out: FixtureBoard[] = [];
  if (!existsSync(FIXTURE_BOARDS)) return out;
  for (const name of (await readdir(FIXTURE_BOARDS)).sort()) {
    if (name.startsWith(".")) continue; // scratch copies other tools leave next to the fixtures
    const dir = join(FIXTURE_BOARDS, name);
    if (!(await stat(dir)).isDirectory()) continue;
    const files = await readdir(dir);
    const unrouted = files.filter((f) => f.endsWith(".unrouted.kicad_pcb") && !f.includes("_v2")).sort()[0];
    if (!unrouted) continue;
    out.push({ name, dir, unrouted, routed: unrouted.replace(".unrouted.kicad_pcb", ".kicad_pcb") });
  }
  return out;
}

export interface RunningBoard {
  dir: string;
  pcb: string;
  socketPath: string;
  /** The connection itself, for code that opens its own client on it (the bridge job does). */
  transport: Transport;
  kicad: KiCad;
  board: Board;
  stderr(): string;
  stop(): Promise<void>;
}

/** Copies `fixture.dir` to a temp dir, starts a server on the unrouted board and waits until it answers. */
export async function openFixture(
  fixture: FixtureBoard,
  opts: { prefix?: string; file?: "unrouted" | "routed"; cli?: string } = {},
): Promise<RunningBoard> {
  const dir = await mkdtemp(join(tmpdir(), `fp-pcb-router-${fixture.name}-`));
  await cp(fixture.dir, dir, { recursive: true });
  const pcb = join(dir, opts.file === "routed" ? fixture.routed : fixture.unrouted);
  return openBoardFile(pcb, { ...opts, cleanupDir: dir });
}

export async function openBoardFile(pcb: string, opts: { prefix?: string; cli?: string; cleanupDir?: string } = {}): Promise<RunningBoard> {
  const cli = opts.cli ?? KICAD_CLI;
  await mkdir("/tmp/kicad", { recursive: true });
  const socketPath = `/tmp/kicad/${opts.prefix ?? "router"}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
  await rm(socketPath, { force: true });
  const proc = Bun.spawn([cli, "api-server", pcb, "--socket", socketPath], { stdout: "ignore", stderr: "pipe" });
  const stderrChunks: string[] = [];
  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrChunks.push(new TextDecoder().decode(value));
    }
  })().catch(() => {});
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`kicad-cli exited with ${proc.exitCode} before listening:\n${stderrChunks.join("")}`);
    if (existsSync(socketPath)) break;
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`kicad-cli did not create ${socketPath} within 60 s`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const transport = await NngIpcTransport.connect({ path: socketPath, defaultTimeoutMs: 120_000 });
  const kicad = await KiCad.connect(transport, {
    clientName: `fp-pcb/router-${opts.prefix ?? "bench"}-${process.pid}`,
    readyTimeoutMs: 120_000,
  });
  const board = await kicad.currentBoard();
  if (!board) {
    proc.kill();
    throw new Error(`server did not open ${pcb}`);
  }
  return {
    dir: opts.cleanupDir ?? dirname(pcb),
    pcb,
    socketPath,
    transport,
    kicad,
    board,
    stderr: () => stderrChunks.join(""),
    async stop() {
      await transport.close().catch(() => {});
      proc.kill("SIGTERM");
      const t = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      await proc.exited;
      clearTimeout(t);
      await rm(socketPath, { force: true });
      if (opts.cleanupDir && !process.env.KEEP_BENCH_DIRS) await rm(opts.cleanupDir, { recursive: true, force: true });
    },
  };
}
