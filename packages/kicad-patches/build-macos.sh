#!/usr/bin/env bash
# Build kicad-cli (+ pcbnew and eeschema kifaces) from the KiCad 10.99 checkout on macOS
# using Homebrew libraries. Produces build/<type>/kicad/KiCad.app/Contents/MacOS/kicad-cli
# inside the KiCad checkout; kifaces land in KiCad.app/Contents/PlugIns, which is where
# kicad-cli looks for them when run from the build tree.
#
# Usage: build-macos.sh [KICAD_SRC] [BUILD_TYPE]
#   KICAD_SRC   path to the KiCad checkout (default: ../../../kicad relative to this script)
#   BUILD_TYPE  Release (default) | RelWithDebInfo | Debug
#
# Homebrew prerequisites (all present on the machine this was written on):
#   cmake ninja wxwidgets@3.2 boost protobuf nng glew glm cairo pixman harfbuzz freetype
#   fontconfig gettext opencascade libngspice unixodbc libgit2 zstd
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KICAD_SRC="${1:-$(cd "$HERE/../../../kicad" && pwd)}"
BUILD_TYPE="${2:-Release}"
BUILD_DIR="$KICAD_SRC/build/$(echo "$BUILD_TYPE" | tr '[:upper:]' '[:lower:]')"
BREW="$(brew --prefix)"
JOBS="$(sysctl -n hw.ncpu)"
CCACHE_ARGS=()
if command -v ccache >/dev/null 2>&1; then
  CCACHE_ARGS=(-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache)
fi

echo "KiCad source : $KICAD_SRC ($(git -C "$KICAD_SRC" describe --tags --always))"
echo "Build dir    : $BUILD_DIR ($BUILD_TYPE, $JOBS jobs)"

mkdir -p "$BUILD_DIR"
cmake -S "$KICAD_SRC" -B "$BUILD_DIR" -G Ninja \
  "${CCACHE_ARGS[@]}" \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  -DCMAKE_PREFIX_PATH="$BREW" \
  -DwxWidgets_CONFIG_EXECUTABLE="$BREW/bin/wx-config-3.2" \
  -DNGSPICE_LIB_NAME=libngspice.0.dylib \
  -DNGSPICE_ROOT_DIR="$BREW/opt/libngspice" \
  -DOCC_INCLUDE_DIR="$BREW/opt/opencascade/include/opencascade" \
  -DOCC_LIBRARY_DIR="$BREW/opt/opencascade/lib" \
  -DKICAD_BUILD_QA_TESTS=OFF \
  -DKICAD_BUILD_I18N=OFF \
  -DKICAD_SCRIPTING_WXPYTHON=OFF \
  -DKICAD_USE_SENTRY=OFF \
  -DKICAD_UPDATE_CHECK=OFF \
  -DKICAD_INSTALL_DEMOS=OFF \
  -DKICAD_USE_PCH=ON

ninja -C "$BUILD_DIR" -j"$JOBS" kicad-cli pcbnew_kiface eeschema_kiface

CLI="$BUILD_DIR/kicad/KiCad.app/Contents/MacOS/kicad-cli"
echo
echo "Built: $CLI"
"$CLI" version
echo "Run the headless API server with:"
echo "  $CLI api-server [project.kicad_pro] [--socket /tmp/kicad/api.sock]"
