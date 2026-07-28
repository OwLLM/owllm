# OwLLM Desktop

**A local-first AI workstation: run LLMs on your own hardware, orchestrate multi-agent teams, and keep the dangerous parts sandboxed — with one feature nobody else has: split the model and the agents across machines.**

OwLLM runs `llama.cpp` GGUF models on your GPU, lets you design and run **multi-agent teams** that actually use tools (read/write files, run shell, search the web, call MCP servers), and treats cloud models (Claude / GPT / Gemini) as first-class peers when you add a key. Rust owns the runtime (model lifecycle, hardware, tool execution); React owns the UI.

---

## Why OwLLM is different

### 🛰 Split the brains from the GPU — run agents anywhere, model on your rig
This is the headline. An agent's "thinking" and its **tools** (shell, files, git, web, MCP) are decoupled from the **model server** over a plain OpenAI-compatible HTTP API. So you can:

- Run the **GPU model server on your Windows machine** (fast native CUDA — no porting, no VM), and
- Run the **agents somewhere safer/cheaper** — a Linux box, a WSL sandbox, or another PC — pointing them at your model over the network.

You get the speed of native GPU inference **and** the isolation of running autonomous agents off your main system. Set it in two clicks: **Server → "Serve inference on the network"** (opt-in, key-required) on the GPU box, and **Server → "Inference source → Remote"** on the agent box. *No one ships this cleanly.*

> Default is loopback-only and unauthenticated-disabled — turning on network serving generates a key and binds the port; it's plain HTTP, so it's meant for a trusted LAN or a VPN/SSH tunnel, never the open internet.

### 🛡 True OS-level isolation: agents run inside Linux, not on your PC
Autonomous agents that edit files and run shell commands are powerful and risky — and **every tool-using surface has this risk**: the Code page, the agentic teams, *and* the fine-tuning chat (chats use tools too). OwLLM's answer is real OS-level isolation, not just guard rails:

- **🐧 Real Linux sandbox.** Flip on isolation and every tool a model runs — `shell`, file writes, edits, `grep`, **and the cloud subscription CLIs (Claude/Codex/Gemini/Kimi)** — executes **inside a Linux sandbox**, in a project that lives in the sandbox filesystem (`~/owllm/<project>`). A model that decides to `rm -rf` or write outside the project **physically cannot reach your real drive or home.** The desktop app, your GPU model server, and fine-tuning stay native and fast; only the dangerous *tool execution* is sandboxed. A header badge shows **🛡 Isolated** vs **⚠ Not isolated** at all times.
- **One engine per OS, same isolation:**
  - **Windows → WSL2** *(shipping)* — a real Linux VM. Tools run inside Ubuntu; nothing touches `C:`.
  - **macOS → Lima** *(beta)* — a lightweight Linux VM on Apple's Virtualization.framework, the same VM-grade boundary as WSL.
  - **Linux → bubblewrap** *(beta)* — namespace sandbox with a private filesystem view + a dedicated sandbox-home, so the rest of `~` (`~/.ssh`, `~/.aws`) is invisible.
- **On by default, zero setup.** With a sandbox engine present, **new projects are isolated automatically** and the in-sandbox toolchain (node, uv, git, the agent CLIs, `gh`) installs itself in the background — no manual step. On a PC without WSL, one-click `wsl --install`.
- **🔑 Your logins come with you.** Every provider login is mirrored into the sandbox automatically — the subscription CLIs (**Claude/Codex/Gemini/Kimi**) *and* every API key (OpenAI, Anthropic, Moonshot, DeepSeek, xAI, Groq, Perplexity, Mistral, Together, Gemini, HF). Isolated cloud agents are authenticated with zero extra steps; the **Accounts** page tests each provider on **both** the host **and** inside the sandbox so you can see exactly what an isolated agent can use.
- **🐙 Connect GitHub.** Because the agents run *inside* the sandbox, your host git credentials don't reach them — so OwLLM writes your connected GitHub token into the **sandbox's** git + `gh` credential store. Isolated agents clone private repos and push commits, with nothing leaking to the host.
- **Convert any time.** Flip a project **isolated ↔ not** from the header — OwLLM copies it across the boundary and reopens the copy; the original stays put.
- **Graceful fallback.** No sandbox engine present (locked-down PC, virtualization off)? The app stays fully usable on the host with the guard rails below and a loud "not isolated" warning — your call.

And the guard rails apply on the host path too:

- **Write path-jail** — writes are confined to the workspace (worktree/project, temp, app scratch). A write to `C:\Windows` or your Documents is refused.
- **Catastrophic-command block** — never-legitimate commands (wipe root/home, format a disk, fork bomb, registry delete, remote-download-piped-to-shell) are stopped; normal scoped work is untouched.
- **Worktree isolation** — every agent in a team runs in its **own git worktree on its own branch**, so parallel agents never clobber each other; results merge back with conflict detection.

> **Strength tiers:** WSL2 and Lima are real VMs (separate kernel + filesystem) — the strong tier. bubblewrap shares the host kernel but gives a private filesystem view. macOS/Linux engines are **beta** (compile-verified per-OS; runtime hardening in progress); Windows/WSL is the proven path.

### 🧩 Native GGUF tool-calling + web search that just works
Tool-calling uses the model's **own chat template** (`llama-server --jinja` → native `tools` array → structured `delta.tool_calls`) — **no XML hacks, no dialect parsing**. MCP servers (filesystem, search, GitHub, etc.) auto-start, with a **master on/off switch**, **per-tool toggles**, and a **schema-safety gate** so one malformed MCP schema can't break tool-calling for everything. **Web search works out of the box** — on first run OwLLM auto-installs the **keyless DuckDuckGo** search server (no API key, no credit card); it's engine-agnostic, so any search MCP you add is used automatically.

### ☁️ Cloud models as first-class peers — with live streaming
Mix local and cloud freely in one team: Anthropic/OpenAI/Gemini **APIs** (just add a key) or **subscription CLIs** (Claude Code, Codex, Gemini) — all routed by the same dispatcher, all running wherever the agent backend runs. Subscription agents **stream their activity live** (reasoning, commands, tool calls, web searches) instead of going dark until the end.

### 🧠 Memory that stays useful instead of becoming stale context
Agentic teams have two memory layers: per-agent episodic history and shared
project memory for facts, decisions, and worklog. Retrieval is scoped to the
current project and framed as a **current-task context pack**, so old completed
work is reference material, not something the model should continue or report as
today's result. The memory roadmap is tracked in
[`owllm-desktop/docs/MEMORY_RAG_DESIGN.md`](owllm-desktop/docs/MEMORY_RAG_DESIGN.md).

### 🎛 The full local-AI workstation
- **Code page** — your local model codes directly in a folder, with **per-project persistence**: the conversation, plan, and model come back when you reopen the project (or relaunch). Open it isolated (WSL) or as a plain folder.
- **Fine-tuning** (LoRA), **GGUF conversion**, model onboarding — all on your hardware.
- **Agentic Studio** — design agents, give them models + tools, run multi-agent projects.
- **Signed auto-updater** — ships fixes with a branded, plain-language changelog.
- **Bridges** — drive it from Telegram / WhatsApp / Discord.

---

## Quick start

1. Download the installer from [Releases](https://github.com/OwLLM/owllm/releases/latest) and run it.
2. On first launch, the **onboarding wizard** provisions the runtime (llama.cpp engine, Python, etc.) for your hardware.
3. Pick a model, start the server, and open **Agentic Team** or **Fine Tuning → Chat**.

## The split, in two clicks

**On the GPU machine** (serves the model): Server tab → **🌐 Serve inference on the network** → *Turn ON* → copy the key. (Scope your firewall to the port + the agent's IP; for another physical machine, use a VPN/SSH tunnel.)

**On the agent machine** (runs the teams): Server tab → **🛰 Inference source → Remote** → enter the GPU machine's IP, the model's port, and paste the key.

That's it — agents and chat now run locally and isolated, using the remote GPU model.

---

## Platform support

<table>
<tr>
<td width="33%" valign="top" align="center">

### 🪟 &nbsp;Windows

**10 / 11 · x86-64**

![shipping](https://img.shields.io/badge/shipping-2ea043?style=for-the-badge)

[![Download installer](https://img.shields.io/badge/⬇%20Download-installer-2f6fd4?style=for-the-badge)](https://github.com/OwLLM/owllm/releases/latest)

Native CUDA GPU server · WSL2 sandbox · signed auto-updater

</td>
<td width="33%" valign="top" align="center">

### 🐧 &nbsp;Linux

**x86-64**

![shipping](https://img.shields.io/badge/shipping-2ea043?style=for-the-badge)

[![Download AppImage or deb](https://img.shields.io/badge/⬇%20AppImage%20·%20.deb-2f6fd4?style=for-the-badge)](https://github.com/OwLLM/owllm/releases/latest)

llama.cpp payloads · GPU probes (NVIDIA + AMD/Intel) · bubblewrap sandbox

</td>
<td width="33%" valign="top" align="center">

### 🍎 &nbsp;macOS

**Apple Silicon · Metal**

![beta](https://img.shields.io/badge/beta-d29922?style=for-the-badge)

[![Download dmg](https://img.shields.io/badge/⬇%20Download-.dmg-2f6fd4?style=for-the-badge)](https://github.com/OwLLM/owllm/releases/latest)

Metal payload · unified-memory model sizing · Lima sandbox *(awaiting HW verification)*

</td>
</tr>
</table>

The runtime is delivered by a **cross-platform module system** (registry-driven, per-OS variants) — the same installer flow provisions all three OSes. **Unified-memory machines** (Apple Silicon, AMD Strix Halo / Ryzen AI APUs, Intel iGPUs) get model-fit ratings and context sizing computed from their real shared-RAM GPU budget, not a meaningless dedicated-VRAM number.

## Architecture deep-dive

For the full design — the split, the safety tiers, native tool-calling, MCP robustness, the worktree fleet, and the cross-platform runtime — see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## License

OWLLM is proprietary software owned by **Far island Corporation Ltd.**
Official unmodified executables may be used free of charge, but the source code
is not open source and may not be copied, modified, redistributed, sublicensed,
or sold. See [LICENSE](LICENSE) for the complete terms.
