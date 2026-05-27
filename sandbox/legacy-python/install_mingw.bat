@echo off
echo =============================================
echo   MinGW-w64 Quick Installer
echo =============================================
echo.
echo This script will help you install MinGW-w64 (GCC compiler for Windows)
echo.
echo Option 1: Manual Install (Recommended)
echo   1. Open: https://winlibs.com/
echo   2. Download: "Win64 - MSVCRT runtime" (first option)
echo   3. Extract to C:\mingw64
echo   4. Add C:\mingw64\bin to system PATH
echo.
echo Option 2: Use Chocolatey (if installed)
echo   choco install mingw
echo.
echo After installation, close and reopen your terminal, then run:
echo   build_launcher.bat
echo.
pause

