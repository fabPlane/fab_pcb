import { resolve } from "node:path";

/** Embed the solver worker beside the compiled entrypoint, including desktop bundles. */
export function bridgeCompileCommand(entrypoint: string, outfile: string, bunTarget?: string): string[] {
  return [
    "bun",
    "build",
    entrypoint,
    resolve(import.meta.dir, "../router/src/fab-router-worker.ts"),
    "--compile",
    // import.meta.url points to the bundled entrypoint; preserve the worker's sibling filename.
    "--entry-naming=[name].ts",
    ...(bunTarget ? [`--target=${bunTarget}`] : []),
    `--outfile=${outfile}`,
  ];
}
