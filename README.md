# kicad-web

A headless, browser-based UI for KiCad 10.99+ built entirely on the KiCad IPC API
(`kicad-cli api-server`). TypeScript end to end; KiCad runs as a server process and
never opens a window.

Status: planning. Start with the docs, in order:

1. [docs/01-architecture.md](docs/01-architecture.md) — system shape, transport, session and document model, milestones
2. [docs/02-typescript-api.md](docs/02-typescript-api.md) — the TypeScript client layers and object model
3. [docs/03-rendering.md](docs/03-rendering.md) — how the board and schematic are drawn in the page
4. [docs/04-ipc-gaps.md](docs/04-ipc-gaps.md) — what the IPC layer cannot do yet and the patch plan for the KiCad fork
5. [docs/05-agents.md](docs/05-agents.md) — the agent roster, waves, contracts and exit tests
6. [docs/api-coverage.md](docs/api-coverage.md) — generated per-command coverage matrix (111 commands)

`docs/plan.html` is the same plan as a single shareable page.

Companion repo: the KiCad fork (branch `web-api`) that carries the API patches.
This repo pins the fork commit it was generated against in `packages/proto/KICAD_COMMIT`.
