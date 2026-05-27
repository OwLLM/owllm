@echo off
REM Build script for Windows - Creates standalone installer with auto-detection
REM This script builds the application using PyInstaller and creates an NSIS installer

echo ================================================
echo   Building LLM Fine-tuning Studio for Windows
echo ================================================
echo.

REM Check if Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found!
    echo Please install Python 3.8+ and add it to PATH
    pause
    exit /b 1
)

echo Step 1: Installing build dependencies...
python -m pip install --upgrade pip
python -m pip install -r requirements_build.txt
if errorlevel 1 (
    echo ERROR: Failed to install build dependencies
    pause
    exit /b 1
)

echo.
echo Step 2: Installing application dependencies...
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install application dependencies
    pause
    exit /b 1
)

echo.
echo Step 3: Running system detection test...
python system_detector.py
if errorlevel 1 (
    echo WARNING: System detection test failed
)

echo.
echo Step 4: Building executable with PyInstaller...
pyinstaller --clean llm_studio.spec
if errorlevel 1 (
    echo ERROR: PyInstaller build failed
    pause
    exit /b 1
)

echo.
echo Step 5: Copying application files to dist...
if not exist "dist\LLM_Studio" mkdir "dist\LLM_Studio"
copy /Y gui.py "dist\LLM_Studio\"
copy /Y finetune.py "dist\LLM_Studio\"
copy /Y run_adapter.py "dist\LLM_Studio\"
copy /Y validate_prompts.py "dist\LLM_Studio\"
copy /Y system_detector.py "dist\LLM_Studio\"
copy /Y smart_installer.py "dist\LLM_Studio\"
copy /Y verify_installation.py "dist\LLM_Studio\"
copy /Y requirements.txt "dist\LLM_Studio\"

echo.
echo Step 6: Creating installer with NSIS...
REM Check if NSIS is available
where makensis >nul 2>&1
if errorlevel 1 (
    echo WARNING: NSIS not found in PATH
    echo Installer script created but not compiled
    echo Install NSIS from https://nsis.sourceforge.io/
    echo Then run: makensis installer_windows.nsi
) else (
    makensis installer_windows.nsi
    if errorlevel 1 (
        echo ERROR: NSIS compilation failed
    ) else (
        echo Installer created successfully!
    )
)

echo.
echo ================================================
echo   Build Complete!
echo ================================================
echo.
echo Executable: dist\LLM_Studio.exe
echo Installer: dist\LLM_Studio_Installer.exe (if NSIS was available)
echo.
pause

