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

## Slice 4 — activity stats (shipped 2026-06-13)

`ui/src/support/activityStats.ts` — localStorage counters, 200-key cap,
corruption-safe. Instrumented: page visits (AppShell, AFTER activeKey's
declaration — TDZ bites if the effect is placed above the useState),
env installs, manual server starts, tool-call failures (executeToolCall
wrapper — tool NAME only). View/Clear in the drawer.

## Slice 5 — model choice + AI diagnosis (shipped 2026-06-13)

Auto-selection with the app's OWN discovery: `buildEntries(models,
accounts)` (exported by ModelPicker — the shared catalogue) + server_status.
Policy: RUNNING local model wins (private/free); else first available
cloud entry (subscription before API key) with an EXPLICIT consent round
("I'd use <label> — a CLOUD model: your question and the app snapshot
would leave this device. Press Send again to confirm"); local-models-
exist-but-cold → "start one on the Server page, I won't load GBs into
your GPU unannounced"; nothing at all → tiny-Gemma (<1 GB) offer routing
to the Models page. Dispatch: streamLocalChat({allowedTools: []}) for
local (no tools in support chat), streamChatCompletion for cloud — the
same shared paths as Code/Chat pages.

Live probe: asked "Why is my model server not running" → consent named
"Claude Fable 5 · low (subscription)" → confirmed → streamed answer was
correctly snapshot-grounded ("everything ready, server just not started;
pick a model; RTX 4090 + CUDA 12.6 detected; if it crashed on load tell
me the model — broken GGUF / OOM / port conflict"). Exactly the spec's
likely-cause + fix + bug-or-not + repro shape.

## Slice 6 — bug report bundle (shipped 2026-06-13) → P0-8 COMPLETE

Flow: type a description → "Report a bug" assembles {description, page,
snapshot, activity, last AI summary, optional capture} → `redactForReport`
scrubs it BEFORE the preview (keys/tokens by prefix, JWTs, bearer
headers, telegram bot tokens, home-path usernames — capture-group
replacement preserves JSON escaping) → the FULL redacted JSON is shown →
the button arms to "💾 Save report bundle" → second click writes
report.json + screenshot.png to %USERPROFILE%\OwLLM\bug-reports\<stamp>\
(support_export_report). Nothing is ever transmitted — the private
"backend" is a local folder the user shares deliberately. Probe: 13
redactor assertions (every secret class scrubbed, benign diagnostics
intact, output still valid JSON).

## P0-8 status: all six slices shipped

Possible polish later (not blockers): render the orbit hint screenshot-
verified (logic shipped, only tooltip was visually confirmed); a
configurable private endpoint as an alternative to local export; the
quarantine/crash log tail in the bundle; auto-attach a fresh capture at
report time.
