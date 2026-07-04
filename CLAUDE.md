# LocaLLM / OWLLM — repository map for agents

READ THIS FIRST. This repo contains a **live app** and a pile of **legacy code that
looks live but is not executed**. Past agents (and humans) have wasted hours
debugging the dead twin. Do not repeat that. When you investigate *runtime
behaviour*, work in `owllm-desktop/`. Treat the legacy paths below as history.

## The live app

`owllm-desktop/` — the shipping product. Tauri (Rust) + React.
- UI / all app logic: `owllm-desktop/ui/src/`
- Rust backend: `owllm-desktop/src-tauri/src/`
- Agentic team logic: `owllm-desktop/ui/src/pages/agentic/`
- Fine-tuning chat: `owllm-desktop/ui/src/pages/finetuning/`

**What the app DOES** (full feature map + where each feature lives):
`owllm-desktop/docs/FEATURES.md` — read it before changing behaviour, and
keep it current when you ship a feature.

## Tool-calling: NATIVE GGUF ONLY — there is no XML path

Chat **and** agentic tool-calling use the model's native chat template:
send the OpenAI `tools` array → `llama-server --jinja` renders it through the
GGUF's own template → read structured `delta.tool_calls` back. **No XML catalog
injected into the prompt. No regex dialect parsing of replies.**

- The single shared local loop: `streamLocalChat()` in
  `owllm-desktop/ui/src/pages/agentic/dispatch.ts`.
- Tool specs + MCP tools: `owllm-desktop/ui/src/pages/agentic/localTools.ts`.
- Codified by commit `129bcb13` (2026-06-01): *"Native GGUF tool-calling only:
  delete XML protocol + dialect spaghetti."*

If you see `<tool_call name="...">` XML, `parse_tool_calls`, or
`format_for_prompt` anywhere, you are looking at **dead legacy code**. It is not
how the app calls tools. Do not cite it, fix it, or reason from it.

## Legacy — DELETED. `python-app/` no longer exists.

The entire `python-app/` tree (the old PySide6 desktop GUI, the old XML agent
orchestrator, the installer/electron experiments, dev venvs and caches — ~1.9 GB,
14k files) was **removed from the repo on 2026-06-21**. `owllm-desktop/` is a
ground-up port and is fully self-contained; nothing in the live app or the build
ever referenced `python-app/` (verified: no Rust path resolution, no TS import,
no bundle entry — the build pulls only `owllm-desktop/resources/*`). It's gone from
disk but recoverable from git history if ever needed.

If you see a comment that says *"mirrors X from python-app/…"* it's a historical
provenance note pointing at a deleted file — treat it as history, not a live path.
If you see `<tool_call name="...">` XML, `parse_tool_calls`, or `format_for_prompt`,
that's the dead tool-calling protocol — it was never how this app calls tools.

## Python that IS live (backend, spawned by the Tauri app)

The only Python the app runs is a small set of ML scripts bundled under
`owllm-desktop/resources/` — fine-tuning, GGUF conversion, abliteration, a
screenshot tool: `resources/finetune.py`, `convert_hf_to_gguf.py`,
`tools/abliterate.py`, `tools/screenshot_url.py`. They are spawned from the Rust
side (`paths::finetune_script()` etc.), which **prefers the bundled
`resources/` copy** and falls back only to the user's runtime-data install dir
(`llm_root()` = the models/llama-server tree), never to any source checkout.

`finetune.py` imports `core.model_compatibility`, which is bundled as
`resources/core/model_compatibility.py` (a self-contained copy). If a bundled
script grows a new `core.*` import, copy that module into `resources/core/` too —
there is no longer a `python-app/core/` to fall back on.
(`screenshot_url.py` wants `core.twinforge.*`, which is **not** in `resources/` —
that tool's import is a pre-existing bundling gap, unrelated to the deletion.)

## Rule of thumb

Runtime question → `owllm-desktop/`. There is no Python "dead twin" to get lost in
anymore; the only Python that runs lives in `owllm-desktop/resources/`.
