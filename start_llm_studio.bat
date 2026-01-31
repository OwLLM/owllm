@echo off
echo ========================================
echo   LLM Fine-tuning Studio Launcher
echo ========================================
echo.

cd /d "%~dp0\LLM"

REM Check if virtual environment exists
if not exist ".venv\Scripts\python.exe" (
    echo ERROR: Virtual environment not found!
    echo Please run the installer first.
    pause
    exit /b 1
)

echo Starting LLM Fine-tuning Studio...
echo.

REM Launch the desktop app
start "" .venv\Scripts\pythonw.exe -m desktop_app.main

exit /b 0

