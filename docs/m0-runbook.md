# M0 runbook — build kicad-cli and answer a Ping from Bun

## 1. Build KiCad 10.99 (macOS, Homebrew libraries)

```bash
packages/kicad-patches/build-macos.sh            # ../kicad checkout, Release
```

What the script pins, and why (each one was a configure failure on a stock setup):

| Flag | Reason |
|---|---|
| `-DwxWidgets_CONFIG_EXECUTABLE=$(brew --prefix)/bin/wx-config-3.2` | Homebrew installs `wxwidgets@3.2` with a versioned `wx-config` |
| `-DNGSPICE_LIB_NAME=libngspice.0.dylib -DNGSPICE_ROOT_DIR=…/libngspice` | `Findngspice.cmake` searches for `libngspice.so.0` on every UNIX, including macOS |
| `-DOCC_INCLUDE_DIR=…/opencascade/include/opencascade -DOCC_LIBRARY_DIR=…/opencascade/lib` | `FindOCC.cmake` does not know the Homebrew layout |
| `KICAD_BUILD_QA_TESTS/I18N/USE_SENTRY/UPDATE_CHECK/INSTALL_DEMOS=OFF` | not needed for a server |

Only three targets are built: `kicad-cli`, `pcbnew_kiface`, `eeschema_kiface`. On macOS
they land in the build tree as

```
build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli
build/release/kicad/KiCad.app/Contents/PlugIns/_pcbnew.kiface
build/release/kicad/KiCad.app/Contents/PlugIns/_eeschema.kiface
```

which is exactly where `KIWAY` looks for kifaces (`<bundle>/Contents/PlugIns`), so no
`ninja install` is required.

## 2. Run the headless server

```bash
../kicad/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli api-server \
    ../kicad/qa/data/pcbnew/api_kitchen_sink.kicad_pro \
    --socket /tmp/kicad/api-m0.sock
```

Prints `KiCad API server listening at ipc:///tmp/kicad/api-m0.sock` (stdout is block-buffered
when redirected to a file, so the line may not appear until exit). Ctrl-C shuts it down and
closes the project. Omit `--socket` to use `/tmp/kicad/api.sock`.

Preloading a `.kicad_pro` loads only the project settings. The board is not open until a
client sends `OpenDocument{type: DOCTYPE_PCB, path}`; preload the `.kicad_pcb` instead if
you want the board open at start.

## 3. Ping it from Bun

```bash
bun tooling/m0/ping.ts /tmp/kicad/api-m0.sock ../kicad/qa/data/pcbnew/api_kitchen_sink.kicad_pcb
```

The script has no dependencies. It implements the nng SP handshake and framing and
hand-encodes the `ApiRequest` envelope. Output on 2026-09-06 against commit cbd303d16b:

```
connecting to ipc:///tmp/kicad/api-m0.sock
SP handshake ok (peer is REP0)
Ping: AS_OK (11.43 ms) token=11dae6b5-e189-4952-bd1c-c2c9d0861463
GetVersion: AS_OK (11.14 ms) token=11dae6b5-e189-4952-bd1c-c2c9d0861463
  response type: type.googleapis.com/kiapi.common.commands.GetVersionResponse
  KiCad 10.99.0  "10.99.0-3658-gcbd303d16b"
OpenDocument: AS_OK (353.97 ms) token=11dae6b5-e189-4952-bd1c-c2c9d0861463
  opened: api_kitchen_sink.kicad_pcb in project "api_kitchen_sink"
GetOpenDocuments: AS_OK (12.45 ms) token=11dae6b5-e189-4952-bd1c-c2c9d0861463
  open PCB: api_kitchen_sink.kicad_pcb  project "api_kitchen_sink" at /Users/hyper/projects/tensorfleet/kicad/qa/data/pcbnew
```

## What M0 taught us (feeds the transport and the gap list)

- **nng IPC framing is a 9-byte header**, not 8: byte 0 is a message-type tag (`0x01` =
  data) and bytes 1–8 are the big-endian uint64 length. Sending an 8-byte length makes nng
  close the pipe with `NNG_EPROTO` and no error reaches the client. Verified against
  `src/sp/transport/ipc/ipc.c` in nng 1.12.2 and by dumping what `nngcat --req0` sends.
- **Every request costs ~11 ms** even for `Ping`. `command_api_server.cpp` pumps wx events
  in a `while` loop with `wxMilliSleep(10)`, so a request waits up to 10 ms before it is
  dispatched. Replacing the sleep with a condition variable woken by the nng thread is a
  small patch (added as gap G18) and matters for a UI issuing many small calls.
- **`GetOpenDocuments` answers `AS_UNHANDLED`** when no document of that type is open,
  because the handler that serves it only exists once a document is open. The client must
  treat `AS_UNHANDLED` for document commands as "no document", not as an error.
- `nngcat` (ships with Homebrew nng) is a handy reference client:
  `nngcat --req0 --dial ipc:///tmp/kicad/api-m0.sock --file request.bin --format hex`.

The framing code in `tooling/m0/ping.ts` is the seed for `NngIpcTransport` in
`packages/client` (agent A3).
