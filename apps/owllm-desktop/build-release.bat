@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem 2026-05-17: switched from GNU/mingw to MSVC. The GNU toolchain on
rem Windows kept producing non-deterministic toolchain failures: gcc
rem 13.2.0 ICE in the IRA pass compiling sqlite3.c, rustc segfaulting
rem with STATUS_ACCESS_VIOLATION on our lib, LTO bitcode corruption
rem after partial builds. MSVC is the path Microsoft actually
rem maintains and is significantly more stable. Requires "Visual
rem Studio Build Tools 2022" with the "Desktop development with C++"
rem workload, OR a Visual Studio install.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [owllm-desktop] Rust is not installed or not on PATH.
  echo Install from https://rustup.rs then reopen this window and run again.
  exit /b 1
)

where cl >nul 2>nul
if errorlevel 1 (
  echo [owllm-desktop] MSVC C++ compiler ^(cl.exe^) not on PATH.
  echo Install "Visual Studio Build Tools 2022" with the
  echo "Desktop development with C++" workload, then run this from a
  echo "x64 Native Tools Command Prompt for VS 2022", OR run vcvars64
  echo first:
  echo    "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
  exit /b 1
)

rustup toolchain install stable-x86_64-pc-windows-msvc
if errorlevel 1 exit /b 1

echo [owllm-desktop] Building web UI...
call npm run build
if errorlevel 1 exit /b 1

echo [owllm-desktop] Building Tauri release with MSVC toolchain ^(this can take several minutes on first run^)...
call npm run tauri -- build --target x86_64-pc-windows-msvc
if errorlevel 1 exit /b 1

echo.
echo [owllm-desktop] Done.
set "RELEASE=%cd%\src-tauri\target\x86_64-pc-windows-msvc\release"
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
