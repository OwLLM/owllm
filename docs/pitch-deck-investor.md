# OwLLM — Investor Pitch Deck

> **Format guide:** Each `##` heading is one slide. Body bullets go on-slide (keep terse — investors scan, don't read). Each blockquote is the **speaker note** (what you actually *say* while the slide is up). Length-target: 12 minutes spoken, 16 slides + 3 appendix.
>
> **Placeholders marked `[USER: …]` must be filled in before presenting.** Items the user explicitly needs to decide are flagged in **Pre-flight** at the bottom.

---

## Slide 1 — Title

# OwLLM
### Your GPU. Your models. Your team of agents.

[USER: presenter name · role · date · contact email]

> "I'm going to show you a local-first AI workstation that does something nobody else does — it runs a real *team* of AI agents on your own hardware. Twelve minutes."

---

## Slide 2 — The problem (set the stakes)

**Three things are simultaneously true in 2026:**

- Consumers spent **$50B+** on AI-capable GPUs (RTX 4090, 5090, AI PCs)
- They sit at **~5% utilisation** while users pay $20–200/month to OpenAI, Anthropic, Google
- **Regulated industries** (legal, medical, defence, finance) **cannot** send data to cloud APIs — they're locked out of the AI productivity wave

**The hardware is here. The open-weight models are here. The *workstation* isn't.**

> "Every consumer buying a 4090 today is paying twice — once for the silicon, once for the tokens. And regulated industries — which is most of the economy by GDP — can't use cloud AI at all. There's a category-defining hole in the market."

---

## Slide 3 — What we built

### OwLLM is a local-first AI workstation with multi-agent teams.

[USER: insert hero screenshot — frameless HybridFrame window with Agentic mode open, an agent team running]

**Chat · Code · Research · Fine-tune · Orchestrate — all on your own hardware.**

> "It's a 50-megabyte native desktop app — Tauri, Rust core, React UI. It runs open-weight models locally, fine-tunes them on your data, and orchestrates teams of specialised agents. Watch what that looks like."

---

## Slide 4 — Demo: the wow moment

### Six agents. One feature. Built in parallel. On your laptop.

[USER: embed 30-second GIF / video — *code_artisan* team running. Show: orchestrator dispatches → architect designs → coder writes → critic reviews → refactorer polishes → all in isolated git worktrees → diff merges cleanly into main]

> "This is six agents working in parallel on the same codebase. They don't collide on files, ports, or GPUs because we built an atomic resource-claim substrate in SQLite. No other local-LLM tool — Ollama, LM Studio, Jan — does anything like this. We'll come back to *why* it's hard."

---

## Slide 5 — The product surface

### One app. Six things no competitor combines.

|  |  |  |
|---|---|---|
| 🤖 **Local model runtime** | 🎓 **Fine-tuning UI** | 👥 **18+ agent teams** |
| llama.cpp, any GGUF | LoRA, graceful stop | code, research, design |
| 🔌 **MCP tools** | 📱 **Bridges** | ☁️ **Cloud as peers** |
| any MCP server plugs in | Telegram + WhatsApp | Claude, GPT, Gemini, Kimi |

> "Each of these alone exists somewhere. Nobody puts all six in one app, and certainly nobody builds them on a Rust core that boots in under a second."

---

## Slide 6 — The killer feature: agent teams

### 18 pre-built specialist teams. One click to launch.

- **code_artisan** — architect → coder → critic → refactorer loop
- **research_lab** — librarian → deep_reader → synthesizer → fact_checker → citer
- **data_analyst** — SQL writer → notebook runner → visualizer → narrator
- **product_studio** — product_owner → UX designer → frontend/backend coders → design critic
- **writers_room · secretary · concierge · bug_hunter · health_coach · smart_home · learning_tutor · n8n_workflow_builder** … and more

> "These aren't prompt templates. Each team is a *graph* of specialists with a real orchestrator routing work, a critic gating quality, and per-task timeouts so a hung specialist can't block the team. It's the difference between a chatbox and a workforce."

---

## Slide 7 — Why this is hard (the technical moat)

### Five problems competitors paper over. We built infrastructure.

- **Stable GPU selection** — UUID + `PCI_BUS_ID` ordering. Competitors' "select 4090" silently runs on the A2000.
- **Atomic fleet scheduling** — SQLite `BEGIN IMMEDIATE` claims on ports, GPUs, branches, file paths. Nobody else has a real concurrency substrate.
- **Multi-process llama-server** — concurrent inference with persistent StateStore. Others are one-server-per-app.
- **Sentinel-file graceful Stop for fine-tuning** — saves the checkpoint. Others SIGTERM and corrupt the run.
- **Supervisor Brain** — local LLM diagnoses failures, never escalates to cloud. Adaptive without brittleness.

> "Each of these is a real engineering investment with months of work behind it. They're not features we marketed — they're bugs we hit, and the infrastructure we built to solve them. Our competitors hit the same bugs and ship the bugs."

---

## Slide 8 — Why this is hard (the UX moat)

### A native 2026 desktop app, not an Electron blob.

- **50 MB** Tauri (Rust + React), not 200 MB Electron
- **Frameless transparent window** with HybridFrame chrome (we strip `WS_CAPTION` via raw Win32 to make Tauri actually frameless on Windows)
- **All-Rust critical path** — hardware probe, model lifecycle, MCP runtime, file I/O. Python only spawned on-demand for fine-tuning.
- **Boots in under a second.** Real progress bars, real VRAM, real metrics — never a lying spinner.

> "This stuff is craft. You can feel it the second you launch the app. It's the difference between Notion and a $5 Electron app from 2018."

---

## Slide 9 — Market

### Three concentric markets. We can win all three.

- **TAM** — Every consumer who owns or will buy a GPU-capable PC in 2026–2028: **~400M devices globally** [USER: verify with IDC GPU shipment data]
- **SAM** — Developers, researchers, regulated-industry knowledge workers, AI-curious power users: **~40M people** [USER: refine with Stack Overflow + GitHub population estimates]
- **SOM (3-year)** — Convert **0.5%** of SAM = **200,000 paid seats** at **$X ARPU** = **$X ARR** [USER: pick ARPU and target — see Pricing slide]

**The unlock:** open-weight models (Llama 4, Qwen 3, DeepSeek) have closed the gap with GPT-4 class for most workflows. Local is finally *good enough*, for free.

> "The market got real in 2025 when Llama 4 and DeepSeek hit GPT-4 quality on consumer hardware. We're not betting on local models getting good — they already are. We're betting on the workstation gap closing."

---

## Slide 10 — Why now

### Four trends just converged.

1. **Open-weight models hit GPT-4 quality** (Llama 4, Qwen 3, DeepSeek) — local is finally good enough
2. **Consumer GPUs hit 24–32 GB VRAM** (RTX 5090, AMD Strix Halo) — fits 70B-class models
3. **MCP became the standard tool protocol** (Anthropic, 2024–2025) — the agent ecosystem is finally interoperable
4. **Regulated industries got AI mandates** but lost cloud-API permission — local is the only path

> "Any one of these alone wouldn't be enough. All four together open a window that wasn't open eighteen months ago and probably won't stay open for more than two years."

---

## Slide 11 — Competitive landscape

### The category has a hole. We're filling it.

| | LM Studio | Ollama | Jan | Open WebUI | **OwLLM** |
|---|---|---|---|---|---|
| Local runtime | ✅ | ✅ | ✅ | (via Ollama) | ✅ |
| Fine-tuning UI | ❌ | ❌ | ❌ | ❌ | ✅ |
| Multi-agent teams | ❌ | ❌ | partial | partial | ✅ |
| MCP tools | ❌ | ❌ | partial | partial | ✅ |
| Parallel agents + git isolation | ❌ | ❌ | ❌ | ❌ | ✅ |
| Cloud models as peers | ❌ | ❌ | ✅ | ✅ | ✅ |
| Bridges (Telegram/WhatsApp) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Native Rust shell | ✅ | CLI | ❌ | web | ✅ |

> "Everyone in the local-LLM space is fighting for the chatbox layer. We skipped that fight and built the workstation. By the time they pivot to compete with us, we have the substrate they don't."

---

## Slide 12 — Business model

### Open-core, with hosted compute as the cash engine.

- **Free forever** — full local app, full agent teams, no caps. **Drives adoption + community + signal.**
- **OwLLM Teams** ($X/seat/month) — centralised admin, audit logs, shared agent teams, SSO, fleet dashboards. **Targets the regulated-industry wedge.**
- **OwLLM Cloud Compute** (pay-per-hour) — "I don't have a 4090, run my fine-tune for me." **Captures upside when users grow beyond their hardware.**
- **(Future) Agent Team Marketplace** — creators publish teams, we take 15%. **Network effect on the unique team primitive.**

[USER: confirm pricing & business model — alternatives in appendix A3]

> "Free local app is the wedge — we believe local AI is a movement and we want to lead it. The money comes from teams that need administration, and from users who outgrow their hardware and want us to run the GPU."

---

## Slide 13 — Traction

[USER: fill in real numbers — placeholders below for the structure]

- **Shipped** — v[X.Y] in production on Windows, [macOS / Linux: planned / shipped]
- **Users** — [N] downloads · [N] active installs · [N] community Discord members
- **Engineering velocity** — [N] commits in last 90 days · [N] active agent teams shipped
- **Recent landings** (last 4 weeks): SSE error surfacing for llama-server · real Stop button + mic feedback · idempotent HF downloads · HF token wiring · RAW-tag flag for HF safetensors
- **Fleet substrate** shipped 2026-05-06 (commit ac933d7) — atomic resource claims now production
- **Roadmap shipped on time** — Supervisor scheduled for production rollout, TwinForge three-agent split in active development

> "[USER: walk through the strongest 2-3 numbers. If user numbers are small, lead with engineering velocity + technical milestones. Investors at seed/pre-seed care about *execution*, not metrics yet.]"

---

## Slide 14 — Roadmap (next 12 months)

### Three milestones. Honest timeline.

- **Q3 2026 — Supervisor to production** (shadow-mode + feature-flag rollout). Adaptive safety layer becomes the default.
- **Q4 2026 — TwinForge three-agent split lands.** Code-aware replicator + GUI-only replicator + tester — unlocks the "OwLLM builds OwLLM" loop.
- **Q1 2027 — OwLLM Teams beta** (10 design-partner companies in regulated industries). First revenue.

> "We don't promise the moon. These are dates we believe and that we can be measured against."

---

## Slide 15 — Team

[USER: fill in. Standard investor format below.]

- **[Name]** — [role] · [previous: relevant company / shipped product / domain expertise]
- **[Name]** — [role] · [previous]
- **[Name]** — [role] · [previous]

**Why us:** [USER: 1-sentence answer to "why is this team the right team to build this?" — usually some combination of (a) we built X before, (b) we have deep domain expertise in Y, (c) we've been dogfooding the problem]

> "[USER: give the 'why us' story in 30 seconds. Investors invest in people first, market second, product third.]"

---

## Slide 16 — The ask

### Raising **$[USER: amount]** to do three things.

1. **Hire [N] engineers** — [breakdown: e.g., 2 Rust, 1 ML, 1 frontend, 1 DX]
2. **Ship OwLLM Teams** to first 10 paying design partners
3. **18 months of runway** to reach **$[X] ARR** and Series A readiness

**[USER: lead investor target · check size · close timeline]**

> "We're raising a [seed / pre-seed] of [$X]. We're talking to [N] funds. We'd love [target fund] to lead. We're closing by [date]."

---

## Slide 17 — Close

# Your GPU is a lab.
# Let us prove it.

[USER: contact email · download URL · calendar link for follow-up]

> *(Pause. Wait for questions. The Q&A is where the deal is won.)*

---

## Appendix A1 — Architecture diagram (back-pocket for technical Q&A)

```
┌─────────────────────────────────────────────────────────┐
│                  Tauri Window (Rust)                    │
│  ┌──────────────────────────────────────────────────┐   │
│  │           React UI (HybridFrame chrome)           │   │
│  └──────────────────────────────────────────────────┘   │
│         │                                                │
│         ▼  Tauri commands (IPC)                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │       Rust core — the critical path              │   │
│  │  hardware · server · huggingface · mcp · fleet   │   │
│  │  agent_tools · audio · pty · accounts            │   │
│  └──────────────────────────────────────────────────┘   │
│       │              │              │           │       │
│       ▼              ▼              ▼           ▼       │
│  llama-server   MCP servers    Python venv   nvidia-smi│
│  (1..N procs)   (JSON-RPC      (on-demand,   (GPU UUID │
│                  stdio)         training only) probe)   │
└─────────────────────────────────────────────────────────┘
```

> "Python isn't loaded at startup. The critical path is all Rust. That's why we boot in under a second and why we don't crash when a Python dep is broken."

---

## Appendix A2 — Fleet substrate (back-pocket)

- **SQLite schema:** `claims(resource_type, resource_id, agent_id, claim_token, expires_at)` with composite unique partial indexes on `(resource_type, resource_id) WHERE released_at IS NULL`
- **Claim transaction:** `BEGIN IMMEDIATE` → check existing → insert claim → commit. SQLite serialises writers; second claimant gets `ClaimConflict`.
- **Resource types claimed:** ports · GPU slots · git worktrees · module write-paths · model-file locks
- **Auto-release on agent crash:** TTL + heartbeat. Dead agent's claims expire; another agent picks up.

> "We use SQLite because we get ACID for free, no extra process to run, no Postgres dependency. It scales to the only scale that matters here — one user's machine running 6–20 agents."

---

## Appendix A3 — Business model alternatives (back-pocket / discussion)

If asked "why open-core and not X?":

| Model | Pro | Con | Verdict |
|---|---|---|---|
| **Open-core (chosen)** | Wedge + community + enterprise upsell | Slow monetisation | ✅ best for category-defining play |
| Closed paid app | Fast revenue | No community moat, easy to clone | ❌ commoditises us |
| Pure hosted SaaS | Predictable MRR | Defeats the local-first thesis | ❌ contradicts the wedge |
| API-only B2B | High ACVs | Misses the consumer wave | ⚠ secondary, not primary |
| Marketplace-first | Network effects | Chicken-and-egg | ⚠ phase 2, not phase 1 |

> "We chose open-core because the wedge — 'local AI is a movement and we want to lead it' — only works if the local app is free. Enterprise teams and hosted compute capture the monetisation curve as users grow."

---

## Pre-flight checklist (before this deck is presentation-ready)

- [ ] **Slide 1** — presenter name + contact
- [ ] **Slide 3** — hero screenshot (HybridFrame window, Agentic mode visible)
- [ ] **Slide 4** — 30-second demo GIF/video (code_artisan team)
- [ ] **Slide 9** — verify TAM/SAM numbers with real source (IDC GPU data); pick ARPU
- [ ] **Slide 12** — confirm pricing & business model (or pick an alternative from A3)
- [ ] **Slide 13** — real traction numbers (downloads, users, commits, partners)
- [ ] **Slide 15** — team bios + "why us" sentence
- [ ] **Slide 16** — round size, breakdown, target lead, close date
- [ ] **Slide 17** — contact email + calendar link
- [ ] Rehearse to **12 minutes flat**. Slide 4 demo should hit by minute 3. Save 8+ minutes for Q&A.
