# Backend distribution

FabPlane desktop expects one platform bundle at `dist/pcb/<target>` and packages it under
`Resources/pcb`. A bundle contains the KiCad fork runtime, a standalone Bun-compiled
`fp-pcb-bridge`, standard footprint and symbol libraries, and `bundle.json` with relative paths.

Supported targets are `linux-x64`, `darwin-x64`, `darwin-arm64`, and `windows-x64`. Unix bundles
use nng IPC sockets. Windows uses KiCad's native nng WebSocket listener on loopback because Bun has
no named-pipe nng transport; the manifest selects this without exposing a public listener.

## Assemble a staged runtime

After building/installing the fork and obtaining the official `kicad-footprints` and
`kicad-symbols` trees:

```bash
bun packages/kicad-patches/bundle.ts linux-x64 \
  /path/to/staged-kicad-runtime \
  /path/to/kicad-footprints \
  /path/to/kicad-symbols \
  dist/pcb/linux-x64
```

The library arguments must contain `*.pretty` directories and `*.kicad_sym` files respectively;
empty or missing inputs fail instead of producing an installer whose first compile cannot resolve
parts. The bridge discovers every bundled library and writes enabled project table rows before
compile.

On Windows, run `packages/kicad-patches/build-windows.ps1` from a Developer PowerShell with CMake,
Ninja, Bun and vcpkg. It configures the fork with the vcpkg toolchain, installs to a staging tree,
then invokes the same bundle builder. `build-macos.sh` and the Linux Docker build remain the native
fork build entry points; their output must be staged with all non-system dynamic libraries before
calling `bundle.ts`.

## Verification boundary

`bundle.test.ts` validates target names, executable names and transport selection on every host.
The bundle builder validates runtime/library contents and cross-compiles the standalone bridge.
Static checks do not constitute runtime verification: execute the later manual test on each native
platform, and inspect dynamic dependencies (`ldd`, `otool -L`, or `dumpbin /dependents`) before
publishing. In particular, the current Linux Docker image is a complete OCI runtime, but extracting
only `/opt/kicad` does not copy Debian runtime packages into a desktop AppImage.

The bridge no longer contains `@tscircuit/capacity-autorouter`. Its JavaScript route job loads the
private GPL-derived `TensorFleet/js_autorouter` module at runtime. Do not publish a bundle carrying
that module until its licensing/distribution decision is explicit; see `packages/router/README.md`.

Linux bundles carry the non-glibc shared-library closure collected from the three KiCad binaries
under `kicad/lib/runtime`; `bundle.json.libraryPaths` tells the desktop supervisor to prepend both
KiCad library directories to `LD_LIBRARY_PATH`. End users never build or run the Docker image: it
is only the reproducible native-build environment used to publish `fp-pcb-backend-linux-x64.tar.gz`.
The Fabdesk release downloads that immutable asset and embeds it in the AppImage and `.deb`.

## Later manual test

From an installed FabPlane build, with no separately installed KiCad and no external bridge:

```text
1. Start FabPlane and open Doctor; confirm KiCad >= 10.99 and fp-pcb are ready.
2. Create a project whose circuit.netlist.json uses one standard footprint and libSource symbol.
3. Build; confirm board.kicad_pcb and board.kicad_sch exist and the schematic renders.
4. Route; confirm Route Cinema's final frame contains copper, then restart FabPlane and confirm the route persists.
5. Run DRC and ERC, export Gerbers/BOM, and reopen the project after another application restart.
```
