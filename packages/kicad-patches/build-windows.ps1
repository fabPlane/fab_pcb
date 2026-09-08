# Build the KiCad fork on Windows with its upstream vcpkg toolchain, then assemble the backend bundle.
# Run from a Developer PowerShell with CMake, Ninja, Bun, and vcpkg installed.
param(
  [string]$KicadSource = (Resolve-Path "$PSScriptRoot\..\..\..\kicad"),
  [string]$VcpkgRoot = $env:VCPKG_ROOT,
  [string]$Footprints = $env:KICAD_FOOTPRINT_DIR,
  [string]$Symbols = $env:KICAD_SYMBOL_DIR,
  [string]$Output = "$PSScriptRoot\dist\windows-x64"
)
$ErrorActionPreference = "Stop"
if (-not $VcpkgRoot) { throw "Pass -VcpkgRoot or set VCPKG_ROOT" }
if (-not $Footprints) { throw "Pass -Footprints or set KICAD_FOOTPRINT_DIR" }
if (-not $Symbols) { throw "Pass -Symbols or set KICAD_SYMBOL_DIR" }
$build = Join-Path $KicadSource "build\release"
$stage = Join-Path $KicadSource "build\bundle-runtime"
cmake -S $KicadSource -B $build -G Ninja `
  -DCMAKE_TOOLCHAIN_FILE="$VcpkgRoot\scripts\buildsystems\vcpkg.cmake" `
  -DVCPKG_OVERLAY_TRIPLETS="$KicadSource\tools\custom_vcpkg_triplets" `
  -DCMAKE_BUILD_TYPE=Release -DKICAD_BUILD_QA_TESTS=OFF -DKICAD_BUILD_I18N=OFF `
  -DKICAD_USE_SENTRY=OFF -DKICAD_UPDATE_CHECK=OFF -DKICAD_INSTALL_DEMOS=OFF -DKICAD_USE_PCH=OFF
cmake --build $build --parallel
cmake --install $build --prefix $stage
bun run "$PSScriptRoot\bundle.ts" windows-x64 $stage $Footprints $Symbols $Output
