# OwLLM Desktop (parallel Rust/React shell)

This folder is an **incremental** replacement shell for the legacy PySide desktop app.

## Layout

- `ui/`: React + Vite frontend
- `src-tauri/`: Rust/Tauri v2 backend (process supervision + IPC)
- `python_engine/`: headless Python “engine” + a vendored subset of `LLM/`
- `docs/`: API notes

## Prereqs

- Node.js + npm (for the UI)
- **Rust toolchain** (`rustup`)
- **MinGW** at `C:\mingw64\bin` for the GNU Windows release build path

## Dev

From `apps/owllm-desktop/`:

```powershell
npm install
npm run tauri dev
```

## Release `.exe` (Windows)

Uses the Rust GNU Windows toolchain (`stable-x86_64-pc-windows-gnu`) and MinGW. This avoids requiring Visual Studio Build Tools/MSVC for local release builds.

From `apps/owllm-desktop/`:

```powershell
npm install
.\build-release.bat
```

Or:

```powershell
npm run build:exe
```

Outputs:

- `src-tauri\target\x86_64-pc-windows-gnu\release\owllm-desktop.exe` — the app
- `src-tauri\target\x86_64-pc-windows-gnu\release\bundle\nsis\` — Windows installer(s)

### Icons

Source: `src-tauri/app-icon.png`. Regenerate all platform icons with:

```powershell
python .\tools\generate_app_icon.py
npm run tauri -- icon .\src-tauri\app-icon.png
```

### Python interpreter

By default the Rust supervisor runs:

- `python` from `PATH`

Override:

- `OWLLM_PYTHON` — absolute path to `python.exe`

The engine listens on `127.0.0.1:18765` by default (`OWLLM_ENGINE_HOST` / `OWLLM_ENGINE_PORT`).

## Shared data with the existing install

`python_engine/LLM/models`, `.envs`, `wheelhouse`, and a few other heavy dirs are **junctions** to the canonical `../../LLM/...` tree in this repo checkout.

That matches the plan’s “read-only reuse first” guidance without copying multi‑GB artifacts into `apps/`.
