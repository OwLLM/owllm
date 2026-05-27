@echo off
REM Python Installation Checker and Setup Helper
REM Run this after installing Python to verify everything works

echo ================================================
echo   Python Installation Verification
echo ================================================
echo.

REM Check if Python is available
where python >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [1/3] Python found:
    python --version
    goto :python_found
)

where python3 >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [1/3] Python3 found:
    python3 --version
    set PYTHON_CMD=python3
    goto :python_found
)

where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [1/3] Py launcher found:
    py --version
    set PYTHON_CMD=py
    goto :python_found
)

echo ERROR: Python not found!
echo.
echo Please install Python from: https://www.python.org/downloads/
echo Make sure to check "Add Python to PATH" during installation.
echo.
echo After installation, restart Command Prompt and run this script again.
echo.
pause
exit /b 1

:python_found
echo.
echo Testing Python functionality...

if "%PYTHON_CMD%"=="" set PYTHON_CMD=python

%PYTHON_CMD% -c "print('Python is working!')" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [2/3] Python execution works
) else (
    echo ERROR: Python execution failed!
    pause
    exit /b 1
)

%PYTHON_CMD% -m pip --version >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [3/3] Pip is available
) else (
    echo ERROR: Pip not working!
    pause
    exit /b 1
)

echo.
echo ================================================
echo   Setting up GUI Environment
echo ================================================

REM Create virtual environment if it doesn't exist
if not exist ".venv" (
    echo Creating virtual environment...
    %PYTHON_CMD% -m venv .venv
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: Failed to create virtual environment!
        pause
        exit /b 1
    )
    echo Virtual environment created.
)

REM Activate virtual environment
echo Activating virtual environment...
call .venv\Scripts\activate.bat
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to activate virtual environment!
    pause
    exit /b 1
)

REM Install dependencies
echo Installing GUI dependencies...
pip install -r requirements.txt
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to install dependencies!
    pause
    exit /b 1
)

echo.
echo ================================================
echo   GPU Check
echo ================================================
python -c "import torch; print('GPU Available:', torch.cuda.is_available()); print('GPU Name:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU Mode')" 2>nul

echo.
echo ================================================
echo   Ready to Launch GUI!
echo ================================================
echo.
echo Everything is set up!
echo.
echo To start the GUI, run:
echo    run_gui.bat
echo.
echo Or start it manually:
echo    streamlit run gui.py
echo.
echo The GUI will open at: http://localhost:8501
echo.

set /p choice="Would you like to start the GUI now? (y/n): "
if /i "%choice%"=="y" goto start_gui
if /i "%choice%"=="yes" goto start_gui
goto end

:start_gui
echo Starting GUI...
streamlit run gui.py

:end
echo.
echo You can start the GUI anytime by running run_gui.bat
pause

