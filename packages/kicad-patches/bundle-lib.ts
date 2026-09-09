import { readdir, stat } from "node:fs/promises";

export interface BundleTarget {
  bunTarget: string;
  bridgeName: string;
  kicadCliName: string;
  socketTransport: "ipc" | "ws";
}

const TARGETS: Record<string, BundleTarget> = {
  "linux-x64": { bunTarget: "bun-linux-x64", bridgeName: "fp-pcb-bridge", kicadCliName: "kicad-cli", socketTransport: "ipc" },
  "darwin-x64": { bunTarget: "bun-darwin-x64", bridgeName: "fp-pcb-bridge", kicadCliName: "kicad-cli", socketTransport: "ipc" },
  "darwin-arm64": { bunTarget: "bun-darwin-arm64", bridgeName: "fp-pcb-bridge", kicadCliName: "kicad-cli", socketTransport: "ipc" },
  "windows-x64": { bunTarget: "bun-windows-x64", bridgeName: "fp-pcb-bridge.exe", kicadCliName: "kicad-cli.exe", socketTransport: "ws" },
};

export function targetSpec(target: string): BundleTarget {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`unsupported bundle target ${JSON.stringify(target)}; expected ${Object.keys(TARGETS).join(", ")}`);
  return spec;
}

export async function validateLibraryDirectory(kind: "footprint" | "symbol", root: string): Promise<void> {
  if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`${kind} library directory not found: ${root}`);
  const suffix = kind === "footprint" ? ".pretty" : ".kicad_sym";
  const entries = await readdir(root, { withFileTypes: true });
  const found = entries.some((entry) => entry.name.endsWith(suffix) && (kind === "footprint" ? entry.isDirectory() : entry.isFile()));
  if (!found) throw new Error(`${kind} library directory ${root} contains no ${suffix} libraries`);
}

export async function validateJsAutorouterSource(root: string): Promise<void> {
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new Error(`js_autorouter source directory not found: ${root}`);
  }
  if (!(await stat(`${root}/package.json`).catch(() => null))?.isFile()) {
    throw new Error(`js_autorouter package.json not found in ${root}`);
  }
  if (!(await stat(`${root}/src/index.ts`).catch(() => null))?.isFile()) {
    throw new Error(`js_autorouter entry point not found: ${root}/src/index.ts`);
  }
}
