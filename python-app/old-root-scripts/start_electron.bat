@echo off
REM Quick launcher for LLM Fine-tuning Studio Electron App (Development)

echo ========================================
echo LLM Fine-tuning Studio - Quick Start
echo ========================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Navigate to electron-app directory
cd /d "%~dp0electron-app"

REM Check if node_modules exists
if not exist "node_modules" (
    echo [First Run] Installing dependencies...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Failed to install dependencies!
        pause
        exit /b 1
    )
    echo.
)

echo Starting LLM Fine-tuning Studio...
echo.

REM Start the app
call npm start

