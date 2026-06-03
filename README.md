<div align="center">

<img src="assets/owl-hero.png" alt="OwLLM" width="160" />

# OwLLM

### Your GPU. Your models. Your team of AI agents.

**Local-first AI workstation — run open-weight models, fine-tune them on your data, and orchestrate entire teams of specialised agents. No cloud required.**

<p align="center">
  <a href="https://github.com/OwLLM/owllm/releases/latest"><img src="https://img.shields.io/github/v/release/OwLLM/owllm?label=download&style=for-the-badge&color=3ec5d8" alt="Download" /></a>
  <a href="https://github.com/OwLLM/owllm/discussions"><img src="https://img.shields.io/github/discussions/OwLLM/owllm?style=for-the-badge&color=3ec5d8" alt="Discussions" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/OwLLM/owllm?style=for-the-badge&color=3ec5d8" alt="License" /></a>
  <a href="https://github.com/OwLLM/owllm/stargazers"><img src="https://img.shields.io/github/stars/OwLLM/owllm?style=for-the-badge&color=3ec5d8" alt="Stars" /></a>
</p>

<img src="assets/demo.gif" alt="OwLLM demo — six agents building a feature in parallel" width="720" />

</div>

---

## Why OwLLM

- **Stop paying per token.** Your 4090 sits at 5% utilisation while you pay OpenAI. OwLLM puts it to work — open-weight models (Llama, Qwen, Mistral, DeepSeek) running on your GPU.
- **Privacy by default.** Nothing leaves your machine. Critical for legal, medical, regulated industries — and respectful of everyone else.
- **Multi-agent teams, not just chat.** 18+ pre-built specialist teams (code, research, design, data, writing, ops). The orchestrator routes work; the critic gates quality.
- **Fine-tune on your data.** Full LoRA pipeline with Unsloth, TRL, PEFT. Watch loss curves in real time. Graceful Stop saves the checkpoint.

## What you can do with it

| | |
|---|---|
| 🤖 **Run local models** | Browse HuggingFace, pick a GGUF, click Start. Real `llama-server`, live VRAM monitoring, OOM-friendly hints. |
| 👥 **Spin up agent teams** | `code_artisan` · `research_lab` · `data_analyst` · `product_studio` · `writers_room` · `secretary` · and 12 more. |
| 🎓 **Fine-tune** | LoRA + Unsloth, dataset → adapter in your kitchen. Abliteration support for safety research. |
| 🔌 **MCP-first tooling** | Plug in any MCP server (filesystem, git, browser, Postgres, etc.). One-click curated packs per team. |
| ☁️ **Cloud as a peer** | Claude, GPT, Gemini, Kimi join the conversation as equals — when you provide keys. Local + cloud, same window. |
| 📱 **Telegram / WhatsApp bridges** | Your agent team, on your phone. Voice messages transcribed locally with Whisper.cpp. |
| 🎨 **Native desktop feel** | ~50 MB Tauri shell, not a 200 MB Electron blob. Frameless transparent HybridFrame chrome. Boots in under a second. |

## How it compares

| | LM Studio | Ollama | Jan | Open WebUI | **OwLLM** |
|---|:---:|:---:|:---:|:---:|:---:|
| Local model runtime | ✅ | ✅ | ✅ | (via Ollama) | ✅ |
| Fine-tuning UI | ❌ | ❌ | ❌ | ❌ | ✅ |
| Multi-agent teams | ❌ | ❌ | partial | partial | ✅ (18 pre-built) |
| MCP tool integration | ❌ | ❌ | partial | partial | ✅ |
| Parallel agents w/ git isolation | ❌ | ❌ | ❌ | ❌ | ✅ |
| Cloud models as peers | ❌ | ❌ | ✅ | ✅ | ✅ |
| Telegram/WhatsApp bridges | ❌ | ❌ | ❌ | ❌ | ✅ |
| Native shell (not Electron) | ✅ | n/a (CLI) | ❌ | ❌ (web) | ✅ |
| Transparent / frameless UI | ❌ | n/a | ❌ | n/a | ✅ |

## Install

1. **[Download the installer](https://github.com/OwLLM/owllm/releases/latest)** (~30 MB)
2. Run `OwLLM-Desktop-Setup-x64.exe`. Windows SmartScreen may flag it the first time (the build isn't EV-signed yet) — click "More info" → "Run anyway".
3. On first launch, a **hardware-aware wizard** opens. It detects your GPU, RAM, disk, and offers the modules that fit:
   - **Local Inference** (~33 MB CPU / ~32 MB Vulkan / ~285 MB CUDA) — needed to run any local model
   - **Audio / Speech-to-Text** (~148 MB) — voice messages from Telegram, mic input
   - **Fine-tuning** (~12 GB) — only if you have an NVIDIA GPU and intend to train
   - **MCP toolchain** (~260 MB) — only if you want browser/git/postgres MCP servers
4. Pick what you'll use, click Install, watch progress, done.

If you're cloud-only (Claude/GPT keys, no GPU), you can skip the wizard entirely. The shell alone is enough for cloud-model chat + agent orchestration.

**System requirements:** Windows 10/11 x64. macOS and Linux planned. NVIDIA GPU with 8 GB+ VRAM recommended for local inference; 12 GB+ for fine-tuning. CPU-only mode works on any modern x64 machine (slower).

## Three agent teams you'll actually use on day one

- **`code_artisan`** — architect → coder → critic → refactorer loop. Drop it on a repo, give it a feature, walk away. Each agent works in its own git worktree.
- **`research_lab`** — librarian → deep_reader → synthesizer → fact_checker → citer. Multi-source research with real citations, not hallucinated ones.
- **`secretary`** — triager → responder + scheduler + digest. Hook it to Telegram and your inbox; it learns your style.

[Full team catalogue →](data/teams/)

## How updates work

OwLLM updates in three independent streams:

- **Shell** auto-updates on next launch (Tauri's signed updater).
- **Modules** (llama backend, fine-tune env, audio, MCP toolchain) check for new versions per-launch, download in background, swap on next start. No full reinstalls.
- **Data layer** (team templates, role prompts, model sampling profiles, MCP recommendations) pulls hot from `data/` in this repo. Push a fix here → it reaches every installed app within minutes, no rebuild.

The data layer is **community-contributable** — see [CONTRIBUTING.md](CONTRIBUTING.md). New agent teams, new role definitions, new model profiles all land via pull request.

## Roadmap

- [x] Multi-agent dispatch with worktree isolation
- [x] Modular installer with hardware-aware wizard
- [x] MCP-first tool architecture
- [x] Telegram bridge
- [ ] **macOS + Linux builds** — Q3 2026
- [ ] **WhatsApp bridge** — Q3 2026
- [ ] **TTS (voice output)** — Q4 2026
- [ ] **Vision models** (LLaVA, Pixtral) — Q4 2026
- [ ] **Director-mode approval gates** — Q4 2026
- [ ] **Kanban-style multi-agent board** — Q1 2027

Track active work in [Discussions → Roadmap](https://github.com/OwLLM/owllm/discussions).

## Community

- 💬 [GitHub Discussions](https://github.com/OwLLM/owllm/discussions) — Q&A, show what you built, roadmap input
- 🐛 [Issues](https://github.com/OwLLM/owllm/issues) — bug reports (use the template)
- 🎨 [Contributing agent teams](CONTRIBUTING.md) — community-curated team packs

## License

The contents of this repository (agent team templates, role definitions, registry, schemas, docs) are released under [MIT](LICENSE) — fork, modify, share custom team packs freely.

The compiled OwLLM Desktop application distributed via [Releases](https://github.com/OwLLM/owllm/releases) is governed by its own [end-user license agreement](EULA.md). Source code for the application is not currently public.

## Acknowledgements

OwLLM stands on the shoulders of:
- [llama.cpp](https://github.com/ggml-org/llama.cpp) (ggml-org) — the inference engine
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (ggerganov) — local speech-to-text
- [Tauri](https://tauri.app/) — the desktop shell
- [Unsloth](https://github.com/unslothai/unsloth) — accelerated fine-tuning
- [Model Context Protocol](https://modelcontextprotocol.io/) (Anthropic) — the tool standard

If your local-AI work could use a workstation that respects your hardware, your data, and your time — give OwLLM a try. Star the repo if you do; it's the single best signal that this category is worth investing in further.
