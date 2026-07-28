@echo off
rem ==============================================================
rem  OWLLM Desktop launcher (dev mode — Vite HMR + Tauri window)
rem  Double-click for the dev workflow: live-reload React + Rust.
rem  Compiles Rust on first run (slow); subsequent runs are fast.
rem  Use launch.bat for the production exe.
rem ==============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title OWLLM Desktop (dev)

rem GNU Rust toolchain + MinGW64 — required on this machine (no MSVC).
set "PATH=%USERPROFILE%\.cargo\bin;C:\mingw64\bin;%PATH%"
set "RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [owllm-desktop] Rust is not installed or not on PATH.
  echo Install from https://rustup.rs then reopen this window and run again.
  pause
  exit /b 1
)

where x86_64-w64-mingw32-gcc >nul 2>nul
if errorlevel 1 (
  echo [owllm-desktop] MinGW GCC is not on PATH.
  echo Expected: C:\mingw64\bin\x86_64-w64-mingw32-gcc.exe
  echo Install MinGW64 from https://winlibs.com  ^(unzip to C:\mingw64^).
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [owllm-desktop] Node.js is not installed or not on PATH.
  echo Install from https://nodejs.org  ^(LTS recommended^).
  pause
  exit /b 1
)

rem npm install on first run only — if node_modules missing.
if not exist "%cd%\node_modules" (
  echo [owllm-desktop] node_modules missing — running npm install...
  call npm install
  if errorlevel 1 (
    echo [owllm-desktop] npm install failed.
    pause
    exit /b 1
  )
)

rem Warn if Vite port already taken — `npm run tauri dev` will spin its own
rem Vite at 5173 and fail if something else (a stray dev server) is holding it.
netstat -ano | findstr ":5173" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [owllm-desktop] WARNING: port 5173 is already in use.
  echo  If a stray Vite is running from earlier, kill it first:
  echo    powershell -c "Get-NetTCPConnection -LocalPort 5173 -State Listen ^| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
  echo.
  echo Continuing in 3 seconds — Tauri will fail if the port stays occupied...
  timeout /t 3 /nobreak >nul
)

echo [owllm-desktop] Starting Tauri dev mode (Vite HMR + Rust window)...
echo                 First Rust build can take a couple of minutes.
echo.
call npm run tauri dev
exit /b %errorlevel%
