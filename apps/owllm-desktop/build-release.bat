@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PATH=%USERPROFILE%\.cargo\bin;C:\mingw64\bin;%PATH%"
set "RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [owllm-desktop] Rust is not installed or not on PATH.
  echo Install from https://rustup.rs then reopen this window and run again.
  exit /b 1
)

where x86_64-w64-mingw32-gcc >nul 2>nul
if errorlevel 1 (
  echo [owllm-desktop] MinGW GCC is not on PATH.
  echo Expected: C:\mingw64\bin\x86_64-w64-mingw32-gcc.exe
  exit /b 1
)

rustup toolchain install stable-x86_64-pc-windows-gnu
if errorlevel 1 exit /b 1

echo [owllm-desktop] Building web UI...
call npm run build
if errorlevel 1 exit /b 1

echo [owllm-desktop] Building Tauri release with GNU toolchain ^(this can take several minutes on first run^)...
call npm run tauri -- build --target x86_64-pc-windows-gnu
if errorlevel 1 exit /b 1

echo.
echo [owllm-desktop] Done.
set "RELEASE=%cd%\src-tauri\target\x86_64-pc-windows-gnu\release"
set "DIST=%cd%\dist"
if not exist "%DIST%" mkdir "%DIST%"
copy /Y "%RELEASE%\owllm-desktop.exe" "%cd%\OwLLM Desktop.exe" >nul
copy /Y "%RELEASE%\owllm-desktop.exe" "%DIST%\OwLLM Desktop.exe" >nul
rem WebView2Loader.dll MUST sit next to the exe — without it Windows
rem aborts startup with "WebView2Loader.dll was not found". The release
rem build emits it into %RELEASE%; copy alongside both portable exes.
if exist "%RELEASE%\WebView2Loader.dll" (
  copy /Y "%RELEASE%\WebView2Loader.dll" "%cd%\WebView2Loader.dll" >nul
  copy /Y "%RELEASE%\WebView2Loader.dll" "%DIST%\WebView2Loader.dll" >nul
)
copy /Y "%RELEASE%\bundle\nsis\OwLLM Desktop_0.1.0_x64-setup.exe" "%DIST%\OwLLM Desktop Setup.exe" >nul
echo   Run now:       %cd%\OwLLM Desktop.exe
echo   Dist exe:      %DIST%\OwLLM Desktop.exe
echo   Dist setup:    %DIST%\OwLLM Desktop Setup.exe
echo   Cargo output:  %RELEASE%
exit /b 0
