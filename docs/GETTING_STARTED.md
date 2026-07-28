# Getting started with OwLLM

New here? This is the short path from a fresh install to a working AI agent team.
The whole idea of OwLLM: **agents that actually do things on your machine** — write
code, run tools, research, talk to you on your phone — using either your AI
subscription or a model running locally on your own hardware.

---

## Step 1 — Give your agents a brain (a model)

Agents need a model to think with. You have two ways, and you can mix them:

### Option A — Connect a subscription (easiest, no GPU needed)
Use an AI plan you already pay for. On the **Accounts** page, connect any of:
- **Claude** (Anthropic) — Claude Code / API
- **OpenAI** (GPT / Codex)
- **Google Gemini**
- **Kimi (Moonshot)**

Click **Test** after connecting so the app confirms it works. That's it — your
agents can now think. Nothing runs on your hardware; it uses the provider.

### Option B — Run a local model (private, offline, free)
Runs entirely on your own machine — nothing leaves your computer.
1. **Models** page → download a GGUF model (start small if your GPU is modest —
   a Gemma-class model under ~4 GB runs almost anywhere; bigger models need more VRAM).
2. **Server** page → start the local model server (llama.cpp).
3. Your agents now use that local model.

> A subscription is the fastest way to get going. A local model is best for
> privacy / offline / no-API-cost. Many people set up both and switch per task.

---

## Step 2 — (Recommended) Turn on isolation

So agents run **sandboxed in Linux (WSL)** and can't touch your Windows files:
- **Home** page → if the WSL row isn't green, click **Set up WSL** (one click;
  it installs Ubuntu — no reboot if WSL is already present).
- When you open a project for agents, use **🛡 Isolate** so it runs inside the
  sandbox. Your GitHub / CLI logins are mirrored in automatically.

Without isolation, agents still run, but on the host with a write-guard only.
Use **🔍 Verify** on the Agents page any time to confirm where they actually run.

---

## Step 3 — Run a team

1. **Agents** page → choose or point at a project folder.
2. Pick a team (or build your own in **Studio**).
3. Type a goal in plain language.
4. **Run** — the orchestrator plans, dispatches specialists, and reports back.

---

## Step 4 — (Optional) Drive it from your phone

**Bridges** page → connect Telegram, Discord, Slack, email, WhatsApp, or LINE and
message your agent team from anywhere.

---

## Stuck?

- Click the **🦉 owl (The Watcher)** at the top of the window → **🩺 Check my setup**.
  It reads your real state (WSL, GPU, model server, environment) and tells you
  exactly what's missing and how to fix it.
- Found a bug? The Watcher's **Report this as a bug** sends a redacted report
  (with your note + a screenshot) straight to the team.
