@echo off
REM Build script for LLM Fine-tuning Studio Electron App (Windows)

echo ========================================
echo LLM Fine-tuning Studio - Build Script
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

echo [Step 1/4] Installing dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to install dependencies!
    pause
    exit /b 1
)
echo.

echo [Step 2/4] Checking Python environment...
if exist "..\LLM\.venv\Scripts\python.exe" (
    echo [OK] Python virtual environment found
) else (
    echo [WARNING] Python virtual environment not found at ..\LLM\.venv\
    echo Make sure your Python environment is set up correctly
)
echo.

echo [Step 3/4] Building Electron app for Windows...
call npm run build:win
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed!
    pause
    exit /b 1
)
echo.

echo [Step 4/4] Build complete!
echo.
echo ========================================
echo Build Output:
echo ========================================
dir /b dist\*.exe 2>nul
if %ERRORLEVEL% EQU 0 (
    echo.
    echo Installers created in: electron-app\dist\
    echo.
    echo - Setup installer: LLM-Studio-Setup-1.0.0.exe
    echo - Portable version: LLM-Studio-1.0.0-portable.exe
) else (
    echo [WARNING] No .exe files found in dist folder
)
echo.
echo ========================================

pause

