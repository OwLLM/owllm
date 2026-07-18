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

rem Ensure module ZIPs exist for the bundle. bootstrap.bat is idempotent
rem and re-uses cached downloads. Skip if dist\modules\manifest.json
rem is already present (build-release was run recently) -- bypass with
rem `set OWLLM_REBUILD_MODULES=1` to force a refresh.
if not defined OWLLM_REBUILD_MODULES (
  if exist "%cd%\dist\modules\manifest.json" goto :modules_ready
)
echo [owllm-desktop] Bootstrapping module ZIPs ^(first run or rebuild^)...
call "%cd%\bootstrap.bat"
if errorlevel 1 (
  echo [owllm-desktop] bootstrap.bat failed -- see error above. Aborting.
  exit /b 1
)
:modules_ready

echo [owllm-desktop] Building web UI...
call npm run build
if errorlevel 1 exit /b 1

rem Force a FRESH UI embed. Tauri bakes the built frontend INTO the binary at
rem COMPILE time (generate_context!). A TS-only change leaves all Rust untouched,
rem so cargo reuses the cached crate object code -- with the STALE embedded UI --
rem and ships an old interface even though npm run build just produced new assets.
rem (This bit us: a verify-command field shipped in source but never appeared in
rem the installed app.) Cleaning ONLY our crate forces main.rs to recompile and
rem re-embed; all dependencies stay cached, so it costs a relink + our crate, not
rem a full rebuild.
echo [owllm-desktop] Forcing fresh UI embed (cargo clean -p owllm-desktop)...
call cargo clean -p owllm-desktop --release --target x86_64-pc-windows-gnu --manifest-path src-tauri\Cargo.toml
if errorlevel 1 echo [owllm-desktop] warn: cargo clean -p failed (continuing; UI may be stale)

echo [owllm-desktop] Building Tauri release with GNU toolchain...
rem --bundles nsis: build ONLY the NSIS installer, not the MSI. The release only
rem ships OwLLM.Desktop.Setup.exe (the NSIS) + latest.json ? the MSI is never
rem uploaded, and its WiX bundling step started failing with "cannot find the file
rem specified (os error 2)" AFTER everything (incl. the NSIS) was already EV-signed.
rem Skipping it removes a dependency we don't ship and unblocks signed releases.
call npm run tauri -- build --target x86_64-pc-windows-gnu --bundles nsis
if errorlevel 1 exit /b 1

echo.
echo [owllm-desktop] Done.
set "RELEASE=%cd%\src-tauri\target\x86_64-pc-windows-gnu\release"
set "DIST=%cd%\dist"
if not exist "%DIST%" mkdir "%DIST%"
copy /Y "%RELEASE%\owllm-desktop.exe" "%cd%\OwLLM Desktop.exe" >nul
copy /Y "%RELEASE%\owllm-desktop.exe" "%DIST%\OwLLM Desktop.exe" >nul
rem WebView2Loader.dll MUST sit next to the exe -- without it Windows
rem aborts startup with "WebView2Loader.dll was not found". The release
rem build emits it into %RELEASE%; copy it to dist, and only seed the
rem tracked root copy if it is missing. The signed release DLL gets a new
rem timestamp each build, so overwriting the tracked copy makes git dirty
rem after every publish.
if exist "%RELEASE%\WebView2Loader.dll" (
  if not exist "%cd%\WebView2Loader.dll" copy /Y "%RELEASE%\WebView2Loader.dll" "%cd%\WebView2Loader.dll" >nul
  copy /Y "%RELEASE%\WebView2Loader.dll" "%DIST%\WebView2Loader.dll" >nul
)
rem Pick the newest versioned NSIS installer Tauri's bundler emitted.
rem Previously hardcoded `_0.1.0_` which silently copied a stale build
rem after every version bump until v0.3.0 caught it.
for /F "delims=" %%F in ('dir /B /O-D "%RELEASE%\bundle\nsis\OwLLM Desktop_*_x64-setup.exe" 2^>nul') do (
  copy /Y "%RELEASE%\bundle\nsis\%%F" "%DIST%\OwLLM Desktop Setup.exe" >nul
  goto :nsis_done
)
:nsis_done
echo   Run now:       %cd%\OwLLM Desktop.exe
echo   Dist exe:      %DIST%\OwLLM Desktop.exe
echo   Dist setup:    %DIST%\OwLLM Desktop Setup.exe
echo [owllm-desktop] Pruning superseded OwLLM crate artifacts...
rem The installer and portable executable are copied above. Cargo itself can now
rem remove every obsolete hash variant for OUR crate, across debug/test/release
rem profiles, while preserving the cached third-party dependencies needed by the
rem next build. This prevents source/UI revisions from growing target forever.
call cargo clean -p owllm-desktop --manifest-path src-tauri\Cargo.toml
if errorlevel 1 echo [owllm-desktop] warn: artifact prune failed; retained cache for this run
echo   Cargo dependency cache retained in src-tauri\target
exit /b 0
