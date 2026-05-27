@echo off
:: build_installer.bat -- one-shot build of OWLLM-Setup-AI.exe.
::
:: Pipeline:
::   1. python runtime\download_runtime.py
::      Fetches llama-server.exe + gemma-4-E2B-it-Q4_K_M.gguf into
::      runtime\ if they aren't already there.
::   2. cargo build --release  (default) OR  go build  (with --use-go)
::      Compiles the native bootstrap launcher (no console window).
::   3. makensis installer\OWLLM-Setup-AI.nsi
::      Produces OWLLM-Setup-AI.exe in installer\.
::
:: Run from the LLM\bootstrap\ directory:
::   build_installer.bat            <-- builds Rust bootstrap_rs (default)
::   build_installer.bat --use-go   <-- builds legacy Go bootstrap_go
::                                      (kept as rollback path for two
::                                       releases per the Rust migration
::                                       plan in
::                                       LLM/docs/supervisor/RUST_MIGRATION.md)
::
:: Prerequisites on PATH:
::   - python   (3.10+)
::   - makensis (NSIS 3.x)
::
:: Neither Rust nor Go is required on PATH — the script auto-uses the
:: portable toolchains under LLM\tools\rust\ and LLM\tools\go\ (same
:: "self-contained, no system pollution" pattern as the bundled
:: python_runtime\). If a portable toolchain is missing it falls back
:: to a system install on PATH; if both are missing it prints the
:: download instructions.
::
:: To fetch the portable toolchains once:
::   powershell -ExecutionPolicy Bypass -File ..\tools\download_rust.ps1
::   powershell -ExecutionPolicy Bypass -File ..\tools\download_go.ps1

setlocal EnableExtensions EnableDelayedExpansion

set HERE=%~dp0
pushd "%HERE%"

:: Parse the optional --use-go flag.
set USE_GO=0
if /I "%~1"=="--use-go" set USE_GO=1
if /I "%~2"=="--use-go" set USE_GO=1

echo === [1/3] fetching runtime artifacts (llama-server + GGUF) ===
python runtime\download_runtime.py
if errorlevel 1 (
    echo download_runtime.py failed
    popd
    exit /b 1
)

if "%USE_GO%"=="1" (
    call :build_with_go
) else (
    call :build_with_rust
)
if errorlevel 1 (
    popd
    exit /b 1
)

echo.
echo === [3/3] packaging OWLLM-Setup-AI.exe ===
where makensis >nul 2>&1
if errorlevel 1 (
    echo makensis not found on PATH.
    echo Install NSIS 3.x from https://nsis.sourceforge.io/ and add it to PATH.
    popd
    exit /b 1
)
makensis installer\OWLLM-Setup-AI.nsi
if errorlevel 1 (
    echo makensis failed
    popd
    exit /b 1
)

echo.
echo === done ===
echo installer at: %HERE%installer\OWLLM-Setup-AI.exe
popd
endlocal
exit /b 0

:: ---- subroutines ----------------------------------------------------

:build_with_rust
echo.
echo === [2/3] building bootstrap.exe (Rust — default) ===

:: Locate cargo: prefer the portable toolchain we ship under
:: LLM\tools\rust\.
set "CARGO_EXE="
if exist "%HERE%..\tools\rust\bin\cargo.exe" (
    set "CARGO_EXE=%HERE%..\tools\rust\bin\cargo.exe"
    set "RUSTUP_HOME=%HERE%..\tools\rust\.rustup"
    set "CARGO_HOME=%HERE%..\tools\rust\.cargo"
    set "PATH=%HERE%..\tools\rust\bin;%PATH%"
    echo Using portable Rust: !CARGO_EXE!
) else (
    where cargo >nul 2>&1
    if errorlevel 1 (
        echo Rust toolchain not found.
        echo Either install Rust 1.86+ system-wide ^(go to rustup.rs^) or run:
        echo   powershell -ExecutionPolicy Bypass -File ..\tools\download_rust.ps1
        echo to fetch the portable copy into LLM\tools\rust\.
        echo.
        echo To fall back to the legacy Go bootstrap rerun with:
        echo   build_installer.bat --use-go
        exit /b 1
    )
    set "CARGO_EXE=cargo"
    echo Using system cargo on PATH
)

pushd bootstrap_rs
"!CARGO_EXE!" build --release
if errorlevel 1 (
    echo cargo build failed
    popd
    exit /b 1
)
copy /Y "target\release\bootstrap.exe" "..\bootstrap.exe" >nul
if errorlevel 1 (
    echo could not copy bootstrap.exe up one level
    popd
    exit /b 1
)
popd
echo bootstrap.exe built from bootstrap_rs/
exit /b 0

:build_with_go
echo.
echo === [2/3] building bootstrap.exe (Go — legacy --use-go path) ===
echo NOTE: bootstrap_go/ is on a deprecation path. The Rust port at
echo       bootstrap_rs/ has full functional parity ^(115 tests passing^).
echo       This build path remains for two releases as a rollback option.
echo.

:: Locate Go: prefer the portable toolchain we ship under
:: LLM\tools\go.
set "GO_EXE="
if exist "%HERE%..\tools\go\bin\go.exe" (
    set "GO_EXE=%HERE%..\tools\go\bin\go.exe"
    set "GOROOT=%HERE%..\tools\go"
    set "GOPATH=%HERE%..\tools\gopath"
    set "GOCACHE=%HERE%..\tools\gocache"
    echo Using portable Go: !GO_EXE!
) else (
    where go >nul 2>&1
    if errorlevel 1 (
        echo Go not found.
        echo Either install Go 1.22+ system-wide ^(go.dev/dl^) or run:
        echo   powershell -ExecutionPolicy Bypass -File ..\tools\download_go.ps1
        echo to fetch the portable copy into LLM\tools\go\.
        exit /b 1
    )
    set "GO_EXE=go"
    echo Using system Go on PATH
)

pushd bootstrap_go
"!GO_EXE!" build -ldflags "-H=windowsgui -s -w" -o ..\bootstrap.exe .
if errorlevel 1 (
    echo go build failed
    popd
    exit /b 1
)
popd
echo bootstrap.exe built from bootstrap_go/
exit /b 0
