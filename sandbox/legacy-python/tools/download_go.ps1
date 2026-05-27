<#
.SYNOPSIS
    Download the portable Go toolchain into LLM/tools/go/.

.DESCRIPTION
    OWLLM's design principle is "self-contained, no system pollution."
    Building bootstrap.exe needs Go 1.22+, but we don't want to require
    a system-wide Go install. This script fetches the official Go zip
    from go.dev and extracts it under LLM/tools/go/, where
    build_installer.bat picks it up automatically.

    Idempotent: if LLM/tools/go/bin/go.exe already exists at the
    requested version, the script exits without re-downloading.

.PARAMETER Version
    Go version to install (default 1.22.10). Picks the windows-amd64
    archive from https://go.dev/dl/.

.NOTES
    No admin required. Nothing leaves LLM/tools/. Reversible: just
    delete LLM/tools/go/.
#>
param(
    [string]$Version = "1.22.10"
)

$ErrorActionPreference = "Stop"

$llmDir = (Resolve-Path "$PSScriptRoot\..").Path
$target = Join-Path $llmDir "tools\go"
$goExe = Join-Path $target "bin\go.exe"

# Idempotent: skip if the right version is already installed.
if (Test-Path $goExe) {
    $existing = & $goExe version 2>$null
    if ($existing -match [regex]::Escape("go$Version ")) {
        Write-Host "Portable Go already at $Version :  $existing" -ForegroundColor Green
        return
    }
    Write-Host "Existing Go: $existing — replacing with $Version" -ForegroundColor Yellow
    Remove-Item -Recurse -Force $target
}

$url = "https://go.dev/dl/go$Version.windows-amd64.zip"
$dl = Join-Path $llmDir "tools\go.zip"

Write-Host "Downloading $url ..." -ForegroundColor Cyan
$pp = $ProgressPreference; $ProgressPreference = "SilentlyContinue"
try {
    Invoke-WebRequest -Uri $url -OutFile $dl -UseBasicParsing
} finally {
    $ProgressPreference = $pp
}
$sizeMB = [math]::Round((Get-Item $dl).Length / 1MB, 1)
Write-Host "Downloaded $sizeMB MB to $dl" -ForegroundColor Green

Write-Host "Extracting to $target ..." -ForegroundColor Cyan
Expand-Archive -Path $dl -DestinationPath (Split-Path $target) -Force
Remove-Item $dl

if (-not (Test-Path $goExe)) {
    throw "Extraction succeeded but $goExe is missing — archive layout may have changed."
}

Write-Host ""
Write-Host "OK. Verify with:" -ForegroundColor Cyan
& $goExe version
Write-Host ""
Write-Host "build_installer.bat now picks this up automatically."
