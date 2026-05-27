@echo off
REM Fix PyTorch DLL initialization error on Windows
REM This script will reinstall PyTorch with CPU-only version if needed

echo ================================================
echo   Fixing PyTorch DLL Error
echo ================================================
echo.

cd /d "%~dp0"

REM Check if virtual environment exists
if not exist ".venv" (
    echo ERROR: Virtual environment not found!
    echo Run install_python.bat first.
    pause
    exit /b 1
)

REM Activate virtual environment
echo Activating virtual environment...
call .venv\Scripts\activate.bat
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to activate virtual environment!
    pause
    exit /b 1
)

echo.
echo ================================================
echo   Step 1: Uninstalling PyTorch
echo ================================================
pip uninstall torch torchvision torchaudio -y

echo.
echo ================================================
echo   Step 2: Installing CPU-only PyTorch
echo ================================================
echo Installing PyTorch CPU version (more stable on Windows)...
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: Failed to install PyTorch!
    echo.
    echo Alternative: Install Visual C++ Redistributables:
    echo https://aka.ms/vs/17/release/vc_redist.x64.exe
    echo.
    pause
    exit /b 1
)

echo.
echo ================================================
echo   Step 3: Verifying Installation
echo ================================================
python -c "import torch; print('PyTorch version:', torch.__version__); print('CUDA available:', torch.cuda.is_available())"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ================================================
    echo   SUCCESS! PyTorch is now working.
    echo ================================================
    echo.
    echo You can now run the GUI:
    echo   start_gui.bat
    echo.
) else (
    echo.
    echo ERROR: PyTorch still not working.
    echo.
    echo Please try:
    echo 1. Install Visual C++ Redistributables:
    echo    https://aka.ms/vs/17/release/vc_redist.x64.exe
    echo.
    echo 2. Restart your computer
    echo.
    echo 3. Run this script again
    echo.
)

pause

