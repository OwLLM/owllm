; OWLLM-Setup-AI.nsi -- NSIS installer for the AI-driven flavor.
;
; Builds OWLLM-Setup-AI.exe, the parallel installer flavor that
; ships the bundled supervisor (Gemma 4 E2B + llama-server) and the
; native bootstrap launcher. The classic Python-based installer
; (OWLLM-Setup.exe) keeps shipping unchanged in parallel until
; ROLLOUT.md Phase 7 (default cutover).
;
; Build (from this directory):
;   makensis OWLLM-Setup-AI.nsi
;
; Prerequisites in ../runtime/ before makensis runs:
;   - bootstrap.exe                         (built from ../bootstrap_go/)
;   - llama-server.exe                      (from llama.cpp release zip)
;   - gemma-4-E2B-it-Q4_K_M.gguf            (downloaded from HF Unsloth mirror)
; Both are fetched/built by ../build_installer.bat which is the
; recommended orchestrator.
;
; Install layout (under %LOCALAPPDATA%\OWLLM\bootstrap\):
;
;   bootstrap.exe
;   runtime/
;     llama-server.exe
;     gemma-4-E2B-it-Q4_K_M.gguf
;   recipes/
;     hardware_profiles.json
;     plan.gbnf
;     system_prompt.txt
;
; The installer launches bootstrap.exe at the end so the supervisor
; immediately drives the Python install.

;------------------------------------------------------------------ Boilerplate

Unicode True
SetCompressor /SOLID lzma
RequestExecutionLevel user

!define APP_NAME      "OWLLM (AI Installer)"
!define APP_VERSION   "0.1.0"
!define APP_PUBLISHER "OWLLM"
!define APP_DIR_NAME  "OWLLM"

Name        "${APP_NAME}"
OutFile     "OWLLM-Setup-AI.exe"

; Per-user, no admin required.
InstallDir "$LOCALAPPDATA\${APP_DIR_NAME}\bootstrap"

VIProductVersion "0.1.0.0"
VIAddVersionKey  "ProductName"     "${APP_NAME}"
VIAddVersionKey  "FileDescription" "OWLLM AI Installer (parallel flavor)"
VIAddVersionKey  "FileVersion"     "${APP_VERSION}"
VIAddVersionKey  "ProductVersion"  "${APP_VERSION}"
VIAddVersionKey  "CompanyName"     "${APP_PUBLISHER}"

;------------------------------------------------------------------ UI

!include "MUI2.nsh"

!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

;------------------------------------------------------------------ Sections

Section "Bootstrap launcher" Sec_Bootstrap
  SectionIn RO

  SetOutPath "$INSTDIR"
  File "..\bootstrap.exe"

  SetOutPath "$INSTDIR\runtime"
  File "..\runtime\llama-server.exe"
  File "..\runtime\gemma-4-E2B-it-Q4_K_M.gguf"

  SetOutPath "$INSTDIR\recipes"
  File "..\recipes\hardware_profiles.json"
  File "..\recipes\plan.gbnf"
  File "..\recipes\system_prompt.txt"

  ; Uninstaller
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Registry uninstall entry
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_DIR_NAME}-AI" \
              "DisplayName"     "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_DIR_NAME}-AI" \
              "DisplayVersion"  "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_DIR_NAME}-AI" \
              "Publisher"       "${APP_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_DIR_NAME}-AI" \
              "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_DIR_NAME}-AI" \
              "InstallLocation" "$INSTDIR"

SectionEnd

Section "-Run bootstrap" Sec_RunBootstrap
  ; Hand off to bootstrap.exe so the supervisor drives the Python
  ; install immediately. Exec (not ExecWait) so the installer GUI can
  ; close. bootstrap.exe is itself -H=windowsgui linked so no console
  ; flashes.
  Exec '"$INSTDIR\bootstrap.exe"'
SectionEnd

;------------------------------------------------------------------ Uninstall

Section "Uninstall"
  ; Best-effort: tell the supervisor to shut down gracefully if running.
  ; (No-op if it's not.)
  ExecWait '"$INSTDIR\bootstrap.exe" --shutdown' $0

  Delete "$INSTDIR\bootstrap.exe"
  Delete "$INSTDIR\runtime\llama-server.exe"
  Delete "$INSTDIR\runtime\gemma-4-E2B-it-Q4_K_M.gguf"
  Delete "$INSTDIR\runtime\bootstrap_env.json"
  Delete "$INSTDIR\runtime\pending_question.json"
  Delete "$INSTDIR\recipes\hardware_profiles.json"
  Delete "$INSTDIR\recipes\plan.gbnf"
  Delete "$INSTDIR\recipes\system_prompt.txt"
  Delete "$INSTDIR\Uninstall.exe"

  RMDir "$INSTDIR\runtime"
  RMDir "$INSTDIR\recipes"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_DIR_NAME}-AI"
SectionEnd
