@echo off
title LLM Fine-tuning Studio
color 0A
cls

echo.
echo ================================================================
echo            LLM FINE-TUNING STUDIO - SIMPLE LAUNCHER
echo ================================================================
echo.
echo Starting application...
echo.

cd /d "%~dp0\LLM"

REM Check for virtual environment
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found!
    echo.
    echo This appears to be a fresh clone. Running first-time setup...
    echo.
    
    REM Create venv
    echo [1/3] Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo [FAILED] Could not create virtual environment!
        echo.
        echo Make sure Python 3.8+ is installed: https://www.python.org/downloads/
        pause
        exit /b 1
    )
    
    REM Install base requirements
    echo [2/3] Installing PySide6 for GUI...
    .venv\Scripts\python.exe -m pip install --upgrade pip
    .venv\Scripts\python.exe -m pip install PySide6==6.8.1
    if errorlevel 1 (
        echo [FAILED] Could not install PySide6!
        pause
        exit /b 1
    )
    
    echo [3/3] First-time setup complete!
    echo.
    echo NOTE: Additional dependencies will be installed on first run.
    echo.
    pause
)

REM Launch the application
echo Launching GUI...
echo.
start "" .venv\Scripts\pythonw.exe -m desktop_app.main

exit /b 0

