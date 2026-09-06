#!/bin/sh
# kicad-cli wrapper: `docker run <image> [kicad-cli args]`.
#   docker run --rm <image> version
#   docker run --rm -v /tmp/kicad:/tmp/kicad -v $PWD:/work <image> api-server /work/board.kicad_pcb --socket /tmp/kicad/api.sock
# No DISPLAY is needed (kicad-cli is a wxAppConsole). Should that ever change, install xvfb in
# the Dockerfile and replace the exec line with: exec xvfb-run -a kicad-cli "$@"
set -e
# The GTK backend of wxWidgets logs a warning when no session bus exists; silence it.
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-/dev/null}"
exec kicad-cli "$@"
