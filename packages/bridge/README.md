# @kicad-web/bridge

Bun process that sits between browser tabs and `kicad-cli api-server`:

- speaks nng SP framing on KiCad's unix socket (`NngIpcTransport` from `@kicad-web/client/transport`, no native deps);
- spawns and supervises one `kicad-cli api-server` per **session**, reports its state to clients;
- forwards WebSocket binary frames byte-for-byte, serialising them onto KiCad's one-request-at-a-time REQ/REP socket;
- exposes a file API confined to a workspace root and optional static hosting for `apps/web`.

```
bun run --filter @kicad-web/bridge start        # or: bun packages/bridge/src/main.ts
```

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4020` | HTTP + WebSocket port (`0` = pick a free one) |
| `HOST` | `127.0.0.1` | bind address |
| `KICAD_CLI` | `../kicad/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli` | server binary |
| `KICAD_SOCKET_DIR` | `/tmp/kicad` | where `api-<session>.sock` files go |
| `WORKSPACE_ROOT` | `../kicad/qa/data` | root of the `/files` API |
| `STATIC_DIR` | unset | directory served for unmatched `GET`s, with SPA fallback to `index.html` |
| `KICAD_REQUEST_TIMEOUT_MS` | `120000` | per-request timeout towards KiCad |
| `KICAD_START_TIMEOUT_MS` | `60000` | time allowed for a new server to answer `Ping` with `AS_OK` |
| `WS_IDLE_TIMEOUT_SEC` | `900` | WebSocket idle timeout (the bridge sends pings) |
| `WS_MAX_PAYLOAD_BYTES` | 64 MiB | largest WebSocket message accepted |

## HTTP API

| Route | Effect |
|---|---|
| `GET /health` | `{ok, kicadCli, kicadCliExists, workspaceRoot, sessions:[...]}` |
| `GET /sessions` | list sessions (`id, state, path, socketPath, pid, kicadToken, exitCode, signal, clients, ...`) |
| `POST /sessions` `{path?, socket?, id?}` | spawn `kicad-cli api-server [path] --socket <sock>`, wait until `Ping` is `AS_OK`; `201 {session, wsUrl}`. `path` may be a `.kicad_pro`, `.kicad_pcb` or `.kicad_sch` (relative paths resolve against the workspace root; a `.kicad_pro` loads only the project, not the board). `400` bad input, `502` the server failed to start (message includes the last kicad-cli output lines). |
| `GET /sessions/:id` / `GET /sessions/:id/log` | one session / its last 200 stdout+stderr lines |
| `DELETE /sessions/:id` | SIGTERM (SIGKILL after 5 s), unlink socket, close its WebSockets |
| `GET /files/list?path=` · `GET /files/stat?path=` · `GET /files/read?path=` · `PUT /files/write?path=` · `POST /files/mkdir?path=` | confined to `WORKSPACE_ROOT` (lexically and through symlinks); `403` on escape |
| `GET /ws?session=<id>` | WebSocket bound to a session (see below) |

All responses carry permissive CORS headers so a Vite dev server on another port can talk to the bridge.

## WebSocket protocol

Defined in `@kicad-web/client/transport/ws-bridge-protocol.ts`; `WebSocketTransport` implements the client side.

- Binary frame: 4-byte big-endian correlation id + raw `ApiRequest` / `ApiResponse` bytes. Any number of requests may be in flight per socket; the bridge queues them FIFO onto KiCad.
- Text frame: JSON control message
  - `{type:'hello', protocolVersion, sessionId, kicadToken, serverState}` — sent on open
  - `{type:'server-state', sessionId, state:'starting'|'running'|'exited'|'failed', kicadToken?, exitCode?, signal?, message?}` — pushed on every process state change
  - `{type:'error', id, code:'timeout'|'closed'|'protocol'|'connect'|'bad-request'|'no-session'|'internal', message}` — a request failed inside the bridge (`id` null for connection-level problems)
  - `{type:'ping'}` / `{type:'pong'}` — keepalive, either direction

When the KiCad process dies the bridge rejects the in-flight request with `closed`, pushes `server-state`, keeps the session listed (state `failed`/`exited`, with `exitCode`/`signal`) until it is deleted, and answers later requests on that session with an `error{code:'closed'}` frame. The WebSocket itself stays open so the tab can show the state and start a new session.

## Notes on KiCad's server behaviour (measured 2026-09-06, commit cbd303d16b)

- The socket file appears ~150 ms after spawn, **before** the preloaded document is loaded; `Ping` answers `AS_NOT_READY` ("KiCad is not ready to reply") for roughly the next 450 ms with the kitchen-sink board. The bridge polls `Ping` and only reports `running` on `AS_OK`.
- If the requested socket path already exists and another KiCad holds the directory-wide `api.lock`, `kicad-cli` silently listens on `api-<pid>.sock` instead. The bridge unlinks its socket path before spawning and also watches the fallback name.
- Every request costs ~13 ms (the 10 ms `wxMilliSleep` event loop); 200 sequential `Ping`s ≈ 2.6 s direct and ≈ 2.6 s through the bridge (the bridge adds well under 0.1 ms per request). The "1000 Pings < 2 s" exit criterion needs the G18 patch.
- nng queues requests that arrive while one is being processed on the same pipe and answers them in order, and several connections can be open at once; the bridge still keeps one request in flight per socket to match REQ/REP semantics.
- Oversized/garbage requests (tested up to 20 MiB) are answered `AS_BAD_REQUEST` "request could not be parsed" without disturbing the connection.
- `SIGTERM` shuts the server down cleanly in ~0.5 s (exit code 0, "Shutting down"); `SIGKILL` closes the socket immediately and the in-flight request is lost.
