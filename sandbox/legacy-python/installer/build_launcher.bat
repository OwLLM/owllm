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

REM Kill any running launcher processes to unlock the files
echo.
echo Checking for running launcher.exe / launcher_worker.exe...
taskkill /F /IM launcher.exe >nul 2>&1
taskkill /F /IM launcher_worker.exe >nul 2>&1
if errorlevel 1 (
    echo No running launcher processes found (or already closed)
) else (
    echo Closed running launcher processes
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
echo [1/4] Compiling resource file...
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
echo [2/4] Compiling launcher_worker.exe (console, hidden)...
g++ -O2 -s -mconsole -DLOCALLLM_LAUNCHER_WORKER launcher.cpp -o launcher_worker.exe -static -static-libgcc -static-libstdc++ -lshlwapi -lurlmon -luser32
if errorlevel 1 (
    echo ERROR: Failed to compile launcher_worker.exe
    pause
    del launcher_res.o
    exit /b 1
)
echo SUCCESS: launcher_worker.exe built

echo.
echo [3/4] Compiling launcher.exe (GUI stub)...
g++ -O2 -s -mwindows -DLOCALLLM_LAUNCHER_GUI launcher.cpp launcher_res.o -o launcher.exe -static -static-libgcc -static-libstdc++ -lshlwapi -lurlmon -luser32
if errorlevel 1 (
    echo ERROR: Failed to compile launcher.exe
    pause
    del launcher_res.o
    exit /b 1
)
echo SUCCESS: launcher.exe built

echo.
echo [4/4] Cleaning up temporary files...
del launcher_res.o
del owl_launcher.ico
echo SUCCESS: Cleanup complete

echo.
echo =============================================
echo   launcher.exe + launcher_worker.exe created!
echo =============================================
echo.

REM Show file sizes
for %%A in (launcher.exe) do echo launcher.exe size: %%~zA bytes
for %%A in (launcher_worker.exe) do echo launcher_worker.exe size: %%~zA bytes

echo.
echo You can now:
echo 1. Test: Double-click launcher.exe (it starts launcher_worker.exe hidden)
echo 2. Commit: git add launcher.exe launcher_worker.exe
echo.
pause

