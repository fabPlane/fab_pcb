/**
 * Shared helper for tests that need a real `kicad-cli api-server`: spawns one on a unique socket
 * (via ./kicad-fixtures), connects `NngIpcTransport` + `KiCad`, and offers a temporary copy of the
 * kitchen-sink fixtures as one project so board and schematic can be open at the same time
 * (the headless server allows a single project).
 */
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NngIpcTransport } from "../src/transport";
import { KiCad } from "../src/model";
import { KICAD_CLI, KITCHEN_SINK_PCB, KITCHEN_SINK_SCH, haveKicad, startKicadServer, type KicadServer } from "./kicad-fixtures";

export { KICAD_CLI, KITCHEN_SINK_PCB, KITCHEN_SINK_SCH, haveKicad };

export const KICAD_DATA = KITCHEN_SINK_PCB.replace(/\/pcbnew\/api_kitchen_sink\.kicad_pcb$/, "");
/** A small footprint library shipped with KiCad's QA data (R_0402/R_0603/...). */
export const QA_RESISTOR_LIB = `${KICAD_DATA}/libraries/Resistor_SMD.pretty`;
/** A KiCad s-expression netlist from the QA data, for ImportNetlist dry runs. */
export const QA_NETLIST = `${KICAD_DATA}/eeschema/netlists/prefix_bus_alias/prefix_bus_alias.net`;
/** KiCad's QA symbol library (Device.kicad_sym), for headless symbol documents. */
export const QA_DEVICE_LIB = `${KICAD_DATA}/libraries/Device.kicad_sym`;

export interface TempProject {
  dir: string;
  pro: string;
  pcb: string;
  sch: string;
  dru: string;
  cleanup(): Promise<void>;
}

/** Copies the kitchen-sink board (+ project + DRU) and schematic into one temp project directory. */
export async function tempProject(prefix = "kicad-web-conf-"): Promise<TempProject> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const base = KITCHEN_SINK_PCB.replace(/\.kicad_pcb$/, "");
  const pro = join(dir, "api_kitchen_sink.kicad_pro");
  const pcb = join(dir, "api_kitchen_sink.kicad_pcb");
  const dru = join(dir, "api_kitchen_sink.kicad_dru");
  const sch = join(dir, "api_kitchen_sink.kicad_sch");
  await cp(`${base}.kicad_pro`, pro);
  await cp(`${base}.kicad_pcb`, pcb);
  await cp(`${base}.kicad_dru`, dru);
  await cp(KITCHEN_SINK_SCH, sch);
  // Project-local footprint library table so `Resistor_SMD:*` resolves without an installed KiCad.
  await writeFile(
    join(dir, "fp-lib-table"),
    `(fp_lib_table\n  (version 7)\n  (lib (name "Resistor_SMD") (type "KiCad") (uri "${QA_RESISTOR_LIB}") (options "") (descr "QA resistors"))\n)\n`,
  );
  return { dir, pro, pcb, sch, dru, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface RunningKiCad {
  server: KicadServer;
  transport: NngIpcTransport;
  kicad: KiCad;
  stop(): Promise<void>;
}

/** Spawns a server (optionally preloading `file`) and connects a `KiCad` handle once it is ready. */
export async function startKiCad(file: string | null = null, prefix = "conf", cli?: string): Promise<RunningKiCad> {
  const server = await startKicadServer(file, prefix, cli);
  const transport = await NngIpcTransport.connect({ path: server.socketPath, defaultTimeoutMs: 60_000 });
  const kicad = await KiCad.connect(transport, { clientName: `kicad-web/${prefix}-${process.pid}`, readyTimeoutMs: 60_000 });
  return {
    server,
    transport,
    kicad,
    async stop() {
      await transport.close().catch(() => {});
      await server.stop();
    },
  };
}

if (!haveKicad()) {
  console.log(`[skip] kicad-cli not found at ${KICAD_CLI} (set KICAD_CLI to run the conformance tests)`);
}
