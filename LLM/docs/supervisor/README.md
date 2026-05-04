# OWLLM Supervisor

The Supervisor is an embedded AI assistant that watches the app, detects failures, and applies fixes — both at install time (bootstrap) and during normal use (training, inference, dataset prep).

It replaces brittle rule-based recovery (`profile_selector.py`, `capability_matrix.py`, large parts of `self_heal_orchestrator.py`) with a fine-tuned **Gemma 4 E2B** running locally via `llama.cpp` — no cloud dependency, no Python required for the install-time path.

## Documents in this directory

| Doc | Purpose |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | High-level design, components, boot sequence, data flow |
| [BOOTSTRAP.md](BOOTSTRAP.md) | Native bootstrap launcher — solves the chicken-and-egg of "no Python yet" |
| [TOOLS.md](TOOLS.md) | The action surface the model can invoke (install_pkg, swap_wheel, …) |
| [EVENTS.md](EVENTS.md) | Event bus contract — what triggers the supervisor at runtime |
| [FINETUNE.md](FINETUNE.md) | Fine-tune plan: dataset, method, eval gate, distribution |

## Quick map

```
LLM/bootstrap/           ← native launcher + bundled E2B model (install-time)
LLM/core/supervisor/     ← Python runtime supervisor (post-install)
LLM/docs/supervisor/     ← these docs
```

## Why Gemma 4 E2B (not Gemma 3, not E4B by default)

- **Gemma 4** released April 2026 — Per-Layer Embeddings give 2B-effective models long-context awareness without the memory cost.
- **E2B Q4_K_M ≈ 1.5 GB** — small enough to bundle in the installer.
- **128K context** — enough to read full pip-resolver output + stack trace + hardware spec in one prompt.
- **~25 tok/s on 5-year-old i5 CPU** — acceptable cold start, snappy on any GPU.
- **Apache 2.0** — clean to redistribute.

E4B is supported as a runtime fallback when the user has ≥8 GB free RAM and a discrete GPU.

## Status

Skeleton — design + stub files only. No working code yet.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture and [the corpus extractor task](FINETUNE.md#step-1-build-the-failure-corpus) for the recommended first step.
