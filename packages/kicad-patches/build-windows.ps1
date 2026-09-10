# Build only the headless KiCad targets on Windows, stage their runtime, then assemble the backend.
# Dependencies must already be installed in build/release/vcpkg_installed by CI (or vcpkg manually).
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
$installed = Join-Path $build "vcpkg_installed"
if (-not (Test-Path $installed)) { throw "vcpkg dependencies are missing: $installed" }
cmake -S $KicadSource -B $build -G Ninja `
  -DCMAKE_TOOLCHAIN_FILE="$VcpkgRoot\scripts\buildsystems\vcpkg.cmake" `
  -DVCPKG_OVERLAY_TRIPLETS="$KicadSource\tools\custom_vcpkg_triplets" `
  -DVCPKG_TARGET_TRIPLET=x64-windows `
  -DVCPKG_MANIFEST_INSTALL=OFF `
  -DVCPKG_INSTALLED_DIR="$installed" `
  -DCMAKE_BUILD_TYPE=Release -DKICAD_BUILD_QA_TESTS=OFF -DKICAD_BUILD_I18N=OFF `
  -DKICAD_USE_SENTRY=OFF -DKICAD_UPDATE_CHECK=OFF -DKICAD_INSTALL_DEMOS=OFF `
  -DKICAD_WIN32_INSTALL_PDBS=OFF -DKICAD_USE_PCH=ON
if ($LASTEXITCODE) { exit $LASTEXITCODE }
cmake --build $build --target kicad-cli pcbnew_kiface eeschema_kiface --parallel
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& "$PSScriptRoot\stage-windows.ps1" -KicadSource $KicadSource -BuildDir $build -Output $stage
if ($LASTEXITCODE) { exit $LASTEXITCODE }
bun run "$PSScriptRoot\bundle.ts" windows-x64 $stage $Footprints $Symbols $Output
exit $LASTEXITCODE
