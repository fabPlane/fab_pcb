# macOS CI routing

Normal tests and compilation stay on Linux. The backend release workflow needs
macOS to package and smoke-test the macOS-native KiCad runtime and target JDK.

Apple Silicon release jobs prefer the shared company Mac when its shared
heartbeat is fresh and idle. A busy, offline, stale, or already-reserved Mac
selects `blacksmith-6vcpu-macos-15`. The control job itself runs on Blacksmith
Linux. Intel packaging uses Blacksmith with Rosetta to execute the native
Intel JDK and backend; it does not consume the Apple Silicon local reservation.

The Mac's existing repository listener is now connected continuously, alongside
the other company repository listeners, instead of being available only during
a rotation window. An OS-level job hook serializes builds across those
listeners, and completed checkout workspaces are removed. The shared VM is a
build machine rather than a fresh installer-test image.

A fast-forward-only control ref (`ci-macos-lease`) reserves local capacity
within this repository. A cleanup workflow releases it; completed or cancelled
owners can be reclaimed on the next selection. The monitor publishes a shared
busy signal to every participating repository. Fork PRs use hosted capacity.

`Shared Mac runner smoke` compiles and executes native C without publishing
backend releases. Existing Linux and Windows job routing is unchanged.
