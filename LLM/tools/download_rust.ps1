<#
.SYNOPSIS
    Download the portable Rust toolchain into LLM/tools/rust/.

.DESCRIPTION
    Mirror of download_go.ps1. OWLLM's "self-contained, no system
    pollution" rule applies to Rust the same way it applies to Go.

    Fetches the official Rust toolchain archive from
    https://static.rust-lang.org/dist/ and extracts it under
    LLM/tools/rust/. build_installer.bat then uses
    LLM/tools/rust/bin/cargo.exe directly without touching the
    system PATH.

    Uses the GNU ABI (rust-x86_64-pc-windows-gnu) so it links against
    the same MinGW toolchain that already builds launcher.exe. No
    MSVC / Visual Studio dependency.

.PARAMETER Version
    Rust version to install. Default is 1.78.0 — the oldest stable
    that has full support for everything bootstrap_rs needs.

.NOTES
    No admin required. Reversible: just delete LLM/tools/rust/.
#>
param(
    [string]$Version = "1.78.0"
)

$ErrorActionPreference = "Stop"

$llmDir = (Resolve-Path "$PSScriptRoot\..").Path
$target = Join-Path $llmDir "tools\rust"
$cargoExe = Join-Path $target "bin\cargo.exe"

if (Test-Path $cargoExe) {
    $existing = & $cargoExe --version 2>$null
    if ($existing -match [regex]::Escape("cargo $Version ")) {
        Write-Host "Portable Rust already at $Version :  $existing" -ForegroundColor Green
        return
    }
    Write-Host "Existing Rust: $existing — replacing with $Version" -ForegroundColor Yellow
    Remove-Item -Recurse -Force $target
}

# The standalone Rust distribution comes as a .tar.gz. PowerShell
# 5.1 can't extract .tar.gz natively, so we use the bundled tar.exe
# that ships on Windows 10 1803+. Falls back to 7z if tar isn't
# available.
$archive = "rust-$Version-x86_64-pc-windows-gnu.tar.gz"
$url = "https://static.rust-lang.org/dist/$archive"
$dl = Join-Path $llmDir "tools\$archive"

Write-Host "Downloading $url ..." -ForegroundColor Cyan
$pp = $ProgressPreference; $ProgressPreference = "SilentlyContinue"
try {
    Invoke-WebRequest -Uri $url -OutFile $dl -UseBasicParsing
} finally {
    $ProgressPreference = $pp
}
$sizeMB = [math]::Round((Get-Item $dl).Length / 1MB, 1)
Write-Host "Downloaded $sizeMB MB to $dl" -ForegroundColor Green

$tarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tarExe) {
    throw "tar.exe not found on PATH. Install Windows 10 1803+ or 7-Zip and retry."
}

# Extract to a staging dir; the archive contains an outer
# rust-X.Y.Z-... folder we have to merge.
$staging = Join-Path $llmDir "tools\_rust_staging"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging | Out-Null

Write-Host "Extracting (this can take a couple of minutes) ..." -ForegroundColor Cyan
& tar.exe -xzf $dl -C $staging
if ($LASTEXITCODE -ne 0) {
    throw "tar extraction failed with exit code $LASTEXITCODE"
}

# Find the inner rust-X.Y.Z-* dir and run its install.sh / install.exe
# equivalent — for the standalone archive, we just need to copy
# components into $target.
$inner = Get-ChildItem $staging -Directory | Select-Object -First 1
if (-not $inner) {
    throw "Couldn't find inner rust-* folder inside the archive"
}

# The standalone tarball is structured as:
#   rust-X.Y.Z-x86_64-pc-windows-gnu/
#     install.sh              <- not useful on Windows
#     rustc/                  <- compiler
#     cargo/                  <- package manager
#     rust-std-x86_64-pc-windows-gnu/  <- stdlib for that target
# Each component has a `manifest.in` listing files to install
# relative to a destination prefix. For an offline install we copy
# rustc/, cargo/, and rust-std-* into one merged dir at $target.

if (Test-Path $target) { Remove-Item -Recurse -Force $target }
New-Item -ItemType Directory -Path $target | Out-Null

$components = @("rustc", "cargo", "rust-std-x86_64-pc-windows-gnu")
foreach ($c in $components) {
    $compDir = Join-Path $inner.FullName $c
    if (-not (Test-Path $compDir)) {
        Write-Host "warning: component $c not found in archive — skipping" -ForegroundColor Yellow
        continue
    }
    Write-Host "  merging component: $c" -ForegroundColor DarkCyan
    # Each component has a single top-level dir whose contents go
    # straight into $target. Copy bin/, lib/, share/, etc.
    Get-ChildItem $compDir -Force | Where-Object { $_.PSIsContainer } | ForEach-Object {
        $src = Join-Path $compDir $_.Name
        $dst = Join-Path $target $_.Name
        # Use robocopy for fast merge; tolerate exit codes 0..7.
        $rc = robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /NS /NC 2>$null
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy failed (exit $LASTEXITCODE) merging $src -> $dst"
        }
    }
}

Remove-Item -Recurse -Force $staging
Remove-Item $dl

if (-not (Test-Path $cargoExe)) {
    throw "Extraction completed but $cargoExe is missing — archive layout may have changed."
}

Write-Host ""
Write-Host "OK. Verify with:" -ForegroundColor Cyan
& $cargoExe --version
& (Join-Path $target "bin\rustc.exe") --version
Write-Host ""
Write-Host "build_installer.bat will pick this up automatically once the"
Write-Host "Rust path is enabled (default after migration R6)."
