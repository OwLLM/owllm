@echo off
echo =============================================
echo   Building LLM Studio Launcher
echo =============================================
echo.

REM Get script directory (generic path)
set "SCRIPT_DIR=%~dp0"
set "ICONS_DIR=%SCRIPT_DIR%..\icons"
set "ICO_ICON=%ICONS_DIR%\owl_launcher.ico"

REM Check if MinGW is installed
where gcc >nul 2>&1
if errorlevel 1 (
    echo ERROR: GCC not found!
    echo.
    echo Please install MinGW-w64:
    echo 1. Download from: https://winlibs.com/
    echo 2. Extract to C:\mingw64
    echo 3. Add C:\mingw64\bin to PATH
    echo 4. Restart terminal and run this script again
    echo.
    pause
    exit /b 1
)

REM Check if ICO icon exists
if not exist "%ICO_ICON%" (
    echo ERROR: ICO icon not found: %ICO_ICON%
    echo Please make sure owl_launcher.ico exists in the icons folder
    echo.
    pause
    exit /b 1
)

REM Kill any running launcher.exe processes to unlock the file
echo.
echo Checking for running launcher.exe processes...
taskkill /F /IM launcher.exe >nul 2>&1
if errorlevel 1 (
    echo No running launcher.exe found (or already closed)
) else (
    echo Closed running launcher.exe processes
)
timeout /t 1 /nobreak >nul

REM Copy icon to build directory for windres
cd /d "%SCRIPT_DIR%"
copy /Y "%ICO_ICON%" "owl_launcher.ico" >nul
if errorlevel 1 (
    echo ERROR: Failed to copy icon file
    pause
    exit /b 1
)

REM Verify icon file exists and has content
if not exist "owl_launcher.ico" (
    echo ERROR: Icon file not found after copy
    pause
    exit /b 1
)

echo.
echo [1/3] Compiling resource file...
echo Using icon: owl_launcher.ico
REM Use absolute path in resource file to ensure it's found
windres -i launcher.rc -o launcher_res.o --input-format=rc --output-format=coff
if errorlevel 1 (
    echo ERROR: Failed to compile resource file
    echo Make sure owl_launcher.ico exists in: %ICONS_DIR%
    pause
    exit /b 1
)
echo SUCCESS: Resource compiled

echo.
echo [2/3] Compiling C++ source with static linking...
g++ -O2 -s -mwindows launcher.cpp launcher_res.o -o launcher.exe -static -static-libgcc -static-libstdc++ -lshlwapi -lurlmon
if errorlevel 1 (
    echo ERROR: Failed to compile launcher
    pause
    del launcher_res.o
    exit /b 1
)
echo SUCCESS: Launcher compiled (fully static, no DLL dependencies)

echo.
echo [3/3] Cleaning up temporary files...
del launcher_res.o
del owl_launcher.ico
echo SUCCESS: Cleanup complete

echo.
echo =============================================
echo   launcher.exe created successfully!
echo =============================================
echo.

REM Show file size
for %%A in (launcher.exe) do echo File size: %%~zA bytes (%%~zAKB)

echo.
echo You can now:
echo 1. Test it: Double-click launcher.exe
echo 2. Commit it: git add launcher.exe
echo.
pause

