# OwLLM Desktop — Architecture & Design

This document explains how OwLLM is built and the design choices behind its
differentiating features, for contributors and technically-minded users. For
the user-facing overview see the [root README](../README.md).

The live app is **`owllm-desktop/`** — Tauri (Rust) + React. Rust owns the
runtime (model lifecycle, hardware probe, tool execution, file/process); React
owns the UI. Cloud models are first-class peers via the same dispatcher.

---

## 1. The split: model server ⟂ agent runtime

**Problem.** Autonomous agents that run shell commands and edit files should be
isolated from your main system. But the thing that's *hard* to isolate/port is
GPU inference (CUDA llama.cpp, drivers). On Windows, running CUDA inside
WSL/containers is slow (the `/mnt/c` cross-filesystem penalty applies to
Docker-on-Windows too, since Docker Desktop *is* WSL2).

**Insight.** Inference is already an OpenAI-compatible **HTTP** service, and the
agent loop already talks to it over HTTP. So decouple them:

- **Model server** (the hard-to-port part) stays native where the GPU is —
  e.g. Windows. `llama-server --jinja` behind `/v1/chat/completions`.
- **Agent runtime** (the part that needs sandboxing) runs anywhere — a Linux
  box, a WSL sandbox, another PC — and calls the model over the network.

**Implementation (shipped).**
- Agent side: `ui/src/pages/agentic/inferenceEndpoint.ts` persists
  `{ mode, host, port, apiKey }`; `resolveInferenceBase()` returns the base
  URL + bearer key. Both tool-using surfaces honor it — the agentic dispatch
  (`pages/agentic/dispatch.ts → streamLocalChat`) **and** the fine-tuning chat
  (`pages/finetuning/ChatPage.tsx`). Default = local managed server, so
  existing behavior is unchanged.
- Server side: `src-tauri/src/server.rs` — `InferenceExpose`
  (`inference_expose.json`) + `inference_expose_get/set`. Default binds
  `127.0.0.1`; when the user opts in it binds `0.0.0.0` **and requires an
  api-key** (`--api-key`). The `/health` poll forwards the key too.
- UI: Server page — "Inference source" (agent side) and "Serve on the network"
  (server side, default OFF, generates a `crypto.randomUUID` key).

**Security model.** Opt-in only; never unauthenticated; plain HTTP → trusted
LAN or VPN/SSH tunnel only, never internet-facing. Blast radius is narrow: the
exposed port is **inference only** — no file/shell access (those live in the
agent backend). On **Windows 10** WSL2 is NAT-only (loopback not shared), so
the WSL split needs network serving ON; on **Windows 11** with WSL "mirrored
networking" loopback is shared, so it can stay OFF.

---

## 2. Tool-calling: native GGUF only

Chat and agentic tool-calling use the model's **own chat template**: send the
OpenAI `tools` array → `llama-server --jinja` renders it through the GGUF's
template → read structured `delta.tool_calls` back. **No XML catalog injected
into the prompt, no regex dialect parsing of replies** (that approach made
models invent incompatible dialects and degenerate).

- Single shared loop: `streamLocalChat()` in `pages/agentic/dispatch.ts`.
- Local tool specs + execution: `pages/agentic/localTools.ts` →
  Rust commands in `src-tauri/src/agent_tools.rs`.

Any `<tool_call>` XML / `parse_tool_calls` / `format_for_prompt` you find is
**dead legacy** (quarantined in `python-app/_legacy/`). See repo-root
`CLAUDE.md`.

---

## 3. MCP — robust by construction

`src-tauri/src/mcp.rs` runs MCP servers as stdio JSON-RPC subprocesses;
`pages/agentic/localTools.ts` merges their tools into the `tools` array. Robustness:

- **Auto-start** of enabled servers (lazy, on first agent run — not at boot, so
  launch stays instant).
- **Master switch** + **per-tool toggles** (`pages/agentic/mcpSettings.ts`,
  surfaced on the MCP page).
- **Schema-safety gate** (`sanitizeToolParameters`): every MCP `inputSchema` is
  coerced to a shape `llama.cpp`'s `--jinja` tool grammar can render
  (`$ref`/`oneOf`/deep-nesting/non-object roots collapse to safe forms). One
  malformed schema can otherwise make the model emit **no** native tool calls
  at all — this isolates it so one bad tool can't break tool-calling globally.

---

## 3b. Memory and RAG

Agentic teams use two memory layers:

- **Per-agent episodic memory**: recent instruction/reply turns for each
  specialist, char-budgeted before they are folded back into that agent's
  context.
- **Shared team memory**: project-scoped facts and worklog in SQLite, retrieved
  with BM25-lite keyword ranking. Durable facts can sync through the GitHub
  vault; auto-captured worklog stays local.

Retrieved memory is injected as a current-task context pack, not raw history:
old completed work is reference material, while the current request and live
files/tools remain authoritative. The design note and roadmap live in
[`owllm-desktop/docs/MEMORY_RAG_DESIGN.md`](../owllm-desktop/docs/MEMORY_RAG_DESIGN.md).

---

## 4. Safety: guard rails, isolation, and tiers

### Guard rails (shipped, default-on) — `src-tauri/src/agent_tools.rs`
- **Write path-jail** (`write_jail`): `tool_write_file` / `tool_create_dir`
  refuse targets outside the workspace (cwd/worktree, OS temp, `~/OwLLM`).
  Lexical `..` normalization (works for not-yet-existing files); component-wise,
  case-insensitive on Windows.
- **Catastrophic-command block** (`dangerous_shell_command`): refuses a narrow
  set of never-legitimate commands (recursive root/home wipe, disk
  format/partition/raw-write, fork bomb, HKLM registry delete, shutdown,
  remote-download-piped-to-shell). Scoped ops (`rm -rf node_modules`) are fine.

These are guard rails, **not** a hard boundary — the shell is Turing-complete.
For true containment, OwLLM now executes the tools themselves inside Linux:

### OS-level isolation — `src-tauri/src/wsl.rs` (shipped, Phase 1)
Every tool-using surface funnels its tools through one place — `executeToolCall`
→ the `agent_tools.rs` commands — so isolating *those* isolates the Code page,
the agentic teams, **and** the fine-tuning chat at once (chats use tools too).

The model: an isolated project lives **inside the WSL distro** at
`~/owllm/<project>`. The Windows UI uses that project's
`\\wsl.localhost\<distro>\…` UNC path as its workspace. Then:
- **File tools isolate for free.** `tool_read_file`/`write`/`list`/`create_dir`/
  `grep`/`glob` are plain `std::fs` on the workspace path — and a UNC path
  resolves into the **distro filesystem**, off the Windows `C:` drive. No code
  change needed; the path placement does the work.
- **The shell tool is the one that must cross in.** `cmd.exe` can't even `cd`
  into a UNC path, so `tool_shell_exec` detects a WSL-UNC cwd
  (`wsl::parse_wsl_unc`) and runs the command inside the distro via
  `wsl -d <distro> -- bash -lc 'cd <linux_cwd> && (<command>)'`
  (`wsl::build_wsl_bash_script`). A model that runs `rm -rf` only touches the
  Linux project, never Windows. The `--cd` flag is intentionally avoided (it
  errors on real distros); the `bash -lc 'cd …'` form is portable.
- **The fine-tuning chat scratch dir** becomes a WSL project when isolation is
  on (`chat_scratch_dir`), so that surface is sandboxed too.
- `wsl.rs` exposes `wsl_status` (distro detection), `wsl_isolation_get/set`
  (persisted), and `wsl_create_project` / `wsl_list_projects`. The Code page
  shows a **🛡 Isolated / ⚠ Not isolated** badge and, when WSL is absent, a loud
  warning with **graceful host fallback** (guard rails above still apply).

**Next (Phase 2):** run the subscription CLIs (Claude/Codex/Gemini) inside the
distro too (they execute their *own* tools today), and onboarding that offers
`wsl --install` + provisions the in-distro toolchain.

### Concurrency isolation — `src-tauri/src/fleet.rs`
Each specialist in a team runs in its **own `git worktree`** on branch
`owllm-fleet/<run_id>/<agent>` at a path outside the project, then
squash-merges back with conflict detection (conflicts keep the worktree for
resolution). This is isolation-by-copy + merge, not real-time locking — the
right model for autonomous agents (no deadlocks, clean rollback).

### Tiers
- **Safe (default):** guard rails + worktrees + (roadmap) plain-language
  conflict resolution and one-click undo.
- **Hardened (shipped, Phase 1):** tools execute inside WSL/Ubuntu — see above.
- **Guru (roadmap):** one switch flips the rails off for experienced users
  (generalizes the existing per-project `trust_writes`).

---

## 5. Cross-platform runtime & onboarding

Runtimes are delivered by a **registry-driven module system**
(`src-tauri/src/modules.rs`) with per-OS variants
(`WindowsX86_64 / LinuxX86_64 / MacOsAarch64 / MacOsX86_64`):
download → verify → extract, with progress events. `src-tauri/src/paths.rs`
already branches Win/macOS/Linux for data/cache roots; `env_manager.rs`
(venv+pip) and the `uv` installer are cross-platform.

**In progress:** Linux/macOS runtime variants in the registry, Metal/ROCm GPU
detection in `hardware.rs` (today NVIDIA-only via `nvidia-smi`), and real
dependency probes to replace the placeholder Home "Software Requirements"
panel. Note the split makes the **Linux agent box light to provision** — it
needs only the agent/cloud toolchain (node, git, the Claude/Codex/Gemini CLIs,
uv), not the GPU stack, which can stay on the Windows server.

---

## 6. Releases & auto-update

`src-tauri/tauri.conf.json` pins a **minisign updater public key**; every
release must be signed with the matching private key or clients reject it.
`.github/workflows/release.yml` builds Windows/macOS/Linux, signs the updater
artifacts, and drafts a release on the public `OwLLM/owllm` repo (the updater
endpoint is `OwLLM/owllm/releases/latest/download/latest.json`). The in-app
updater (`ui/src/UpdatePrompt.tsx`) shows a branded, plain-language changelog.

---

## Repository map

- `owllm-desktop/` — the live app (Tauri + React). **All runtime behavior.**
- `owllm-desktop/ui/src/` — UI + app logic.
- `owllm-desktop/src-tauri/src/` — Rust backend.
- `python-app/_legacy/` — quarantined legacy (old PySide6 app + XML agent
  orchestrator). **Never** cite as current behavior.
- See repo-root `CLAUDE.md` for the live-vs-legacy rules.
