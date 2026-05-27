@echo off
rem Convenience shortcut at the repo root.
rem Hands off to apps/owllm-desktop/launch.bat, which runs the built
rem "OwLLM Desktop.exe" (or builds it once on first run).
rem For the HMR dev workflow, use apps\owllm-desktop\launch-dev.bat.
call "%~dp0apps\owllm-desktop\launch.bat" %*
