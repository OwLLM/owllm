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

- **🐧 WSL/Ubuntu sandbox (shipping).** Flip on isolation and every tool a model runs — `shell`, file writes, edits, `grep`, everything — executes **inside a WSL/Ubuntu distro**, in a project that lives in the Linux filesystem (`~/owllm/<project>`). A model that decides to `rm -rf` or write outside the project **physically cannot reach your Windows `C:` drive.** The Windows app, your GPU model server, and fine-tuning stay native and fast; only the dangerous *tool execution* is sandboxed. A header badge shows **🛡 Isolated** vs **⚠ Not isolated** at all times.
- **Graceful fallback.** No WSL (locked-down PC, virtualization off)? The app stays fully usable on the host with the guard rails below and a loud "not isolated" warning — your call.

And the guard rails apply on the host path too:

- **Write path-jail** — writes are confined to the workspace (worktree/project, temp, app scratch). A write to `C:\Windows` or your Documents is refused.
- **Catastrophic-command block** — never-legitimate commands (wipe root/home, format a disk, fork bomb, registry delete, remote-download-piped-to-shell) are stopped; normal scoped work is untouched.
- **Worktree isolation** — every agent in a team runs in its **own git worktree on its own branch**, so parallel agents never clobber each other; results merge back with conflict detection.

*Next:* running the cloud subscription CLIs (Claude/Codex/Gemini) inside the sandbox too, and one-click `wsl --install` provisioning during onboarding.

### 🧩 Native GGUF tool-calling + web search that just works
Tool-calling uses the model's **own chat template** (`llama-server --jinja` → native `tools` array → structured `delta.tool_calls`) — **no XML hacks, no dialect parsing**. MCP servers (filesystem, search, GitHub, etc.) auto-start, with a **master on/off switch**, **per-tool toggles**, and a **schema-safety gate** so one malformed MCP schema can't break tool-calling for everything. **Web search works out of the box** — on first run OwLLM auto-installs the **keyless DuckDuckGo** search server (no API key, no credit card); it's engine-agnostic, so any search MCP you add is used automatically.

### ☁️ Cloud models as first-class peers — with live streaming
Mix local and cloud freely in one team: Anthropic/OpenAI/Gemini **APIs** (just add a key) or **subscription CLIs** (Claude Code, Codex, Gemini) — all routed by the same dispatcher, all running wherever the agent backend runs. Subscription agents **stream their activity live** (reasoning, commands, tool calls, web searches) instead of going dark until the end.

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

| | Status |
|---|---|
| **Windows 10 / 11** | ✅ shipping |
| **Linux** | 🚧 in progress (the agent backend is light to provision: node/git/CLIs/uv — the heavy GPU stack can stay on the Windows server via the split) |
| **macOS** (Metal) | 🗺 roadmap |

The runtime is delivered by a **cross-platform module system** (registry-driven, per-OS variants) — the same installer that provisions Windows extends to Linux/macOS.

## Architecture deep-dive

For the full design — the split, the safety tiers, native tool-calling, MCP robustness, the worktree fleet, and the cross-platform runtime — see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## License

MIT © OWLLM.
