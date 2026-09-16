import { mkdirTree } from "./fs";

/**
 * `@fp-pcb/kicad-wasm` — loader for KiCad's headless API core compiled to WebAssembly.
 *
 * The wasm build (`kicad_api.js` + `kicad_api.wasm`, Emscripten `MODULARIZE` ES6 with
 * `EXPORT_NAME=createKicadApi`) exports this C ABI:
 *
 * ```c
 * int         kiapi_init(const char* configJson);   // 0 = ok
 * uint8_t*    kiapi_dispatch(const uint8_t* req, size_t len, size_t* outLen);
 * void        kiapi_free(void* p);
 * void        kiapi_shutdown(void);
 * const char* kiapi_last_error(void);
 * ```
 *
 * plus one callback: the module calls `Module.__kiapiEvent(bytes)` with a serialized
 * `kiapi.common.events.Event` — it must be in place before `kiapi_init`.
 *
 * `createKiCadWasm()` wraps all of that in a `KiCadWasmInstance`, which is exactly what
 * `WasmTransport` from `@fp-pcb/client` consumes. This package deliberately knows nothing about
 * protobuf: it moves bytes and owns the module's lifetime and its MEMFS.
 */

/** Emscripten's `FS` object, narrowed to what this package (and `./fs`) uses. */
export interface KiCadWasmFS {
  mkdir(path: string, mode?: number): unknown;
  mkdirTree?(path: string, mode?: number): unknown;
  writeFile(path: string, data: Uint8Array | string, opts?: { encoding?: string; flags?: string }): unknown;
  readFile(path: string, opts?: { encoding?: string }): Uint8Array;
  readdir(path: string): string[];
  unlink(path: string): unknown;
  rmdir?(path: string): unknown;
  stat(path: string): { mode: number; size: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  analyzePath?(path: string, dontResolveLastLink?: boolean): { exists: boolean };
}

/** The resolved Emscripten module. Function names carry the leading underscore Emscripten adds. */
export interface KiCadWasmModule {
  HEAPU8: Uint8Array;
  FS: KiCadWasmFS;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _kiapi_init(configJson: number): number;
  _kiapi_dispatch(req: number, len: number, outLen: number): number;
  _kiapi_free(ptr: number): void;
  _kiapi_shutdown(): void;
  _kiapi_last_error(): number;
  UTF8ToString(ptr: number, maxBytes?: number): string;
  stringToNewUTF8(s: string): number;
  __kiapiEvent?: (bytes: Uint8Array) => void;
  [key: string]: unknown;
}

/** The default export of `kicad_api.js`. */
export type KiCadWasmModuleFactory = (moduleArg?: Record<string, unknown>) => Promise<KiCadWasmModule>;

/** Everything `kiapi_init` is told, serialized as JSON. */
export interface KiCadWasmConfig {
  /** Writable MEMFS directory for KiCad's settings. Default `/home/kicad`. */
  home: string;
  /** Read-only MEMFS directory holding KiCad's share tree (templates, schemas). Default `/kicad/share`. */
  share: string;
  /** Extra environment variables (`KICAD10_SYMBOL_DIR`, `KICAD10_FOOTPRINT_DIR`, ...). */
  env: Record<string, string>;
  /** MEMFS path of a document to open at startup, or `""`. */
  preload: string;
  /** API token clients must present, or `""` for a generated one. */
  token: string;
  /** Publish `kiapi.common.events.Event` frames through `Module.__kiapiEvent`. */
  publishEvents: boolean;
}

export interface KiCadWasmOptions extends Partial<KiCadWasmConfig> {
  /** The factory exported by `kicad_api.js`. Omit to `import()` it from `moduleUrl`. */
  module?: KiCadWasmModuleFactory;
  /** Where to find `kicad_api.js`. Default: `dist/kicad_api.js` next to this package. */
  moduleUrl?: string | URL;
  /** Where to find `kicad_api.wasm` (Emscripten `locateFile`). Default: next to `kicad_api.js`. */
  wasmUrl?: string | URL;
  /** Event frames from the module (already copied out of the heap). */
  onEvent?: (bytes: Uint8Array) => void;
  /** `Module.print` / `Module.printErr`. Default: forward to `console.log` / `console.error`. */
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}

const DEFAULT_CONFIG: KiCadWasmConfig = {
  home: "/home/kicad",
  share: "/kicad/share",
  env: {},
  preload: "",
  token: "",
  publishEvents: true,
};

/** Thrown when the module reports a failure; carries `kiapi_last_error()` when there is one. */
export class KiCadWasmError extends Error {
  override readonly name = "KiCadWasmError";
  constructor(
    message: string,
    readonly lastError = "",
  ) {
    super(lastError ? `${message}: ${lastError}` : message);
  }
}

/**
 * A loaded module. Implements `KiCadWasmInstance` from `@fp-pcb/client/transport` structurally, so
 * `new WasmTransport(await createKiCadWasm())` is all the wiring there is.
 */
export class KiCadWasm {
  private readonly listeners = new Set<(bytes: Uint8Array) => void>();
  private closed = false;

  constructor(
    readonly module: KiCadWasmModule,
    readonly config: KiCadWasmConfig,
  ) {}

  get FS(): KiCadWasmFS {
    return this.module.FS;
  }

  /** `kiapi_last_error()`, or `""`. */
  lastError(): string {
    try {
      const ptr = this.module._kiapi_last_error();
      return ptr ? this.module.UTF8ToString(ptr) : "";
    } catch {
      return "";
    }
  }

  /** One serialized `ApiRequest` in, one serialized `ApiResponse` out. Synchronous, like the ABI. */
  dispatch(request: Uint8Array): Uint8Array {
    if (this.closed) throw new KiCadWasmError("the wasm module has been shut down");
    const m = this.module;
    const reqPtr = m._malloc(request.length || 1);
    const lenPtr = m._malloc(4);
    if (!reqPtr || !lenPtr) throw new KiCadWasmError("out of wasm memory", this.lastError());
    try {
      m.HEAPU8.set(request, reqPtr);
      // size_t is 32-bit in wasm32 and the heap is little-endian.
      const outPtr = m._kiapi_dispatch(reqPtr, request.length, lenPtr);
      if (!outPtr) throw new KiCadWasmError("kiapi_dispatch returned null", this.lastError());
      const heap = m.HEAPU8; // may have been replaced if the heap grew during the call
      const len = heap[lenPtr]! | (heap[lenPtr + 1]! << 8) | (heap[lenPtr + 2]! << 16) | (heap[lenPtr + 3]! << 24);
      const reply = heap.slice(outPtr, outPtr + (len >>> 0));
      m._kiapi_free(outPtr);
      return reply;
    } finally {
      m._free(reqPtr);
      m._free(lenPtr);
    }
  }

  /** Subscribe to `kiapi.common.events.Event` frames. Returns an unsubscribe function. */
  onEvent(cb: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Called by the module through `Module.__kiapiEvent`; also usable from tests. */
  emitEvent(bytes: Uint8Array): void {
    for (const cb of Array.from(this.listeners)) cb(bytes);
  }

  /** `kiapi_shutdown()`. Idempotent; the module object is unusable afterwards. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    try {
      this.module._kiapi_shutdown();
    } finally {
      this.module.__kiapiEvent = undefined;
    }
  }

  get isShutDown(): boolean {
    return this.closed;
  }
}

/** Load `kicad_api.js`, wire the event callback, run `kiapi_init` and hand back the instance. */
export async function createKiCadWasm(opts: KiCadWasmOptions = {}): Promise<KiCadWasm> {
  const config: KiCadWasmConfig = {
    home: opts.home ?? DEFAULT_CONFIG.home,
    share: opts.share ?? DEFAULT_CONFIG.share,
    env: opts.env ?? DEFAULT_CONFIG.env,
    preload: opts.preload ?? DEFAULT_CONFIG.preload,
    token: opts.token ?? DEFAULT_CONFIG.token,
    publishEvents: opts.publishEvents ?? DEFAULT_CONFIG.publishEvents,
  };

  const factory = opts.module ?? (await loadFactory(opts.moduleUrl));
  let instance: KiCadWasm | undefined;
  const onEvent = (bytes: Uint8Array) => {
    // The module hands out a view into its heap; copy before it grows, moves or frees it.
    const copy = new Uint8Array(bytes);
    opts.onEvent?.(copy);
    instance?.emitEvent(copy);
  };

  const moduleArg: Record<string, unknown> = { __kiapiEvent: onEvent };
  const wasmUrl = opts.wasmUrl ? String(opts.wasmUrl) : undefined;
  const sidecarBase = wasmUrl ?? sidecarBaseOf(opts);
  if (wasmUrl ?? sidecarBase) {
    moduleArg.locateFile = (path: string) =>
      path.endsWith(".wasm") && wasmUrl ? wasmUrl : sidecarBase ? sibling(sidecarBase, path) : path;
  }
  if (opts.print) moduleArg.print = opts.print;
  if (opts.printErr) moduleArg.printErr = opts.printErr;

  const module = normalise(await factory(moduleArg));
  module.__kiapiEvent = onEvent; // in case the factory did not copy moduleArg onto the Module
  instance = new KiCadWasm(module, config);

  mkdirTree(module.FS, config.home);
  mkdirTree(module.FS, config.share);

  const cfgPtr = module.stringToNewUTF8(JSON.stringify(config));
  let rc: number;
  try {
    rc = module._kiapi_init(cfgPtr);
  } finally {
    module._free(cfgPtr);
  }
  if (rc !== 0) throw new KiCadWasmError(`kiapi_init returned ${rc}`, instance.lastError());
  return instance;
}

/** Emscripten sometimes exports without the leading underscore (`-sEXPORTED_FUNCTIONS` variants). */
function normalise(module: KiCadWasmModule): KiCadWasmModule {
  const m = module as unknown as Record<string, unknown>;
  for (const name of ["malloc", "free", "kiapi_init", "kiapi_dispatch", "kiapi_free", "kiapi_shutdown", "kiapi_last_error"]) {
    if (typeof m[`_${name}`] !== "function" && typeof m[name] === "function") m[`_${name}`] = m[name];
  }
  const missing = ["_malloc", "_free", "_kiapi_init", "_kiapi_dispatch", "_kiapi_free", "_kiapi_shutdown", "_kiapi_last_error"].filter(
    (n) => typeof m[n] !== "function",
  );
  if (missing.length > 0) {
    throw new KiCadWasmError(`the wasm module does not export ${missing.join(", ")} (rebuild with -sEXPORTED_FUNCTIONS)`);
  }
  for (const n of ["UTF8ToString", "stringToNewUTF8"]) {
    if (typeof m[n] !== "function") {
      throw new KiCadWasmError(`the wasm module does not export the runtime method ${n} (-sEXPORTED_RUNTIME_METHODS)`);
    }
  }
  if (!m.HEAPU8) throw new KiCadWasmError("the wasm module does not expose HEAPU8 (-sEXPORTED_RUNTIME_METHODS=HEAPU8)");
  return module;
}

/**
 * Where the module's sidecars (`kicad_api.wasm`, `kicad_api.data`) live, when `wasmUrl` does not
 * say. An explicit `moduleUrl` wins; a caller that hands over its own `module` factory without one
 * (the worker's seeding wrapper used to) gets `""`, i.e. Emscripten's own resolution.
 */
function sidecarBaseOf(opts: KiCadWasmOptions): string {
  if (opts.moduleUrl) return String(opts.moduleUrl);
  return opts.module ? "" : defaultModuleUrl().href;
}

/**
 * Resolve one sidecar name against the module's own location.
 *
 * Emscripten asks for these by bare file name, and its two fallbacks are both wrong as soon as the
 * module is not served from the page's (or the process's) own directory: the `--preload-file`
 * loader `fetch`es `kicad_api.data` against the *document* URL in a browser and hands it straight
 * to `readFileSync` — relative to the cwd — under Node and Bun. `file:` URLs come back as plain
 * paths because that loader, unlike the wasm one, has no `file://` handling.
 */
function sibling(base: string, name: string): string {
  const url = base.replace(/[^/]*$/, "") + name;
  return url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length)) : url;
}

/** Default module location: `dist/kicad_api.js`, where `bun run fetch` puts the build. */
export function defaultModuleUrl(): URL {
  // `@vite-ignore`: a bundler must not resolve this at build time. Hosts that bundle the loader
  // (apps/web) pass their own `moduleUrl`; this default is for Bun/Node running from the package.
  return new URL(/* @vite-ignore */ "../dist/kicad_api.js", import.meta.url);
}

async function loadFactory(moduleUrl?: string | URL): Promise<KiCadWasmModuleFactory> {
  const url = moduleUrl ? (typeof moduleUrl === "string" ? moduleUrl : moduleUrl.href) : defaultModuleUrl().href;
  let mod: { default?: unknown };
  try {
    mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  } catch (e) {
    throw new KiCadWasmError(
      `cannot load the KiCad wasm module from ${url} — run 'bun run --filter @fp-pcb/kicad-wasm fetch' after building it (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const factory = mod.default;
  if (typeof factory !== "function") throw new KiCadWasmError(`${url} has no default export (expected the createKicadApi factory)`);
  return factory as KiCadWasmModuleFactory;
}

export * from "./fs";
export * from "./fonts";
export * from "./worker-client";
