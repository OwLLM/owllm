@echo off
:: bootstrap.bat â€” build OwLLM Desktop module ZIPs from upstream binaries.
::
:: Wrapper around scripts\build-modules.ps1. Reads bootstrap-manifest.json,
:: downloads pinned llama.cpp / whisper.cpp / Python embed / Node.js / uv /
:: wheelhouses, packs them into ZIPs under dist\modules\, computes SHA-256.
::
:: Idempotent. Safe to re-run â€” cached upstream binaries are reused unless
:: -ForceRedownload is passed. Output ZIPs are reused unless -ForceRebuild.
::
:: Usage:
::   bootstrap.bat                          REM build all modules
::   bootstrap.bat -Only local-inference-cuda
::   bootstrap.bat -Skip finetune-*         REM skip the slow wheelhouse ones
::
:: After this completes, copy the sha256 values from dist\modules\*.sha256
:: into data\modules\registry.json and upload the ZIPs to a GitHub Release.

setlocal enabledelayedexpansion
cd /d "%~dp0"

where pwsh >nul 2>nul
if errorlevel 1 (
    where powershell >nul 2>nul
    if errorlevel 1 (
        echo [owllm] PowerShell not on PATH. Install pwsh or use the legacy powershell.exe.
        exit /b 1
    )
    set "PS=powershell"
) else (
    set "PS=pwsh"
)

%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-modules.ps1" %*
exit /b %ERRORLEVEL%
