# @fp-pcb/kicad-wasm

Loader for KiCad's headless API core compiled to WebAssembly. It owns the module's lifetime, its
MEMFS and the `kiapi_*` C ABI, and hands `@fp-pcb/client`'s `WasmTransport` a `KiCadWasmInstance` —
`dispatch(bytes) -> bytes`, `onEvent(cb)`, `shutdown()`. It knows nothing about protobuf.

```
src/index.ts   createKiCadWasm(): load kicad_api.js, wire __kiapiEvent, kiapi_init, dispatch/shutdown
src/fs.ts      MEMFS: mountProject / mountFile / writeFile / readFile / listFiles / exportDir
scripts/fetch.ts   copy kicad_api.{js,wasm,data} from the KiCad build into dist/
```

## Getting a build

The wasm build lives in the KiCad fork (`docs/08-wasm.md`), not here. Once it exists:

```sh
bun run --filter @fp-pcb/kicad-wasm fetch          # from ../kicad/build/wasm/host
KICAD_WASM_DIR=/path/to/host bun run fetch          # or from somewhere else
```

`dist/` is generated and git-ignored; nothing in this package is checked in as a binary.

## Use

```ts
import { createKiCadWasm, mountProject } from "@fp-pcb/kicad-wasm";
import { WasmTransport, WasmSubscriber } from "@fp-pcb/client/transport";
import { KiCad, KiCadEvents } from "@fp-pcb/client";

const wasm = await createKiCadWasm({
  home: "/home/kicad", // writable MEMFS dir for KiCad's settings
  share: "/kicad/share", // KiCad's share tree (from the .data bundle, or mounted below)
  env: { KICAD10_FOOTPRINT_DIR: "/kicad/share/footprints" },
  publishEvents: true,
});

// The wasm build cannot see the host disk: copy the project in, at the same absolute path so
// every path inside the .kicad_pro and fp-lib-table stays valid.
await mountProject(wasm, "/tmp/my-project");

const transport = new WasmTransport(wasm); // close() shuts the module down
const kicad = await KiCad.connect(transport, { clientName: "fp-pcb/wasm" });
const events = new KiCadEvents(new WasmSubscriber(transport));

const project = await kicad.openProject("/tmp/my-project/my-project.kicad_pro");
const board = await project.openBoard("/tmp/my-project/my-project.kicad_pcb");
```

Job outputs are written into MEMFS; `exportDir(wasm, "/tmp/my-project/out", hostDir)` copies them
back to the host.

## The ABI this expects

```c
int         kiapi_init(const char* configJson);   // 0 = ok
uint8_t*    kiapi_dispatch(const uint8_t* req, size_t len, size_t* outLen);
void        kiapi_free(void* p);
void        kiapi_shutdown(void);
const char* kiapi_last_error(void);
```

`configJson` is `{"home","share","env",{...},"preload","token","publishEvents"}`. Events are pushed
the other way: the module calls `Module.__kiapiEvent(bytes)` with one serialized
`kiapi.common.events.Event`, and the loader installs that callback before `kiapi_init`.

Emscripten flags the loader assumes: `MODULARIZE`, `EXPORT_ES6`, `EXPORT_NAME=createKicadApi`,
`EXPORTED_RUNTIME_METHODS=HEAPU8,FS,UTF8ToString,stringToNewUTF8` and the five `kiapi_*` functions
plus `malloc`/`free` in `EXPORTED_FUNCTIONS`. Exports without the leading underscore are accepted
too. `docs/08-wasm.md` is the full contract.

## Tests

`test/loader.test.ts` runs the whole loader against `test/mock-module.ts`, a JS implementation of
the ABI over a byte array, so none of this needs a wasm build. `test/wasm.kicad.test.ts` is the
integration counterpart: it skips unless a real build is present and then runs `Ping`/`GetVersion`.
