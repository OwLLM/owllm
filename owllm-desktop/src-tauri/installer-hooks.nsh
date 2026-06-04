; OwLLM Desktop — custom NSIS installer hooks.
;
; Why this file exists: Tauri 2 NSIS perUser installs default to
;   $LOCALAPPDATA\<ProductName>
; which for us resolves to "$LOCALAPPDATA\OwLLM Desktop". That collides
; with the directory the running app uses for downloaded modules /
; runtime / settings. We want the binary at the Windows-conventional
; "$LOCALAPPDATA\Programs\OwLLM Desktop\" so the binary install and the
; data folder are cleanly separated.
;
; PRE-INSTALL fires inside Section Install BEFORE the File commands
; copy content into $INSTDIR. We rewrite $INSTDIR + re-issue SetOutPath
; so the rest of the install proceeds at the new location. Only
; rewrites when $INSTDIR still equals the Tauri default — if the user
; picked a custom path via the install-dir page, we respect that.

!macro NSIS_HOOK_PREINSTALL
  StrCmp $INSTDIR "$LOCALAPPDATA\OwLLM Desktop" 0 hook_done
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\OwLLM Desktop"
    CreateDirectory $INSTDIR
    SetOutPath $INSTDIR
  hook_done:
!macroend
