/**
 * A hand-written stand-in for the Emscripten module: the same C ABI surface (`_malloc`, `_free`,
 * `_kiapi_*`, `HEAPU8`, `UTF8ToString`, `stringToNewUTF8`) plus a MEMFS-shaped `FS`, implemented in
 * JS over a byte array and a bump allocator. It lets the loader be tested without a wasm build.
 */
import type { KiCadWasmModule } from "../src/index";

export interface MockOptions {
  /** Return value of `kiapi_init` (non-zero makes `createKiCadWasm` throw). */
  initResult?: number;
  /** What `kiapi_last_error()` reports. */
  lastError?: string;
  /** Reply bytes for a request. Default: the request reversed. */
  reply?: (request: Uint8Array) => Uint8Array | null;
  /** Event frames published from inside `kiapi_dispatch`. */
  eventsPerDispatch?: (request: Uint8Array) => Uint8Array[];
  /** Grow (and therefore replace) `HEAPU8` during each dispatch, like a real memory growth. */
  growHeapOnDispatch?: boolean;
  /** Drop the leading underscore from the exported functions (the other Emscripten convention). */
  exportWithoutUnderscore?: boolean;
  heapBytes?: number;
}

export interface MockModule extends KiCadWasmModule {
  FS: MockFS;
  /** Config JSON `kiapi_init` was called with. */
  initConfig: string | null;
  /** Requests handed to `kiapi_dispatch`, in order. */
  requests: Uint8Array[];
  /** Pointers `kiapi_free` was called with. */
  freedReplies: number[];
  /** Pointers still held by the bump allocator (leak check). */
  liveAllocations(): number;
  shutdowns: number;
}

/** The minimum of Emscripten's MEMFS the loader and `./fs` helpers touch. */
export class MockFS {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>(["/"]);

  mkdir(path: string): void {
    const p = norm(path);
    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    if (!this.dirs.has(parent)) throw new Error(`ENOENT: ${parent}`);
    if (this.dirs.has(p) || this.files.has(p)) throw new Error(`EEXIST: ${p}`);
    this.dirs.add(p);
  }

  writeFile(path: string, data: Uint8Array | string): void {
    const p = norm(path);
    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    if (!this.dirs.has(parent)) throw new Error(`ENOENT: ${parent}`);
    this.files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
  }

  readFile(path: string): Uint8Array {
    const f = this.files.get(norm(path));
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f;
  }

  readdir(path: string): string[] {
    const p = norm(path);
    if (!this.dirs.has(p)) throw new Error(`ENOTDIR: ${path}`);
    const prefix = p === "/" ? "/" : `${p}/`;
    const names = new Set<string>([".", ".."]);
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (key === p || !key.startsWith(prefix)) continue;
      names.add(key.slice(prefix.length).split("/")[0]!);
    }
    return [...names];
  }

  unlink(path: string): void {
    this.files.delete(norm(path));
  }

  stat(path: string): { mode: number; size: number } {
    const p = norm(path);
    if (this.dirs.has(p)) return { mode: 0o040755, size: 0 };
    const f = this.files.get(p);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return { mode: 0o100644, size: f.length };
  }

  isDir(mode: number): boolean {
    return (mode & 0o170000) === 0o040000;
  }

  isFile(mode: number): boolean {
    return (mode & 0o170000) === 0o100000;
  }
}

function norm(path: string): string {
  const p = path.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

/** Build a factory shaped like `kicad_api.js`'s default export. */
export function createMockFactory(opts: MockOptions = {}): (moduleArg?: Record<string, unknown>) => Promise<MockModule> {
  return async (moduleArg: Record<string, unknown> = {}) => {
    let heap = new Uint8Array(opts.heapBytes ?? 1 << 20);
    let brk = 16; // never hand out 0: it means null
    const live = new Set<number>();
    const sizes = new Map<number, number>();
    let lastError = opts.lastError ?? "";

    const malloc = (size: number): number => {
      const need = Math.max(1, size);
      if (brk + need > heap.length) return 0;
      const ptr = brk;
      brk += need + (8 - (need % 8)); // keep pointers 8-aligned like dlmalloc
      live.add(ptr);
      sizes.set(ptr, need);
      return ptr;
    };
    const free = (ptr: number): void => {
      live.delete(ptr);
      sizes.delete(ptr);
    };

    const module: MockModule = {
      get HEAPU8() {
        return heap;
      },
      FS: new MockFS(),
      initConfig: null,
      requests: [],
      freedReplies: [],
      shutdowns: 0,
      liveAllocations: () => live.size,

      _malloc: malloc,
      _free: free,

      _kiapi_init(cfgPtr: number): number {
        module.initConfig = module.UTF8ToString(cfgPtr) as string;
        return opts.initResult ?? 0;
      },

      _kiapi_dispatch(reqPtr: number, len: number, outLenPtr: number): number {
        const request = heap.slice(reqPtr, reqPtr + len);
        module.requests.push(request);
        if (opts.growHeapOnDispatch) {
          const bigger = new Uint8Array(heap.length * 2);
          bigger.set(heap);
          heap = bigger; // exactly what memory growth does to HEAPU8
        }
        for (const ev of opts.eventsPerDispatch?.(request) ?? []) {
          (module.__kiapiEvent as ((b: Uint8Array) => void) | undefined)?.(ev);
        }
        const reply = (opts.reply ?? ((r: Uint8Array) => r.slice().reverse()))(request);
        if (!reply) {
          lastError = lastError || "no handler for this request";
          return 0;
        }
        const ptr = malloc(reply.length);
        if (!ptr) return 0;
        heap.set(reply, ptr);
        heap[outLenPtr] = reply.length & 0xff;
        heap[outLenPtr + 1] = (reply.length >>> 8) & 0xff;
        heap[outLenPtr + 2] = (reply.length >>> 16) & 0xff;
        heap[outLenPtr + 3] = (reply.length >>> 24) & 0xff;
        return ptr;
      },

      _kiapi_free(ptr: number): void {
        module.freedReplies.push(ptr);
        free(ptr);
      },

      _kiapi_shutdown(): void {
        module.shutdowns++;
      },

      _kiapi_last_error(): number {
        if (!lastError) return 0;
        return module.stringToNewUTF8(lastError) as number;
      },

      UTF8ToString(ptr: number): string {
        let end = ptr;
        while (end < heap.length && heap[end] !== 0) end++;
        return new TextDecoder().decode(heap.slice(ptr, end));
      },

      stringToNewUTF8(s: string): number {
        const bytes = new TextEncoder().encode(s);
        const ptr = malloc(bytes.length + 1);
        heap.set(bytes, ptr);
        heap[ptr + bytes.length] = 0;
        return ptr;
      },
    };

    if (opts.exportWithoutUnderscore) {
      for (const name of ["malloc", "free", "kiapi_init", "kiapi_dispatch", "kiapi_free", "kiapi_shutdown", "kiapi_last_error"]) {
        module[name] = module[`_${name}`];
        delete module[`_${name}`];
      }
    }

    Object.assign(module, moduleArg); // Emscripten merges moduleArg onto the Module
    return module;
  };
}
