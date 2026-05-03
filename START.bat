@echo off
REM =============================================================
REM   OWLLM / LLM Fine-Tuning Studio — production entry point
REM
REM   Single source of truth for "double-click to launch":
REM     1. Use the BUNDLED Python runtime under
REM        LLM\python_runtime\ — never touch system Python.
REM     2. Hand off to LLM\LAUNCHER.py so it can run the
REM        health gate (PySide6 OK? torch+CUDA OK?) and route
REM        to safe-mode (installer GUI from bundled Python)
REM        when the workload venv is broken at the C-extension
REM        layer. Without this hand-off, the safe-mode path
REM        is dead code in production.
REM =============================================================

setlocal EnableExtensions EnableDelayedExpansion

REM --- Resolve the bundled Python interpreter ------------------
set "REPO_DIR=%~dp0"
set "PY_RUNTIME=%REPO_DIR%LLM\python_runtime"
set "BUNDLED_PY="

if exist "%PY_RUNTIME%\python3.12\python.exe" (
    set "BUNDLED_PY=%PY_RUNTIME%\python3.12\python.exe"
) else if exist "%PY_RUNTIME%\python3.11\python.exe" (
    set "BUNDLED_PY=%PY_RUNTIME%\python3.11\python.exe"
)

if "!BUNDLED_PY!"=="" (
    echo =============================================================
    echo  BUNDLED PYTHON RUNTIME NOT FOUND
    echo =============================================================
    echo.
    echo  Looked under:
    echo    %PY_RUNTIME%\python3.12\python.exe
    echo    %PY_RUNTIME%\python3.11\python.exe
    echo.
    echo  OWLLM is designed to be self-contained and never use
    echo  system Python. The bundled runtime appears to be missing
    echo  from this install.
    echo.
    echo  Re-extract the OWLLM zip / re-run the installer so the
    echo  python_runtime\ folder is present.
    echo.
    pause
    exit /b 1
)

echo =============================================================
echo  OWLLM launcher
echo =============================================================
echo  Bundled Python: !BUNDLED_PY!
echo.

REM Always run from the LLM dir so relative imports in LAUNCHER.py
REM resolve the way they expect.
pushd "%REPO_DIR%LLM"

REM Hand off to LAUNCHER.py — it owns:
REM   * venv discovery
REM   * PySide6 health probe
REM   * torch+CUDA probe + safe-mode route
REM   * dependency check
REM   * the actual app launch (or installer GUI fallback)
"!BUNDLED_PY!" "%REPO_DIR%LLM\LAUNCHER.py"
set "LAUNCHER_RC=%ERRORLEVEL%"

popd

if not "%LAUNCHER_RC%"=="0" (
    echo.
    echo Launcher exited with code %LAUNCHER_RC%.
    echo Check LLM\logs\app.log and LLM\logs\auto_repair.log for details.
    pause
)

exit /b %LAUNCHER_RC%
