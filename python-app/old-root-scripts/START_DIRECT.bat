@echo off
REM ================================================================
REM   DIRECT LAUNCHER - Skips setup wizard, goes straight to app
REM ================================================================

cd /d "%~dp0\LLM"

REM Check if venv exists
if not exist ".venv\Scripts\pythonw.exe" (
    echo ERROR: Virtual environment not found!
    echo Please run START.bat first for initial setup.
    pause
    exit /b 1
)

REM Ensure setup marker exists
if not exist ".setup_complete" (
    echo Creating setup marker...
    echo. > .setup_complete
)

REM Launch the main app directly (no setup wizard)
echo Launching LLM Fine-tuning Studio...
start "" .venv\Scripts\pythonw.exe -m desktop_app.main

echo.
echo App launched! Check your taskbar for the window.

exit /b 0

