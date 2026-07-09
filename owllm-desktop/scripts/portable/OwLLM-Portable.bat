@echo off
rem OwLLM Go — portable launcher (USB-portable Block 2).
rem
rem Put this .bat NEXT TO owllm-desktop.exe on the stick and double-click it.
rem It pins every OwLLM data root to the stick, so secrets, configs, the state
rem DB, models and the webview cache all live under this folder and leave no
rem trace on the host machine.
rem
rem Alternative (no .bat needed): create an empty file named `portable.json`
rem next to owllm-desktop.exe — the app detects it at startup and does the
rem same redirection by itself.
set "OWLLM_PORTABLE_ROOT=%~dp0"
start "" "%~dp0owllm-desktop.exe"
