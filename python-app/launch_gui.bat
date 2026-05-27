@echo off
REM Launcher for LLM Fine-tuning Studio
cd /d "%~dp0"
python gui.py
if errorlevel 1 (
    echo.
    echo Error: Failed to start GUI
    echo Make sure Python and dependencies are installed.
    pause
)
