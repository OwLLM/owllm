$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Resolve-Path (Join-Path $here "..")

Push-Location $app

try {
  # Python smoke (python_engine) was removed on 2026-05-14 when the
  # bundled Python HTTP server was deleted. Rust now owns the runtime.

  npm run build | Write-Host

  if (Get-Command cargo -ErrorAction SilentlyContinue) {
    Push-Location (Join-Path $app "src-tauri")
    try {
      $env:PATH = "$env:USERPROFILE\.cargo\bin;C:\mingw64\bin;$env:PATH"
      $env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"
      cargo check --target x86_64-pc-windows-gnu | Write-Host
    } finally {
      Pop-Location
    }
  } else {
    Write-Warning "cargo not found on PATH; skipping Rust tests (install Rust via rustup)."
  }
} finally {
  Pop-Location
}
