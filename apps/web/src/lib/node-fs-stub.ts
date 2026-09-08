/**
 * A browser stand-in for `node:fs/promises`, aliased in by `vite.config.ts`.
 *
 * `@fp-pcb/kicad-wasm` re-exports its MEMFS helpers from one entry point, and the half that copies
 * *host* directories in and out (`mountProject`, `exportDir`, ...) imports `node:fs/promises` at the
 * top level. The browser build only uses the other half — `writeFile`, `readFile`, `exists`,
 * `listFiles`, `mkdirTree`, which touch nothing but the module's own file system — so the node
 * import only has to resolve, not work. Anything that actually reaches for the host disk says so
 * instead of failing as a missing module at build time.
 */
function unavailable(name: string): () => never {
  return () => {
    throw new Error(`node:fs/promises.${name} is not available in the browser — a tab cannot read the host disk; import the files into MEMFS instead`);
  };
}

export const readFile = unavailable('readFile');
export const writeFile = unavailable('writeFile');
export const readdir = unavailable('readdir');
export const mkdir = unavailable('mkdir');
export const stat = unavailable('stat');
export const rm = unavailable('rm');

export default { readFile, writeFile, readdir, mkdir, stat, rm };
