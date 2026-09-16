# Linux image: `kicad-cli api-server` from the fork

```bash
packages/kicad-patches/build-linux.sh --smoke          # git archive of ../kicad HEAD -> fp-pcb/kicad-cli:<sha>
JOBS=3 packages/kicad-patches/build-linux.sh           # Docker Desktop with < 8 GB: ~1.5 GB per pcbnew TU with PCH
KICAD_REF=main packages/kicad-patches/build-linux.sh
KICAD_REPO=https://gitlab.com/<fork>/kicad.git KICAD_REF=<sha> packages/kicad-patches/build-linux.sh   # CI: clone inside the build
packages/kicad-patches/docker/smoke.sh fp-pcb/kicad-cli:latest
```

- `Dockerfile` — multi-stage: `src-context` / `src-git` → `build` (Debian trixie, the package list from
  KiCad's `qa/arm64/Dockerfile` + `install-deps.sh`, ccache in a BuildKit cache mount, targets
  `kicad-cli pcbnew_kiface eeschema_kiface`, same CMake flags as `build-macos.sh`) → `runtime`
  (only the packages `ldd` + `dpkg -S` report for the three binaries, non-root user `kicad`).
- `entrypoint.sh` — `exec kicad-cli "$@"`. No X display: `kicad-cli` is a `wxAppConsole`
  (`kicad/kicad_cli.cpp`) and `api-server` never creates a window, so `DISPLAY` stays unset and
  xvfb is not installed. If that ever changes, add `xvfb` and `exec xvfb-run -a kicad-cli "$@"`.
- `smoke.sh` — `version` + Ping/GetVersion/OpenDocument via `tooling/m0/ping.ts` in a sibling
  `oven/bun` container sharing the socket volume.
- `Dockerfile.dockerignore` — only used when the raw checkout is the build context.

Runtime layout in the image: `/opt/kicad/bin/{kicad-cli,_pcbnew.kiface,_eeschema.kiface}` (KIWAY
loads kifaces from the executable's directory on Linux), `/opt/kicad/lib/libki{common,gal,api}.so*`
(10.99 builds these as shared libraries with a build-tree RPATH only, hence `LD_LIBRARY_PATH=/opt/kicad/lib`
in the image), `/opt/kicad/KICAD_COMMIT`, `/tmp/kicad` for sockets (`VOLUME`), `HOME=/home/kicad`
for the settings KiCad writes on first start. The build stage fails if any library stays unresolved
or the `ldd` → `realpath` → `dpkg -S` runtime-package list comes out empty (on merged-`/usr` Debian
`ldd` prints `/lib/...` while dpkg records `/usr/lib/...`, so the paths are resolved first), and the
runtime stage runs `kicad-cli version` before the image is tagged.

Keep the image at the commit `packages/proto/KICAD_COMMIT` pins (the fork branch moves faster than
the pin):

```bash
JOBS=3 packages/kicad-patches/build-linux.sh "$(cat packages/proto/KICAD_COMMIT)" --smoke
```

Build time on a 6-CPU / 8 GB Docker Desktop VM (arm64): about 65 minutes for a cold compile; the
compile layer is cached per commit, so a change to the staging or runtime stages rebuilds in minutes.

```bash
docker run --rm -d -v /tmp/kicad:/tmp/kicad -v "$PWD:/work" fp-pcb/kicad-cli \
    api-server /work/board.kicad_pcb --socket /tmp/kicad/api.sock
```

On Linux hosts the socket in `/tmp/kicad` is usable directly by the bridge (`KICAD_SOCKET_DIR`);
on macOS Docker Desktop cannot share unix sockets with the host, so run the bridge in a container
on the same volume or use the native build from `build-macos.sh`.
