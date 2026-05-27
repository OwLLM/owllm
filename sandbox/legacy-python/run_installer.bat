@echo off
REM Bootstrap launcher for OWLLM Installer
REM ALWAYS runs installer from bootstrap\.venv, never from LLM\.venv

setlocal enabledelayedexpansion

REM Get script directory
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM Locate project root / LLM dir robustly
REM If installer_gui.py exists in SCRIPT_DIR, then SCRIPT_DIR is the LLM folder.
if exist "%SCRIPT_DIR%installer_gui.py" (
    set "LLM_DIR=%SCRIPT_DIR%"
    set "PROJECT_ROOT=%SCRIPT_DIR%..\"
) else (
    REM Otherwise assume we're in project root and LLM is a subfolder
    set "PROJECT_ROOT=%SCRIPT_DIR%"
    set "LLM_DIR=%SCRIPT_DIR%LLM\"
)

set "BOOTSTRAP_VENV=%PROJECT_ROOT%\bootstrap\.venv"
set "BOOTSTRAP_PYTHON=%BOOTSTRAP_VENV%\Scripts\python.exe"
set "INSTALLER_SCRIPT=%LLM_DIR%\installer_gui.py"

REM Ensure bootstrap folder exists (repo may not have it yet)
if not exist "%PROJECT_ROOT%\bootstrap" (
    mkdir "%PROJECT_ROOT%\bootstrap" >nul 2>&1
)

REM Check if bootstrap venv exists
if not exist "%BOOTSTRAP_PYTHON%" (
    echo Creating bootstrap venv...
    
    REM Find system Python (prefer 3.10-3.12)
    set "SYSTEM_PYTHON="
    for %%P in (py -3.12 py -3.11 py -3.10 python3.12 python3.11 python3.10 python3 python py -3) do (
        %%P --version >nul 2>&1
        if !ERRORLEVEL! EQU 0 (
            REM Check if version is in supported range (3.10-3.12)
            for /f "delims=" %%V in ('%%P -c "import sys; v=sys.version_info; print(v.major*100+v.minor)" 2^>nul') do (
                if %%V GEQ 310 if %%V LEQ 312 (
                    for /f "delims=" %%E in ('%%P -c "import sys; print(sys.executable)" 2^>nul') do set "SYSTEM_PYTHON=%%E"
                    if defined SYSTEM_PYTHON goto :found_python
                )
            )
        )
    )
    
    :found_python
    if not defined SYSTEM_PYTHON (
        echo ERROR: Cannot find compatible Python!
        echo This installer requires Python 3.10, 3.11, or 3.12.
        echo Please install a supported Python version from https://www.python.org/downloads/
        pause
        exit /b 1
    )
    
    REM Create bootstrap venv
    "%SYSTEM_PYTHON%" -m venv "%BOOTSTRAP_VENV%"
    if !ERRORLEVEL! NEQ 0 (
        echo ERROR: Failed to create bootstrap venv!
        pause
        exit /b 1
    )
    
    REM Install installer dependencies
    echo Installing installer dependencies...
    "%BOOTSTRAP_PYTHON%" -m pip install -U pip --quiet
    if exist "%LLM_DIR%\installer_requirements.txt" (
        "%BOOTSTRAP_PYTHON%" -m pip install -r "%LLM_DIR%\installer_requirements.txt" --quiet
    )
)

REM Run installer from bootstrap
echo Starting installer from bootstrap...
"%BOOTSTRAP_PYTHON%" "%INSTALLER_SCRIPT%"

endlocal

