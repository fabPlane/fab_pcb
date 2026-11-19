# Native setup for a new machine

Use a setup script or let the development agent install prerequisites. No Docker is needed.
Keep system installation outside measured routing time. Record the actual setup and smoke result.

## Linux x86-64 reference environment

The supported reference is Ubuntu 24.04 x86-64, Python 3.12, stock KiCad 10.0.6 and Bun 1.4+.
The five router assets themselves are installed by `setup.py`, automatically on the first
benchmark invocation or explicitly with:

```bash
python3 benchmarks/autorouter/setup.py
```

Before running that script, install the system prerequisites. On Ubuntu 24.04 the package list is:

```bash
sudo apt-get update
sudo apt-get install python3 python3-venv cmake g++ git ca-certificates \
  libcli11-dev nlohmann-json3-dev libeigen3-dev libboost-dev libsqlite3-dev libzstd-dev
```

Install Bun from its [official installation instructions](https://bun.com/docs/installation).
Version 1.4.0 was used for qualification. Install stock KiCad 10.0.6, including its Python
`pcbnew` module, rather than a Fabdesk/FabPCB runtime or the newest available KiCad.
The original Ubuntu package is still available from its
[archived Launchpad build](https://launchpad.net/~kicad/+archive/ubuntu/kicad-10.0-releases/+build/33552541):

- [KiCad 10.0.6 amd64 package](https://launchpadlibrarian.net/875124375/kicad_10.0.6~ubuntu24.04.1_amd64.deb)
- Package SHA-256: `a4920d3fc7b5719b8d5efa4ee24603a4313b50a53409bb5417f50770ce73926d`
- Extracted `/usr/bin/kicad-cli` SHA-256:
  `03d0a691514fa384d4e4a81331c2ba5a872c8493fa78f54032aec011eeb22402`

Download and verify the package before installing it with `sudo apt-get install ./PACKAGE.deb`.
The installer will resolve its system library dependencies. Then check `import pcbnew` using
`/usr/bin/python3`. The benchmark independently enforces the KiCad executable checksum.

Once prerequisites are present:

```bash
bun run benchmark:autorouter --check
bun run benchmark:autorouter --smoke
```

The first command installs any missing router assets. The smoke runs one small case once per
router and generates JSON/native evidence and HTML. Inspect the summary for five completed,
valid attempts. A zero exit status alone does not establish board validity. Once ready, the
normal command runs all 390 attempts:

```bash
bun run benchmark:autorouter
```

Observed 2026-10-16: a clean Git export with no router assets or benchmark download cache fetched
all pinned sources/binaries, built TraceMaker CPU, prepared drandyhaas/KiCadRoutingTools' venv
and passed all five smoke attempts. The host already had system prerequisites installed.
This verifies automatic router installation; it is not qualification of every Linux distribution.

## macOS status and agent handoff

The current benchmark does **not** run unchanged on macOS, on either Intel or Apple Silicon.
Do not run the existing installer there expecting native binaries: its pinned downloads are Linux
assets. A native macOS port needs more than dependency installation:

- Discover the KiCad application's CLI and compatible Python/`pcbnew`; replace Linux-only
  executable paths throughout the relocated harness, while preserving check semantics.
- Obtain or build the same five engine revisions for the host architecture, including the native
  KiCadRoutingTools library and TraceMaker CPU target. Record platform artifact hashes.
- Replace Linux `/proc` telemetry and CPU-affinity calls with supported measurements or explicit
  unavailable fields. Preserve full route timing and native pass gates.
- Preserve the original Linux checker and input records. Introduce a separately identified
  portable runtime/checker profile, with the Mac KiCad identity recorded; do not remove the Linux
  checksum gate and call the result an exact reference-runtime reproduction.
- Run the five-engine smoke on a real Mac and verify the generated HTML before claiming support.

An agent setting up on a Mac should report this compatibility work explicitly. Linux smoke results
are not evidence of macOS support. No macOS execution has been tested for this benchmark.
