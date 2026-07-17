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
| **Advanced** | MCP, Accounts, Signing, Devices | MCP servers/packs; API keys + subscription CLI logins; code-signing certificate vault; secure remote device control |

## Models & inference

- **Local serving**: llama.cpp (`llama-server --jinja`), auto-start on first send,
  one server shared across app windows/instances (port adoption), VRAM-aware
  context sizing, vision via auto-downloaded `--mmproj` projectors.
- **Platforms**: engine + runtime modules ship per-platform variants — Windows
  x64 (CUDA/Vulkan/CPU), Linux x64 (Vulkan/CPU), Linux ARM64 (CUDA for Jetson
  JetPack 7+ gated by `cudaMajorMin`, CPU for Pi/ARM servers), macOS ARM64
  (Metal). Unsupported platform/arch combos degrade honestly: the wizard names
  the arch ("no build published for windows-aarch64 (ARM64) yet") instead of
  offering a foreign binary. python-runtime / mcp-toolchain / audio-stt have
  Linux-ARM64 variants; the CUDA module bundles its own CUDA runtime libs
  (spawned with `LD_LIBRARY_PATH` — stock JetPack has only the driver).
- **Browse/download**: HuggingFace search + curated recs, VRAM-fit color coding,
  cache management, Tuned tab for fine-tuned/abliterated artifacts. Interrupted
  downloads keep their `.partial` and resume via HTTP Range — the Downloaded
  card shows ⏬ Resume download (no quant re-pick, no restart from 0%).
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
- **Lean prompt profile**: solo and ≤3-agent runs get the trimmed injection
  stack — short memory hint instead of the tutorial, halved snapshot/RAG
  budgets (`setLeanRun` in `localTools.ts`, `lean` param on both
  `buildSpecialistPrompt` copies). "Smallest safe activation" per
  `docs/AGENTIC_DESIGN.md`; user project rules are never trimmed.
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
- **Run Notebook** (`RunNotebook.tsx`): per-project brainstorm pane + Kanban
  plan board (NOW/NEXT/LATER) + NEXT-STEPS list + 🪄 Digest agent (rewrites
  raw notes into implementable steps, additive-only). Steps feed the run
  (steer or new goal); ⚡ Start batch feeds the whole NOW lane (the board is
  never consumed); ▶ Start queue feeds the first pending step and auto-feed
  walks the rest at each clean run end. Also mounted on the Code page.
- **Memory**: per-agent history + shared **team memory** (`memory.rs`) — FACTS
  (durable, keyed, vault-synced) vs WORKLOG (auto-captured, local, capped 100),
  BM25-lite retrieval, `[REMEMBER]` harvest on every model path, 3D graph
  viewer, 📌 promote worklog→fact. Retrieved memory is framed as a
  current-task context pack so stale completed work cannot masquerade as the
  active result. Design note: `docs/MEMORY_RAG_DESIGN.md`.
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
Optional **second agent pane** (own transcript/model, ⇄ auto-feed both ways,
divided composer). The chat pane carries its own header — model picker +
`Clear` (run state) + `Clear history` (chat window **and** saved threads) —
and the composer lives in the same column as the chat, so input and window
stay width-aligned beside the full-height file rail and right column.
Right column = ⚡ Super User: project **rules** (same directives as the team;
shared scope when the folder is a team project) + **Notebook** with auto-feed;
mid-run chat becomes a steer. "Just chat" mode with persisted threads.

## Isolation & sandboxing

- **Folder-sealed sandbox**: bubblewrap inside WSL2 (Windows), Lima (macOS
  beta), bwrap (Linux beta). Agents see ONLY the project folder — the real
  folder, no copy. Cloud CLIs run inside too; logins/API keys auto-mirror in.
- Graduated trust: isolated by default, per-project Full-access opt-out,
  write-jail + dangerous-command guard when not isolated.
- Sandbox disk card: usage view, cache clear, WSL disk reclaim, plus
  **anti-inflation** so the WSL `.vhdx` doesn't balloon unattended:
  - **Safe default — automatic cache-trim** (`sandbox_trim` / `auto_housekeep`):
    when the regenerable caches (uv/npm/pip) inside a *running* distro exceed a
    threshold, they're cleared on startup + on demand, then `fstrim`. No admin,
    no restart, no data risk. This is the main lever that keeps growth in check.
  - **Advanced opt-in — sparse disk** (`sandbox_enable_sparse`): returns freed
    space continuously via `.wslconfig sparseVhd=true` + `wsl --manage
    --set-sparse true --allow-unsafe`. Gated behind an explicit warning because
    **modern WSL disables sparse by default due to a potential data-corruption
    risk** — never auto-applied. One-click, clearly labelled advanced.
  - No-op on Linux/macOS (bwrap = host FS; Lima manages its own disk).
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
- **OwLLM chrome (app-styled window)**: the browser is a FRAMELESS multi-webview
  window that looks like the app, not a stock OS window — an OwLLM chrome-bar
  webview (`ui/public/browser-chrome.html`: title, back/reload, URL box,
  min/max/close, accent-aware via the shared localStorage theme key) sits above
  the page webview (`Window::builder` + `add_child`, tauri `unstable` feature),
  so the bar never overlays site content. The bar's buttons/drag/URL entry
  report over the same title channel tagged `EVT` (`parse_chrome_event`) — no
  IPC grant to any webview. If the multi-webview build fails on some platform,
  it falls back to the previous decorated single-webview window
  (`build_legacy`) so agent browsing never breaks. `browser_set_chrome` still
  paints the DWM border (and the fallback's caption) in the app accent.
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
- **Scope**: three transports, decided per run in `claude_cli_stream`:
  * HOST run → HTTP on `127.0.0.1` (config path handed to the CLI as the 8.3
    short path — the plain path contains a space that the batch-shim spawn
    splits; see v0.7.62).
  * Non-jailed WSL run (full-access or bwrap absent) → MCP *stdio* relay that
    shells each call through Windows `curl.exe` interop to the host loopback —
    no firewall rule needed.
  * bwrap-JAILED WSL run → excluded (interop is dead inside the jail), with
    ONE exception: the **Browser role**. Detected Rust-side from its
    `tool_allowlist` naming `browser_*` (Publisher pattern —
    `is_browser_role_allowlist`, accounts.rs), that single agent is spawned via
    `sandbox::program_argv_unjailed` (plain WSL, interop alive) and wired to
    the relay, while every other agent in the team stays jailed. Deliberate,
    disclosed tradeoff: the Browser agent's run gains /mnt + interop access
    like a full-access run.
  Adding memory_*/kvm_node to the catalogue is a follow-up. The CLI↔gateway
  handshake + tool loading were verified against the real installed CLI
  (2026-07-05); the jail-exception spawn path is code-verified but needs one
  live isolated-team run to confirm end-to-end.
- **OpenAI / Codex parity** (`codex_cli_stream`): the same gateway now reaches
  Codex-CLI agents too — Codex has no `--mcp-config` flag, so it's wired via
  `-c mcp_servers.owllm.*` overrides (HOST → HTTP `url` + `bearer_token_env_var`
  with the token in `OWLLM_GW_TOKEN`; WSL → the same stdio relay as `command` +
  `args`). VERIFIED against codex 0.128.0: `codex exec` **silently cancels**
  every MCP tool call under `--sandbox workspace-write`; they execute only with
  `approval_policy="never"` AND `--sandbox danger-full-access`. So for Codex the
  gateway is wired + the sandbox escalated ONLY for the **Browser role** (host-
  capable by design) or a **full-access** project — a normal sandboxed Codex
  coder is untouched (no browser, no escalation). This role/full-access scoping
  is the deliberate difference from the Claude path (which needs no escalation);
  it exists because codex couples MCP-call approval to the sandbox mode. Kimi/
  Gemini CLIs remain one-shot (no streaming tool path) — a later follow-up.

## OWLLM Node — KVM remote control (`kvm.rs`)

- Agents see + operate a REMOTE computer through a stock NanoKVM/PiKVM
  (no firmware fork): `kvm_node` tool — screenshot (MJPEG frame), type,
  keys, mouse, boot_key, power (GPIO), mount_iso. Verified live against
  NanoKVM firmware 2.4.3.
- **Safety**: ships DISABLED; enable via the Accounts-page 🖥🔌 panel (or
  `OWLLM_KVM_NODE=1`); per-host consent allowlist, fail-closed for all
  injection actions; every action → redacted JSONL audit (`kvm_audit.jsonl`).

## Remote Devices / Fleet Control (`remote_devices/`, Devices page)

- Securely control one OwLLM install from another. **Control requires a paired,
  cryptographic device key the target explicitly approved — a matching GitHub
  account only aids discovery, it NEVER grants control.** (Distinct from OWLLM
  Node above, which drives external KVM hardware; this controls OwLLM *devices*.)
- **Identity**: per-install Ed25519 (sign/id) + X25519 (seal) keypair, DPAPI-
  wrapped at rest, never synced. `device_id = hex(SHA-256(ed_pub))`. Editable name.
- **Sealed transport (WAN-capable)**: every command AND its reply is an
  end-to-end AES-256-GCM sealed + Ed25519-signed envelope — the wire only carries
  ciphertext. `Transport` seam with `LoopbackTransport` (self), `LanDirectTransport`
  (`lan.rs` — `tiny_http` listener + `reqwest`), `P2pTransport` (`p2p.rs`), and
  `RelayTransport` (`relay.rs`). Devices need NOT be on the same network: each
  publishes all its addresses (overlay/Tailscale + public host:port + LAN), the
  controller tries each, then the **embedded P2P transport** (iroh: QUIC NAT
  hole-punching + n0's free public relays — compiled in, zero setup, no account;
  each device publishes a `p2p_node_id`, pairable by node id from anywhere), then
  falls back to a **self-hostable relay** (store-and-forward, both peers dial out,
  ciphertext-only — run it via `device_relay_serve` on any always-on box).
- **Discovery**: `vault_sync_devices` (a 4th vault channel) publishes each
  device's public record + all endpoints and pulls peers into the registry; or
  **pair by IP** directly with no vault. Self-maintaining: the listener starts at
  app launch (when enabled) so the launch sync always publishes dialable
  endpoints, toggling remote control republishes immediately, and Pair pulls the
  vault once before reporting a peer has no address.
- **Trust + policy**: pairing request (over the wire / by IP) → unmistakable
  target-side approval → per-controller `PermissionPolicy` (Shell / WSL / File
  writes / Admin), default read-only diagnostics. `authorize()` is a unit-tested
  pure chokepoint. Revocable, fail-closed.
- **Executor**: diagnostics (read-only), shell, "Run in WSL", and File write —
  all timed-out + cancellable. Dangerous actions (FileWrite/Admin) run ONLY after
  a **live target-side approval** (or 120s timeout → denied). "Being controlled"
  banner + emergency Stop. Persistent replay cache. Redacted JSONL audit on both
  ends (output stored only as length + digest). Ships DISABLED
  (`OWLLM_REMOTE_DEVICES=1` or the page toggle). Design: `docs/REMOTE_DEVICES.md`.
- **Interactive shell (SSH-like)**: an `🖥 Open shell` in the Devices console
  spawns a real PTY on the target (`session.rs`, portable-pty) and streams it into
  an xterm terminal over the sealed transport — installers that prompt, REPLs,
  `sudo` flows, log tails, dev work. Session ops are the `shell` tier, bound to
  the controller that opened them; the target shows the banner for the whole session.
- **Agent remote access**: a `device_exec` agent tool (distinct from `ssh_exec` —
  no SSH keys, works over the sealed device channel) lets the team run commands on
  a paired device for tech support / installs / dev. Gated by a **"Let agents use
  remote devices"** switch (off by default; free once on, admin still target-approved).

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

## Code signing (`signing.rs`, Signing page)

- **One home for signing credentials**, so shipping a signed build isn't a
  scavenger hunt across Apple's portal, the Keychain and GitHub secrets. The
  Signing page (Advanced) stores the **Apple Developer ID** set (certificate
  `.p12` + its password, signing identity, Apple ID, app-specific/notarization
  password, Team ID → the six `APPLE_*` secrets `release.yml` reads) and the
  **Windows Authenticode** selectors (thumbprint / subject / TSA → `OWLLM_SIGN_*`,
  `release.rs::SignCfg`).
- **Encrypted at rest** via `crypt::protect` (DPAPI per Windows user; passthrough
  on macOS/Linux for now — same known limitation as `browser_vault.rs`). Secret
  values are NEVER returned to the frontend by `signing_status`; they leave Rust
  only through the explicit `signing_export_env` reveal path used by "Push to
  GitHub secrets" / "Copy values" and the agent tool.
- **Import `.p12`** → base64 into the store; identity + expiry are parsed
  best-effort via `openssl` when present (PATH or Git-for-Windows `usr/bin`), so
  the page shows an **expiry countdown** (amber ≤30 days, red once expired).
- **No-Mac path (bare `.cer`)**: Apple's portal only *issues* a certificate —
  the private key lives wherever the CSR was made. "Generate signing request"
  (`signing_apple_gen_csr`) creates the key (stored encrypted) + a
  `.certSigningRequest` file to upload at Apple's portal; importing the issued
  `.cer`/`.cert`/`.crt`/`.pem` (`signing_apple_import_cert`) pairs it with that
  key into the `.p12` the pipeline needs — with a pubkey match check so a .cer
  from someone else's CSR is rejected with a clear message. Works on any OS.
- **Push to GitHub Actions secrets** in one click via the `gh` CLI (which does
  the libsodium sealed-box); when `gh` is absent, "Copy values" yields the
  `NAME=value` lines to paste into Settings → Secrets.
- **Shared within instances**: every OwLLM window / fleet worktree on the machine
  reads the same `owllm_config_home()` store. Across the user's other PCs the
  vault (`vault_sync_signing`) mirrors NON-secret metadata only (identity, team,
  expiry, presence) — the certificate/passwords stay local per machine.
- **Reachable by agents in any project**: the `signing_get` tool (local
  `localTools.ts` + MCP-gateway `mcp__owllm__signing_get`) returns metadata by
  default, or the CI env values with `include_secrets=true`, so a coding agent
  can wire signed releases from whatever project it's started in. Same reveal
  boundary as `device_exec`.
- **Credential hub (readiness strip + portals)**: `signing_hub_status` probes
  the LIVE environment — is the stored Authenticode thumbprint mounted in the
  OS store right now (PowerShell `Cert:` drive, NOT `certutil`, which blocks on
  cloud-CSP certs like SimplySign; macOS `security find-identity`), is
  SimplySign Desktop running, is `openssl` reachable, is the `gh` CLI installed
  and which account it's logged in as, how many web logins are vaulted. Every
  probe runs hidden with a hard 10 s kill-timeout. The page renders these as a
  one-glance chip strip.
- **Provider portals open in-app, already signed in**: `signing_portal_open`
  (catalog: Apple Developer certificates, Apple ID app-passwords, Certum panel,
  GitHub tokens, Microsoft Partner Center, Google Play Console — or any custom
  URL) opens the page in the app-styled agent browser, whose persistent profile
  keeps past sessions, then best-effort autofills the login from the browser
  vault. The Signing page's **Web logins** card manages that vault (add /
  delete / open-signed-in / import from installed browsers via
  `browser_import`), so "renew the cert" never starts with a password reset.

## Sync, vault & publishing

- **Vault** (opt-in `owllm-vault` GitHub repo): team templates, roles, project
  rows, chat, memory FACTS sync across the user's PCs. GitHub device-flow auth.
- **Device-local folder paths** (`vault.rs` `VaultProject.locations`): a project's
  on-disk folder is per-device, keyed by `device_id`, so a peer's absolute path
  (`C:\…` on a Mac) is never adopted. A freshly-synced project imports GHOSTED
  (empty path) with all its chat/memory/settings intact; the Project Settings
  dialog flags the missing folder (`path_is_dir` probe) and prompts Browse… to
  bind a local folder. Each machine writes only its own `locations` entry and
  never clobbers a peer's.
- **Publish pipeline**: rule-based host-side release (used to ship OWLLM
  itself and any user project via the Project Card).
- **Fleet** (`fleet.rs`): git-worktree substrate for parallel agents/pages;
  diff/merge/finalize; orphan sweep.

## Support & UX

- **Application-wide localization**: Settings switches English, Simplified
  Chinese, Korean, Japanese, Arabic, or Italian live and persists the choice.
  The shared catalogue covers page chrome, controls, menus, dialogs, empty
  states, status copy, tooltips and accessibility labels; new/missing entries
  fall back to English. Arabic switches the application shell to RTL while
  code, terminals, paths and user/model-authored content keep their natural or
  technical direction. The separate agent-browser chrome follows the same key.

- **The Watcher**: in-app support agent — per-page docs (`PAGE_DOCS`), guided
  walkthroughs, screenshot+ask, one-click bug report to GitHub. Window capture
  works on Windows (PrintWindow) AND Linux (GDK readback, `support.rs`).
- **Linux chrome**: no overlay window off-Windows — the frame draws in-page,
  the main window is transparent (`tauri.linux.conf.json`) and the see-through
  headroom band above the frame is click-through via GTK input-shape
  (`frame_shape.rs`), mirroring the Windows overlay behaviour.
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
