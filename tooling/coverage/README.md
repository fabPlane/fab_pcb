# @kicad-web/coverage

Reproduces the IPC API coverage matrix: which `kiapi` request messages exist, which C++ handler
registers each one, and whether it works under `kicad-cli api-server`.

```bash
bun run coverage                       # from the repo root; writes tooling/coverage/commands.json and docs/api-coverage.md
bun tooling/coverage/run.ts --check    # exit 1 if those files are stale (CI)
bun tooling/coverage/run.ts --verbose  # also list the messages classified as payload types
KICAD_WORKTREE=1 bun run coverage      # analyse the working tree instead of git HEAD
```

Inputs (read from git HEAD of `$KICAD_SRC`, default `../kicad`, so they match `packages/proto/KICAD_COMMIT`):

- request messages: top-level messages of `common/commands/*.proto`, `board/board_commands.proto`,
  `board/board_jobs.proto`, `schematic/schematic_commands.proto`, `schematic/schematic_jobs.proto`,
  taken from the descriptors in `@kicad-web/proto`. A message is a request if a handler registers it,
  or if its name has no `Response|Result|Status|Spec|Entry|Options|Settings` suffix and starts with an
  imperative verb (`Get`, `Set`, `Run`, `Check`, ...). Everything else is a payload type.
- registrations: `registerHandler<Req, Res>( ... )` in `common/api/api_server.cpp` (API_HANDLER_SERVER,
  serves GetSupportedCommands), `common/api/api_handler_common.cpp`,
  `api_handler_editor.cpp`, `pcbnew/api/api_handler_board.cpp`, `api_handler_pcb.cpp`,
  `api_handler_footprint.cpp`, `eeschema/api/api_handler_sch.cpp`, `kicad/cli/command_api_server.cpp`.
  Names may be qualified (`commands::GetVersion`, `google::protobuf::Empty`) and are resolved to full
  proto names through the registry.
- GUI gating: `checkForHeadless( "Req" )` in the same file, or a `HANDLER_MODE::GUI_ONLY` argument on
  the registration.

`commands.json` rows: `{ command, group, requestType, responseType, handlers, headless }` with
`headless` one of `ok | gui-only | partial | unregistered`; `responseType` is `null` for unregistered
commands. The client generator (`packages/client`) consumes this file.
