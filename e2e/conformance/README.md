# API conformance suite

The IPC API conformance suite — one test per headless command against a real
`kicad-cli api-server` and the kitchen-sink fixtures — is owned by the client SDK agent (A4)
and lives next to the client it exercises:

```
packages/client/test/conformance/*.kicad.test.ts
```

It is an **integration** suite by the workspace convention (`*.kicad.test.ts`, or any test file under a
`conformance/` directory — `tooling/ci/run-tests.ts`), so `bun run test:unit` never runs it and
`bun run test:integration` does. The tests skip themselves with a message when the
`kicad-cli` binary cannot be found.

```bash
# macOS, after packages/kicad-patches/build-macos.sh
KICAD_CLI=../kicad/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli bun run test:integration

# only the conformance directory
KICAD_CLI=... bun run --filter @fp-pcb/client test:conformance

# Linux / CI, using the Docker image from packages/kicad-patches/build-linux.sh
docker run --rm -d --name kicad -v /tmp/kicad:/tmp/kicad -v "$PWD/e2e/fixtures:/work" fp-pcb/kicad-cli api-server --socket /tmp/kicad/api.sock
```

`KICAD_CLI` is the only knob: when unset, the tests look for the macOS build tree at
`../kicad/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli` (see
`packages/client/test/kicad-fixtures.ts`). Set `KICAD_INTEGRATION_REQUIRED=1` to make the runner fail
instead of warn when it is unset (the `kicad-integration` CI job does this).

This directory intentionally holds no tests, so that the conformance tests, the generated
`commands.ts` they cover and the client they call are versioned together.
