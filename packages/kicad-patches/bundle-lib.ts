import { lstat, readFile, readlink, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/** Guard the known USB-C shield mapping that KiCad DRC cannot detect after a mismatched import. */
export async function validateUsbCShieldCompatibility(footprints: string, symbols: string): Promise<void> {
  const symbolPath = join(symbols, "Connector.kicad_sym");
  const footprintPath = join(footprints, "Connector_USB.pretty", "USB_C_Receptacle_GCT_USB4125-xx-x_6P_TopMnt_Horizontal.kicad_mod");
  const [symbol, footprint] = await Promise.all([
    readFile(symbolPath, "utf8").catch(() => {
      throw new Error(`USB-C symbol library not found: ${symbolPath}`);
    }),
    readFile(footprintPath, "utf8").catch(() => {
      throw new Error(`USB-C footprint not found: ${footprintPath}`);
    }),
  ]);
  const symbolShield = symbol.match(/\(symbol "USB_C_Receptacle_PowerOnly_6P_1_1"[\s\S]*?\(name "SHIELD"[\s\S]*?\(number "([^"]+)"/)?.[1];
  if (!symbolShield) throw new Error(`USB-C shield pin not found in ${symbolPath}`);

  const shieldPads = [...footprint.matchAll(/^\s*\(pad "(S1|SH)"\s/gm)]
    .map((match) => match[1])
    .filter((number): number is string => Boolean(number));
  const footprintShields = new Set(shieldPads);
  if (shieldPads.length !== 4 || footprintShields.size !== 1) {
    throw new Error(`expected four consistently numbered USB-C shield pads in ${footprintPath}`);
  }
  const footprintShield = [...footprintShields][0];
  if (symbolShield !== footprintShield) {
    throw new Error(`USB-C shield pin/pad mismatch: symbol uses ${symbolShield}, footprint uses ${footprintShield}`);
  }
}

export async function validateFabRouterSource(root: string): Promise<void> {
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new Error(`fab_router source directory not found: ${root}`);
  }
  if (!(await stat(`${root}/package.json`).catch(() => null))?.isFile()) {
    throw new Error(`fab_router package.json not found in ${root}`);
  }
  const pkg = JSON.parse(await readFile(`${root}/package.json`, "utf8")) as {
    name?: string;
    private?: boolean;
    dependencies?: Record<string, string>;
  };
  if (pkg.name !== "@fabplane/fab-router" || pkg.private !== true) {
    throw new Error(`unexpected fab_router package metadata in ${root}/package.json`);
  }
  if (Object.keys(pkg.dependencies ?? {}).length) {
    throw new Error("fab_router gained runtime dependencies; update packaging explicitly");
  }
  if (!(await stat(`${root}/src/api.ts`).catch(() => null))?.isFile()) {
    throw new Error(`fab_router entry point not found: ${root}/src/api.ts`);
  }
  if (!(await stat(`${root}/spec/types/settings.ts`).catch(() => null))?.isFile()) {
    throw new Error(`fab_router runtime types not found: ${root}/spec/types/settings.ts`);
  }
}

/** Reject links that will break or escape after the bundle is moved to another machine. */
export async function validateRelocatableSymlinks(root: string): Promise<void> {
  const bundleRoot = resolve(root);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target)) throw new Error(`non-relocatable absolute symlink: ${path} -> ${target}`);
        const resolvedTarget = resolve(dirname(path), target);
        const fromRoot = relative(bundleRoot, resolvedTarget);
        if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
          throw new Error(`symlink escapes bundle: ${path} -> ${target}`);
        }
        if (!(await stat(path).catch(() => null))) throw new Error(`broken symlink: ${path} -> ${target}`);
      } else if (info.isDirectory()) {
        await visit(path);
      }
    }
  }
  await visit(bundleRoot);
}

/** Locate KiCad's stock-data root in an installed prefix or a macOS application bundle. */
export async function findStockData(root: string): Promise<string | null> {
  for (const candidate of [join(root, "share", "kicad"), join(root, "KiCad.app", "Contents", "SharedSupport")]) {
    if ((await stat(candidate).catch(() => null))?.isDirectory()) return candidate;
  }
  return null;
}
