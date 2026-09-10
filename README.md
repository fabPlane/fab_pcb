# FabPlane PCB

A headless, browser-based UI for KiCad 10.99+ built entirely on the KiCad IPC API
(`kicad-cli api-server`). TypeScript end to end; KiCad runs as a server process and
never opens a window.

## Status

![IPC API headless](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FTensorFleet%2Ffab_pcb%2Fmain%2Fdocs%2Fcoverage-badge.json)

IPC API coverage: **152/167** commands headless (91.0%) · 15 GUI-only · 0 unregistered — KiCad 8cc9377988
(`bun run coverage:summary` prints this line from `tooling/coverage/commands.json`; `--badge` rewrites
`docs/coverage-badge.json`, the shields.io endpoint behind the badge; CI checks both are fresh).
The 15 GUI-only commands are selection, visible layers and appearance state, which a web page owns
itself; every headless command passes the conformance suite against a live server.

Milestones M0–M4 are done: `kicad-cli` builds from the fork ([docs/m0-runbook.md](docs/m0-runbook.md)),
the board and schematic render in the browser from live server data, edits commit back through
KiCad's own commit API and undo, and DRC/ERC, exports and a 3D view run from the UI. See
[docs/screenshots](docs/screenshots). The fork's `web-api` branch carries 21 API commits that closed
every P0 gap and most P1 gaps ([docs/04-ipc-gaps.md](docs/04-ipc-gaps.md)).

```bash
bun install
bun run ci                 # frozen install → gen:check → coverage:check (+ badge) → typecheck → unit tests
bun run test:unit          # every workspace, one bun process each (tooling/ci/run-tests.ts)
KICAD_CLI=... bun run test:integration   # *.kicad.test.ts against a real kicad-cli api-server
bun run test:e2e           # Playwright smoke on apps/web + mock services (e2e/)
packages/kicad-patches/build-macos.sh    # native kicad-cli; build-linux.sh for the Docker image
KICAD_CLI="$(bun run --silent kicad:fetch)" bun run test:integration   # or use a prebuilt nightly (below)
```

### Prebuilt `kicad-cli` nightlies

The fork publishes the headless server (`kicad-cli` + the pcbnew/eeschema kifaces) for
Linux x86_64, macOS arm64/x86_64 and Windows x86_64 every night as GitHub Releases:
[`nightly`](https://github.com/TensorFleet/kicad/releases/tag/nightly) is the rolling
latest, `nightly-<date>-<sha10>` are pinnable builds, and `manifest.json` on each release
maps platform → archive, sha256 and the executable's path inside it (format and runtime
requirements: `tools/nightly/README.md` in the fork). `tooling/kicad-cli/fetch.ts` is the
dependency-free downloader — the same logic fabdesk uses to pull the binary in:

```bash
bun run kicad:fetch                               # latest for this machine -> prints the executable (no token needed)
bun run kicad:fetch -- --tag nightly-20260910-0c45443da6   # pin a build
bun run kicad:fetch -- --check                    # what the release carries, no download
```

Builds unpack under `.kicad-cli/<build tag>/<platform>/` and are reused when complete.

Ownership of every path is in [docs/ownership.md](docs/ownership.md). Start with the docs, in order:

1. [docs/01-architecture.md](docs/01-architecture.md) — system shape, transport, session and document model, milestones
2. [docs/02-typescript-api.md](docs/02-typescript-api.md) — the TypeScript client layers and object model
3. [docs/03-rendering.md](docs/03-rendering.md) — how the board and schematic are drawn in the page
4. [docs/04-ipc-gaps.md](docs/04-ipc-gaps.md) — what the IPC layer cannot do yet and the patch plan for the KiCad fork
5. [docs/05-agents.md](docs/05-agents.md) — the agent roster, waves, contracts and exit tests
6. [docs/api-coverage.md](docs/api-coverage.md) — generated per-command coverage matrix (111 commands)

`docs/plan.html` is the same plan as a single shareable page.

Companion repo: the KiCad fork (branch `web-api`) that carries the API patches. This repo pins the
fork commit in `packages/proto/KICAD_COMMIT` and the alignment tag in `packages/proto/KICAD_TAG`;
every major change set is tagged `fp-pcb/<date>-<name>` on both repos (rule in docs/01-architecture.md).
