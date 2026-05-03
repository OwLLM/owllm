@echo off
REM =============================================================
REM   OWLLM / LLM Fine-Tuning Studio — launcher (LLM-dir entry)
REM
REM   Equivalent to ..\START.bat but kept here so users running
REM   from inside LLM\ get the same self-contained behaviour.
REM   ALWAYS uses the bundled python_runtime — never system Python.
REM =============================================================

setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

cd /d "%~dp0"

set "BUNDLED_PY="
if exist "python_runtime\python3.12\python.exe" (
    set "BUNDLED_PY=%~dp0python_runtime\python3.12\python.exe"
) else if exist "python_runtime\python3.11\python.exe" (
    set "BUNDLED_PY=%~dp0python_runtime\python3.11\python.exe"
)

if "!BUNDLED_PY!"=="" (
    echo Bundled Python runtime not found under python_runtime\python3.{11,12}\.
    echo OWLLM is designed to be self-contained and never use system Python.
    echo Re-extract OWLLM or re-run the installer to restore python_runtime\.
    pause
    exit /b 1
)

"!BUNDLED_PY!" "%~dp0LAUNCHER.py"
set "LAUNCHER_RC=%ERRORLEVEL%"

if not "%LAUNCHER_RC%"=="0" (
    echo.
    echo Launcher exited with code %LAUNCHER_RC%.
    echo See logs\app.log and logs\auto_repair.log for details.
    pause
)

exit /b %LAUNCHER_RC%
