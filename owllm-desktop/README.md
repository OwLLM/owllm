# OwLLM Desktop (Tauri + React)

This folder is the **target rewrite** of the legacy PySide6 desktop app.

## Architecture (2026-05-14)

- **Rust owns the runtime.** Model registry, server lifecycle (llama.cpp /
  Ollama subprocess management with `CREATE_NO_WINDOW`), hardware probe,
  MCP connections, bridges, agents orchestration, config persistence —
  all native Rust commands in `src-tauri/src/`.
- **React owns the UI.** Inline-styled pages under `ui/src/pages/`,
  faithful ports of each PySide6 page (`LLM/desktop_app/pages/*.py`).
- **Python is an on-demand guest, not a daemon.** Invoked only for
  fine-tuning training scripts and per-model venv bootstrap. Each
  invocation is a one-shot subprocess that completes and exits. No
  long-running HTTP server, no console popups at app startup.

This is the architecture we agreed on. An earlier draft (deleted on
2026-05-14) spawned a bundled `python_engine` HTTP server at startup
and proxied every Tauri command through it — that drifted from the
plan and is gone.

## Layout

- `ui/` — React + Vite + TypeScript frontend
- `src-tauri/` — Rust/Tauri v2 backend (native Tauri commands)
- `docs/` — API notes

## Prereqs

- Node.js + npm (for the UI)
- **Rust toolchain** (`rustup`)
- **MinGW** at `C:\mingw64\bin` for the GNU Windows release build path

## Run

Two double-click launchers:

- `launch.bat` — production: runs `OwLLM Desktop.exe`. Rebuilds first
  if the source is newer than the exe.
- `launch-dev.bat` — HMR dev workflow: Vite + Tauri dev with live
  reload. Use this for iteration.

Or manually from `apps/owllm-desktop/`:

```powershell
npm install
npm run tauri dev
```

## Release `.exe` (Windows)

Uses the Rust GNU Windows toolchain (`stable-x86_64-pc-windows-gnu`)
and MinGW. Avoids requiring MSVC / Visual Studio Build Tools.

From `apps/owllm-desktop/`:

```powershell
.\build-release.bat
```

Or `npm run build:exe`.

Outputs:

- `OwLLM Desktop.exe` — portable exe at the project root, with
  `WebView2Loader.dll` sibling
- `dist/OwLLM Desktop.exe` and `dist/OwLLM Desktop Setup.exe`
- `src-tauri\target\x86_64-pc-windows-gnu\release\bundle\nsis\` —
  NSIS installer

### Icons

Source: `src-tauri/app-icon.png`. Regenerate all platform icons:

```powershell
python .\tools\generate_app_icon.py
npm run tauri -- icon .\src-tauri\app-icon.png
```
