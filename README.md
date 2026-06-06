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

### 🛡 Safe by default, out of the way for pros
Autonomous agents that edit files and run shell commands are powerful and risky. OwLLM ships **guard rails by default**:

- **Write path-jail** — agents can only write inside their workspace (worktree/project, temp, app scratch). A write to `C:\Windows` or your Documents is refused.
- **Catastrophic-command block** — never-legitimate commands (wipe root/home, format a disk, fork bomb, registry delete, remote-download-piped-to-shell) are stopped; normal scoped work is untouched.
- **Worktree isolation** — every agent in a team runs in its **own git worktree on its own branch**, so parallel agents never clobber each other; results merge back with conflict detection.

For experienced users, a **Guru mode** (roadmap) flips the hand-holding off; for hard isolation, run the whole thing in **WSL/Linux** (roadmap) and let the OS sandbox it.

### 🧩 Native GGUF tool-calling + robust MCP
Tool-calling uses the model's **own chat template** (`llama-server --jinja` → native `tools` array → structured `delta.tool_calls`) — **no XML hacks, no dialect parsing**. MCP servers (filesystem, search, GitHub, etc.) auto-start, with a **master on/off switch**, **per-tool toggles**, and a **schema-safety gate** so one malformed MCP schema can't break tool-calling for everything.

### ☁️ Cloud models as first-class peers
Mix local and cloud freely in one team: Anthropic/OpenAI/Gemini **APIs** (just add a key) or **subscription CLIs** (Claude Code, Codex, Gemini) — all routed by the same dispatcher, all running wherever the agent backend runs.

### 🎛 The full local-AI workstation
- **Fine-tuning** (LoRA), **GGUF conversion**, model onboarding — all on your hardware.
- **Agentic Studio** — design agents, give them models + tools, run multi-agent projects.
- **Signed auto-updater** — ships fixes with a branded, plain-language changelog.
- **Bridges** — drive it from Telegram/WhatsApp.

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
