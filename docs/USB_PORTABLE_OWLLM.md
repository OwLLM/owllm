# USB-Portable OwLLM — Design & Handoff

> **Purpose of this doc:** a self-contained brief so a fresh chat (with no prior
> context) can pick up the "run OwLLM from a USB stick" feature. Read it top to
> bottom. Decisions are already made where marked **DECIDED**; everything else is
> open design. Date of decisions: **2026-06-16**.

---

## 0. Orient yourself first (read the repo map)

This repo contains a **live app** and a pile of **legacy code that looks live but
is not executed**. Past agents wasted hours debugging the dead twin. The root
`CLAUDE.md` is the authority — read it. Short version:

- **Live app:** `owllm-desktop/` — Tauri (Rust) + React. UI in
  `owllm-desktop/ui/src/`, Rust backend in `owllm-desktop/src-tauri/src/`.
- **Dead/legacy:** anything under `python-app/_legacy/` (old PySide6 GUI + old XML
  agent orchestrator). Do **not** reason about runtime behaviour from it.
- Tool-calling is **native GGUF chat-template only** (no XML), via
  `streamLocalChat()` in `owllm-desktop/ui/src/pages/agentic/dispatch.ts`.

For this feature you work almost entirely in `owllm-desktop/src-tauri/src/`.

---

## 1. The goal

Ship a **portable** OwLLM: plug a USB stick into (almost) any Windows host, run
one launcher, enter a passphrase, and the app comes up carrying **its own
credentials, project secrets, projects, and memory** — writing nothing to the
host. Pull state down / push state up via a **private GitHub repo** so losing the
stick costs nothing.

User's own framing: *"a version that runs on USB-portable devices (with
subscription), isolated by nature and portable with all credentials and project
secrets, set in memory and GitHub."*

---

## 2. Key decisions (DECIDED)

| Question | Decision |
| --- | --- |
| **Storage / sync model** | **Hybrid** — encrypted vault on the stick **plus** a private GitHub repo as sync/backup mirror. |
| **v1 scope** | **Cloud + CPU local models.** Subscription-CLI agents (Claude/Codex) + chat against cloud, **plus** 1–2 small bundled GGUFs for offline CPU chat. |
| **Out of scope for v1** | GPU local inference at scale and **fine-tuning** — both are inherently host-bound (need the host's NVIDIA GPU + CUDA). Do not try to make these portable. |

---

## 3. Why the subscription path is the portable one

The **subscription-CLI agents (Claude / Codex) are cloud inference** — they need
network + auth, **not a GPU**. That makes them the natural fit for a USB device.
By contrast, GPU local inference and fine-tuning depend on the host's hardware and
cannot live on the stick.

**Isolation nuance — state this clearly to the user:** a USB build gives **data
isolation** (your secrets/projects live on the stick; the app leaves no trace in
the host's `%APPDATA%`/`%USERPROFILE%`). It does **not** give **execution
isolation** — anything a local-model agent *shells out* to still runs on the
host's CPU/filesystem unless that host has the sandbox (WSL/bwrap/Lima) installed.

---

## 4. The architecture lever: two host-anchored storage roots

The entire feature hinges on redirecting two roots from the host to the stick via
an `OWLLM_PORTABLE_ROOT` env var (or a `portable.json` marker next to the exe).

### Root A — config & credentials: `~/.owllm/` (Windows: `%USERPROFILE%\.owllm`)
Currently every subsystem hardcodes `PathBuf::from(home).join(".owllm")`
**independently**. Known call sites:

- `owllm-desktop/src-tauri/src/accounts.rs:94` — `agent_secrets.json` (API keys)
- `owllm-desktop/src-tauri/src/accounts.rs` (~466, ~521) — sandbox env `agent_env.sh`
- `owllm-desktop/src-tauri/src/mcp.rs:84` — `mcp_config.json`
- `owllm-desktop/src-tauri/src/bridges.rs:195` — `bridge_config.json`
- `owllm-desktop/src-tauri/src/fleet.rs:43` — fleet dir
- `owllm-desktop/src-tauri/src/sandbox.rs` (~203–233) — sandbox home `sbhome`,
  jail resolv.conf (note: this path runs **inside WSL**, not on Windows — see §6)
- `owllm-desktop/src-tauri/src/env_manager.rs` (~300–659) — `~/.owllm/envs/<name>`
  (these are **WSL-side** venvs for fine-tuning; out of v1 scope)

### Root B — heavy modules: `app_data_dir()` = `%APPDATA%\com.localllm.owllm-desktop`
Resolved in `owllm-desktop/src-tauri/src/paths.rs:238` (and via Tauri's
`app_data_dir()` in `modules.rs:409`, `data_layer.rs:25`). Holds `modules/`:
`llama-server.exe`, embedded Python, mcp-toolchain. See `paths.rs:134–238`.

---

## 5. v1 build plan (in dependency order)

### Block 1 — Centralized path resolver  ← **START HERE**
Refactor all the call sites in §4 to funnel through a single source of truth, e.g.
`owllm_config_home()` and `owllm_data_root()` in `paths.rs`. Then make that source
honor portable mode (`OWLLM_PORTABLE_ROOT`). **Low-risk, independently useful, and
nothing else is testable without it.** Verify with a probe (write a file via each
subsystem, confirm it lands under the redirected root) — do not trust "it built".

### Block 2 — Portable-mode detection & no-trace launch
- Marker file `portable.json` next to the exe → enter portable mode.
- Redirect Root A and Root B to the stick.
- Redirect **WebView2 user-data-dir** to the stick too, so cache/cookies/cookies
  don't leak to the host (Tauri exposes this).
- Ship `OwLLM-Portable.exe` (or `.bat`) at the stick root as the launcher
  (house rule: every app ships with a launcher).

### Block 3 — Hybrid encrypted vault
- `vault.age` (or libsodium secretbox) on the stick. Key derived from a
  **passphrase** via argon2, prompted at launch.
- Contents: `agent_secrets.json`, sandbox env, **subscription CLI auth tokens**,
  `mcp_config.json`, `bridge_config.json`, GitHub token.
- Launch: decrypt into the redirected `.owllm` home. On change: re-encrypt.
- Never cache secrets in plaintext on the host.

### Block 4 — GitHub mirror
- Private repo (e.g. `owllm-vault`). `git pull` on launch, commit + push on change.
- The vault stays **encrypted even inside the repo**, so a repo leak ≠ a
  credential leak. Repo MUST be private (house rule: never expose source/secrets).
- Vault is opaque → newest-wins, no merge. Projects/memory ride along.

### Block 5 — CPU local models
- Bundle `llama-server.exe` + 1–2 small Q4 GGUFs under the redirected `modules/`.
- The module resolver already reads from the data root, so once Block 1 lands this
  mostly falls out. Add a clean `n_gpu_layers=0` fallback when no CUDA is present
  (GPU host → uses GPU for free; GPU-less host → slow CPU, but works).

---

## 6. The two hardest risks (call these out honestly)

1. **Subscription-CLI auth re-homing (highest risk).** The Claude and Codex CLIs
   keep their **own** auth outside `~/.owllm` (e.g. `~/.claude/`, Codex's own
   config) and were not built to be portable. Plan: carry those tokens in the
   vault and re-point each CLI's config dir per launch (`CLAUDE_CONFIG_DIR`, the
   Codex equivalent, possibly `HOME`). **Needs a focused per-CLI probe** — most
   likely thing to misbehave across hosts. Related: the app already mirrors logins
   into the sandbox (`sandbox_sync_logins`, `github_connect`).

2. **No WSL on the host → no execution sandbox.** Cloud chat doesn't care. But
   local-model agents that shell out would run via the **Full host access** path
   (v0.5.12 toggle) or be limited. Portable mode should default to a visible
   "this host has no sandbox" banner. WSL itself cannot be carried on the stick
   (admin install + BIOS virtualization + reboot).

Minor: WebView2 runtime must exist on the host (present on most Win10/11; bundle
the evergreen bootstrapper as fallback). Corporate hosts may block running exes
from removable media (AV/policy).

---

## 7. Immediate next step

Implement **Block 1** (centralized path resolver) and verify with a probe. It is
the gate for everything else and safe to land on its own.

---

## 8. Unrelated pending work in this tree (FYI, not part of this feature)

Three small home-screen UI polish edits were made and the UI bundle builds clean,
but they are **not yet committed/pushed**:
- `owllm-desktop/ui/src/pages/core/HomePage.tsx` — "Welcome to OWLLM" overlay now
  fades out & unmounts (~2.4s) instead of permanently covering the status panels;
  low-contrast version text bumped `--fg-subtle` → `--fg-muted`; card tagline
  opacity 0.65 → 0.82.
- `owllm-desktop/ui/src/AppShell.tsx` — window close button is neutral by default
  and only flushes red on hover; glyph changed `❌` (a colour emoji that ignores
  CSS `color`) → `✕` (text glyph that respects it).

---

## 9. House rules that bite on this feature

- Never make source public; never expose secrets; the backing GitHub repo is private.
- "Commit" means commit **and** push.
- Verify changes with a real probe, never trust "build succeeded".
- Version scheme: patch rolls at 100 (0.5.15 → … → 0.5.99 → 0.6.0), never 0.5.100.
- Every app ships with a launcher.
