@echo off
REM Check Model Status After Clone
REM Run this script after cloning the repository to check which models need downloading

echo ======================================================================
echo   LLM Studio - Model Status Check
echo ======================================================================
echo.

cd /d "%~dp0LLM"

python check_models_after_clone.py

if %ERRORLEVEL% EQU 0 (
    echo.
    echo All models are complete!
    echo.
) else (
    echo.
    echo Some models need to be downloaded.
    echo See instructions above or check MODEL_MANAGEMENT_GUIDE.md
    echo.
)

pause

