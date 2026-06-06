# Cross-platform status (Windows / Linux / macOS)

Honest status of OwLLM Desktop across OSes, and exactly what each one still
needs. The app code (Rust + React) is largely cross-platform; the gap is the
**native runtime bundle** (the model-serving stack), which is Windows-shaped
today and delivered per-OS by the module registry.

## TL;DR

| | App builds | App launches + UI | NVIDIA GPU detect | Model serving (llama.cpp) | Status |
|---|---|---|---|---|---|
| **Windows 10/11** | ✅ | ✅ | ✅ nvidia-smi | ✅ bundled | **shipping** |
| **Linux** | ✅ (CI matrix) | ✅ (default window) | ✅ nvidia-smi (now) | 🚧 runtime variant needed | **agent box usable now via the split; standalone needs runtime** |
| **macOS** | ✅ (CI matrix) | ✅ (default window) | 🚧 Metal detect TODO | 🚧 Metal runtime needed | **builds; runtime work pending** |

## What's already cross-platform (in the code)
- **Build:** `.github/workflows/release.yml` builds Windows + macOS (arm64/x64) + Linux (`.deb`/`.rpm`/`.AppImage`) on every release — the app *compiles* on all three.
- **Paths:** `src-tauri/src/paths.rs` branches data/cache roots for Win/macOS/Linux.
- **Runtime delivery:** `src-tauri/src/modules.rs` is a registry-driven module system with per-OS variants (`WindowsX86_64 / LinuxX86_64 / MacOsAarch64 / MacOsX86_64`).
- **venv + pip** (`env_manager.rs`) and the **`uv` installer** (`mcp.rs`) are cross-platform.
- **GPU detection:** `hardware.rs` `gpus_via_nvidia_smi()` now runs on **Windows and Linux** (nvidia-smi is identical). macOS returns no NVIDIA (correct) until Metal detection is added.

## The big lever: the split makes Linux usable *now*
A Linux box does **not** need the GPU runtime to be useful — with the
**model/agents split** (`docs/ARCHITECTURE.md`), run the **agents** on Linux
and point them at a **Windows GPU model server**. The Linux side then only
needs the light **agent toolchain** (node, git, the Claude/Codex/Gemini CLIs,
`uv` for MCP) — not the CUDA/llama.cpp stack. So:

> **Linux today = a great isolated agent box against your Windows model.**
> Standalone Linux inference is the remaining piece.

## What each OS still needs

### Linux — to run models standalone (not just as an agent box)
1. **Runtime variants in the registry** (`OwLLM/owllm` → `data/modules/registry.json`):
   a Linux `llama.cpp` build (CUDA + CPU), and for fine-tuning a Linux
   Python/torch env. Until then, the app launches but can't start a local model.
2. **Metal/ROCm:** N/A for Linux NVIDIA (works); add `rocm-smi` for AMD later.
3. **Window chrome:** the frameless/transparent HybridFrame is Win32-specific
   (`SetWindowLong`); Linux falls back to the default window (functional, less
   bespoke). A Wayland/X polish pass is cosmetic, not blocking.

### macOS — to run models
1. **Metal `llama.cpp`** runtime variant in the registry (arm64 + x64).
2. **Metal GPU detection** in `hardware.rs` (e.g. `system_profiler
   SPDisplaysDataType`) — currently no GPU is reported on macOS.
3. **Window chrome:** same as Linux — default window works; bespoke chrome is a
   later cosmetic pass.

## Not blocking, but on the list
- Real **dependency probes** for the Home "Software Requirements" panel
  (currently hardcoded) — should report actual per-OS Python/torch/GPU/deps
  status from the existing `hardware_info` / `env_profile_status` commands.

## Bottom line
The **apps build on all three OSes** and the code is cross-platform; **Linux is
already useful as an isolated agent box** via the split. The remaining work to
make Linux/macOS run models *standalone* is **registry runtime variants** (an
external-data task on `OwLLM/owllm`) plus macOS Metal detection — not an app
rewrite.
