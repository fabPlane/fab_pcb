#
# Linux build of the KiCad fork's headless server: `kicad-cli` + the pcbnew and eeschema
# kifaces, from the same three ninja targets and CMake flags as ../build-macos.sh.
#
# Source selection (build arg KICAD_SOURCE):
#   context (default)  the build context IS the KiCad tree (build-linux.sh exports `git archive`
#                      of the fork checkout into a scratch directory and points docker at it)
#   git                clone KICAD_REPO at KICAD_REF inside the build (CI without a local checkout)
#
#   docker build -f Dockerfile --build-arg KICAD_SOURCE=git \
#       --build-arg KICAD_REPO=https://gitlab.com/<fork>/kicad.git --build-arg KICAD_REF=web-api \
#       -t fp-pcb/kicad-cli .
#
# Dependency list: Debian trixie packages, mirroring KiCad's own qa/arm64/Dockerfile and
# install-deps.sh (wxWidgets 3.2 GTK, nng, protobuf, OpenCascade, ngspice, boost, cairo, harfbuzz,
# libgit2, libsecret, unixODBC, poppler-glib, zint, glm, nlohmann-json). No swig/wxPython:
# the 10.99 tree has no scripting option any more and the server does not need Python.
#
# Runtime stage: the exact runtime packages are computed in the build stage with `ldd` + `dpkg -S`
# over the produced binaries, so the final image carries no -dev packages. `kicad-cli` is a
# wxAppConsole (kicad/kicad_cli.cpp) and `api-server` never opens a window, so no X display is
# needed: DISPLAY is left unset. xvfb is NOT installed; if a future KiCad change starts requiring
# a display, add `xvfb` here and wrap the entrypoint in `xvfb-run -a`.

ARG BASE=debian:trixie
ARG KICAD_SOURCE=context

# ----------------------------------------------------------------------------- sources
FROM ${BASE} AS src-context
COPY . /src

FROM ${BASE} AS src-git
ARG KICAD_REPO=https://gitlab.com/kicad/code/kicad.git
ARG KICAD_REF=web-api
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# init + fetch works for branches, tags and bare commit ids alike (unlike `clone --branch`)
RUN git init -q /src && cd /src \
    && git remote add origin "$KICAD_REPO" \
    && git fetch --depth 1 origin "$KICAD_REF" \
    && git checkout -q FETCH_HEAD \
    && git rev-parse HEAD > /src/.kicad-commit

FROM src-${KICAD_SOURCE} AS src

# ----------------------------------------------------------------------------- build
FROM ${BASE} AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build pkg-config git ca-certificates ccache \
    libwxgtk3.2-dev libwxgtk-webview3.2-dev libgtk-3-dev \
    libboost-all-dev \
    libcairo2-dev libpixman-1-dev libharfbuzz-dev libfontconfig1-dev libfreetype-dev libglib2.0-dev \
    libcurl4-openssl-dev libgit2-dev libsecret-1-dev libsqlite3-dev unixodbc-dev \
    libprotobuf-dev protobuf-compiler libnng-dev \
    libngspice0-dev ngspice \
    libocct-data-exchange-dev libocct-draw-dev libocct-foundation-dev libocct-modeling-algorithms-dev \
    libocct-modeling-data-dev libocct-ocaf-dev libocct-visualization-dev \
    nlohmann-json3-dev libglm-dev libzint-dev libpoppler-glib-dev \
    libgl-dev libglu1-mesa-dev libegl-dev libgles-dev libx11-dev \
    libwayland-dev wayland-protocols libspnav-dev \
    libzstd-dev zlib1g-dev libbz2-dev libssl-dev python3-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=src /src /src
WORKDIR /src

ARG BUILD_TYPE=Release
# Parallel jobs; leave empty for nproc. The pcbnew translation units need ~1.5 GB each with PCH,
# so keep JOBS*1.5 GB under the machine's memory (Docker Desktop defaults to a small VM).
ARG JOBS=
# Label only (the tree comes from git archive, so CMake cannot ask git itself)
ARG KICAD_REF=web-api

# resources/CMakeLists.txt reads translation/pofiles/LINGUAS and the top-level CMakeLists.txt
# add_subdirectory(doxygen) even with I18N off; keep both present when the context trimmed them.
RUN mkdir -p /src/translation/pofiles /src/doxygen \
    && touch /src/translation/pofiles/LINGUAS \
    && [ -f /src/doxygen/CMakeLists.txt ] || touch /src/doxygen/CMakeLists.txt
RUN --mount=type=cache,target=/ccache,sharing=locked \
    export CCACHE_DIR=/ccache && \
    cmake -S /src -B /src/build/linux -G Ninja \
      -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
      -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
      -DCMAKE_INSTALL_PREFIX=/opt/kicad \
      -DKICAD_BUILD_QA_TESTS=OFF \
      -DKICAD_BUILD_I18N=OFF \
      -DKICAD_USE_SENTRY=OFF \
      -DKICAD_UPDATE_CHECK=OFF \
      -DKICAD_INSTALL_DEMOS=OFF \
      -DKICAD_USE_PCH=ON \
    && ninja -C /src/build/linux ${JOBS:+-j$JOBS} kicad-cli pcbnew_kiface eeschema_kiface \
    && ccache -s

# Stage the runtime tree. On Linux KIWAY looks for _*.kiface next to the executable
# (common/kiway.cpp dso_search_path), so the binaries go into one bin/ directory. KiCad 10.99 also
# builds libkicommon / libkigal / libkiapi as shared libraries (build-tree RPATH only), so they are
# copied to lib/ and found through LD_LIBRARY_PATH in the runtime stage.
#
# Runtime packages: `ldd` lists the resolved .so paths; on merged-/usr Debian they print as
# /lib/... while dpkg records /usr/lib/..., so resolve with realpath before `dpkg -S`. The list must
# not be empty and no library may stay unresolved, otherwise the build fails here rather than at
# `docker run`.
RUN set -eu \
    && mkdir -p /opt/kicad/bin /opt/kicad/lib /opt/kicad/share/kicad \
    && cp build/linux/kicad/kicad-cli build/linux/pcbnew/_pcbnew.kiface build/linux/eeschema/_eeschema.kiface /opt/kicad/bin/ \
    && find build/linux -name 'libki*.so*' -not -path '*/CMakeFiles/*' -exec cp -a {} /opt/kicad/lib/ \; \
    && ls -l /opt/kicad/lib \
    && (cp -r resources/project_template /opt/kicad/share/kicad/template 2>/dev/null || true) \
    && cp -r api/schemas /opt/kicad/share/kicad/schemas \
    && (cat /src/.kicad-commit 2>/dev/null || echo "$KICAD_REF") > /opt/kicad/KICAD_COMMIT \
    && export LD_LIBRARY_PATH=/opt/kicad/lib \
    && bins="/opt/kicad/bin/kicad-cli /opt/kicad/bin/_pcbnew.kiface /opt/kicad/bin/_eeschema.kiface $(ls /opt/kicad/lib/*.so)" \
    && ! ldd $bins | grep -q 'not found' \
    && ldd $bins | awk '/=> \//{print $3}' | sort -u | grep -v '^/opt/kicad/' \
         | xargs -r realpath | sort -u | xargs -r dpkg -S | cut -d: -f1 | sort -u > /opt/kicad/runtime-packages.txt \
    && test -s /opt/kicad/runtime-packages.txt \
    && echo "runtime packages ($(wc -l < /opt/kicad/runtime-packages.txt)):" && cat /opt/kicad/runtime-packages.txt \
    && mkdir -p /opt/kicad/lib/runtime \
    && ldd $bins | awk '/=> \//{print $3}' | sort -u | grep -v '^/opt/kicad/' \
         | while read -r library; do \
             name="$(basename "$library")"; \
             case "$name" in libc.so.*|libm.so.*|libdl.so.*|libpthread.so.*|librt.so.*|ld-linux-*) continue ;; esac; \
             cp -L "$library" "/opt/kicad/lib/runtime/$name"; \
           done \
    && test -n "$(find /opt/kicad/lib/runtime -maxdepth 1 -type f -print -quit)" \
    && echo "bundled runtime libraries: $(find /opt/kicad/lib/runtime -maxdepth 1 -type f | wc -l)"

# ----------------------------------------------------------------------------- runtime
FROM ${BASE} AS runtime
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=build /opt/kicad/runtime-packages.txt /tmp/runtime-packages.txt
RUN apt-get update && apt-get install -y --no-install-recommends \
    $(cat /tmp/runtime-packages.txt) ca-certificates shared-mime-info \
    && rm -rf /var/lib/apt/lists/* /tmp/runtime-packages.txt \
    && useradd -m -u 1000 kicad && mkdir -p /tmp/kicad && chown kicad /tmp/kicad
COPY --from=build /opt/kicad /opt/kicad
COPY entrypoint.sh /usr/local/bin/kicad-entrypoint
RUN chmod +x /usr/local/bin/kicad-entrypoint
ENV PATH=/opt/kicad/bin:$PATH \
    LD_LIBRARY_PATH=/opt/kicad/lib \
    HOME=/home/kicad \
    KICAD_SOCKET_DIR=/tmp/kicad
USER kicad
# Fail the build if the runtime stage cannot run the binary (as the runtime user, so the settings
# KiCad writes on first start under $HOME/.config are owned by `kicad`, not root).
RUN ! ldd /opt/kicad/bin/kicad-cli /opt/kicad/bin/_pcbnew.kiface /opt/kicad/bin/_eeschema.kiface | grep 'not found' \
    && kicad-cli version
WORKDIR /work
# api-server listens on a unix socket; share /tmp/kicad (or /work) with the host / sibling containers.
VOLUME ["/tmp/kicad"]
ENTRYPOINT ["/usr/local/bin/kicad-entrypoint"]
CMD ["version"]
