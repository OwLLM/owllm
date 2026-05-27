@echo off
REM Bootstrap Launcher - Works WITHOUT system Python
REM Downloads Python embeddable if needed and runs the installer

setlocal enabledelayedexpansion

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo ============================================================
echo   LLM Fine-tuning Studio - Bootstrap Launcher
echo ============================================================
echo.

REM Configuration
set "PYTHON_VERSION=3.12.0"
set "PYTHON_RUNTIME_DIR=python_runtime"
set "PYTHON_EMBEDDABLE_URL=https://www.python.org/ftp/python/%PYTHON_VERSION%/python-%PYTHON_VERSION%-embed-amd64.zip"
set "PYTHON_ZIP=python-embed.zip"
set "PYTHON_DIR=%PYTHON_RUNTIME_DIR%\python%PYTHON_VERSION:~0,3%"

REM Check if Python runtime already exists
if exist "%PYTHON_DIR%\python.exe" (
    echo [OK] Python runtime found at: %PYTHON_DIR%
    goto :run_installer
)

echo [INFO] Python runtime not found. Downloading Python embeddable...
echo.

REM Create python_runtime directory
if not exist "%PYTHON_RUNTIME_DIR%" mkdir "%PYTHON_RUNTIME_DIR%"

REM Download Python embeddable using PowerShell
echo [1/3] Downloading Python %PYTHON_VERSION% embeddable package...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference = 'SilentlyContinue'; ^
    try { ^
        Invoke-WebRequest -Uri '%PYTHON_EMBEDDABLE_URL%' -OutFile '%PYTHON_ZIP%' -UseBasicParsing; ^
        Write-Host '[OK] Download complete' ^
    } catch { ^
        Write-Host '[ERROR] Download failed:' $_.Exception.Message; ^
        exit 1 ^
    }"

if errorlevel 1 (
    echo [ERROR] Failed to download Python embeddable package.
    echo Please check your internet connection and try again.
    pause
    exit /b 1
)

REM Extract Python embeddable
echo [2/3] Extracting Python embeddable package...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "try { ^
        Expand-Archive -Path '%PYTHON_ZIP%' -DestinationPath '%PYTHON_DIR%' -Force; ^
        Write-Host '[OK] Extraction complete' ^
    } catch { ^
        Write-Host '[ERROR] Extraction failed:' $_.Exception.Message; ^
        exit 1 ^
    }"

if errorlevel 1 (
    echo [ERROR] Failed to extract Python embeddable package.
    pause
    exit /b 1
)

REM Clean up zip file
if exist "%PYTHON_ZIP%" del "%PYTHON_ZIP%"

REM Configure Python embeddable (uncomment pip in python312._pth)
echo [3/3] Configuring Python embeddable...
if exist "%PYTHON_DIR%\python312._pth" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "(Get-Content '%PYTHON_DIR%\python312._pth') -replace '^#import site$', 'import site' | Set-Content '%PYTHON_DIR%\python312._pth'"
)

REM Download get-pip.py for pip installation
if not exist "%PYTHON_DIR%\get-pip.py" (
    echo [INFO] Downloading pip installer...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ProgressPreference = 'SilentlyContinue'; ^
        Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile '%PYTHON_DIR%\get-pip.py' -UseBasicParsing"
    
    if exist "%PYTHON_DIR%\get-pip.py" (
        echo [INFO] Installing pip...
        "%PYTHON_DIR%\python.exe" "%PYTHON_DIR%\get-pip.py" --quiet
    )
)

echo [OK] Python runtime ready at: %PYTHON_DIR%
echo.

:run_installer
REM Check if installer_gui.py exists
if not exist "installer_gui.py" (
    echo [ERROR] installer_gui.py not found in current directory.
    echo Current directory: %CD%
    pause
    exit /b 1
)

echo ============================================================
echo   Starting Installer GUI...
echo ============================================================
echo.

REM Run installer using Python runtime
"%PYTHON_DIR%\python.exe" "installer_gui.py"

if errorlevel 1 (
    echo.
    echo [ERROR] Installer failed. Check the log above for details.
    pause
    exit /b 1
)

endlocal
