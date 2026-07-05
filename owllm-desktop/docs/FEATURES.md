# OWLLM — complete feature map (for agents working on this app)

> **Audience: AI agents and developers touching this codebase.** Read this to know
> what the product DOES before changing it. For repo layout and live-vs-legacy
> rules read `/CLAUDE.md` first. For the agentic-engine design rationale read
> `docs/AGENTIC_DESIGN.md`. Keep this file CURRENT when you ship a feature —
> same rule as the Watcher's `PAGE_DOCS` (`ui/src/support/WatcherDrawer.tsx`),
> which holds the user-facing twin of this map.

OWLLM ("Orchestrated Workflow for LLM") is a Tauri (Rust) + React desktop app:
a local-first AI workstation that runs **agent teams** (local GGUF, cloud API,
or subscription CLIs), **fine-tunes and quantizes models**, and drives teams
from **messaging bridges**. Rust owns the runtime (server lifecycle, DB, MCP,
bridges, sandboxing); React owns all UI via `invoke()`.

## Modules / install modes

| Module | Pages | Notes |
|---|---|---|
| **Core** (always) | Home, Server, Info | hardware probe, llama-server lifecycle, sandbox-disk care |
| **Fine-tuning** | Models, Dataset, Train, Chat | Python env is installed on demand, ONLY needed for Train |
| **Agentic** | Code, Agents, Studio, Bridges | the flagship: teams, solo coder, bridges |
| **Gamify** (experimental) | Gamify, Characters, Arena | RPG world driven by the same dispatch stream |
| **Advanced** | MCP, Accounts | MCP servers/packs; API keys + subscription CLI logins |

## Models & inference

- **Local serving**: llama.cpp (`llama-server --jinja`), auto-start on first send,
  one server shared across app windows/instances (port adoption), VRAM-aware
  context sizing, vision via auto-downloaded `--mmproj` projectors.
- **Browse/download**: HuggingFace search + curated recs, VRAM-fit color coding,
  cache management, Tuned tab for fine-tuned/abliterated artifacts.
- **Cloud**: Anthropic / OpenAI / Gemini / Kimi via API keys, or **subscription
  CLIs** (Claude Code, Codex, Gemini, Kimi) — one ModelPicker everywhere
  (`list_models`; never a per-page dropdown).
- **Tool-calling is NATIVE GGUF ONLY**: OpenAI `tools` array → model's own chat
  template → structured `delta.tool_calls`. No XML protocol (see CLAUDE.md).

## Agentic teams (`ui/src/pages/agentic/`)

- **Orchestrator + specialists**: plan → parallel `@agent` dispatch → integrate.
  Edges on the canvas are a REAL execution graph (allow-list + handoff).
  ~20 bundled team templates; 12 role archetypes; Brainstorm assembles a
  bespoke team from a brief (and can deep-research first, writes BRIEF.md).
- **Solo-Loop vs Team**: header toggle; Solo = one coder in an edit→verify→fix
  loop with Critic + Publisher; Team = full orchestration.
- **Verification Gate**: "done" = a real command's exit code (auto-detected or
  from the Project Card), never model say-so. Per-agent verify-fix loops.
- **Project Card** (`.owllm/project.json`): committed per-repo config — goal,
  verify command(s), release config, solo/team default. Steward role lints it
  (rule-based, `cardLint.ts`). Releases run **deterministically on the host**
  (bump → commit → tag → build → sign → publish → verify updater).
- **Multi-page**: tab strip opens several Agents pages at once, each with its
  own project + run; tabs stay alive (runs keep going), green ● = running.
- **Mid-run steering**: chat messages during a run queue as ⚡ steers and are
  injected at the next agent boundary — or **between tool calls** on local
  models (`getSteer` in `dispatch.ts`). Never dropped.
- **Run Notebook** (`RunNotebook.tsx`): per-project brainstorm pane + NEXT-STEPS
  list + 🪄 Digest agent (rewrites raw notes into implementable steps,
  additive-only). Steps feed the run (steer or new goal); auto-feed walks the
  list at each clean run end. Also mounted on the Code page.
- **Memory**: per-agent history + shared **team memory** (`memory.rs`) — FACTS
  (durable, keyed, vault-synced) vs WORKLOG (auto-captured, local, capped 100),
  BM25-lite retrieval, `[REMEMBER]` harvest on every model path, 3D graph
  viewer, 📌 promote worklog→fact.
- **Rules**: per-project must/prefer/avoid directives (`directives.rs`),
  auto-seeded with a native best-practice set, injected into every agent's
  prompt (and every Code-page coder turn). Editable from the Super User card
  (Agents) and the Code page's right column.
- **Skills**: skill packs auto-equipped by role, badges on agent cards,
  cross-provider self-load (any model reads `.owllm/skills/<id>` from disk).
- **Eval harness**: `routing.verify.run.mjs` control-flow judge + live-run
  scorecard + per-run Run Report (who ran · wrote files? · verdict · done?).

## Code page (`CodePage.tsx`)

Single coding agent in one folder. Multi-page tab strip; each page = its own
chat + Kanban plan + **private git worktree** on its own branch (merge from the
header). Plan/Act phases; live diffs; editable file viewer; image paste.
Right column = ⚡ Super User: project **rules** (same directives as the team;
shared scope when the folder is a team project) + **Notebook** with auto-feed;
mid-run chat becomes a steer. "Just chat" mode with persisted threads.

## Isolation & sandboxing

- **Folder-sealed sandbox**: bubblewrap inside WSL2 (Windows), Lima (macOS
  beta), bwrap (Linux beta). Agents see ONLY the project folder — the real
  folder, no copy. Cloud CLIs run inside too; logins/API keys auto-mirror in.
- Graduated trust: isolated by default, per-project Full-access opt-out,
  write-jail + dangerous-command guard when not isolated.
- Sandbox disk card: usage view, cache clear, WSL disk reclaim.
- GitHub connect for clone/push from inside the sandbox.

## Browser control (`browser.rs`, `browser_vault.rs`, `browser_import.rs`)

- **Native agent web browser**: a real OwLLM-owned `WebviewWindow` (the app's
  own WebView2 / WKWebView / WebKitGTK engine — **no Python/Playwright, no
  external Chromium**). Opens as a popup the user can watch and log into;
  logins/cookies persist via a pinned data dir. Driven by the same `browser_*`
  tools (open/navigate, indexed snapshot, click, fill, press, select, back,
  reload, get_text, close) — the tool contract is unchanged. Rust injects a JS
  bridge (`initialization_script`) and reads results back through a
  base64-over-`document.title` channel (`eval` → poll `title()`), so no remote
  IPC capability is needed.
- **Local dev servers**: scheme-less localhost-family URLs (`localhost:5173`,
  `127.0.0.1:3000`, `[::1]`, `192.168.*`, `10.*`, `*.localhost`) default to
  `http://` instead of `https://`, so agents can open and test a web app they
  are building.
- **Device emulation** (`browser_set_device` / `browser_device` tool): desktop,
  iphone, android, tablet presets — real viewport dimensions plus a mobile
  user-agent. The UA is build-time-only on the webview, so switching device
  rebuilds the window in place and re-navigates (logins survive; the profile
  dir is stable). UI chips in the panel's Browse tab mirror the tool.
- **Password vault** (`browser_vault.rs`): site logins saved encrypted at rest
  via `crypt` (DPAPI per Windows user account; passthrough on macOS/Linux for
  now — OS-keychain backing is a follow-up). Agents autofill the current page
  (`fill_login`); passwords never reach the frontend, only the target page.
- **Import** (`browser_import.rs`): pull saved logins from **Chrome, Edge,
  Brave, Opera** — all Chromium, one code path: AES-256 profile key unwrapped
  from `Local State` via DPAPI, each `v10`/`v11` password blob AES-256-GCM.
  Firefox (NSS) is detected + counted but decryption is a follow-up. Full
  decryption is Windows-only in this build; macOS/Linux Chromium key stores
  (Keychain / Secret Service) are the next step.
- **UI**: 🌐 Browser panel (shared `BrowserPanel.tsx`, Code + Agents pages) —
  Browse / Passwords / Import tabs.
- **Browser agent** (role `resources/agents/roles/browser.yaml`, base `browser`):
  a dedicated team member that owns the non-isolated web work — localhost
  previews, live sites, form filling/testing, cross-device checks. Its team card
  swaps the chat preview for the SAME `BrowserPanel` mounted `inline`
  (`isBrowser` in `AgentsPage.tsx`, mirroring the Publisher's rule-based card),
  so the card IS the browser remote. Included in the `dev_squad` template.
  Card controls fire host-side (the window + gateway are host objects), so they
  work even when the rest of the team is sandboxed.
- **Reachable by ALL agent kinds**: local + API agents call `browser_*` through
  `executeToolCall`; subscription-CLI agents (Claude Code) reach the SAME
  browser natively via the MCP gateway below (host runs). No per-tool harvest
  hack.

## MCP gateway — OWLLM tools for subscription-CLI agents (`mcp_gateway.rs`)

- **The problem it solves**: subscription-CLI agents never reach the app's
  `executeToolCall`, so OWLLM-only tools were invisible to them. Instead of
  patching each tool with a `[HARVEST]`-style hack, the app now speaks the
  protocol the CLI already supports — **MCP**.
- **How**: a tiny MCP server hosted INSIDE the app on `127.0.0.1` (ephemeral
  port, **loopback only**, `Authorization: Bearer <token>` on every request),
  speaking MCP Streamable-HTTP (POST → one JSON-RPC reply). `claude_cli_stream`
  writes an `--mcp-config` pointing the CLI at it and adds `mcp__owllm__*` to
  `--allowedTools`. The CLI model then calls `mcp__owllm__browser_open` etc.
  natively — no puppet model, no paraphrase layer. Tool calls dispatch to the
  same `browser::*` functions the local path uses (one engine, no twin).
- **Scope**: wired for HOST runs only (loopback is reachable there, and the
  browser window is a host-desktop object). WSL-isolated runs keep today's
  behaviour (browser unavailable). Extending to isolated runs (host-IP binding
  or WSL mirrored-networking) and adding memory_*/kvm_node to the catalogue are
  follow-ups. **Runtime-unverified**: the CLI↔gateway handshake is implemented
  to spec + unit-tested for framing, but the live round-trip needs a real app
  session to confirm the installed CLI's `--mcp-config` HTTP shape.

## OWLLM Node — KVM remote control (`kvm.rs`)

- Agents see + operate a REMOTE computer through a stock NanoKVM/PiKVM
  (no firmware fork): `kvm_node` tool — screenshot (MJPEG frame), type,
  keys, mouse, boot_key, power (GPIO), mount_iso. Verified live against
  NanoKVM firmware 2.4.3.
- **Safety**: ships DISABLED; enable via the Accounts-page 🖥🔌 panel (or
  `OWLLM_KVM_NODE=1`); per-host consent allowlist, fail-closed for all
  injection actions; every action → redacted JSONL audit (`kvm_audit.jsonl`).

## USB-portable mode — "OwLLM Go" (`paths.rs::init_portable_mode`)

- Drop the app on a stick with a `portable.json` marker next to the exe (or
  launch via `scripts/portable/OwLLM-Portable.bat`): secrets, configs, state
  DB, models and the webview cache ALL redirect under the stick
  (`OWLLM_PORTABLE_ROOT` + the existing env-override family) — no trace on
  the host. Blocks 3–5 (encrypted vault, GitHub mirror, bundled CPU models)
  are still roadmap: `docs/USB_PORTABLE_OWLLM.md`.

## Fine-tuning & model surgery (`resources/*.py`, spawned from Rust)

- **Train**: LoRA/QLoRA (Unsloth/TRL/PEFT/bnb) on consumer GPUs, live loss,
  resume, GPU picked by UUID (`core.gpu_config`). GGUF/GPTQ/AWQ are NOT
  trainable — Transformers/safetensors only (bnb-4bit is).
- **Dataset Builder**: PDF/DOCX/URL/TXT → parse → picked LLM → instruction JSONL.
- **GGUF export + quantization**: HF → GGUF, Q4–Q8/F16.
- **Abliteration**: effect-based (causal) refusal-direction removal with
  before/after compliance scoring — safety-research tooling.

## Bridges (`bridges/`, Rust + shared TS core)

Telegram, WhatsApp, Discord, Slack, Email (IMAP/SMTP), LINE — one dispatch
core (`useBridgeDispatch()`), per-platform transport only. In-chat commands
(`/project`, `/model`, `/brainstorm`), attachments, one-window polling locks.

## Sync, vault & publishing

- **Vault** (opt-in `owllm-vault` GitHub repo): team templates, roles, project
  rows, chat, memory FACTS sync across the user's PCs. GitHub device-flow auth.
- **Publish pipeline**: rule-based host-side release (used to ship OWLLM
  itself and any user project via the Project Card).
- **Fleet** (`fleet.rs`): git-worktree substrate for parallel agents/pages;
  diff/merge/finalize; orphan sweep.

## Support & UX

- **The Watcher**: in-app support agent — per-page docs (`PAGE_DOCS`), guided
  walkthroughs, screenshot+ask, one-click bug report to GitHub.
- Update streams: signed Tauri updater (shell) + per-launch module swap +
  hot-pulled data layer (teams/roles/profiles from the public repo).
- Frameless HybridFrame window (transparent — NEVER make it opaque),
  sticky-scroll chats (`useStickyScroll`), shared `ChatBubble` renderer,
  shared `LogBox` for all logs.

## Where to look (quick index)

| Concern | File |
|---|---|
| local chat + tool loop | `ui/src/pages/agentic/dispatch.ts` (`streamLocalChat`) |
| tool specs + MCP | `ui/src/pages/agentic/localTools.ts` |
| team dispatch (desktop) | `ui/src/pages/agentic/AgentsPage.tsx` (own copy of cloud dispatch!) |
| team dispatch (bridges) | `ui/src/pages/agentic/dispatch.ts` |
| solo coder page | `ui/src/pages/agentic/CodePage.tsx` + `CodeSidePanel.tsx` |
| notebook | `ui/src/pages/agentic/RunNotebook.tsx` |
| team memory | `src-tauri/src/memory.rs` + `TeamMemoryModal.tsx` |
| rules | `src-tauri/src/directives.rs` |
| project card / gate | `ui/src/pages/agentic/gate.ts`, `cardLint.ts` |
| vault sync | `src-tauri/src/vault.rs` |
| worktrees/fleet | `src-tauri/src/fleet.rs` |
| user-facing page docs | `ui/src/support/WatcherDrawer.tsx` (`PAGE_DOCS`) |

**Known trap for agents**: `AgentsPage.tsx` duplicates parts of `dispatch.ts`
(prompt builders + cloud dispatch). A fix in one usually needs the other —
grep BOTH before declaring a dispatch bug fixed.
