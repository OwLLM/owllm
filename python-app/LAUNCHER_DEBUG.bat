@echo off
chcp 65001 >nul
title 🐛 LLM Fine-tuning Studio Launcher (DEBUG MODE)
color 0E

echo.
echo ═══════════════════════════════════════════════════════
echo    🐛 LLM Fine-tuning Studio - DEBUG MODE 🐛
echo ═══════════════════════════════════════════════════════
echo.
echo This debug launcher will:
echo  - Show all console output
echo  - Keep the window open after exit
echo  - Display detailed error messages
echo.

REM Change to script directory
cd /d "%~dp0"

REM Check if first-time setup has been completed
if not exist ".setup_complete" (
    echo.
    echo ⚙️  First-time setup required...
    echo This will detect your hardware and install all dependencies.
    echo Please wait, this may take 5-15 minutes.
    echo.
    
    REM Activate virtual environment if it exists
    if exist .venv\Scripts\activate.bat (
        call .venv\Scripts\activate.bat
    )
    
    REM Run first-time setup
    python first_run_setup.py
    
    if errorlevel 1 (
        echo.
        echo ❌ Setup failed! Please check the logs above.
        echo.
        echo Common issues:
        echo  - No internet connection
        echo  - Python not in PATH
        echo  - Antivirus blocking downloads
        echo.
        echo You can retry by running this launcher again.
        pause
        exit /b 1
    )
    
    echo.
    echo ✅ Setup completed successfully!
    echo.
)

REM Normal app launch
echo Starting application...
echo.

if exist .venv\Scripts\activate.bat (
  echo ✓ Activating virtual environment...
  call .venv\Scripts\activate.bat
)

REM Show Python version and environment info
echo.
echo === DEBUG INFO ===
python --version
echo Virtual Environment: %VIRTUAL_ENV%
echo Working Directory: %CD%
echo.
echo === STARTING APP ===
echo.

REM Launch with console visible for debugging
python -m desktop_app.main

if errorlevel 1 (
    echo.
    echo ❌ Application failed to start!
    echo.
    echo Exit code: %errorlevel%
    echo.
    echo Try running: python verify_installation.py
    echo to check your installation.
    echo.
)

echo.
echo === APP CLOSED ===
echo.
pause

