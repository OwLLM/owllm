<#
.SYNOPSIS
    Register OWLLM's bundled Python + workspace as Windows Defender exclusions.

.DESCRIPTION
    OWLLM's repeated nighttime crashes correlated with Windows Defender
    instability (mpengine.dll segfaulted twice on 2026-05-11 around 22:30).
    Defender's real-time scanner hooks into every running process's address
    space and AV/extension memory races are a documented source of Windows
    desktop app crashes — especially for processes with large C-extensions
    like PySide6, torch, and pyarrow.

    Adding the OWLLM tree to Defender's exclusion list stops the scanner
    from injecting into the bundled python.exe and from rescanning the
    venv site-packages on every dll load.

.NOTES
    Requires elevated PowerShell (Run as administrator).
    To remove these exclusions later:

        Remove-MpPreference -ExclusionPath "C:\1_Git\LocaLLM\LLM"
        Remove-MpPreference -ExclusionProcess "python.exe"
        Remove-MpPreference -ExclusionProcess "launcher.exe"
#>

$ErrorActionPreference = "Stop"

# Verify admin
$current = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $current.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: this script must be run as administrator." -ForegroundColor Red
    Write-Host "Right-click PowerShell -> Run as administrator, then re-run."
    exit 1
}

# Resolve repo root from script location (tools/ is one level under LLM/).
$llmDir = (Resolve-Path "$PSScriptRoot\..").Path
$repoRoot = (Resolve-Path "$llmDir\..").Path

Write-Host "Adding Defender exclusions for OWLLM..." -ForegroundColor Cyan
Write-Host "  LLM dir : $llmDir"
Write-Host "  repo    : $repoRoot"

# Path exclusions — skip on-access scan for these whole trees.
$paths = @(
    $llmDir,
    "$llmDir\.envs",
    "$llmDir\python_runtime",
    "$llmDir\runtime",
    "$llmDir\runtime\llama.cpp"
)

foreach ($p in $paths) {
    if (Test-Path $p) {
        try {
            Add-MpPreference -ExclusionPath $p -ErrorAction Stop
            Write-Host "  + path : $p" -ForegroundColor Green
        } catch {
            Write-Host "  ! path : $p — $($_.Exception.Message)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  - skip : $p (does not exist yet)" -ForegroundColor DarkGray
    }
}

# Process exclusions — skip scanning the running images.
$procs = @("python.exe", "pythonw.exe", "launcher.exe", "llama-server.exe")
foreach ($proc in $procs) {
    try {
        Add-MpPreference -ExclusionProcess $proc -ErrorAction Stop
        Write-Host "  + proc : $proc" -ForegroundColor Green
    } catch {
        Write-Host "  ! proc : $proc — $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Done. Verify with:" -ForegroundColor Cyan
Write-Host "  Get-MpPreference | Select-Object -ExpandProperty ExclusionPath"
Write-Host "  Get-MpPreference | Select-Object -ExpandProperty ExclusionProcess"
