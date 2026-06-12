# P0-8 · The Watcher — notes (Slices 1+2 shipped)

Slices 1 (summon + drawer) and 2 (support_snapshot) completed 2026-06-13.
Probe: REAL app run (`npx tauri dev`), Win32 synthesized clicks, screenshots
read back — the drawer opened from the top-center summon and "Check my
setup" rendered the live snapshot (OWLLM 0.4.75, Ryzen 5950X/32GB, RTX
4090, WSL Ubuntu·mc, env ready, llama.cpp found). Screenshots in
%TEMP%\owllm_watcher_probe*.png during the session.

## CRITICAL discovery: two chrome modes, two summon points

`overlay_frame_enabled()` defaults TRUE → on this machine (and likely all
users) the chrome is the OVERLAY FRAME window ("OwLLM Overlay Frame"), a
separate click-through webview (`set_ignore_cursor_events(true)`), and
AppShell renders OverlayContentPanel — the React HybridFrame (and its owl
badge) NEVER RENDERS in this mode. Wiring only the HybridFrame owl would
have shipped a dead feature.

- HybridFrame mode: the owl badge img is the summon (pointerEvents flips
  to auto only when the callback is wired).
- Overlay mode: the centered OWLLM title in the ModeBar (directly beneath
  the click-through owl) is the summon. Tooltip carries the name. Making
  it clickable removes a 200×54px patch from the header drag region —
  accepted tradeoff.
- The once-per-minute "The Watcher" satellite label animates next to
  whichever summon is live; stops forever after first open
  (localStorage owllm:watcher:discovered).

## Architecture

- `support.rs::support_snapshot` COMPOSES existing probes (readiness::
  app_readiness, hardware_info, server_status via app.state::<ServerState>,
  wsl_setup_status, module_list) — no parallel diagnostics. Non-secret by
  construction.
- `ui/src/support/WatcherDrawer.tsx` — drawer with chat-style entries +
  actions: What page am I on? (PAGE_BLURBS map), Check my setup (snapshot
  render + "Home page has a Set-up button" nudge on ❌ rows), Report a bug
  (stub honest about shipping later).

## Probe technique (reusable for any UI verification)

tauri dev in background → EnumWindows by process id (FindWindow by title
was flaky; enumerate instead) → SetForegroundWindow → SetCursorPos +
mouse_event → CopyFromScreen → Read the PNG. Remember: PowerShell tool
calls do NOT share Add-Type state — redefine the P/Invoke class per call.
First click may be eaten by whatever modal is open (AccountSyncModal) —
screenshot first, then aim.

## Also noted

- tauri.conf.json currently has `transparent: false` + the overlay-frame
  split. The old "transparent:true non-negotiable" memory refers to the
  HybridFrame era; the overlay window itself is transparent:true. DON'T
  touch either.

## Slice 3 — app-window capture (shipped 2026-06-13)

`support_capture_window`: PrintWindow + PW_RENDERFULLCONTENT (0x2) into a
top-down 32bpp DIB, BGRA→RGBA, PNG-encode (`png` crate, new dep), base64
over IPC. Live-probed: clicked the button in the running app — the
preview rendered showing the app WITH the open Watcher modal inside it
(modal-over-app capture proven), plus the honest "not captured: overlay
chrome; other windows/monitors never" note.

Gotchas:
- `PrintWindow` lives in `windows_sys::Win32::Storage::Xps`, NOT
  UI::WindowsAndMessaging. Feature: "Win32_Storage_Xps".
- GDI alpha is garbage — force 0xFF per pixel or the PNG renders blotchy.
- Copy the DIB bits out BEFORE DeleteObject/DeleteDC.
- Non-Windows returns an explicit "attach an OS screenshot instead" error
  (the documented fallback messaging).

## Remaining slices

- Slice 4: local activity counters (view/clear; product telemetry only).
- Slice 5: model choice + AI diagnosis (reuse ModelPicker discovery; tiny
  Gemma <1GB fallback offer; show provider before cloud use).
- Slice 6: send report (private path default, preview + consent,
  redaction; local export bundle when no backend configured).
