@echo off
rem ==============================================================
rem  OWLLM Desktop launcher (release / one-click)
rem  Double-click this file to run the app.
rem    * If "OwLLM Desktop.exe" already exists -> just run it.
rem    * Otherwise -> build it once via build-release.bat,
rem      then run. First build can take several minutes.
rem  Use launch-dev.bat for the HMR dev workflow.
rem ==============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title OWLLM Desktop

set "EXE=%cd%\OwLLM Desktop.exe"
set "WEBVIEW_DLL=%cd%\WebView2Loader.dll"

rem Sanity: the exe needs WebView2Loader.dll as a sibling on Windows.
rem If the DLL is missing, treat it as a stale build and force a rebuild
rem so build-release.bat re-copies it alongside the exe.
set "REBUILD=0"
if exist "%EXE%" if not exist "%WEBVIEW_DLL%" set "REBUILD=1"

rem Freshness check — rebuild if any .tsx/.ts/.css/.rs source is newer
rem than the built exe. PowerShell one-liner: compare LastWriteTime
rem against the most recent source file. Exits 1 if a rebuild is needed.
if exist "%EXE%" if "!REBUILD!"=="0" (
  for /f %%i in ('powershell -NoProfile -Command "$exe=Get-Item '%EXE%'; $newest=Get-ChildItem -Recurse -File '%cd%\ui\src','%cd%\src-tauri\src','%cd%\src-tauri\Cargo.toml','%cd%\src-tauri\tauri.conf.json' ^| Sort-Object LastWriteTime -Descending ^| Select-Object -First 1; if ($newest -and $newest.LastWriteTime -gt $exe.LastWriteTime) { 'stale' } else { 'fresh' }"') do set "FRESHNESS=%%i"
  if /i "!FRESHNESS!"=="stale" set "REBUILD=1"
)

if exist "%EXE%" if "!REBUILD!"=="0" (
  echo [owllm-desktop] Starting OwLLM Desktop ^(built version is current^)...
  start "" "%EXE%"
  exit /b 0
)

if exist "%EXE%" (
  echo [owllm-desktop] Built exe is older than current source.
  echo [owllm-desktop] Rebuilding so you get the latest UI ^(3-8 min^)...
) else (
  echo [owllm-desktop] First-run: built app not found at "%EXE%".
  echo [owllm-desktop] Building release once ^(GNU toolchain, 3-8 minutes^)...
)
echo.

call "%cd%\build-release.bat"
if errorlevel 1 (
  echo.
  echo [owllm-desktop] Build failed. See messages above.
  echo [owllm-desktop] Tip: install Rust from https://rustup.rs and MinGW from
  echo                 https://winlibs.com  ^(unzip to C:\mingw64^).
  pause
  exit /b 1
)

if exist "%EXE%" (
  echo.
  echo [owllm-desktop] Build OK. Launching...
  start "" "%EXE%"
  exit /b 0
)

echo [owllm-desktop] Build completed but the exe is still missing — check build-release.bat output.
pause
exit /b 1
