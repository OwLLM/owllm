; NSIS Installer Script for LLM Fine-tuning Studio
; Creates Windows installer with auto-detection support

!include "MUI2.nsh"

; Installer Information
Name "LLM Fine-tuning Studio"
OutFile "dist\LLM_Studio_Installer.exe"
InstallDir "$PROGRAMFILES\LLM Fine-tuning Studio"
RequestExecutionLevel admin

; Interface Settings
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE.txt"  ; Add license file if available
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

; Languages
!insertmacro MUI_LANGUAGE "English"

; Installer Sections
Section "Application Files" SecApp
    SectionIn RO  ; Required section
    
    SetOutPath "$INSTDIR"
    
    ; Copy executable
    File "dist\LLM_Studio.exe"
    
    ; Copy application files
    File "gui.py"
    File "finetune.py"
    File "run_adapter.py"
    File "validate_prompts.py"
    File "system_detector.py"
    File "smart_installer.py"
    File "verify_installation.py"
    File "requirements.txt"
    
    ; Create uninstaller
    WriteUninstaller "$INSTDIR\Uninstall.exe"
    
    ; Create Start Menu shortcuts
    CreateDirectory "$SMPROGRAMS\LLM Fine-tuning Studio"
    CreateShortcut "$SMPROGRAMS\LLM Fine-tuning Studio\LLM Fine-tuning Studio.lnk" "$INSTDIR\LLM_Studio.exe"
    CreateShortcut "$SMPROGRAMS\LLM Fine-tuning Studio\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
    
    ; Create desktop shortcut (optional)
    ; CreateShortcut "$DESKTOP\LLM Fine-tuning Studio.lnk" "$INSTDIR\LLM_Studio.exe"
    
    ; Write registry keys
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LLM Fine-tuning Studio" "DisplayName" "LLM Fine-tuning Studio"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LLM Fine-tuning Studio" "UninstallString" "$INSTDIR\Uninstall.exe"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LLM Fine-tuning Studio" "InstallLocation" "$INSTDIR"
SectionEnd

Section "Run System Detection" SecDetection
    ; Run system detection
    ExecWait '"$INSTDIR\LLM_Studio.exe" --detect'
SectionEnd

Section "Install Visual C++ Redistributables" SecVCRedist
    ; Check if already installed
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Version"
    StrCmp $0 "" 0 VCRedistInstalled
    
    ; Download and install
    inetc::get "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe"
    ExecWait '"$TEMP\vc_redist.x64.exe" /install /quiet /norestart'
    Delete "$TEMP\vc_redist.x64.exe"
    
    VCRedistInstalled:
SectionEnd

Section "Install Python Dependencies" SecDeps
    ; Check for Python
    ReadRegStr $0 HKLM "SOFTWARE\Python\PythonCore\3.12\InstallPath" ""
    StrCmp $0 "" CheckPath 0 FoundPython
    
    CheckPath:
    ; Try to find Python in PATH
    ExecWait 'python --version' $1
    StrCmp $1 "0" FoundPython 0 PythonNotFound
    
    FoundPython:
    ; Install dependencies
    ExecWait 'python -m pip install -r "$INSTDIR\requirements.txt"'
    Goto EndDeps
    
    PythonNotFound:
    MessageBox MB_OK "Python not found. Please install Python 3.8+ and run the installer again."
    
    EndDeps:
SectionEnd

; Uninstaller Section
Section "Uninstall"
    ; Remove files
    Delete "$INSTDIR\LLM_Studio.exe"
    Delete "$INSTDIR\gui.py"
    Delete "$INSTDIR\finetune.py"
    Delete "$INSTDIR\run_adapter.py"
    Delete "$INSTDIR\validate_prompts.py"
    Delete "$INSTDIR\system_detector.py"
    Delete "$INSTDIR\smart_installer.py"
    Delete "$INSTDIR\verify_installation.py"
    Delete "$INSTDIR\requirements.txt"
    Delete "$INSTDIR\Uninstall.exe"
    
    ; Remove shortcuts
    RMDir /r "$SMPROGRAMS\LLM Fine-tuning Studio"
    Delete "$DESKTOP\LLM Fine-tuning Studio.lnk"
    
    ; Remove registry keys
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LLM Fine-tuning Studio"
    
    ; Remove installation directory
    RMDir "$INSTDIR"
SectionEnd

; Section Descriptions
LangString DESC_SecApp ${LANG_ENGLISH} "Core application files (required)"
LangString DESC_SecDetection ${LANG_ENGLISH} "Run system detection to configure installation"
LangString DESC_SecVCRedist ${LANG_ENGLISH} "Install Visual C++ Redistributables if needed"
LangString DESC_SecDeps ${LANG_ENGLISH} "Install Python dependencies"

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
    !insertmacro MUI_DESCRIPTION_TEXT ${SecApp} $(DESC_SecApp)
    !insertmacro MUI_DESCRIPTION_TEXT ${SecDetection} $(DESC_SecDetection)
    !insertmacro MUI_DESCRIPTION_TEXT ${SecVCRedist} $(DESC_SecVCRedist)
    !insertmacro MUI_DESCRIPTION_TEXT ${SecDeps} $(DESC_SecDeps)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

