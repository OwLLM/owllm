@echo off
:: build_installer.bat -- one-shot build of OWLLM-Setup-AI.exe.
::
:: Pipeline:
::   1. python runtime\download_runtime.py
::      Fetches llama-server.exe + gemma-4-E2B-it-Q4_K_M.gguf into runtime\
::      if they aren't already there.
::   2. go build -ldflags "-H=windowsgui" -o bootstrap.exe ./bootstrap_go
::      Compiles the native bootstrap launcher (no console window).
::   3. makensis installer\OWLLM-Setup-AI.nsi
::      Produces OWLLM-Setup-AI.exe in installer\.
::
:: Run from the LLM\bootstrap\ directory:
::   build_installer.bat
::
:: Prerequisites on PATH:
::   - python  (3.10+)
::   - go      (1.22+)
::   - makensis (NSIS 3.x)

setlocal EnableExtensions EnableDelayedExpansion

set HERE=%~dp0
pushd "%HERE%"

echo === [1/3] fetching runtime artifacts (llama-server + GGUF) ===
python runtime\download_runtime.py
if errorlevel 1 (
    echo download_runtime.py failed
    popd
    exit /b 1
)

echo.
echo === [2/3] building bootstrap.exe ===
pushd bootstrap_go
go build -ldflags "-H=windowsgui" -o ..\bootstrap.exe .
if errorlevel 1 (
    echo go build failed
    popd
    popd
    exit /b 1
)
popd

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
