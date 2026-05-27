@echo off
REM ============================================================
REM CLEAN INSTALL - Guaranteed to work
REM ============================================================
echo.
echo ============================================================
echo LLM Fine-tuning Studio - Clean Installation
echo ============================================================
echo.
echo This will:
echo   1. Delete existing virtual environment
echo   2. Delete existing wheelhouse (cached downloads)
echo   3. Delete setup markers
echo   4. Start fresh installation with correct versions
echo.
pause

cd /d "%~dp0"

echo.
echo [1/4] Deleting virtual environment...
if exist ".venv" (
    rmdir /s /q ".venv"
    echo   Done
) else (
    echo   No venv found (OK)
)

echo.
echo [2/4] Deleting wheelhouse cache...
if exist "wheelhouse" (
    rmdir /s /q "wheelhouse"
    echo   Done
) else (
    echo   No wheelhouse found (OK)
)

echo.
echo [3/4] Deleting setup markers...
if exist ".setup_complete" del /q ".setup_complete"
if exist "logs\setup.log" del /q "logs\setup.log"
echo   Done

echo.
echo [4/4] Starting clean installation...
echo.
echo ============================================================
echo.

REM Launch the installer
if exist "Launcher3.exe" (
    start "" "Launcher3.exe"
) else if exist "LAUNCHER.bat" (
    call "LAUNCHER.bat"
) else (
    echo ERROR: No launcher found!
    echo Please run from the LLM directory.
    pause
    exit /b 1
)

echo Installation started!
echo.
echo Check the installer window for progress.
echo If it fails, check: logs\setup.log
echo.

