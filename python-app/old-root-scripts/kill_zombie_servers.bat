@echo off
REM Kill Zombie LLM Servers - Windows Batch Script
REM Use this when you get "port already in use" errors

echo ================================================================
echo Zombie LLM Server Killer
echo ================================================================
echo.

echo Scanning for zombie LLM servers on ports 105xx...
echo.

REM Find all processes listening on ports 105xx
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr "127.0.0.1:105"') do (
    if not "%%a"=="0" (
        echo Found zombie server: PID %%a
        taskkill /F /PID %%a 2>nul
        if errorlevel 1 (
            echo   WARNING: Failed to kill PID %%a
        ) else (
            echo   SUCCESS: Killed PID %%a
        )
    )
)

echo.
echo ================================================================
echo Done! All zombie servers have been killed.
echo You can now load your models.
echo.
echo Note: If ports are still in TIME_WAIT, wait 30-60 seconds.
echo ================================================================
echo.

pause
