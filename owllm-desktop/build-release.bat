@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PATH=%USERPROFILE%\.cargo\bin;C:\mingw64\bin;%PATH%"
set "RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu"
rem CFLAGS workaround for gcc 13.2.0 IRA ICE compiling sqlite3.c.
rem Default -O3 trips an internal compiler error in the integrated
rem register allocator; -O1 keeps optimisation but skips the failing
rem pass. Applied per-target so host build scripts use default flags.
set "CFLAGS_x86_64_pc_windows_gnu=-O1"
rem CPU is an i9-13900KF that has degraded under the Raptor Lake
rem Vmin-shift issue. WHEA-Logger ID 19 logged a Translation Lookaside
rem Buffer error on Processor APIC ID 32 (E-core range). To finish
rem builds while waiting for Intel RMA, pin every cargo/rustc child
rem to P-cores only via the cmd-affinity wrapper below. Affinity mask
rem 0xFFFF covers logical processors 0-15 = the 8 P-cores with HT;
rem the E-cores at 16-31 (including the failing one) are excluded.
rem CARGO_BUILD_JOBS=8 keeps per-rustc memory pressure moderate while
rem still using half the P-core threads for throughput.
set "CARGO_BUILD_JOBS=8"

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

echo [owllm-desktop] Building Tauri release with GNU toolchain on P-cores only ^(E-cores excluded to dodge CPU TLB errors^)...
rem start /affinity FFFF launches a child cmd pinned to logical
rem processors 0-15 (P-cores w/ HT). All grandchildren of that cmd
rem (cargo, every rustc subprocess, gcc, link) inherit the same
rem affinity mask automatically — Windows propagates affinity on
rem CreateProcess unless the child explicitly resets it.
rem /b runs in the same console, /wait blocks the .bat until the
rem inner cmd finishes so errorlevel propagates back correctly.
start "owllm-build" /affinity FFFF /b /wait cmd /c "call npm run tauri -- build --target x86_64-pc-windows-gnu & exit /b !errorlevel!"
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
