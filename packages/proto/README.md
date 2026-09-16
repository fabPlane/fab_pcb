# @fp-pcb/proto

Layer 0 of the client stack: TypeScript types for every KiCad IPC API message, generated with
[protobuf-es v2](https://github.com/bufbuild/protobuf-es) from the KiCad checkout pinned in
`KICAD_COMMIT`. Consumers never need `buf`; `src/gen` is committed.

## Contract

```ts
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { ApiRequestSchema, ApiResponseSchema, PingSchema, packAny, unpackAny, unpackAnyAs, typeUrlOf, kiapiRegistry } from "@fp-pcb/proto";

const req = create(ApiRequestSchema, { header: { clientName: "fp-pcb/x" }, message: packAny(PingSchema, create(PingSchema)) });
const bytes = toBinary(ApiRequestSchema, req); // goes on the wire
const res = fromBinary(ApiResponseSchema, replyBytes);
const inner = unpackAny(res.message!); // Message | undefined, resolved via kiapiRegistry
const typed = unpackAnyAs(res.message!, GetVersionResponseSchema);
```

- Flat exports: `XxxSchema` (descriptor), `Xxx` (type), `XxxJson` (JSON type), enums as TS enums.
  Names that exist in both `kiapi.board.types` and `kiapi.schematic.types` (`Group`, `JumperGroup`,
  `JumperSettings`, `TableStrokeMode`) are exported as `BoardGroup` / `SchematicGroup` etc.
- Per-module namespaces keep the original names: `board_types.Group`, `schematic_types.GroupSchema`.
- `kiapiFiles`: every generated file descriptor; `kiapiRegistry`: registry over those plus
  google.protobuf Any/Empty/FieldMask/Duration/Timestamp/Struct/wrappers.
- `typeUrlOf(schema)` = `type.googleapis.com/<fullName>` (what KiCad puts in `Any.type_url`).
- `int64` fields (`Distance.value_nm`, `Vector2.x_nm`, ...) are `bigint`; convert at the client layer.
- proto3 `optional` fields are `T | undefined`; `oneof`s are `{ case: "text", value } | { case: undefined }`.
- Field names are camelCase (`kicad_token` -> `kicadToken`); JSON uses the same camelCase names with int64 as strings.

## Scripts

| Command                        | What it does                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run gen`                  | `buf generate` from `$KICAD_SRC/api/proto` (default `../../../kicad`) at git HEAD into `src/gen`, rewrite `src/gen/index.ts`, write `KICAD_COMMIT` |
| `KICAD_WORKTREE=1 bun run gen` | same, but from the working tree (for iterating on uncommitted API patches)                                                                         |
| `bun run check`                | regenerate into a scratch dir and fail on any difference or a `KICAD_COMMIT` mismatch (CI drift check)                                             |
| `bun test`                     | round trips, real byte captures, int64 behaviour                                                                                                   |

Generation options (`buf.gen.yaml`): `target=ts`, `import_extension=js`, `json_types=true`. Well-known
types come from buf's bundled WKT and map to `@bufbuild/protobuf/wkt`.
