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
| **Gamify** (experimental) | Gamify, Characters, World Map | RPG world driven by the same dispatch stream; World Map is a Solar System explorer (all 8 planets, bundled NASA-derived textures, focus/zoom flights) around the live presence globe. Presence is event-driven — the socket opening IS the sign-in and its close IS the sign-off, no polling: `ui/src/pages/gamify/worldPresence.ts` + the Cloudflare Durable Object in `services/world-presence/`. One installation is one dot forever, keyed by an opaque hash of its device key derived in Rust (`remote_devices::identity::presence_id`); a device that cannot identify itself connects with NO id and is shown live but never recorded. Each dot shows OS family, coarse city and app release; gold = online, purple = recorded but offline. **World Chat** (on by default — every identity on the map is already anonymous; one click turns it off and that choice sticks across restarts) rides the same socket. Its card sits over the **top-right of the globe canvas**, not in the side rail, so clicking a dot and typing to it are one gesture — selecting a dot puts the caret straight in the message box. The client proves it owns a dot by signing a server nonce with the device key the dot's id is derived from (`remote_devices::world_chat`, `services/world-presence/src/chat.js`), so a public id cannot be claimed by anyone else. Messages are `crypto::seal` envelopes the relay only stores and forwards — 1:1 after an explicit accept, group rooms addressed by hash of an invite code that never leaves the client, with block, report, per-day first-contact quotas and an offline queue. Requests from this user's own fleet devices auto-accept. UI: `ui/src/pages/gamify/WorldChatPanel.tsx` — a conversation surface, not a settings form: nickname, reachability and group invites fold behind a ⚙ toggle, the thread keeps real height with an empty-state prompt, and the composer is a multi-line textarea (Enter sends, Shift+Enter continues) whose button always reads **Send**. The card folds to its header (▾): it floats over the globe and takes pointer events, so while open it is also a hole in the map and dots behind it cannot be clicked — picking a new dot re-opens it. A message that lands while the user is on any other page pops a **💬 Got a message from ‹sender›** speech bubble beside the owl at the top-centre of the frame (`AppShell.tsx`). It is derived from the per-thread **unread counts** and NOT from a dwell timer — it names the sender, carries a count when more than one is waiting, survives a restart, and stays until the conversation is actually opened; clicking it jumps to the World Map and opens that exact thread (`openWorldChatThread` → the `owllm:world-chat:open` event). Unread is raised once per line — never for our own echoes, never for a relay replay — persisted at `owllm:world-chat:unread`, and cleared only by looking at the thread (or **Mark all read**). On first use the panel **asks** whether to use the connected GitHub account's name and picture (`WorldChat:github-ask`) — the alternative is talking to a dot labelled `OW-3F91A2`, and nobody opens a settings pane to name themselves. It is asked once, only when a GitHub account is connected, and either answer is remembered (`owllm:world-chat:github`, tri-state so *unanswered* is distinct from *no*) and reversible from the ⚙ row. "Yes" publishes the login and `https://avatars.githubusercontent.com/<login>` with the profile; pictures are drawn on inbox rows, thread titles, every message and the chrome notice. A picture URL is **pinned to GitHub's avatar CDN** on both sides (`sanitizeChatAvatar`, relay `sanitizeAvatar`) — an arbitrary URL rendered by another user's renderer is a beacon, not an avatar. The panel opens on an **inbox**: every conversation ever had, newest first, with the sender, the last line, its time and an unread badge, so a message is reachable without hunting for its dot on the globe. Every line in a thread is stamped with who said it and when (clock today, date + clock older). Conversation history **survives a restart** (`owllm:world-chat:threads` in localStorage, capped at `MAX_THREAD_MESSAGES`, sanitized on restore) because the relay only replays what it still holds *undelivered*; it must never go to the shared state mirror, which replicates every write to every window and device. **The relay half must be deployed for any of this to work** — `npm run deploy` in `services/world-presence/` (needs Cloudflare auth). Against a Worker built before the chat commit no `chat_challenge` is ever issued, so the card sits on "Connecting…" forever |
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
  card shows ⏬ Resume download (no quant re-pick, no restart from 0%). A failed
  row in the Downloads banner offers **↻ Retry** (resumes the remaining queue)
  and **Dismiss**; Resume with nothing half-written on disk says so instead of
  silently reopening the picker.
- **The weight picker names what each file IS** (`weightRoles.ts`). GGUF repos
  mix runnable weights with companions — `mmproj-*` (vision projector, fetched
  automatically), `dflash*`/`draft*` (speculative-decoding draft), `*-lora-*`.
  They are listed under **COMPANION FILES — cannot run on their own**, and a
  selection with no primary weights is refused with the reason, instead of
  downloading something that can never load.
- **A model the engine can't run says so in one second**, not after a 3-minute
  wait. `server_status` classifies llama-server's stderr and quotes its own
  fatal line; `unknown model architecture` is reported as *engine too old — the
  file is NOT corrupt* (not "re-download the GGUF"). `startupFailureReason`
  (`agentic/localServerFailure.ts`) makes every local-model wait loop — agentic
  dock, team dispatch, fine-tuning chat — stop the moment the child dies and
  show that reason. Guarded by `localModelStartFailure.verify.run.mjs`.
- **Linux/macOS crashes are named too, not just Windows ones.** A child killed
  by a signal reports *no* exit code, so every Unix crash used to collapse into
  "Process ended unexpectedly" while Windows got full NTSTATUS decoding.
  `signal_hint_for` (`server.rs`) is the Unix counterpart — SIGKILL is reported
  as the kernel OOM killer *with the `dmesg` command to confirm it*, SIGSEGV /
  SIGBUS / SIGILL / SIGABRT / SIGTERM each get their own cause, and none of them
  blames the model file. Every death path now also quotes llama-server's own
  fatal line. The gate compiles and runs the shipped Rust on a Unix builder
  against a **real** SIGKILL; it reports SKIP on Windows rather than passing
  silently.
- **A parked message is never destroyed.** The dock clears the composer when it
  accepts a draft for load→send; if the load fails, aborts, times out or throws,
  the text is handed back (`owllm:dock:restore-draft`, restored in `finally`).
- **Cloud**: Anthropic / OpenAI / Gemini / Kimi via API keys, or **subscription
  CLIs** (Claude Code, Codex, Gemini, Kimi) — one ModelPicker everywhere
  (`list_models`; never a per-page dropdown).
- **One line per model, effort chosen inline.** A model that exposes reasoning
  -effort tiers (Claude / GPT) is **one row** whose right edge carries a
  `Low · Med · High · Max` strip — clicking a segment selects
  `<variant>/<id>:<tier>`, the same id the dispatch has always parsed. Tiers are
  normalised to cheapest→deepest whatever order the catalogue lists them in, a
  disconnected account disables the whole strip, and the section header counts
  **rows**, not tier entries. Grouping lives in `groupRows()` in
  `ModelPicker.tsx`, so every surface gets it from the one shared picker.
  Guarded by `modelPickerEffortRow.verify.run.mjs`.
- **No surface ever auto-picks a model.** With nothing saved the picker reads
  **“Select model”** (`SELECT_MODEL_LABEL`) and Send/Generate/Run is blocked by
  the rule-based `components/ModelRequiredDialog` — so a run can't use (or bill)
  weights the user never chose. The one non-explicit source still allowed is a
  local server the user started themselves, shown as “(use server model · …)”.
  Guarded by `modelSelectionNoAutopick.verify.run.mjs`.
- **Tool-calling is NATIVE GGUF ONLY**: OpenAI `tools` array → model's own chat
  template → structured `delta.tool_calls`. No XML protocol (see CLAUDE.md).

## Agentic teams (`ui/src/pages/agentic/`)

- **One standard team + profiles**: every bundled template is a PROFILE over
  the same 6-slot roster — orchestrator (read-only planner) + scout
  (`researcher`, parallel read-only recon) + worker_a/worker_b
  (`solo_generalist`, all tools, two interchangeable parallel execution lanes
  carrying the profile's skill seeds + domain rules) + critical_thinker
  (advisory, ON/OFF toggle on its card) + producer (`publisher`, rule-based
  delivery: commit/publish/send only review-approved work; hosts the
  `[PUBLISH]` protocol for owllm_team). What makes "Chief of Staff" different
  from "Dev Squad" is data: `required_mcp` / `mcp_pack` (connectors + approval
  policy), `extra_skills` seeds, and prompt hints
  (`resources/agents/teams/*.json`; gate: `teamProfiles.verify.run.mjs`).
  Projects persist `templateId` in graph_json — rosters are identical across
  profiles, so the id is the template identity. Solo mode collapses to
  worker_a + Critic + Publisher. The one exemption is
  `product_studio_classic` (category Custom): the full 10-agent hierarchical
  studio (product_owner design sub-team → whitepaper.json → parallel FE/BE
  lanes). Custom multi-specialist teams (Studio/Brainstorm) still dispatch
  through the same graph machinery.
- **Per-agent skills picker**: the skill ribbon on every agent card (bottom
  right, rendered even when empty) opens a searchable 4-column popup of ALL
  installed skill packs, deduped across skills homes and split into
  Equipped/Available sections sorted by display name — icon tile, real name
  (frontmatter name or acronym-aware prettified slug: PDF, MCP Builder…),
  short description, namespace chip, `~Xk ctx` size — and clicking a card
  equips/unequips it live for this project. Unequips of role/template skills
  persist as `-id` DENY entries in the graph_json `agentSkills` grant; ONE
  resolver (`resolveEquippedSkillIds` in `skillRuntime.ts`) backs the badge,
  the picker, and every dispatch injection site, and ONE pure organizer
  (`organizeSkillPacks`) shapes the popup. Same-id packs in multiple homes
  resolve user > legacy > bundled (`skills_dirs_read` precedence +
  `list_skill_packs` dedup), so a user-edited pack shadows the bundled copy
  everywhere (gate: `dispatchSkillBlock.verify.run.mjs`).
- **Auto-skill selection**: before the first model token, the goal text is
  matched against installed skills' `triggers:`/keywords and the best 1–2 are
  injected automatically (Solo, team orchestrator, and bridge paths;
  `selectRelevantSkillIds`/`buildSoloSkillBlock` in `skillRuntime.ts`, gate:
  `autoSkillSelection.verify.run.mjs`). Auto-loads are surfaced in the thought
  log (`📦 Auto-loaded skill(s): …`).
- **Solo-Loop vs Team**: header toggle; Solo = one coder in an edit→verify→fix
  loop with Critic + Publisher; Team = full orchestration.
- **🍄 Psychedelic-effect preference** (`psychedelicMode.ts`): the running-card
  aura has two settings, switched by the 🍄 button immediately left of the
  model-selection tab in every agent card header. `full` (the default) keeps
  the spinning rainbow frame plus the violet/cyan halo that breathes with the
  dispatch pulse; `reduced` keeps only the frame, with the Coding-page
  chatbox's constant soft halo. One page-wide preference stored in the synced
  `pageSettings` document (global scope, key `agenticPsychedelic`), so it
  survives navigation, restart and follows the user across machines. Both chat
  tiles and graph node cards take their active style from the single
  `psychedelicActiveStyle()` helper, and both modes still go still under
  `prefers-reduced-motion` (gate: `npm run test:psychedelic`).
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
  (bump → commit → tag → build → sign → publish → verify updater). The
  Publisher card surfaces tracked app scratch such as `.tmp_wheels/` and can
  de-track only those known runtime roots with `git rm --cached`, preserving
  bytes on disk and avoiding model-invented cleanup shell.
- **Job-specific project environments** (`projectEnvironment.ts`): new-project
  intent cards now persist a versioned workspace recipe, not only a team name.
  Web/React work opens a localhost preview beside OwLLM; responsive work uses a
  phone viewport; web/mobile/software also trim the template to a focused
  four-agent roster instead of starting every specialist. Debug, review,
  writing and data jobs expose deliberately different working surfaces.
  Personal-assistant onboarding has a
  visual picker for any combination of mail, messaging, calendar, documents and
  custom web apps, then opens those tabs in OwLLM's agent browser and adds a
  routed Browser specialist (browser access is role-gated). Recipes store
  labels/URLs only in `graph_json` + the Project Card; cookies, passwords and
  tokens stay in the device-local browser profile/vault. The recipe is injected
  into orchestrator/specialist prompts, including an approval boundary for
  sending, publishing, deleting and other consequential browser actions.
- **Multi-page**: tab strip opens several Agents pages at once, each with its
  own project + run; tabs stay alive (runs keep going), green ● = running.
- **Code-page layout** (2026-08-14, first step toward merging the two pages):
  the Agents page reuses the Code page's column building blocks
  (`CodeSidePanel.tsx` `SideColumnShell`/`UsagePanel`/`BrowserToggleButton`/
  `sideTabStyle`, `CodeColumnRails.tsx`, `TreeDir` from `CodePage.tsx`).
  **Left column** = 🧠 Project Memory + the lazy file tree (a clicked file
  lands as an `@path` reference in the composer) + the **Producer card** docked
  at the bottom, where the Code page carries its GitHub cards; collapses to the
  pink rail (🧠 📁 🚀). The Producer *is* the publish card: the WHOLE
  `AgentChatTile` (identity + per-agent model picker + `PublisherTilePanel`'s
  Commit / Merge / Publish + ⚙ Set up repo), a fixed agent for every way of
  working (team, solo-loop, single coder) — so it is no longer also tiled on
  the ▦ canvas grid. **Right column** = the Code panel's resizable shell + tab
  style carrying 📋 Rules / 🏷 Team + the always-visible chat host, **plus the
  Code panel's 📓 Notebook page** (the shared `RunNotebook` mounted `inline`,
  kept mounted across tab flips), with the bottom **Usage** + 🌐 Browser
  container; collapses to the orange rail (📓 📊 ⚡ 🌐). The focused agent's
  page has **no tab of its own** — the chat/log host below *is* that page and
  never hides, so the old 📜 Orchestrator tab was redundant; the per-agent
  Model + Voice it carried moved into the agent editor popup (click the agent's
  name). The FlowHeader's duplicate 📓 Notebook and 🧠 Memory buttons are gone —
  both features live in the columns.
  **Composer** = the same `ChatInputDock` now at the
  bottom of the canvas column (the Code page's composer position), out of the
  right column; slash commands still switch the pane's sub-tabs via a ref
  bridge. Directly above its textarea, `RunToggleRow` puts the three run
  switches on **one line** — ⚡ auto-approve · critic decides for me ·
  parallel dispatch — the controls that used to sit in the right column's
  Super User container (which is gone; auto-approve is no longer *also* a
  Composer toolbar toggle). Every 🌐 browser control opens the popup **and** splits app +
  browser side by side (`openWelcomeBrowserSplit`). Gated by
  `agentsCodeLayoutMerge.verify.run.mjs`.
- **Mid-run steering**: chat messages during a run queue as ⚡ steers and are
  injected at the next agent boundary — or **between tool calls** on local
  models (`getSteer` in `dispatch.ts`). Never dropped.
- **Auto mode** (⚡ next to the composer, or `/auto`): auto-accepts the agents'
  tool calls. **ON by default** — `claude -p` is non-interactive, so a tool that
  needs approval has no prompt anyone can answer and the turn ends having run
  zero tools. Per project, persisted in localStorage; only an explicit untick
  turns it off. When a CLI does refuse a tool anyway, `runBlockers.ts` turns its
  prose ("permission … hasn't been granted") into the real cause plus the one
  step that clears it, in the thread and as a toast — detected once for every
  backend inside `withCliAuthRetry`, since a refusal arrives as a normal reply,
  not an error.
- **Silent-death diagnostics** (`detectRunFailure` in `runBlockers.ts`): a CLI
  that is KILLED writes nothing, so it used to surface only as
  `claude CLI exited 1 — no stdout or stderr`. Two causes now get named instead,
  on the error side of the same `withCliAuthRetry` funnel:
  * **Linux out-of-memory.** A WSL-isolated project runs the CLI *inside* the
    distro, whose default cap is 50% of host RAM; the kernel SIGKILLs the
    biggest process. `sandbox::wsl_oom_report` reads `/var/log/kern.log` +
    `dmesg` (ignoring any kill older than 10 min, so a stale OOM is never
    blamed) and reports the process and the sizes. The notice carries a
    one-click **⬆ Raise WSL memory** button → `sandbox_raise_memory`, which
    merges `[wsl2] memory`/`swap` into `%USERPROFILE%\.wslconfig` (75% of host
    RAM, never lowering a higher value the user set) and deliberately does NOT
    run `wsl --shutdown`, which would kill every running agent.
  * **You pressed Stop.** Kills we perform are recorded per-pid, so the run
    reports "you cancelled this run" rather than a fault.
  A real diagnostic — especially an auth envelope — still wins, so the
  token-refresh retry keeps firing.
- **Stop is scoped**: the agentic page's per-run Cancel calls `cli_cancel_scope`
  with the project dir instead of `cli_cancel_all`, so stopping one run no
  longer tree-kills every other project's live CLI (each survivor then reported
  a bare non-zero exit). Children register under their `cwd` automatically; the
  dock's Stop stays global. MCP-gateway tool results are capped at 60k chars
  with an explicit truncation notice, so OwLLM's own tools can't be what blows
  up an agent's context.
- **Project Brainstorm** (`BrainstormPanel.tsx` + `brainstormModes.ts`): 🧠 on
  the Agents page. The user picks the KIND of brainstorm first — 🎯 Auto (the
  role's own STEP 0 decides), 🚀 New product, 🛠 Improve this app, 🔬 Research,
  💬 Open — and that choice selects the TRACK the brainstormer follows
  (`resources/agents/roles/brainstormer.yaml`, tracks A–D) instead of framing
  every session as a product/market exercise. Only the tracks that call
  `web_search` mention the Brave key. Co-founder chat → `BRIEF.md` → the
  project's Notebook (seeded whether the team already existed or was assembled
  here). The 📋 Board shows the Feature Priority table for a new-product brief
  and the ordered `## Plan` for every other kind. The conversation is
  checkpointed to `.owllm/brainstorm.json` + localStorage; the streamed
  transcript is dropped from the checkpoint past a size budget (it is
  rebuilt from the saved history) and disk writes are rate-limited, with
  forced flushes on close, unmount and end of turn.
  Guarded by `npm run test:brainstorm`.
- **Run Notebook** (`RunNotebook.tsx`): per-project brainstorm pane +
  NEXT-STEPS list + 🪄 Digest agent (rewrites raw notes into implementable
  steps, additive-only). Steps feed the run (steer or new goal); ▶ Start queue
  feeds the first pending step and auto-feed walks the rest at each clean run
  end. Auto-feed is **ON by default** on both surfaces (absent flag = never
  chosen = on); an explicit off/on is the user's word and persists across
  restart, navigation and sync. It still only decides whether a live chain
  CONTINUES — starting one is always a deliberate ▶ Start queue.
  The queue control is a **state machine over the queue document** (a card
  `sent` with no `finishedAt` = in flight), never a local "I pressed start"
  flag: ▶ Start queue when idle → ⏳ Running (disabled) with a ✕ Stop beside
  it → pressable again the moment the job finishes, fails or is stopped.
  Stop/↺ Reset hand every in-flight card back as `pending` and release the
  lease, so a window that crashed or was closed mid-job leaves a queue that
  **recovers** (heartbeat expiry turns Running into ↺ Reset queue) instead of
  one the user can never restart. Stop cancels the QUEUE, not the agent — the
  run in flight keeps going, and its late run-end stamp is refused because the
  card has left the run.
  Mounted inline on the Code page and as a modal on the Agents page —
  ONE blob per project, so both surfaces are views of the same notebook.
  The Kanban plan board (NOW/NEXT/LATER) and its ⚡ Start batch action are
  built but **hidden** behind `SHOW_KANBAN = false`; the digest stops asking
  for a PLAN block while it is off.
  Cross-device: content syncs through the vault and merges per step
  (union by id, most-advanced-status wins, tombstones for deletions — the
  shared rules live in `runtime/notebookMerge.ts`) so a step another PC
  finished can never come back as pending.
  **Exactly one device drives a queue.** `autoFeedOwner` locks it between
  windows on one PC (device-local, stripped before sync); the synced
  `runningOn` is the cross-device lock. Its owner republishes a heartbeat
  every 30s while the queue is live, and a peer holds the queue read-only —
  *"Queue is running on \<PC\> — job N of M"*, Start disabled, Feed disabled,
  with an explicit **Take over here** that keeps the queue's progress — until
  that beat stops changing for 120s, then the lock releases so a crashed PC
  never strands the list. Liveness is judged by whether the beat VALUE changed
  and how long ago THIS device saw it change, never by subtracting a peer's
  clock from the local one (device clocks are not synchronized).
  Writes use optimistic concurrency on the monotonic `queueRev`: a save whose
  base revision has been overtaken in storage reconciles against the winner
  (same step-union rules) instead of overwriting the other device's progress.
- **Memory**: per-agent history + shared **team memory** (`memory.rs`) — FACTS
  (durable, keyed, vault-synced) vs WORKLOG (auto-captured, local, capped 100),
  BM25-lite retrieval, `[REMEMBER]` harvest on every model path, 3D graph
  viewer, 📌 promote worklog→fact. Retrieved memory is framed as a
  current-task context pack so stale completed work cannot masquerade as the
  active result. A post-run **Memory Curator** (`memoryCurator.ts`) makes one
  bounded pass after every solo/team/bridge run and saves at most 2 novel
  durable facts (author `curator`); its model is a per-project setting in the
  Team Memory modal (default Auto · Cheapest → free local model first, or Off)
  so curation never silently inflates token spend. Design note:
  `docs/MEMORY_RAG_DESIGN.md`.
- **Rules**: per-project must/prefer/avoid directives (`directives.rs`),
  auto-seeded with a native best-practice set, injected into every agent's
  prompt (and every Code-page coder turn). Editable from the right column's
  📋 Rules page (Agents) and the Code page's right column.
- **Skills**: skill packs auto-equipped by role, badges on agent cards,
  cross-provider self-load (any model reads `.owllm/skills/<id>` from disk).
- **Personal agents + rule cards**: Studio provides an editor for reusable,
  version-pinned profiles (identity, role, instructions, model, tools, memory,
  delegation, skills) and user-authored fact/preference/constraint/workflow/
  conditional cards. Project configs pin profile/rule revisions and add local
  overrides; the team editor assigns profiles to agents. Documents persist in
  encrypted global/project scopes with atomic replacement, while safe export
  excludes private rules, memory, and secrets by default. Effective-config
  preview shows deterministic precedence + provenance; runtime resolution
  applies fail-closed tool/delegation intersections, project-isolated memory,
  and the resolved skills/rules on every supported model path.
- **Eval harness**: `routing.verify.run.mjs` control-flow judge + live-run
  scorecard + per-run Run Report (who ran · wrote files? · verdict · done?).

## Code page (`CodePage.tsx`)

Single coding agent in one folder. Multi-page tab strip; each page = its own
chat + Kanban plan + **private git worktree** on its own branch (merge from the
header). Plan/Act phases; live diffs; editable file viewer; image paste.
Optional **second agent pane** (own transcript/model, ⇄ auto-feed both ways,
divided composer). The second agent works in **its own worktree** (`code-2`,
cut from the project alongside the page's), so the two never overwrite each
other's files; its header carries **⤵ Merge into agent 1**, which commits its
work, seals the primary's uncommitted edits first, then merges into the page
branch and names any conflicting files. A non-git folder can't be split, so
both share it — the pane says so rather than implying isolation. The page's
Chat mode governs **both** panes (the second used to keep write tools in
"discuss only" mode), and closing/switching the project is blocked while
*either* agent runs — it deletes the checkouts. Both agents' runs live in
`chatRuntime`, so navigating away
mid-turn keeps them streaming and the tab keeps glowing; closing the tab stops
them. **Each pane's Stop is independent**: a run registers its own cancel scope
(`setCliCancelScope`, keyed by the run's AbortSignal) before dispatching, so
Stop kills that agent's spawned CLI via `cli_cancel_scope` and leaves the other
agent running. The second agent's Stop used to only abort the JS controller —
which a spawned `claude`/`codex`/`kimi` never sees — so on every subscription
model it did nothing at all. The chat pane carries its own header — model picker +
`Clear` (run state) + `Clear history` (chat window **and** saved threads) —
and the composer lives in the same column as the chat, so input and window
stay width-aligned beside the full-height file rail and right column.
Right column = ⚡ Super User: project **rules** (same directives as the team;
shared scope when the folder is a team project) + **Notebook** with auto-feed;
mid-run chat becomes a steer. "Just chat" mode with persisted threads.
Opening a workspace also sweeps the **parked** page worktrees of that project
(`fleet_reclaim_page_caches`, background): git-ignored `target/`/`node_modules/`
untouched for 24 h are removed rename-first, so a page you navigated away from
stops hoarding gigabytes. Never the page you just opened, never `dist/` (that
holds the downloaded module payloads), never source, a branch or a worktree.
Both outer columns shrink independently to a 46px rail (`CodeColumnRails.tsx`)
that keeps one large icon per feature the column holds — left 🧠 memory /
📁 files / 🐙 GitHub, right 📓 notebook / 📊 usage / ⚡ rules / 🌐 browser.
Notebook and rules open the column straight onto their page; the 🌐 icon works
**while shrunk** — it opens the browser on its welcome page and arranges OwLLM
and the browser half/half, the same split the personal-assistant recipe uses.
**Background-work continuity** (`cli_orphans.rs` + `orphanContinuation.ts`):
a turn that ends while a process it started is still running (a build, a test
matrix, a deploy) no longer loses that work. The backend samples every CLI
child's descendants while it lives (all OSes, every CLI — claude/codex/kimi/
gemini/grok), adopts the survivors when the turn exits naturally, announces
them in the transcript ("still running — I'll continue when it finishes"), and
when the last one exits the page auto-sends a continuation turn that tells the
agent to verify the result from the process's own logs and finish what it
promised. Stop and watchdog kills never arm a continuation (the tree died with
the turn); the chain is capped at 3 automatic turns and the watch at 2 h.
Finished events that land while the page is unmounted are held and delivered
on the next mount.

## Isolation & sandboxing

- **Folder-sealed sandbox**: bubblewrap inside WSL2 (Windows), Lima (macOS
  beta), bwrap (Linux beta). Agents see ONLY the project folder — the real
  folder, no copy. Cloud CLIs run inside too; logins/API keys auto-mirror in.
- Graduated trust: isolated by default, per-project Full-access opt-out (all
  three OSes since the 2026-08-16 isolation audit — it was Windows-only before,
  so Linux/macOS users could not opt out at all), write-jail +
  dangerous-command guard when not isolated.
- The jail also binds a fleet worktree's git common dir (a worktree's `.git` is
  a pointer into the main repo), so `git` works inside the sandbox without
  exposing the main checkout — only `.git` is visible, not its working files.
- **Availability is probed, never assumed**: `bwrap`/`limactl --version` only
  proves the binary exists. OwLLM spawns a real throwaway jail and reports the
  engine unavailable — with the reason — if that fails, rather than claiming an
  isolation it does not have.
  - **Linux one-time setup**: Ubuntu 24.04+ blocks unprivileged user namespaces
    (`kernel.apparmor_restrict_unprivileged_userns=1`), so bubblewrap cannot
    build a sandbox until an AppArmor profile grants it `userns`. **Harden**
    installs `/etc/apparmor.d/bwrap` — **once per machine** (it attaches to the
    binary, so it covers every user, project, worktree and agent, and survives
    reboots), asking for a password once. Verified on aarch64 Ubuntu 24.04.
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
- **Leaky host services card** (`host_guard.rs`, Windows only — hidden
  elsewhere): the disk janitor bounds what OwLLM *writes*; this bounds memory a
  Windows service leaks because of what OwLLM *does*. Measured 2026-08-26 on a
  14-day session: `PcaSvc` (Program Compatibility Assistant, which grows with
  the process-creation rate — a CLI per agent turn, plus cargo/rustc/npm/git by
  the thousand) held **2,994 MB of private bytes backing 1 MB of data**;
  restarting it returned it to 3.9 MB doing the same job.
  - A normal user **cannot** stop it (`sc sdshow` grants Interactive Users
    start, not stop), and a background sweep must never raise a UAC dialog — so
    **Install guard** asks once and registers a SYSTEM scheduled task that
    re-checks every 6 hours and after boot, unattended, forever. The task is
    explicitly granted read to built-in Users (a default-DACL task is invisible
    to the non-elevated app, which made every status read say "not installed").
  - A reclaim is authorised by one function behind a **safety triad**: the
    svchost must host that service *alone*, the process must not be
    kernel-critical, and its failure action must not be REBOOT. Anything
    unreadable counts against reclaiming. Graceful stop first, always; the
    terminate exists only because a bloated service **wedges its own shutdown**
    (measured: STOP_PENDING with a frozen checkpoint for 8 minutes), and the
    service restarts on demand with a fresh heap.
  - The janitor pass (`auto_note`) only reports. The card shows each service's
    footprint against its threshold plus the task's own log, so "installed" can
    be told apart from "has actually run".
  - Gate: `hostGuard.verify.run.mjs` — runs the shipped verdict and
    failure-action parsers against truth tables and the whole shipped script
    against an unreachable threshold.
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
- **Self-healing session + honest failures**: a wedged session still creates
  tabs and still accepts `navigate()` without error, but no webview ever
  commits a document — so every action times out and an agent reading a generic
  "the page may still be loading" invents a network cause (2026-08-17: a
  reachable WSL dev server reported as unreachable). Timeouts are now diagnosed
  by whether the tab holds a live document, and the tools **repair the session
  themselves**: `browser_open_tab` gives a new tab a 3 s commit budget and
  `browser_cmd` re-checks after a timeout, then the browser is restarted and the
  work replayed (`heal_if_tab_never_loaded` / `recover_wedged_action`), handing
  back the new tab id plus `"restarted": true`. The restart needs POSITIVE
  evidence, because the two obvious tests are both wrong (measured): a webview
  pointed at an unresponsive host reports `about:blank` while the request hangs,
  exactly like a wedged one, and tabs that loaded *before* the wedge keep
  reporting their old URL — so "is any tab alive?" stays silent through the real
  failure. `browser_engine_is_dead` instead opens a background tab on the app's
  own start page, which cannot be slow; only if *that* never commits is the
  engine judged broken. Bounded further: the cooldown is stamped before the
  teardown so a failed restart cannot loop, an automatic restart does not mark
  the session closed, and only `navigate`/`open` is replayed — replaying a
  content read against the fresh blank tab would answer about a page that never
  loaded. `browser_screenshot` likewise refuses a minimized window instead of
  returning a picture of nothing.
- **OwLLM chrome (app-styled window)**: the browser is a FRAMELESS multi-webview
  window that looks like the app, not a stock OS window — an OwLLM chrome-bar
  webview (`ui/public/browser-chrome.html`: launcher app icon + title, tab
  strip, back/reload, URL box, min/max/close) sits above the page webviews
  (`Window::builder` + `add_child`, tauri `unstable` feature), so the bar never
  overlays site content. The bar wears the app header's colour — the same
  `--bg-header` recipe (70% accent over `#1c2244`) resolved live from the
  shared localStorage accent key. Its buttons/drag/URL entry/tab events report
  over a reserved same-origin navigation (`/__owllm_browser_event__`) that
  `on_navigation` intercepts and cancels before any load — no IPC grant to any
  webview. `browser_set_chrome` still paints the DWM border (and the fallback's
  caption) in the app accent.
- **Platform shapes**: the framed chrome-bar window above is **Windows and
  macOS**. **Linux runs `build_legacy`** — one decorated top-level WebView per
  tab — because WebKitGTK mislays stacked child webviews and SIGBUSes the web
  process when they resize (seen on Jetson/Tegra), and it does so *without*
  returning an error, so a runtime fallback never fires. Linux therefore has no
  chrome bar and no `+` inside the browser window; `BrowserPanel` is its tab
  strip, and carries the same actions (`＋` new tab → `browser_new_tab`, `↺`
  reopen, `←` back, `⟳` reload) on every platform.
- **Tabs (multiple pages at once)**: the chrome bar's tab strip opens any
  number of pages side by side, like a normal browser — `+` for a new tab,
  pills to switch, `✕` to close (closing the last tab closes the window). Each
  tab is its own content webview labelled `owllm-browser-page-{id}`; they all
  share one profile dir, so logins/cookies span tabs. Only the active tab sits
  in view — inactive ones are parked offscreen (`PARK_X`), the cross-platform
  substitute for a child-webview `hide()`. Agent `browser_*` tools always drive
  the ACTIVE tab (`content_webview`), so the tool contract is unchanged.
  Switching device emulation rebuilds the window and keeps the active tab.
- **Typed-login auto-capture**: submitting a form with a filled password field
  (or leaving a page with one) reports origin/username/password over the EVT
  title channel; Rust upserts it into the encrypted vault
  (`browser_vault::store_typed_login`), so anything the user types to log in
  autofills next time. Blank passwords are ignored; dedupe is per (origin,
  username), same merge path as manual and imported creds.
  The SCANNER is `FRAME_CRED_JS`, injected with
  `initialization_script_for_all_frames` so it reaches **iframes** — Tauri's
  plain `initialization_script` is main-frame-only, which is why an embedded
  identity provider (Google's iframe, most OAuth) used to be uncapturable. It
  pierces **shadow roots** for web-component logins, and reads
  `composedPath()[0]` rather than `e.target`, since events retarget to the
  shadow host and a document-level listener would otherwise see a `<div>`.
  `BRIDGE_JS` keeps the transport alone: an iframe's `document.title` never
  reaches the window, so a sub-frame `postMessage`s its find to the top frame.
  The credential is filed under the FRAME's origin, so an embedded provider
  login belongs to the provider, not the framing site. QR/passwordless logins
  (WhatsApp Web) are still not captured — no password ever exists to read.
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
  Browse / Passwords / Import tabs. Browse carries the tab strip plus the
  chrome-bar actions (`＋` new tab, `↺` reopen, `←`, `⟳`), so the browser is
  fully drivable on Linux, where the window itself has no chrome bar.
- **Browser agent** (role `resources/agents/roles/browser.yaml`, base `browser`):
  a dedicated team member that owns the non-isolated web work — localhost
  previews, live sites, form filling/testing, cross-device checks. Its team card
  swaps the chat preview for the SAME `BrowserPanel` mounted `inline`
  (`isBrowser` in `AgentsPage.tsx`, mirroring the Publisher's rule-based card),
  so the card IS the browser remote. Provisioned automatically for Personal
  Assistant projects (`kindAgents` in `ProjectSettingsDialog.tsx`).
  Card controls fire host-side (the window + gateway are host objects), so they
  work even when the rest of the team is sandboxed.
- **Reachable by ALL agent kinds**: local + API agents call `browser_*` through
  `executeToolCall`; subscription-CLI agents (Claude, Codex and Kimi) reach the
  SAME browser natively via the MCP gateway below. No per-tool harvest hack.

## Subscription sign-in — Connect opens the provider's page (`PtyTerminal.tsx`)

- **Flow**: Accounts → Connect spawns the provider CLI in an embedded PTY,
  auto-sends `/login`, and opens the authorization URL the CLI prints in a
  private Agent Browser tab (`browser_open_auth_tab`), so provider OAuth never
  inherits the user's ordinary cookies. Opt-in per terminal via
  `autoOpenAuthUrls`; general-purpose terminals never hijack the browser.
- **The URL is read from the terminal buffer, not the byte stream**
  (`unwrapTerminalLines.ts`). A CLI's URL is hard-wrapped across rows, and
  re-deriving that wrap from bytes is ambiguous: a URL ending exactly on the
  last column is indistinguishable from one that continues. xterm records per
  row whether it is a continuation, so read that flag. `authUrlCapture.ts`
  additionally refuses any URL whose END has not been observed — Claude puts
  `state` last, so a cut inside it used to yield a URL that passed every
  "required parameter present" check and was silently truncated.
- **Always a manual route**: once a complete authorization URL has been seen,
  the terminal header shows **⧉ Open sign-in page**, so a failed or missed
  automatic open can never leave sign-in with no way through.
- Guarded by `pages/advanced/authLoginBrowserOpen.verify.run.mjs`.

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
    two explicit exceptions: the **Browser role** and the deliberately
    unrestricted **Solo Generalist**. Detected Rust-side from `browser_*` or
    the explicit `all` tool sentinel, those agents are spawned via
    `sandbox::program_argv_unjailed` (plain WSL, interop alive) and wired to
    the relay, while every other agent in the team stays jailed. Deliberate,
    disclosed tradeoff: these runs gain /mnt + interop access like a
    full-access run.
  Adding memory_*/kvm_node to the catalogue is a follow-up. The Kimi WSL relay
  was verified end-to-end against the real shared WhatsApp browser on
  2026-07-30 (`browser_tabs` → tab select → `browser_snapshot`).
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
  it exists because codex couples MCP-call approval to the sandbox mode.
- **Kimi parity** (`kimi_cli_stream`): Python Kimi receives a per-run
  `--mcp-config-file`; host `kimi-code` receives an isolated temporary home
  with `mcp.json`. WSL uses the same stdio relay described above. Kimi exposes
  gateway tools under bare names (`browser_tabs`, `browser_snapshot`), and its
  stream events surface tool calls/results in the UI. Gemini remains one-shot
  and is configured project-locally.

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
  The default name comes from `hardware::machine_name()`, which asks the OS via
  `sysinfo` — NOT from `COMPUTERNAME`/`HOSTNAME`, a Windows-only and a *shell*
  variable that a GUI-launched app never inherits, so every Linux/macOS install
  used to be named the identical placeholder "This OwLLM PC". A trailing
  `.local`/`.lan` is trimmed and a bare `localhost` is rejected. An identity
  still stamped with the old placeholder is healed on load (exact match only,
  so a name the user typed themselves is never rewritten).
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
- **Browser start page**: the chrome bar's **＋** opens `browser-home.html` —
  big-icon rows for search engines, social, messengers, plus the five most
  recent project pages (query/fragment stripped) and a direct web-search box.
  It is served from the app origin like `browser-chrome.html`, never as a
  `data:` URL: Tauri rejects `data:` webviews unless the `webview-data-url`
  feature is on, which made **＋** silently open nothing. Rust passes the
  recents to the page as base64url JSON in `?r=` (`browser.rs::browser_home_url`).

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
- **Cross-PC sync coordinator** (`sync_core.rs`, `repo_sync` command): the
  release rail's Sync/Push actions run one transaction — fetch → classify
  (synced/ahead/behind/diverged) → integrate diverged histories on a temporary
  worktree with a plain three-way merge → optional verify on the integrated
  commit → push with moved-remote retry → fast-forward the local checkout.
  Never force-pushes; never auto-picks a side of a real conflict (a recovery
  ref + untouched branches preserve both). `↑N ↓M` divergence is a normal
  input, not an error. Publish runs the same transaction before building.
  Generic for ANY repo — zero project-specific knowledge in the Rust core.
  Proven by a standalone two-clone harness (`src-tauri/sync-harness/`, run via
  `syncCoordinator.verify.run.mjs --live`) driving a real bare remote + two
  clones through divergence, same-file merges, conflicts, mid-sync races,
  dirty files, and verify-gated pushes.
- **Fleet** (`fleet.rs`): git-worktree substrate for parallel agents/pages;
  diff/merge/finalize; orphan sweep. Worktree merges use plain three-way
  merging — real overlapping edits return a Conflict with both sides
  preserved; only disposable app runtime files auto-resolve. Cleanup never
  deletes a branch whose work HEAD does not contain (ancestry or
  squash-equivalent tree, `branch_work_contained`): the worktree directory is
  reclaimed but the branch ref survives and the run announces it — an agent
  that committed its own work can never be orphaned by teardown. Only the
  Code page's explicitly confirmed close passes `discardUnmerged` to really
  drop one. Gate: `fleetWorktreeWorkLoss.verify.run.mjs`.

## Support & UX

- **One shared chat composer** (`components/Composer.tsx` + `.owc-*` in
  `styles.css`): every chat surface — Agents dock, Code agent 1 / agent 2 /
  just-chat, fine-tuning chat — renders the same component, the same way
  `ChatBubble` owns message rendering and `LogBox` owns logs. Before this each
  page hand-rolled its own textarea, Send/Stop and picker, so capabilities
  differed per page (only the dock had a mic, only Code had a model picker or
  Terminal, only fine-tuning had modes and slash commands). The container holds
  header (status · badge · **model picker top-right** · Terminal slot), trays
  (image thumbs, document chips, `#` mentions, error/notice), the autosizing
  textarea with the 🎤 dictation button, and an action bar (attach · slash ·
  mention · mode segment · capability toggles · hint · draft counter ·
  Send↔Stop in one fixed slot). Paste and drag-drop both attach; the palette
  drops up; dictation degrades honestly where the WebView has no
  SpeechRecognition. Pages pass only the capabilities they actually have, so
  nothing is faked. Pinned by `sharedComposer.verify.run.mjs`.

- **Bounded stream rendering** (`components/StreamWindow.tsx`, v0.9.60): the run
  views append forever, so rendering every entry grew the DOM monotonically with
  run length until the WebView2 renderer hit its own per-process allocation
  ceiling and Chromium killed it ("This page is having a problem · Error code:
  Out of Memory" — with GBs of system RAM still free). Agents Full Chat / Thought
  / Tool Calls and the Code transcript now materialise only a tail window
  (`STREAM_WINDOW`, 200) with an "N earlier entries hidden · Show more / Show all"
  banner; `LogBox` lays out only the last `INLINE_TAIL_CHARS` (120k) inline and
  keeps the full text in the expand modal + Copy. Nothing leaves state or the DB —
  only how much is in the DOM at once is capped, so memory is flat in run length
  instead of linear. Pinned by five smoke-matrix tripwires.

- **Application-wide localization**: Settings switches English, Simplified
  Chinese, Korean, Japanese, Arabic, Italian, Hindi, or Portuguese (pt-BR)
  live and persists the choice; the selector is a 4×2 grid of flag icons
  (bundled webp assets in `icons/App_icons/`, no OS-dependent emoji). The
  shared catalogue covers page chrome, controls, menus, dialogs, empty
  states, status copy, tooltips and accessibility labels; new/missing entries
  fall back to English. Terminology follows native software conventions —
  git/GitHub command words (commit, push, merge, branch…), CLI commands, and
  established dev loanwords (Code, Info, Signing, token, prompt…) are never
  literally translated. Arabic switches the application shell to RTL while
  code, terminals, paths and user/model-authored content keep their natural or
  technical direction. The separate agent-browser chrome follows the same key.

- **The Watcher**: in-app support agent — per-page docs (`PAGE_DOCS`), guided
  walkthroughs, screenshot+ask, one-click bug report to GitHub. Window capture
  works on Windows (PrintWindow) AND Linux (GDK readback, `support.rs`).
- **Crash / unclean-shutdown detection** (`session_health.rs`): every process
  writes a marker on startup and deletes it on the way out. Cleanup runs on
  `WindowEvent::CloseRequested` (the X), `RunEvent::ExitRequested`, and
  `RunEvent::Exit` because Tauri does not guarantee the later events fire on
  every path (Windows shutdown skips them, and some close paths have been seen
  to skip `Exit`). A marker whose owner is gone means that session never reached
  its exit path — the only way to detect a SIGKILL, an OOM kill, or a power cut,
  none of which leave anything in-process. Markers are per-process (OwLLM is
  multi-instance) and matched on pid **plus** process start time, so a recycled
  pid cannot make a dead session look alive. The next launch shows one toast and
  the records ride along on every support report
  (`SupportSnapshot.unclean_shutdowns` + `crash_log_tail`). Showing the notice
  never deletes the records — only an explicit `session_health_dismiss` does.
  The auto-updater is a legitimate death outside the exit path — `install()`
  never returns on Windows, it hands the NSIS installer to the shell and calls
  `std::process::exit(0)` — so `UpdatePrompt` declares it via
  `session_health_expect_replacement` between `download()` and `install()`, and
  re-arms with `session_health_rearm` if the install fails instead of replacing
  us. The Linux AppImage path does the same before launching its helper, whose
  deferred swap also exits outside `RunEvent::Exit`. Without that, every
  auto-update made the newly installed build open by accusing the previous one
  of crashing.
- **Exit-path breadcrumbs** (`log_exit_path` in `lib.rs`): `CloseRequested`,
  window `Destroyed`, `ExitRequested` (with a backtrace when a code is present,
  naming whoever called `app.exit`) and `Exit` are all recorded to stderr and
  `owllm-crash.log`. Added because a normal Tauri shutdown used to log nothing,
  so a spurious quit and a crash were indistinguishable from outside.
- **Native webview process recovery** (`lib.rs`, both engines): every platform
  runs the page in a process the OS can take away — WebKitGTK kills its web
  process, WebView2 sheds its render process under host memory pressure. The
  native window survives with nothing painting into it, which reads as a solid
  black window that only a restart clears. Linux listens on
  `connect_web_process_terminated`; Windows subscribes to WebView2's
  `ProcessFailed` and reloads on `RENDER_PROCESS_EXITED`. Both append the native
  kind/reason to the user-data dir (`linux-webkit.log` / `windows-webview2.log`,
  TEMP fallback) before recovering, and durable state is restored by main.tsx.
  Three things the mechanism forces: the Windows handler **re-arms itself**
  (webview2-com builds callbacks from a `FnOnce`, so one subscription would
  recover exactly one death and then go silent); the subscription is **per
  webview**, so the overlay frame is armed where it is built — an unarmed view
  stays black while its sibling recovers; and a reload burst limit (3/60 s)
  keeps a page that kills its own renderer on load from spinning forever. An
  unresponsive-but-alive renderer is never reloaded, and a dead *browser*
  process is logged but not reloadable — `Reload` cannot revive one.
  Measured on Windows: killing both render processes left the unpatched build
  with zero renderers and no `Chrome_RenderWidgetHostHWND` for 30 s, while the
  patched build had a fresh render process within 1 s.
  **Every agent-browser view is armed too** (`browser.rs`): each tab in both
  window shapes, plus the browser's own chrome bar. Tabs use
  `Webview2Recovery::ReloadThenNotice` — one reload, then the shared
  `TAB_PROCESS_STOPPED_HTML` notice via `NavigateToString`, the same
  one-retry-then-local-page rule the Linux tab path has always had, because a
  tab shows an arbitrary site that may kill its own renderer on load. The chrome
  bar is app UI, so it reloads like `main`. Measured on an isolated instance
  driven over WebView2 CDP: with the bar unarmed, killing all 4 render processes
  of a browser window recovered 3 and left the bar's renderer gone; armed, all 4
  came back, each logging its own label (`owllm-browser-page-1`, `browser chrome
  bar`, …). A second kill inside the burst window left the tab on `about:blank`
  showing the notice while the app surfaces reloaded again.
  Gate: `ui/src/webviewCrashRecovery.verify.run.mjs` (dependency-free).
  Not covered: the Linux chrome bar has no `connect_web_process_terminated`
  handler (Linux tabs and `main` do), and macOS has no recovery on any view.
- **Linux chrome**: no overlay window off-Windows — the frame draws in-page,
  the main window is transparent (`tauri.linux.conf.json`) and the see-through
  headroom band above the frame is click-through via GTK input-shape
  (`frame_shape.rs`), mirroring the Windows overlay behaviour.
- Update streams: signed Tauri updater (shell) + per-launch module swap +
  hot-pulled data layer (teams/roles/profiles from the public repo).
- **How an update is offered** (`ui/src/UpdatePrompt.tsx` +
  `ui/src/runtime/updateAvailability.ts` + `ui/src/runtime/updateSchedule.ts`):
  the updater checks 2.5 s after launch, **then every 5 min**, and again as soon
  as the machine comes back **online**, the window is **focused**, or the webview
  becomes **visible** (floored at 60 s so alt-tabbing is not a storm). The short
  period exists because a release is published as a *pre-release* and promoted to
  Latest only once every platform is up: for that whole window
  `releases/latest/download/latest.json` still resolves to the PREVIOUS release,
  so the client is told — correctly — that it is up to date, resets its failure
  count, and sleeps the full period. A 30-min period therefore hid v1.0.29 from
  an already-running app for 22 min after the promote. The next check is
  scheduled by the one that just finished, never by a fixed `setInterval`, because a check that
  lands inside a multi-OS publish window does not get "no update" — it gets
  `TargetNotFound` for whichever platforms `finish-multihost.sh` has not merged
  into `latest.json` yet (tauri-plugin-updater resolves the platform URL before
  it compares versions). Those failures back off 1 → 2 → 4 → 8 → 15 min instead
  of waiting out the period, so a Linux/macOS install picks the release up
  within ~15 min of the manifest completing rather than hours later; the
  "unavailable for this platform" notice is withheld until 4 failures in a row
  and clears itself on the next answered check. Finding one no longer opens a
  modal. It publishes to the `updateAvailability` store, and the owl at the
  top-centre of the frame says so in a **manga speech balloon** on its LEFT (so
  it can never collide with the World Chat bubble on its right) — *"Please,
  update your app! We fixed a few bugs and added cool features!"* — clickable,
  for `UPDATE_NOTICE_MS` (10 s), once per version per session. After that the
  offer **rests** in a small **⬆ Update available** badge under the OWLLM mark
  (bottom-right of the wordmark) and stays there until the update is installed;
  the Info page's Application card carries the same badge. The install modal
  opens only on demand (`OPEN_UPDATE_EVENT`), so "Later" hides a dialog instead
  of losing the update — the previous design recorded a dismissal and left no
  other surface anywhere. Gate: `ui/src/updateNotice.verify.run.mjs`.
- **World presence always reports the release.** The version is a query
  parameter the client puts on its own socket (`worldPresence.ts` → `?v=`), so a
  VPN cannot strip it; blank versions on the map are installs older than v1.0.7.
  The identity-failure path in `WorldPresenceRunner` (`AppShell.tsx`) now still
  sends `appVersion` from `getVersion()` — it used to connect with no arguments
  at all, the one path that could show an ONLINE dot as "Version unknown".
- Frameless HybridFrame window (transparent — NEVER make it opaque),
  sticky-scroll chats (`useStickyScroll`), shared `ChatBubble` renderer,
  shared `LogBox` for all logs.

## Where to look (quick index)

| Concern | File |
|---|---|
| local chat + tool loop | `ui/src/pages/agentic/dispatch.ts` (`streamLocalChat`) |
| tool specs + MCP | `ui/src/pages/agentic/localTools.ts` |
| team dispatch (desktop) | `ui/src/pages/agentic/AgentsPage.tsx` (run loop; model calls via shared `dispatch.ts`) |
| team dispatch (bridges) | `ui/src/pages/agentic/dispatch.ts` |
| solo coder page | `ui/src/pages/agentic/CodePage.tsx` + `CodeSidePanel.tsx` |
| notebook | `ui/src/pages/agentic/RunNotebook.tsx` |
| team memory | `src-tauri/src/memory.rs` + `TeamMemoryModal.tsx` |
| rules | `src-tauri/src/directives.rs` |
| project card / gate | `ui/src/pages/agentic/gate.ts`, `cardLint.ts` |
| vault sync | `src-tauri/src/vault.rs` |
| worktrees/fleet | `src-tauri/src/fleet.rs` |
| user-facing page docs | `ui/src/support/WatcherDrawer.tsx` (`PAGE_DOCS`) |
| "why did the app close?" | `src-tauri/src/session_health.rs`, `log_exit_path` in `lib.rs` |

**Known trap for agents (updated 2026-08-14)**: `AgentsPage.tsx` used to carry
its own ~1000-line copy of the cloud dispatch stack (router + provider
streams); it drifted from `dispatch.ts` 19 documented ways and was collapsed
onto the shared stack — `streamChatCompletion` and every provider stream now
live ONLY in `dispatch.ts`, and `teamRunContinuity.verify.run.mjs` fails if a
page-local CLI invoke ever comes back. The PROMPT BUILDERS
(`buildOrchestratorPrompt`/`buildSpecialistPrompt`) are still duplicated
(AgentsPage's richer copy vs dispatch.ts's bridge copy) — a prompt fix still
needs BOTH until that half is unified.
