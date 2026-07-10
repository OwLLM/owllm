// The Watcher — OWLLM's in-app support assistant (P0-8).
//
// Summoned from the unlabeled owl in the HybridFrame top-center. This is
// the Slice-1/2 surface: an animated drawer with app-aware actions —
// "What page am I on?", "Check my setup" (the support_snapshot command,
// composed from the app's real probes) and a "Report a bug" entry point
// (the full reporter ships in a later slice). Everything here is local;
// nothing leaves the device.

import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { getActivity } from "./activityStats";
import { redactForReport } from "./redact";
// Model discovery + dispatch: the SAME machinery the rest of the app uses
// (shared ModelPicker catalogue + the shared dispatch paths) — never a
// parallel model list (P0-8 Slice 5).
import ModelPicker, { buildEntries, type AccountsStatusLite } from "../pages/agentic/ModelPicker";
import {
  streamLocalChat,
  streamChatCompletion,
  providerFor,
  type ModelInfo,
  type HistoryItem,
  type Attachment,
} from "../pages/agentic/dispatch";
// Bug reports are sent to GitHub. When the user isn't connected, the bug view
// walks them through a one-time GitHub sign-in (Device Flow — no token to paste;
// the sign-in page also lets them CREATE a free account). Reuses the shared
// github bindings so there's no parallel auth path.
import { githubStatus, githubDeviceStart, githubDevicePoll, GITHUB_TOKEN_URL, GITHUB_CHANGED_EVENT } from "../pages/agentic/github";

/// Open a URL in the user's real browser (native shell; window.open fallback).
function openExternal(url: string) {
  invoke("shell_open_url", { url }).catch(() => {
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
  });
}

// Landing-card icons are inline SVG, NOT emoji, on purpose: the life-ring emoji
// (🛟 U+1F6DF, Emoji 13.0) ships in Windows 11's Segoe UI Emoji but is MISSING on
// Windows 10, where it renders as a "tofu" box. SVG paints identically on Win10/
// Win11/macOS/Linux and inherits the theme accent, so the icons stop differing
// across OS versions. Sized to match the old 32px emoji.
function LifeRingIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"
      stroke="var(--accent)" strokeWidth={2.5} strokeLinecap="round">
      <circle cx="16" cy="16" r="13" />
      <circle cx="16" cy="16" r="5.5" />
      <line x1="16" y1="3" x2="16" y2="10.5" />
      <line x1="16" y1="21.5" x2="16" y2="29" />
      <line x1="3" y1="16" x2="10.5" y2="16" />
      <line x1="21.5" y1="16" x2="29" y2="16" />
    </svg>
  );
}
function BugIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"
      stroke="var(--accent)" strokeWidth={2.5} strokeLinecap="round">
      <ellipse cx="16" cy="18" rx="8" ry="9.5" />
      <line x1="16" y1="8.5" x2="16" y2="27.5" />
      <circle cx="16" cy="7" r="3" />
      <line x1="14" y1="5" x2="11.5" y2="2.5" />
      <line x1="18" y1="5" x2="20.5" y2="2.5" />
      <line x1="8" y1="14" x2="4.5" y2="12" />
      <line x1="8" y1="18" x2="4.5" y2="18" />
      <line x1="8" y1="22" x2="4.5" y2="24" />
      <line x1="24" y1="14" x2="27.5" y2="12" />
      <line x1="24" y1="18" x2="27.5" y2="18" />
      <line x1="24" y1="22" x2="27.5" y2="24" />
    </svg>
  );
}

type ReadinessRow = { ok: boolean; warn: boolean; detail: string };
type SupportSnapshot = {
  appVersion: string;
  os: string;
  arch: string;
  cpu: string;
  gpus: string[];
  ramTotalGb: number;
  readiness: { wsl: ReadinessRow; gpu: ReadinessRow; env: ReadinessRow; runtime: ReadinessRow };
  server: { running: boolean; model_id: string | null; port: number | null; message: string };
  wslStage: string;
  wslDetail: string;
  modules: string[];
};

type Entry = { from: "watcher" | "you"; text: string; imageDataUrl?: string };

type WindowCapture = { pngBase64: string; width: number; height: number; notCaptured: string };

type ServerStatusT = { running: boolean; model_id: string | null; port: number | null; message: string };

/// How the Watcher will answer an AI question.
type ModelChoice =
  | { kind: "local"; modelId: string; port: number; label: string }
  | { kind: "cloud"; modelId: string; provider: string; label: string; preconsented?: boolean }
  | { kind: "cloud-unavailable"; provider: string; label: string } // picked, but its account isn't connected
  | { kind: "local-cold"; label: string }   // local models exist, server not running
  | { kind: "none" };

const WATCHER_PERSONA =
  "You are The Watcher, OWLLM's in-app support assistant. You are given (a) DOCS for the page the user is " +
  "currently on — what each function/button does and how to fix its common problems — plus a one-line index " +
  "of the other pages, and (b) a JSON snapshot of the app's real state (readiness, hardware, server, WSL, " +
  "modules). Use the DOCS to explain features and walk the user through what to click; use the SNAPSHOT for " +
  "live state. Help in plain language: likely cause, immediate fix steps, whether it looks like a product " +
  "bug, and minimal repro steps when relevant. Be concise and concrete. If the snapshot or docs already show " +
  "the answer (a ❌ row, a crashed server, a documented fix), lead with it. Prefer the DOCS over guessing, " +
  "and never invent state that isn't in the snapshot.\n\n" +
  "KEY FACTS about what each readiness row actually gates — do NOT conflate them:\n" +
  "• WSL → agent/Coder ISOLATION (the sandbox). Agents and the Code page run isolated INSIDE WSL. " +
  "If WSL is OK, isolation is available — that is the only requirement for sandboxed agent runs.\n" +
  "• 'Fine-tuning env' (the `env` row) → ONLY model TRAINING / fine-tuning on the Train page (a Python/torch venv). " +
  "It is NOT required for agents, the Coder, isolation, Chat, or the model server. " +
  "NEVER tell the user to 'install the environment on Train' to fix agents, isolation, chat, or serving — that env is irrelevant to them. " +
  "If `env` is not set up but the user is asking about agents/isolation/Code, say it does not matter for that.\n" +
  "• GPU / runtime → local model SERVING (llama.cpp). Needed to run local models, not for agent dispatch to cloud models.\n" +
  "So a snapshot with WSL ✅ but `env` ⚠️ means: agents CAN run isolated; only fine-tuning is unavailable.";

/// Short one-liners — used for the "What page am I on?" answer and as the
/// cross-page INDEX the Watcher gets so it can point the user elsewhere.
const PAGE_BLURBS: Record<string, string> = {
  home: "the Home page — system status, readiness checks, and quick setup actions live here.",
  agents: "the Agentic Team page — orchestrator + specialist agents that fan out on your goal. Pick a project location, type a goal, hit Run.",
  code: "the Code page — a single coding agent working in a project folder (isolated in WSL when the badge is green).",
  chat: "the fine-tuning Chat playground — talk to local or cloud models, with tools, in up to three columns.",
  train: "the Train page — fine-tune models on your data (needs the environment installed: Environment button).",
  models: "the Models page — your downloaded and fine-tuned models.",
  server: "the Server page — start/stop the local llama.cpp model server.",
  bridges: "the Bridges page — connect Telegram / WhatsApp / Discord / Slack / email to your agents.",
  info: "the Info page — live system info + sandbox-disk maintenance.",
  accounts: "the Accounts page — API keys + subscription-CLI logins for cloud models.",
  mcp: "the MCP page — connect MCP servers so agents gain extra tools.",
  devices: "the Devices page — securely control your other OwLLM machines. Pairing + a device key are required; a GitHub login alone never grants control.",
};

/// FULL per-page/function documentation the Watcher reads for the page the user
/// is ON. Keep this CURRENT when features change — it's the Watcher's source of
/// truth about how each page + function works and how to fix common problems.
const PAGE_DOCS: Record<string, string> = {
  home:
    "HOME — the launcher + system status.\n" +
    "• System Status: live GPU(s) with per-GPU VRAM and a checkbox to include/exclude each from inference; CPU; RAM. 'Refresh Hardware Detection' re-probes.\n" +
    "• Software Requirements & Setup: four LIVE readiness rows (WSL/Ubuntu, GPU & CUDA driver, Fine-tuning env, Local LLM runtime) with one-click fixes when missing — 'Set up WSL', 'Set up Fine-tuning Environment' (jumps to Train), 'Install LLM engine' (llama.cpp).\n" +
    "• Sign-in/sync bar at top: GitHub sign-in so chats/settings follow you across devices.\n" +
    "• Three launcher tiles (Fine Tuning, Agentic Team, Gamify) reveal quick actions on hover.\n" +
    "Note: the Sandbox-disk maintenance panel moved to the Info page.",
  agents:
    "AGENTIC TEAM — an orchestrator + specialist agents that fan out on your goal.\n" +
    "• MULTIPLE PAGES: a tab strip at the very top (like the Code page) lets you open several Agents pages at once — '＋ New page'. Each tab picks its OWN project (same or different) and runs its own team in parallel; a green ● on a tab = that page has a run in progress. Tabs stay alive when you switch, so runs keep going; closing a busy tab asks first (closing stops its run).\n" +
    "• The top of each page is ONE line: a 📁 project dropdown + ⚙ (Project settings) + '+ New' + the goal/Run row.\n" +
    "• ⚙ Project settings popup holds everything project-level: Folder/Browse, a Security block (Trust writes; Isolated vs ⚠ Host-access; Verify; Isolate; Full access), Team template, Bridge, Rename, and Delete (requires a double-confirm).\n" +
    "• '+ New' opens a VISUAL onboarding: step 1 is a card grid — pick WHAT you want to make (🌐 Website/Web app, 📱 Mobile app, 🛠 Software, 🤖 Personal assistant, 🐛 Fix bugs, 🧐 Code review, 🔬 Research, ✍️ Writing, 📊 Data, 📣 Social, 🚀 New product, or ⚙️ Custom). Each card pre-picks the right team template and seeds the team's starting context; step 2 shows Name + Folder + the editable context, a 'What you get' summary (team, agents, MCP), and an Advanced fold with the raw template picker + Trust writes. '← Change' goes back to the cards.\n" +
    "• Goal/Run row: 📎 attach an image/audio, the goal box, 🧠 Brainstorm, Run, Cancel, 📊 telemetry, 🔊 voice.\n" +
    "• The orchestrator leads and dispatches to specialists; the arrows between cards ARE the dispatch graph. Each agent's model + voice are set on its card and PERSIST per project.\n" +
    "• Brainstorm (🧠): a co-founder chat → deep research (competitors, open-source, real user pain, pricing) → writes BRIEF.md → '🤝 Assemble team from brief' (proposes + saves a runnable team) → a live feature Board view.\n" +
    "• Memory (🧠 on the canvas header): the team's shared memory viewer, two tabs — FACTS (durable knowledge agents saved on purpose; syncs across PCs via the vault; filter by tag chips) and WORKLOG (auto-captured record of recent agent turns; local-only, capped; 📌 promotes a worklog row to a durable fact). Also a 3D graph view colored by tag cluster.\n" +
    "• MID-RUN MESSAGES: anything you type in the chat WHILE the team runs is NOT dropped — it's queued (the ⚡ echo) and injected live: the next agent to start a turn gets it, and LOCAL models even pick it up between tool calls mid-turn (like VS Code). No need to wait for the run to finish.\n" +
    "• Browser (🌐 on the canvas header): the agents' NATIVE web browser — a real OwLLM window (the app's own engine, not Python/Playwright, no external Chromium) the agents drive with the browser_* tools (open pages, click, type, fill forms). Logins persist across runs. It opens LOCAL DEV SERVERS too (localhost:5173 / 127.0.0.1:3000 default to http) — build a web app and let the agents check it live — and DEVICE EMULATION previews mobile: desktop / iPhone / Android / tablet chips (real viewport size + mobile user-agent; agents switch it with browser_device). The panel has three tabs: BROWSE (open a URL / show the window / autofill / device chips / stop — agents inherit whatever you log into), PASSWORDS (a local encrypted vault, DPAPI-backed on Windows, that agents autofill — add logins by hand, passwords never shown), and IMPORT (pull saved logins from Chrome / Edge / Brave / Opera; Firefox coming). Closing the panel never stops the browser.\n" +
    "• BROWSER AGENT (a team member, base 'browser'): a dedicated agent whose CARD IS the browser remote — the same Browse / Passwords / Import controls embedded in the tile. It owns the non-isolated web work: opens localhost previews and live sites, reads pages, fills & tests forms, checks mobile layouts. It's in the Dev Squad template (add it to any team from the workbench); when building a web app, dispatch it to open the running site and verify it actually renders. Its card controls fire host-side, so they work even when the rest of the team is sandboxed.\n" +
    "• Notebook (📓 on the canvas header): your scratchpad DURING a run — one Working notes pane, a 📋 Kanban plan board (Now / Next / Later), a NEXT-STEPS list, and a 🪄 Digest notes action that reads the notes/current board/existing steps and proposes bigger implementation chunks instead of tiny chores. Saving a proposed plan clears the consumed notes so you can start a fresh note. ⚡ Feed sends a step to the running team as a steer, or dispatches it as a new goal when idle; Auto-feed dispatches the next pending step after each clean finish. Saved per project.\n" +
    "• SOLO-LOOP: the header toggle swaps the canvas to a 3-card Coder → Critic → Publisher flow — the picked writer shows as 'Coder' (its team lane name only applies in team mode) and solo card positions are separate from the team layout, so dragging in one never messes up the other.\n" +
    "COMMON ISSUES → FIX: (1) 🧠 button greyed = the project has NO folder; click it — it opens ⚙ Settings; set a Folder there, then 🧠 works. (2) The wrong agent acts as orchestrator = a renamed lead; keep 'orchestrator' in its name. (3) Telegram replies 'dispatch error codex CLI' = the orchestrator's model is Codex and it failed (rate-limited / not signed in) — set its model to a working one on its card. (4) Team empty after restart = roster edits on the canvas aren't persisted yet; assembling a team via Brainstorm DOES persist it.",
  code:
    "CODE — a single coding agent working in ONE project folder.\n" +
    "Runs isolated inside WSL when the green 'Isolated' badge shows. The chat + plan/Kanban + workspace persist when you switch tabs and come back. Paste images for the model to read. Set the folder + model at the top. Subscription CLIs (Claude Code, Codex) and cloud/local models all work.\n" +
    "• RIGHT COLUMN — RESIZABLE (drag its left edge; min 300px). TWO pages on tabs at the top — ⚡ SUPER USER: PROJECT RULES, the exact same rules editor the agentic team's Rules tab uses (must/prefer/avoid, auto-seeded with the native best-practice set; add/edit/delete + '↺ Restore best-practices'); they ride EVERY coder turn. If the folder is also an agentic project, rules + notebook are SHARED with the team pages ('shared with team' chip).\n" +
    "• 📓 NOTEBOOK tab: Working notes, a 📋 Kanban plan board (Now / Next / Later), a NEXT-STEPS list, and 🪄 Digest notes — pick its model right there (the same dropdown as everywhere; ✕ = back to the default). Digest reads the notebook once and proposes a board update + fewer, bigger implementation steps; there is no second prompt box. Saving the proposed plan clears the consumed notes. Feeding a step while the coder works = a ⚡ steer (injected between tool calls on local models); idle = a new turn. 'Auto-feed next step' walks the list by itself after each clean finish.\n" +
    "• BOTTOM of the column: USAGE first (VS Code-style quota bars for the account behind the picked model — Claude subscription today; plus the app's own recorded traffic for EVERY provider), then the agent MODE (📋 Plan = Kanban plan/act · ⚡ Auto = act directly · 💬 Chat = discuss only — read-only tools, no edits) which the composer's main button follows, 🌐 Browser = view/drive the agents' shared web browser (live page screenshot, open URLs, stop the daemon; logins persist), and 🖥 Terminal = a real shell in the workspace folder, floating above the app window (this app only) — DRAG its title bar to move it, — hides it (shell keeps running), ✕ ends it.\n" +
    "• Typing in the chat WHILE the coder works is never dropped — it queues as a ⚡ steer and is injected the same way.",
  chat:
    "CHAT (fine-tuning playground) — talk to local OR cloud models, with tools, in up to three columns side by side. Paste images. Subscription CLIs (Claude Code, Codex) work here too. Great for trying a model before wiring it into a team.",
  train:
    "TRAIN — fine-tune a model on your own data (LoRA/QLoRA).\n" +
    "Needs the fine-tuning ENVIRONMENT installed (the 'Environment' button). This is the ONLY thing the `env` readiness row gates — it is NOT needed for agents, Code, Chat, or serving. Pick a base model + dataset, set params, run; uses your selected GPU.",
  models:
    "MODELS — Browse / Downloaded / Tuned / Cache tabs.\n" +
    "• Browse: HuggingFace search + curated recommendations. A card's COLOUR means one thing: does it fit YOUR selected GPU's VRAM — 🟢 fits (inference + fine-tune), 🟡 tight, 🔴 too large. Filter checkboxes narrow by type (GGUF, Instruct, LoRA, Vision…); each card shows the lab that made it.\n" +
    "• Downloading a model ALSO auto-fetches its vision projector (mmproj) for image-capable models so local vision input works.\n" +
    "COMMON ISSUE → FIX: a local model 500s on a pasted image ('image input is not supported - provide the mmproj') = the projector isn't on disk; re-download that model (it backfills the projector), then restart the model.",
  server:
    "SERVER — start/stop the local llama.cpp model server.\n" +
    "It auto-starts when you send to a local model (no manual step). The server is SHARED across OwLLM windows — a second window reuses it instead of fighting over the port — and stops only when the LAST window closes. Vision models load their mmproj automatically. In the log, '/health poll gave up' is a benign readiness-probe timeout, NOT a crash, if the model is actually serving requests.",
  bridges:
    "BRIDGES — connect Telegram / WhatsApp / Discord / Slack / email to your agents.\n" +
    "Set the bot token + the PROJECT to route messages to, then Start. Only ONE OwLLM window polls a given bot at a time (a second one yields). Which project a chat routes to is shared across windows. In a chat you can use /project and /model commands; a new idea can spin up a brainstorm project.",
  info:
    "INFO — a live, honest system view: Application/version, Environment readiness, Hardware, GPU detail (live VRAM), Model-server state, your Models, plus the Sandbox-disk controls (Clear caches / Reclaim disk space) that moved here off Home.",
  accounts:
    "ACCOUNTS — connect models here: paste API keys (Anthropic, OpenAI, Gemini, …) and/or sign into subscription CLIs (Claude Code, Codex, Gemini, Kimi). Keys/secrets never sync off this device. A cloud or subscription agent needs the matching key/login on this page.\n" +
    "• OWLLM Node (🖥🔌 panel): opt-in KVM remote control — lets agents see + operate a REMOTE computer through a NanoKVM/PiKVM device (kvm_node tool: screenshot, type, keys, mouse, power, mount ISO). Ships DISABLED; flip the toggle here, then '+ Allow' each device host — injection is refused for any host not on the list (fail-closed), and every action is written to a redacted audit log.",
  mcp:
    "MCP — connect MCP servers so agents gain extra tools (filesystem, git, web, integrations). Add a server, it's verified, then its tools are available to the team.",
  devices:
    "DEVICES — OwLLM Remote Devices / Fleet Control. Securely control your OTHER OwLLM machines from this one.\n" +
    "• The KEY IDEA: controlling a machine needs a paired, cryptographic device key that the TARGET explicitly approved — a matching GitHub account only helps devices discover each other, it NEVER grants control. Ships DISABLED; flip the master toggle first.\n" +
    "• This device: an Ed25519 + X25519 keypair generated once per install (private keys are DPAPI-encrypted on this PC and NEVER synced). Editable name; the device ID is derived from the key. '🔬 Run secure self-test' seals→opens→runs a diagnostics command end-to-end to prove the crypto pipeline.\n" +
    "• Pairing: a controller sends a request → the target shows an UNMISTAKABLE approval prompt → approving grants read-only diagnostics only. Widen with the per-controller toggles (Shell / WSL / File writes / Admin). File writes & Admin are dangerous — they also need a per-action approval (not executable in v1). Revoke any time; revocation fails closed on the next request.\n" +
    "• Remote console (the magenta-bordered panel, deliberately UNLIKE the local terminal): pick a target + mode (Diagnostics / Shell / Run in WSL) and run. Every command is authenticated, authorized, timed-out, cancellable, and audited on BOTH sides (output is never stored raw — only a length + digest).\n" +
    "• Safety: while a remote command runs the target shows a red 'being controlled' banner with a 'Stop remote control' button (cancels every in-flight command).\n" +
    "• REACHING DEVICES OFF-LAN: control works across ANY network the two machines can route to each other on. On a Tailscale/WireGuard/VPN overlay it 'just works' (your overlay IP is auto-detected + published, NAT-traversed, no setup). Or set a Public endpoint (port-forward / DDNS / MagicDNS host:port) in Network & reachability. Or, for pure-NAT with no overlay, point both devices at a Relay you host (both dial OUT to it, so it works behind any NAT; the relay only ever sees ciphertext — host one via the 'Host a relay' toggle on an always-on box with a public URL/tunnel). The controller tries LAN → overlay → public → relay automatically.\n" +
    "• Transports: loopback (self-test), LAN/overlay direct, and relay — all carrying the same sealed frames. See docs/REMOTE_DEVICES.md.",
};

/// The guided "Help using the app" option list. Each topic shows a real,
/// app-accurate step-by-step. (Future: each gets a short animated walkthrough.)
const HELP_TOPICS: { key: string; label: string; steps: string }[] = [
  {
    key: "finetune",
    label: "🎓 Fine-tune a model",
    steps:
      "🎓 FINE-TUNE A MODEL (Train page)\n" +
      "1. Models page → download a base model (a 🟢 one that fits your GPU), or pick one you already have.\n" +
      "2. Train page → if the “Environment” button says it isn't installed, click it once to build the fine-tuning Python env. (This is the ONLY feature that needs that env — not agents, Code, Chat or serving.)\n" +
      "3. Choose your base model + a dataset (a .jsonl of examples).\n" +
      "4. Set the method (LoRA/QLoRA), epochs and learning rate — the defaults are sane.\n" +
      "5. Pick your GPU, then Start, and watch the loss fall in the log.\n" +
      "6. The result lands in Models → Tuned, ready to chat with or serve.",
  },
  {
    key: "local",
    label: "💻 Use a local model",
    steps:
      "💻 USE A LOCAL MODEL (private, offline)\n" +
      "1. Models page → Browse → download a GGUF. A card's colour tells you the fit: 🟢 fits your GPU, 🟡 tight, 🔴 too big.\n" +
      "2. To run it, just open Chat (or send to it from a team) — the model server auto-starts. You can also start it by hand on the Server page.\n" +
      "3. Chat page → pick the local model → talk. Vision models can read pasted images (their projector is fetched automatically on download).",
  },
  {
    key: "abliterate",
    label: "🚫 Abliterate a model",
    steps:
      "🚫 ABLITERATE A MODEL (strip refusals)\n" +
      "1. Models page → download the base model you want to uncensor (full transformers weights, not a GGUF).\n" +
      "2. Train page → scroll to the Abliterate section → the ℹ icon explains the recipe (FailSpy refusal-direction removal).\n" +
      "3. Pick that base model and Run. It writes a new copy to Models → Tuned named “<model>__abliterated”.\n" +
      "4. Optionally convert it to GGUF and serve it like any local model. (You'll be offered to reclaim the cached source weights afterward.)",
  },
  {
    key: "coder",
    label: "⌨️ Coding agent",
    steps:
      "⌨️ CODING AGENT (Code page)\n" +
      "1. Give it a brain: Accounts page → sign into Claude Code or Codex (subscription), or paste an API key — or run a local model.\n" +
      "2. Code page → set the project Folder at the top and pick the model.\n" +
      "3. For a sandbox, make sure the green “Isolated” badge shows — it runs inside WSL and can't touch the rest of your disk.\n" +
      "4. Type your task. It plans, edits files in that folder, and runs commands. The chat + plan persist when you switch tabs.",
  },
  {
    key: "agentic",
    label: "🧩 Agentic workflow",
    steps:
      "🧩 AGENTIC WORKFLOW (Agentic Team page)\n" +
      "1. Have at least one working model (Accounts for cloud/subscription, or a running local model).\n" +
      "2. Agents page → 📁 pick or “+ New” a project, then ⚙ set its Folder.\n" +
      "3. Design the team: 🧠 Brainstorm researches your idea and assembles a runnable team, or start from a template.\n" +
      "4. Type a goal → Run. The orchestrator leads and hands off to specialists along the arrows between the cards.\n" +
      "5. Optional: connect a Bridge (Telegram/WhatsApp/Discord/Slack/email) to drive the team by chat.",
  },
];


// Turn a raw model/CLI failure into ONE clean line for the user. A failed CLI
// (e.g. codex hitting a usage limit) throws an error whose message is the entire
// raw stdout — the session header, the persona prompt echoed back, the snapshot.
// Dumping that verbatim is the "trash in the chat" users saw. Here we (a) name
// the common, not-our-fault causes plainly, and (b) otherwise show only the
// first MEANINGFUL line, never the echoed prompt/CLI banner.
function cleanWatcherError(raw: unknown): string {
  const s = String((raw as { message?: string })?.message ?? raw ?? "").trim();
  const low = s.toLowerCase();
  if (low.includes("usage limit") || low.includes("quota") || low.includes("rate limit") || low.includes("429") || low.includes("insufficient_quota")) {
    return "⚠️ That model hit its usage limit — that's on the provider's side, not OwLLM. Pick a different model at the top of this panel (a local model, or another provider), then ask again.";
  }
  if (low.includes("not logged in") || low.includes("unauthorized") || low.includes("401") || (low.includes("auth") && low.includes("login"))) {
    return "⚠️ That model isn't signed in. Connect it on the Accounts page (or pick another model above), then try again.";
  }
  // Strip the codex/claude CLI banner + the echoed persona prompt + snapshot, and
  // surface the first line that's actually a message.
  const noise = /^(you are the watcher|---|workdir|model:|provider:|approval|sandbox:|reasoning|session id|user$|<stdin>|openai codex|reading additional input|key facts|•|current page|app snapshot|\{)/i;
  const meaningful = s.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !noise.test(l));
  return `That didn't work: ${(meaningful ?? s).slice(0, 240)}`;
}

export default function WatcherDrawer({
  open,
  onClose,
  mode,
  activeKey,
}: {
  open: boolean;
  onClose: () => void;
  mode: string;
  activeKey: string;
}) {
  const [entries, setEntries] = React.useState<Entry[]>([
    {
      from: "watcher",
      text: "I'm The Watcher — I can see how this app is doing and help you when something misbehaves. Everything I look at stays on this device.",
    },
  ]);
  const [busy, setBusy] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  // AI chat (Slice 5): free-text questions answered by an auto-chosen model.
  const [draft, setDraft] = React.useState("");
  const [models, setModels] = React.useState<ModelInfo[]>([]);
  const [accounts, setAccounts] = React.useState<AccountsStatusLite | null>(null);
  const [server, setServer] = React.useState<ServerStatusT | null>(null);
  // Cloud use needs one explicit confirmation (the question + snapshot
  // leave the device). Holds the pending question while we wait.
  const pendingCloud = React.useRef<string | null>(null);
  const historyRef = React.useRef<HistoryItem[]>([]);
  const abortRef = React.useRef<AbortController | null>(null);
  // ALL hooks live up here, before the `if (!open) return null` early
  // return — a hook below it changes the hook count between renders and
  // crashes React with error #310 (caught by the release smoke test).
  const lastCapture = React.useRef<WindowCapture | null>(null);
  // User-chosen model via the SHARED ModelPicker (same catalogue as every
  // other surface — local models, tuned, subscriptions, API keys, Auto).
  // Empty = the Watcher's default policy (running local first). Persisted.
  const [pickedModel, setPickedModel] = React.useState<string>(() => {
    try { return localStorage.getItem("owllm:watcher:model") ?? ""; } catch { return ""; }
  });
  const pickModel = (id: string) => {
    setPickedModel(id);
    try { localStorage.setItem("owllm:watcher:model", id); } catch { /* ignore */ }
  };
  // While capturing, the Watcher steps OUT of the shot (stays mounted,
  // visibility hidden) so the screenshot shows the app/bug BEHIND it.
  const [selfHidden, setSelfHidden] = React.useState(false);
  // Note composer for "Report this as a bug": the entry being reported (e.g. a
  // screenshot) and the user's own description. Without a note the report only
  // carries the auto-caption ("Here's the capture…"), which the team can't act
  // on — so clicking report opens this composer instead of sending blind.
  const [reportingEntry, setReportingEntry] = React.useState<Entry | null>(null);
  const [reportNote, setReportNote] = React.useState("");
  // Top-level navigation: the Watcher opens on a 1×2 "home" menu (Help vs
  // Report a bug); each choice drills into its own surface.
  const [view, setView] = React.useState<"home" | "help" | "bug">("home");

  // Always land on the home menu when the drawer (re)opens.
  React.useEffect(() => { if (open) setView("home"); }, [open]);

  // GitHub connection — bug reports are sent as GitHub issues, so reporting
  // needs a connected account. Checked when the drawer opens.
  const [ghConnected, setGhConnected] = React.useState<boolean | null>(null);
  const [ghLogin, setGhLogin] = React.useState<string | null>(null);
  const [ghDevice, setGhDevice] = React.useState<{ userCode: string; verificationUri: string } | null>(null);
  const [ghErr, setGhErr] = React.useState<string | null>(null);
  const [ghCopied, setGhCopied] = React.useState(false);
  const ghPollAlive = React.useRef(false);
  React.useEffect(() => {
    if (!open) { ghPollAlive.current = false; return; }
    const load = () => { githubStatus().then((s) => { setGhConnected(s.connected); setGhLogin(s.login); }).catch(() => setGhConnected(false)); };
    load();
    // Reflect an immediate connect/disconnect from another surface while the
    // drawer is open, instead of waiting for window focus.
    window.addEventListener(GITHUB_CHANGED_EVENT, load);
    return () => { ghPollAlive.current = false; window.removeEventListener(GITHUB_CHANGED_EVENT, load); };
  }, [open]);
  // Device Flow: get a code, open github.com/login/device (where the user signs
  // in OR creates a free account), poll until authorized. No token to paste.
  const connectGithub = async () => {
    setGhErr(null);
    try {
      const d = await githubDeviceStart();
      setGhDevice({ userCode: d.userCode, verificationUri: d.verificationUri });
      try { await navigator.clipboard?.writeText(d.userCode); } catch { /* ok */ }
      openExternal(d.verificationUri);
      ghPollAlive.current = true;
      const poll = async () => {
        if (!ghPollAlive.current) return;
        let r;
        try { r = await githubDevicePoll(d.deviceCode); }
        catch (e) { setGhErr(String(e)); setGhDevice(null); ghPollAlive.current = false; return; }
        if (!ghPollAlive.current) return;
        if (r.status === "authorized") { ghPollAlive.current = false; setGhDevice(null); setGhConnected(true); setGhLogin(r.login); return; }
        if (r.status === "denied" || r.status === "expired" || r.status === "error") {
          ghPollAlive.current = false; setGhDevice(null);
          setGhErr(r.detail || (r.status === "expired" ? "The code expired — sign in again." : r.status === "denied" ? "Authorization was declined." : "Sign-in failed."));
          return;
        }
        setTimeout(poll, (r.status === "slowDown" ? d.interval + 5 : d.interval) * 1000);
      };
      setTimeout(poll, d.interval * 1000);
    } catch (e) { setGhErr(String(e)); }
  };

  React.useEffect(() => {
    if (!open) return;
    invoke<ModelInfo[]>("list_models").then((m) => setModels(Array.isArray(m) ? m : [])).catch(() => {});
    invoke<AccountsStatusLite>("accounts_status").then(setAccounts).catch(() => {});
    invoke<ServerStatusT>("server_status").then(setServer).catch(() => {});
    return () => { abortRef.current?.abort(); };
  }, [open]);

  /// Resolve which model answers. An EXPLICIT user pick (shared ModelPicker)
  /// wins; otherwise the default policy: a running local model first (private
  /// + free), else the first available cloud entry (subscription before API
  /// key), else say what's missing. Never silently cloud.
  const chooseModel = (): ModelChoice => {
    const entries = buildEntries(models, accounts);
    // 1) Explicit user choice from the picker.
    if (pickedModel) {
      const prov = providerFor(pickedModel, models);
      const entry = entries.find((e) => e.id === pickedModel);
      const label = entry?.label ?? pickedModel;
      if (prov === "local" || prov === "tuned") {
        if (server?.running && server.model_id) {
          return { kind: "local", modelId: server.model_id, port: server.port ?? 0, label: `${server.model_id} (local)` };
        }
        return { kind: "local-cold", label };
      }
      // Cloud / subscription / API: if its account ISN'T connected, say so instead
      // of attempting a chat that just 401s. The default policy below already
      // filters to available accounts; the explicit pick must too (this is the
      // "chat with a not-registered account bugs out" fix).
      if (entry && !entry.available) {
        return { kind: "cloud-unavailable", provider: prov, label };
      }
      // explicitly chosen + connected ⇒ pre-consented.
      return { kind: "cloud", modelId: pickedModel, provider: prov, label, preconsented: true };
    }
    // 2) Default policy.
    if (server?.running && server.model_id) {
      return {
        kind: "local",
        modelId: server.model_id,
        port: server.port ?? 0,
        label: `${server.model_id} (local — private, free)`,
      };
    }
    const cloud =
      entries.find((e) => e.available && e.variant === "sub") ??
      entries.find((e) => e.available && e.variant === "api");
    if (cloud) {
      return {
        kind: "cloud",
        modelId: cloud.id,
        provider: providerFor(cloud.id, models),
        label: cloud.label,
      };
    }
    const localExists = entries.some((e) => e.available && (e.section === "local" || e.section === "tuned"));
    if (localExists) return { kind: "local-cold", label: "a local model (server not running)" };
    return { kind: "none" };
  };

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const say = (text: string, from: Entry["from"] = "watcher", imageDataUrl?: string) =>
    setEntries((es) => [...es, { from, text, imageDataUrl }]);


  // ONE-CLICK report of a specific Watcher message (the screenshot, the
  // "Check my setup" result, a diagnosis…) AS a bug. Packages that exact
  // content + the live diagnostics + any screenshot, redacts, and sends
  // straight to the OwLLM team's GitHub intake. No typing, no second screen.
  const reportEntry = async (entry: Entry, note?: string) => {
    if (busy) return;
    setBusy(true);
    // The user's own description (from the note composer) is what the team
    // reads first; the entry text (e.g. a screenshot caption) is just context.
    const userNote = (note ?? "").trim();
    say(userNote ? `🐞 Bug report: ${userNote}` : "Report this as a bug", "you");
    const reportedMessage = userNote
      ? `${userNote}\n\n— captured view: ${entry.text}`
      : entry.text;
    const PNG_PREFIX = "data:image/png;base64,";
    const pngFromEntry = entry.imageDataUrl?.startsWith(PNG_PREFIX)
      ? entry.imageDataUrl.slice(PNG_PREFIX.length)
      : (lastCapture.current?.pngBase64 ?? null);
    try {
      const snapshot = await invoke<SupportSnapshot>("support_snapshot").catch(() => null);
      const bundle = {
        kind: "owllm-bug-report",
        createdAt: new Date().toISOString(),
        appVersion: snapshot?.appVersion ?? "?",
        page: { activeKey, mode },
        userNote: userNote || null,
        reportedMessage,
        hasScreenshot: pngFromEntry != null,
        snapshot,
        activity: getActivity(),
      };
      const json = redactForReport(JSON.stringify(bundle, null, 2));
      const titleSrc = userNote || entry.text;
      const firstLine = (titleSrc.split("\n").find((l) => l.trim()) || "In-app bug report").trim();
      const title = firstLine.length > 70 ? firstLine.slice(0, 70) + "…" : firstLine;
      const body =
        "**Reported from The Watcher.**\n\n" +
        (userNote ? `**What the user reported:**\n\n${redactForReport(userNote)}\n\n` : "") +
        "_Captured view:_ " + redactForReport(entry.text).slice(0, 600) +
        "\n\n---\n<details><summary>diagnostics snapshot</summary>\n\n```json\n" + json + "\n```\n</details>";
      const sent = await invoke<{ issueUrl: string; bundleUrl: string }>("support_send_report", {
        title, bodyMd: body, reportJson: json, pngBase64: pngFromEntry,
      });
      say(`✅ Sent to the OwLLM team — they (and the AI fixer) can see it here:\n${sent.issueUrl}`);
    } catch (e) {
      // GitHub not connected / network → refresh the connection state (so the
      // "Connect GitHub" step shows next time) and save locally so it isn't lost.
      void githubStatus().then((s) => { setGhConnected(s.connected); setGhLogin(s.login); }).catch(() => setGhConnected(false));
      try {
        const dir = await invoke<string>("support_export_report", {
          reportJson: redactForReport(JSON.stringify({ userNote: userNote || null, reportedMessage }, null, 2)),
          pngBase64: pngFromEntry,
        });
        say(`Couldn't send it directly (${e}).\n\nMost likely GitHub isn't connected — click "Report a bug" again and I'll walk you through connecting it (free, one-time). I saved a copy locally meanwhile:\n${dir}`);
      } catch (e2) {
        say(`Couldn't send the report (${e}) and the local fallback also failed (${e2}).`);
      }
    } finally {
      setBusy(false);
    }
  };

  /// Free-text AI support: snapshot as grounding, auto-chosen model,
  /// explicit consent before any cloud use, streamed reply. An optional
  /// screenshot (base64 PNG) is shown in the chat AND handed to the model
  /// so a vision model can actually read the screen ("Screenshot and ask").
  const ask = async (raw?: string, imageB64?: string | null) => {
    const typed = (raw ?? draft).trim();
    const text = typed || (imageB64 ? "Here's my screen — what do you see, and what should I do?" : "");
    if (!text || busy) return;
    setDraft("");
    say(text, "you", imageB64 ? `data:image/png;base64,${imageB64}` : undefined);
    const choice = chooseModel();
    if (choice.kind === "none") {
      say(
        "You don't have a usable model yet — no local model is downloaded and no cloud account/key is connected. " +
        "The quickest fix: a tiny support model like Gemma 3 1B (Q4, under 1 GB) runs on almost anything. " +
        "Open the Models page (📦 button below) to download one, or connect an account on the Accounts page.",
      );
      return;
    }
    if (choice.kind === "local-cold") {
      say(
        "You have local models, but the model server isn't running — start one on the Server page and ask me again. " +
        "(I only use what's already running; I won't load gigabytes into your GPU unannounced.)",
      );
      return;
    }
    if (choice.kind === "cloud-unavailable") {
      say(
        `${choice.label} isn't connected on this device, so I can't chat with it. Open the Accounts page (🔐 below) and ` +
        `connect ${choice.provider} (sign in, or paste an API key), then ask me again — or pick a local / already-connected model below.`,
      );
      return;
    }
    // Cloud egress needs one confirmation — UNLESS the user explicitly
    // picked this cloud model in the dropdown (that pick IS the consent).
    if (choice.kind === "cloud" && !choice.preconsented && pendingCloud.current !== text) {
      pendingCloud.current = text;
      say(
        `No local model is running, so I'd use ${choice.label} — a CLOUD model: your question and the app snapshot ` +
        "would leave this device. Press Send again (or Enter) to confirm, or pick a model below / start a local one.",
      );
      setDraft(text);
      return;
    }
    pendingCloud.current = null;
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    say(`(answering with ${choice.label})`);
    let acc = "";
    // Stream into a dedicated live tail entry, replaced in place per delta.
    const onDelta = (d: string) => {
      acc += d;
      setEntries((es) => {
        const copy = [...es];
        const tail = copy[copy.length - 1] as (Entry & { _live?: boolean }) | undefined;
        if (tail?._live) {
          copy[copy.length - 1] = { ...tail, text: acc };
        } else {
          copy.push({ from: "watcher", text: acc, _live: true } as Entry);
        }
        return copy;
      });
    };
    try {
      const snapshot = await invoke<SupportSnapshot>("support_snapshot").catch(() => null);
      const pageDoc = PAGE_DOCS[activeKey] ?? PAGE_BLURBS[activeKey] ?? `the "${activeKey}" page (mode ${mode}).`;
      const pageIndex = Object.entries(PAGE_BLURBS).map(([k, v]) => `- ${k}: ${v}`).join("\n");
      const system =
        `${WATCHER_PERSONA}\n\n` +
        `=== DOCS: CURRENT PAGE (${activeKey}, mode ${mode}) — what the user is looking at ===\n${pageDoc}\n\n` +
        `=== OTHER PAGES (so you can point them to the right place) ===\n${pageIndex}\n\n` +
        `=== APP SNAPSHOT (live state) ===\n${JSON.stringify(snapshot)}`;
      let reply: string;
      if (choice.kind === "local") {
        // Local vision models read the screenshot via an OpenAI multimodal
        // parts array; text-only when there's no image.
        const userContent = imageB64
          ? [
              { type: "text", text },
              { type: "image_url", image_url: { url: `data:image/png;base64,${imageB64}` } },
            ]
          : text;
        reply = await streamLocalChat({
          port: choice.port,
          modelId: choice.modelId,
          systemPrompt: system,
          userContent,
          temperature: 0.3,
          signal: ctrl.signal,
          onDelta,
          history: historyRef.current,
          allowedTools: [], // support chat reads the snapshot; no tools
        });
      } else {
        // Cloud/subscription: the screenshot rides as a native image attachment.
        const attachments: Attachment[] | undefined = imageB64
          ? [{ kind: "image", mime: "image/png", data_b64: imageB64 }]
          : undefined;
        reply = await streamChatCompletion(
          0, choice.modelId, choice.provider, system, text, 0.3, ctrl.signal,
          onDelta, undefined, historyRef.current, false,
          undefined, undefined, attachments,
        );
      }
      historyRef.current = [
        ...historyRef.current,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: reply },
      ].slice(-12);
      // Finalize the streamed tail.
      setEntries((es) => es.map((e) => {
        const { _live, ...rest } = e as Entry & { _live?: boolean };
        void _live;
        return rest as Entry;
      }));
    } catch (e: any) {
      // Never dump the raw CLI output (it echoes the persona prompt + snapshot —
      // the "trash" users reported); show one clean, honest line instead.
      if (e?.name !== "AbortError") say(cleanWatcherError(e));
    } finally {
      setBusy(false);
    }
  };

  // ── Home → Help: pick a model, get guided walkthroughs, screenshot+ask ──
  const enterHelp = () => {
    historyRef.current = [];
    setReportingEntry(null);
    setEntries([{
      from: "watcher",
      text: "What do you need help with? Pick a topic below for a step-by-step — or take a screenshot and ask me anything about what's on your screen.",
    }]);
    setView("help");
  };

  const showTopic = (t: { label: string; steps: string }) => {
    if (busy) return;
    say(t.label, "you");
    say(`${t.steps}\n\n🎬 A short animated walkthrough of this will land here in a future update.`);
  };

  // Capture the app window, then hand it + the user's question to the model.
  const screenshotAndAsk = async () => {
    if (busy) return;
    setSelfHidden(true);
    let png: string | null = null;
    try {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      await new Promise((r) => setTimeout(r, 180));
      const c = await invoke<WindowCapture>("support_capture_window");
      lastCapture.current = c;
      png = c.pngBase64;
    } catch (e) {
      setSelfHidden(false);
      say(`I couldn't capture the window: ${e}`);
      return;
    }
    setSelfHidden(false);
    await ask(draft.trim() || undefined, png);
  };

  // ── Home → Report a bug: auto-screenshot, then open the description box ──
  const startBugReport = async () => {
    historyRef.current = [];
    setReportNote("");
    setView("bug");
    setBusy(true);
    setSelfHidden(true);
    try {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      await new Promise((r) => setTimeout(r, 180));
      const c = await invoke<WindowCapture>("support_capture_window");
      lastCapture.current = c;
      setSelfHidden(false);
      const shot: Entry = {
        from: "watcher",
        text: `📸 Screenshot captured (${c.width}×${c.height}). Describe what went wrong below — what you did, what you expected, what happened — then send it to the OwLLM team.`,
        imageDataUrl: `data:image/png;base64,${c.pngBase64}`,
      };
      setEntries([shot]);
      setReportingEntry(shot);
    } catch (e) {
      setSelfHidden(false);
      const noShot: Entry = { from: "watcher", text: `I couldn't grab a screenshot (${e}), but you can still describe the bug below and send it.` };
      setEntries([noShot]);
      setReportingEntry(noShot);
    } finally {
      setBusy(false);
    }
  };

  const goHome = () => { setReportingEntry(null); setView("home"); };

  const actionBtn: React.CSSProperties = {
    padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)", color: "var(--fg-strong)", fontSize: 12.5,
    fontWeight: 700, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
  };
  const homeCard: React.CSSProperties = {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: 10, padding: "30px 16px", borderRadius: 14, textAlign: "center", minHeight: 170,
    border: "1px solid rgba(var(--accent-rgb),0.45)", background: "var(--bg-card)",
    color: "var(--fg-strong)", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
  };
  const topicBtn: React.CSSProperties = {
    padding: "6px 11px", borderRadius: 999, border: "1px solid rgba(var(--accent-rgb),0.40)",
    background: "rgba(var(--accent-rgb),0.10)", color: "var(--accent)", fontSize: 12,
    fontWeight: 700, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9600, background: "rgba(0,0,0,0.45)",
        // During a capture we vanish (but stay mounted) so the screenshot
        // shows the app/bug behind us, not this drawer.
        visibility: selfHidden ? "hidden" : "visible",
        // Flex-center the drawer WITHOUT a transform — a transformed
        // ancestor would make the ModelPicker's position:fixed popover
        // anchor to the drawer (and get clipped by its overflow:hidden)
        // instead of the screen. That was the hidden/misaligned dropdown.
        display: "flex", justifyContent: "center", alignItems: "flex-start",
      }}
    >
      <style>{`
        @keyframes owllm-watcher-in { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      <div style={{
        marginTop: 64,
        width: "min(560px, 92%)", maxHeight: "min(620px, 82%)",
        background: "var(--bg-panel)", border: "2px solid rgba(var(--accent-rgb),0.78)",
        borderRadius: 14, boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        animation: "owllm-watcher-in 200ms ease-out",
      }}>
        <div style={{
          height: 50, background: "var(--bg-header)", color: "var(--bg-header-fg)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: "0 16px", position: "relative",
          borderBottom: "1px solid rgba(var(--accent-rgb),0.30)",
        }}>
          {view !== "home" && (
            <button
              onClick={goHome}
              title="Back to menu"
              style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", gap: 4, height: 26, padding: "0 10px", border: "1px solid rgba(255,255,255,0.45)", background: "rgba(255,255,255,0.18)", color: "var(--bg-header-fg)", fontSize: 13, fontWeight: 800, cursor: "pointer", borderRadius: 6 }}
            >← Back</button>
          )}
          <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: 0.4, lineHeight: 1.1 }}>The Watcher</div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            {view === "help" ? "help using the app" : view === "bug" ? "report a bug" : "local support assistant"}
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{ position: "absolute", right: 16, top: "50%", transform: "translateY(-50%)", width: 32, height: 24, border: "none", background: "rgba(244,67,54,0.18)", color: "#ff8080", fontSize: 13, cursor: "pointer", borderRadius: 5 }}
          >✕</button>
        </div>

        {view === "home" ? (
          /* Landing menu — the 1×2 table: Help using the app · Report a bug. */
          <div style={{ padding: 22, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "stretch" }}>
            <button style={homeCard} disabled={busy} onClick={enterHelp}>
              <div style={{ height: 32, display: "flex", alignItems: "center" }}><LifeRingIcon /></div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>Help using the app</div>
              <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.4 }}>
                Pick a model, get guided walkthroughs, or screenshot your screen and ask.
              </div>
            </button>
            <button style={homeCard} disabled={busy} onClick={startBugReport}>
              <div style={{ height: 32, display: "flex", alignItems: "center" }}><BugIcon /></div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>Report a bug</div>
              <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.4 }}>
                Grabs a screenshot automatically and opens a box to describe the issue.
              </div>
            </button>
          </div>
        ) : (
          <>
            <div ref={listRef} style={{ flex: 1, overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              {entries.map((e, i) => (
                <div key={i} style={{
                  alignSelf: e.from === "you" ? "flex-end" : "flex-start",
                  maxWidth: "88%", padding: "8px 12px", borderRadius: 10,
                  whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.55,
                  background: e.from === "you" ? "rgba(var(--accent-rgb),0.16)" : "var(--bg-card)",
                  border: `1px solid ${e.from === "you" ? "rgba(var(--accent-rgb),0.4)" : "var(--border)"}`,
                  color: "var(--fg)",
                }}>
                  {e.text}
                  {e.imageDataUrl && (
                    <img
                      src={e.imageDataUrl}
                      alt="app capture preview"
                      style={{ display: "block", marginTop: 8, maxWidth: "100%", borderRadius: 8, border: "1px solid var(--border-strong)" }}
                    />
                  )}
                  {/* One-click: report THIS message (a diagnosis / screenshot)
                      as a bug. Only in the Help view — the bug view already IS
                      a report. Skips the greeting, status lines, the live tail. */}
                  {view === "help" && e.from === "watcher" && i > 0 && !(e as Entry & { _live?: boolean })._live
                    && !e.text.startsWith("(") && !e.text.startsWith("✅") && !e.text.startsWith("Report this")
                    && (e.imageDataUrl || e.text.trim().length > 20) && (
                    <button
                      onClick={() => { setReportingEntry(e); setReportNote(""); }}
                      disabled={busy}
                      title="Describe what's wrong, then send this view + diagnostics + any screenshot to the OwLLM team."
                      style={{
                        marginTop: 9, display: "inline-flex", alignItems: "center", gap: 5,
                        padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 800,
                        border: "1px solid rgba(var(--accent-rgb),0.45)",
                        background: "rgba(var(--accent-rgb),0.10)",
                        color: "var(--accent)", cursor: busy ? "wait" : "pointer",
                      }}
                    >🐞 Report this as a bug</button>
                  )}
                </div>
              ))}
            </div>

            {/* Note composer — the description box. In the bug view it opens
                automatically (with the auto-screenshot attached); in the help
                view it opens when "Report this as a bug" is clicked. */}
            {reportingEntry && (
              <div style={{
                margin: "0 14px", padding: 12, borderRadius: 10,
                background: "var(--bg-elevated)", border: "1px solid rgba(var(--accent-rgb),0.45)",
                display: "flex", flexDirection: "column", gap: 8,
              }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--fg-strong)" }}>
                  Describe the bug {reportingEntry.imageDataUrl ? "(screenshot attached 📸)" : ""}
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.4 }}>
                  What did you do, what did you expect, what happened? This is what the team reads first.
                </div>
                <textarea
                  value={reportNote}
                  onChange={(e) => setReportNote(e.target.value)}
                  autoFocus
                  rows={3}
                  placeholder="e.g. Agents won't run isolated even though WSL is ready — it tells me to install the training env, which makes no sense."
                  style={{
                    resize: "vertical", minHeight: 56, borderRadius: 8, padding: "8px 10px",
                    fontSize: 12.5, fontFamily: "inherit",
                    background: "var(--bg-input)", color: "var(--fg-strong)", border: "1px solid var(--border)",
                  }}
                />
                {ghConnected === false && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: 10, borderRadius: 8, background: "rgba(122,162,255,0.08)", border: "1px solid rgba(122,162,255,0.35)" }}>
                    <div style={{ fontSize: 11.5, color: "var(--fg-strong)", lineHeight: 1.45 }}>
                      🔗 <b>Connect GitHub to send</b> — reports go to the OwLLM team as GitHub issues, so you need a (free) GitHub account connected. One time, then it's one click from any PC you sign in on.
                    </div>
                    {ghDevice ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11.5, color: "var(--fg-muted)" }}>
                        <div>1. We opened <b>github.com/login/device</b> — copy this code and paste it there:</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <code style={{ fontSize: 15, fontWeight: 800, letterSpacing: 2, color: "var(--fg-strong)", background: "var(--bg-input)", padding: "3px 10px", borderRadius: 6, userSelect: "text", WebkitUserSelect: "text", cursor: "text" }}>{ghDevice.userCode}</code>
                          <button style={actionBtn} title="Copy the code" onClick={() => { setGhCopied(false); navigator.clipboard?.writeText(ghDevice.userCode).then(() => setGhCopied(true)).catch(() => {}); }}>{ghCopied ? "✓ Copied" : "📋 Copy"}</button>
                          <button style={actionBtn} onClick={() => openExternal(ghDevice.verificationUri)}>Open page</button>
                        </div>
                        <div>2. Sign in (or <b>create a free account</b>) and paste the code. Waiting for you…</div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <button
                          style={{ ...actionBtn, background: "#24292f", color: "#fff", border: "1px solid #444", fontWeight: 700, alignSelf: "flex-start" }}
                          onClick={connectGithub}
                        >🔗 Sign in with GitHub</button>
                        <div style={{ fontSize: 10.5, color: "var(--fg-subtle)", lineHeight: 1.4 }}>
                          No account yet? The sign-in page lets you create one free in a minute — come back here and it connects automatically. (Or <span onClick={() => openExternal(GITHUB_TOKEN_URL)} style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}>create a token</span> and paste it on the Home page.)
                        </div>
                      </div>
                    )}
                    {ghErr && <div style={{ fontSize: 11, color: "#ff8c8c" }}>{ghErr}</div>}
                  </div>
                )}
                {ghConnected === true && ghLogin && (
                  <div style={{ fontSize: 11, color: "#7ff0c5" }}>✓ GitHub connected as {ghLogin} — ready to send.</div>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    style={{ ...actionBtn, background: "linear-gradient(180deg, #7ff0c5, #2bbf8a)", color: "#04231a", fontWeight: 800, opacity: (busy || !reportNote.trim() || ghConnected === false) ? 0.5 : 1 }}
                    disabled={busy || !reportNote.trim() || ghConnected === false}
                    onClick={async () => { const ent = reportingEntry; const note = reportNote; setReportingEntry(null); setReportNote(""); await reportEntry(ent, note); }}
                    title={ghConnected === false ? "Connect GitHub above first." : "Send your description + this view + diagnostics + any screenshot to the OwLLM team."}
                  >📤 Send report</button>
                  <button style={actionBtn} disabled={busy} onClick={() => { setReportNote(""); if (view === "bug") goHome(); else setReportingEntry(null); }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Help view: the option list + model picker + ask input + the
                single "Screenshot & ask" button. */}
            {view === "help" && (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "2px 14px 0" }}>
                  {HELP_TOPICS.map((t) => (
                    <button key={t.key} style={topicBtn} disabled={busy} onClick={() => showTopic(t)}>{t.label}</button>
                  ))}
                </div>

                {/* Model selector — the SAME shared ModelPicker every other
                    surface uses; "Auto" falls back to running-local-first. */}
                <div style={{ display: "flex", gap: 8, padding: "8px 14px 0", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--fg-muted)", fontWeight: 700, whiteSpace: "nowrap" }}>Model</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <ModelPicker
                      value={pickedModel}
                      onChange={pickModel}
                      models={models}
                      status={accounts}
                      placeholder="Auto (running local first)"
                      fallbackLabel="⚡ Auto (running local first)"
                    />
                  </div>
                  {pickedModel && (
                    <button
                      onClick={() => pickModel("")}
                      title="Back to automatic model choice"
                      style={{ ...actionBtn, padding: "5px 9px", fontSize: 11 }}
                    >Auto</button>
                  )}
                </div>

                {/* Ask input (Enter sends text) + the one action button:
                    Screenshot & ask (captures the app, then asks with it). */}
                <div style={{ display: "flex", gap: 8, padding: "8px 14px 12px", alignItems: "center" }}>
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !busy) ask(); }}
                    placeholder="Ask me anything about the app — what broke, what a page does, what to try…"
                    disabled={busy}
                    style={{
                      flex: 1, height: 34, borderRadius: 8, padding: "0 12px", fontSize: 12.5,
                      background: "var(--bg-input)", color: "var(--fg-strong)", border: "1px solid var(--border)",
                    }}
                  />
                  <button
                    style={actionBtn}
                    disabled={busy}
                    onClick={screenshotAndAsk}
                    title="Capture this app window and ask the model about what's on screen."
                  >{busy ? "⏳" : "📸 Screenshot & ask"}</button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
