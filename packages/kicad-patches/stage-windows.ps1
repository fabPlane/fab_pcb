# Stage a relocatable Windows runtime from the targeted kicad-cli build.
param(
  [Parameter(Mandatory = $true)][string]$KicadSource,
  [Parameter(Mandatory = $true)][string]$BuildDir,
  [Parameter(Mandatory = $true)][string]$Output
)
$ErrorActionPreference = "Stop"
$KicadSource = (Resolve-Path $KicadSource).Path
$BuildDir = (Resolve-Path $BuildDir).Path
if (Test-Path $Output) { Remove-Item -Recurse -Force $Output }
$bin = New-Item -ItemType Directory -Force -Path (Join-Path $Output "bin")
$share = New-Item -ItemType Directory -Force -Path (Join-Path $Output "share\kicad")

function Find-BuildFile([string]$Name) {
  $hits = @(Get-ChildItem -Path $BuildDir -Recurse -File -Filter $Name |
    Where-Object { $_.FullName -notmatch '\\CMakeFiles\\' -and $_.FullName -notmatch '\\vcpkg_installed\\' })
  if ($hits.Count -eq 0) { throw "no $Name under $BuildDir" }
  if ($hits.Count -gt 1) {
    Write-Warning "$($hits.Count) copies of $Name under $BuildDir; taking the newest"
    $hits = @($hits | Sort-Object LastWriteTime -Descending)
  }
  return $hits[0].FullName
}

foreach ($name in "kicad-cli.exe", "_pcbnew.dll", "_eeschema.dll", "kicommon.dll", "kigal.dll", "kiapi.dll") {
  Copy-Item (Find-BuildFile $name) $bin
}

# Copy the complete vcpkg runtime set. It is intentionally a superset of the DLL import closure,
# which is more robust than trying to reproduce Windows loader resolution in PowerShell.
Copy-Item (Join-Path $BuildDir "vcpkg_installed\x64-windows\bin\*.dll") $bin
if ($env:VCToolsRedistDir) {
  $crt = Get-ChildItem -Path (Join-Path $env:VCToolsRedistDir "x64") -Directory -Filter "Microsoft.VC*.CRT" |
    Select-Object -First 1
  if ($crt) { Copy-Item (Join-Path $crt.FullName "*.dll") $bin }
  else { throw "MSVC runtime directory not found below $env:VCToolsRedistDir\x64" }
} else {
  throw "VCToolsRedistDir is not set; run from an MSVC developer environment"
}

Copy-Item -Recurse (Join-Path $KicadSource "api\schemas") (Join-Path $share "schemas")
Copy-Item -Recurse (Join-Path $KicadSource "resources\project_template") (Join-Path $share "template")

& (Join-Path $bin "kicad-cli.exe") version
exit $LASTEXITCODE
