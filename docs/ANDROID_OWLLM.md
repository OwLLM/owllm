# OwLLM on Android — Honest Feasibility & Plan

> Written 2026-06-16 as the answer to "make the Android version too, ASAP."
> Read this before anyone starts coding an APK. The headline is uncomfortable but
> it will save weeks: **you cannot "port" the desktop app to Android. You can
> build a cloud-only companion app that shares the React UI and the API dispatch
> code.** Those are different projects. This doc scopes the real one.

---

## 0. The one-paragraph truth

OwLLM Desktop's value is **agentic teams that run real CLIs (Claude Code, Codex,
Gemini, Kimi) inside a WSL/bwrap sandbox, plus local `llama-server` inference**.
**None of that exists on Android**: no WSL, no bwrap, no Windows `llama-server.exe`,
no npm/pip-installed agent CLIs, no Win32. Tauri 2 *does* build for Android, and
the React UI + the **cloud API** dispatch path *can* run there. So Android = a
**cloud-only companion** (chat + agentic teams over the **API**, bridges, and an
optional small on-device CPU model), NOT the desktop experience on a phone.

---

## 1. What is reusable vs. blocked

| Piece | Android? | Notes |
| --- | --- | --- |
| React UI (`ui/src/`) | ♻️ mostly | Desktop-laid-out; needs a mobile layout pass. The chat components (ChatBubble, dispatch.ts API paths) port well. |
| **API** dispatch (Claude/GPT/Gemini HTTP, `streamChatCompletion` API branch) | ✅ | This is the heart of an Android build. Pure fetch — works in the webview. |
| Bridges (Telegram/WhatsApp — HTTP `getUpdates`/webhooks) | ✅ | Already HTTP; the Rust `telegram_*` commands need re-implementing without Windows assumptions, but the logic is portable. |
| Agentic team graph / dispatch fan-out (`runDispatchLoop`) | ⚠️ partial | Works IF every agent resolves to an **API** model. Sub-CLI agents can't run. |
| Subscription CLIs (codex/claude/gemini/kimi) | ❌ | Desktop npm/pip binaries. On Android there is no CLI to shell to. **Android must use API keys**, not subscription login. |
| WSL/bwrap sandbox + Full-host-access | ❌ | No Linux subsystem on Android. Execution isolation is moot; tool execution would have to be a sandboxed JS/remote runner or dropped. |
| Local `llama-server.exe` | ❌ as-is / ⚠️ rebuildable | The bundled binary is Windows x64. llama.cpp **does** build for Android ARM — a small Q4 GGUF on-device is feasible as a separate native lib (JNI), but it's a real port, not a copy. |
| Fine-tuning / GPU / CUDA | ❌ | Host-bound. Never on a phone. |
| Win32 window chrome, diskpart, PowerShell, `wsl.exe`, `%USERPROFILE%` | ❌ | All `#[cfg(windows)]`. Must be guarded/replaced for the Android target. |

---

## 2. The realistic Android product (v1 scope)

**"OwLLM Mobile" — a cloud companion:**
- Chat + agentic teams against **cloud APIs** (user pastes API keys: Anthropic /
  OpenAI / Gemini). No CLI, no WSL.
- **Bridges**: receive Telegram/WhatsApp messages and dispatch on the phone.
- **Sync** with the desktop via the same private vault/GitHub mirror the
  USB-portable feature defines (projects, memory, keys) — so phone and desktop
  share state.
- **Optional**: one small on-device GGUF via a llama.cpp Android lib for offline
  chat. Stretch goal, not v1.

**Explicitly out:** subscription-CLI agents, WSL sandbox, fine-tuning, GPU, tool
execution that shells out to a real OS (a phone has no project filesystem to act on
the way the desktop does).

---

## 3. Why this is a new app, not a port (effort reality)

The Rust backend (`src-tauri/src/`) is ~Windows-through-and-through: `wsl.rs`,
`sandbox.rs`, `accounts.rs` (CLI discovery), `paths.rs` (`%APPDATA%`),
PowerShell/diskpart, Win32. To target Android you must, at minimum:
1. `cargo tauri android init` + Android SDK/NDK/JDK toolchain (CI + each dev).
2. Put **every** Windows-only command behind `#[cfg(windows)]` and provide
   Android (`#[cfg(target_os = "android")]`) equivalents or stubs — touching most
   files in `src-tauri/src/`.
3. Rewrite dispatch so Android is **API-only** (no `program_argv`/CLI path).
4. A **mobile UI** (the desktop 3-pane / canvas layout doesn't fit a phone).
5. API-key auth flows (no browser-OAuth CLI login).

That's a multi-week build by a person who can run an Android emulator and iterate —
not something to blind-ship overnight. Doing it half-blind would produce an APK
that doesn't build or crashes on launch, which helps no one.

---

## 4. Recommended path (smallest first real step)

1. **Decouple the API dispatch from the desktop assumptions** in `dispatch.ts`
   (already mostly clean — the API branch needs no cwd/CLI). This is shared code
   the mobile app reuses verbatim. *Do this on desktop; it's a refactor that helps
   both.*
2. **Stand up the Tauri Android target** in a branch (`android/`): `tauri android
   init`, get a hello-world webview building + running in the emulator. Gate the
   whole Rust backend to compile on Android (stubs for the Windows commands).
3. **Wire API-only chat** in the mobile shell (paste a key → chat with Claude/GPT).
   That's the first genuinely useful, testable milestone.
4. Layer in bridges, then sync (shares the USB-portable vault), then the optional
   on-device GGUF.

Each step is testable in an emulator. None of it is doable as an unsupervised
overnight blind build, which is why the overnight session shipped the things that
**were** verifiable (the desktop image/bridge fixes + USB-portable Block 1) and
scoped this honestly instead of faking an APK.

---

## 5. House rules that apply

- Never make the source public; the sync repo stays private.
- Verify with a real probe (here: an emulator run), never "it built".
- Every app ships with a launcher (Android: the installed app icon counts).
- Reuse, never recode: the mobile app must share `dispatch.ts` API paths + the
  chat components, not fork them.
