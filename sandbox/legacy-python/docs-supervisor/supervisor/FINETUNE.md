# Fine-tune plan — Gemma 4 E2B as supervisor

## Goal

A bundled, fast, JSON-only model that maps `{hardware, error, state} → {action, args}` better than rules ever could, on the failure modes OWLLM actually sees.

## Base model

[unsloth/gemma-4-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF)

- Effective 2B params with Per-Layer Embeddings → punches above its weight.
- 128K context.
- Apache 2.0.
- Q4_K_M ≈ 1.5 GB, runs on CPU at ~25 tok/s, GPU at 80+ tok/s.
- Unsloth provides ready LoRA pipeline.

E4B is the same plan with a bigger base — kept as a fallback for users with more resources.

## Output format

Strict JSON, GBNF-constrained at decode time:

```json
{
  "action": "install_pkg",
  "args": { "name": "bitsandbytes", "version": "0.44.1" },
  "reason": "torch 2.5.1 ABI requires bnb >= 0.44",
  "fallback": { "action": "swap_wheel", "args": { "name": "torch", "to_version": "2.4.1+cu121" } }
}
```

Grammar lives in `bootstrap/recipes/plan.gbnf` (and a runtime equivalent for multi-step plans). The model literally cannot output free text — every response is a valid action.

## Step 1 — Build the failure corpus

This is the gating task. **If we can't get to ~1000 real labeled examples, the fine-tune won't beat stock E2B + good prompting.**

Sources to mine:

| Source | Extraction |
| --- | --- |
| [CHANGELOG.md](../../CHANGELOG.md) | every "fix:" entry → `(error → fix)` pair |
| `git log --grep=fix` | commit message + diff → `(symptom → resolution)` |
| GitHub issues (if any) | issue body + closing PR → labeled pair |
| Existing user logs (with consent) | stderr + the eventual successful command |
| `core/envs/capability_matrix.py` | rule entries → synthetic seed examples |

Three-stage pipeline:

```
   git log + CHANGELOG.md
            |
            v
   [Stage 1] build_failure_corpus.py
            |  scrapes prose, tags by category (cuda, deps, ui, ...)
            v
   bootstrap/recipes/failure_corpus_raw.jsonl
            |
            v
   [Stage 2] structure_failure_corpus.py
            |  LLM call (Claude API or local Gemma) per row
            |  emits {input, output} JSON; flags vague rows for review
            v
   failure_corpus_structured.jsonl  +  failure_corpus_needs_review.jsonl
            |
            v
   [Stage 3] review_failure_corpus.py
            |  terminal UI: accept / reject / edit
            |  accepted rows get meta.verified_human = true
            v
   bootstrap/recipes/failure_corpus.jsonl   <- the file the fine-tune trains on
```

Run:

```
# Stage 1 -- mine project history (~215 candidates from current repo)
python LLM/tools/build_failure_corpus.py
python LLM/tools/build_failure_corpus.py --dry-run        # stats only

# Stage 2 -- LLM-assisted structuring
$env:ANTHROPIC_API_KEY = "..."                            # PowerShell
python LLM/tools/structure_failure_corpus.py              # full corpus
python LLM/tools/structure_failure_corpus.py --limit 5    # smoke test
python LLM/tools/structure_failure_corpus.py --backend stub --limit 5
python LLM/tools/structure_failure_corpus.py --backend gemma --endpoint http://127.0.0.1:8765

# Stage 3 -- human review
python LLM/tools/review_failure_corpus.py
python LLM/tools/review_failure_corpus.py --include-review-queue
python LLM/tools/review_failure_corpus.py --resume        # continue last session
```

Stage-2 expansion (variations on hardware specs / error tails) plus telemetry
ingestion grows the corpus toward the 3k-5k target.

Final structured schema (`bootstrap/recipes/failure_corpus.jsonl`):

```json
{
  "input": {
    "hardware": { "...": "" },
    "trigger": { "kind": "training_failed", "...": "" },
    "current_env": { "...": "" },
    "error_log_tail": "..."
  },
  "output": {
    "action": "install_pkg",
    "args": { "...": "" },
    "reason": "...",
    "fallback": { "...": "" }
  },
  "meta": {
    "source": "git_log:7ec5671",
    "verified_human": false
  }
}
```

Target: 3,000–5,000 examples for v1, with a 500-example held-out eval set.

## Step 2 — Stock baseline

Before fine-tuning anything: wire stock Gemma 4 E2B end-to-end with a strong system prompt + few-shot examples on 5 known failure modes. Measure accuracy on the eval set.

- If stock hits **>60%** correct-action: fine-tune is worth it, will push to 85%+.
- If stock hits **>85%**: ship without fine-tune for v1, build the fine-tune for v2 once we have more data.
- If stock hits **<30%**: the bottleneck is prompting / tool design, not the model. Don't fine-tune yet.

This step is **non-negotiable** — fine-tuning a model that's already strong is wasteful, and fine-tuning to fix bad prompts just bakes in the bad prompts.

## Step 3 — Fine-tune

### Method

LoRA via [Unsloth](https://unsloth.ai/docs/models/gemma-4):

- Rank 16, alpha 32.
- Targets: `q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj`.
- 3 epochs, learning rate 2e-4, cosine schedule, warmup 5%.
- Batch size 8 (gradient accumulation 4) — fits on a 24 GB GPU.
- Sequence length 8K (most failures fit; long stack traces use 16K with packing off).

### Training data format (Unsloth chat template)

```
<start_of_turn>user
{system_prompt}

# Hardware
{hardware_json}

# Trigger
{trigger_json}

# Current environment
{env_json}

# Error log tail
{stderr_tail}
<end_of_turn>
<start_of_turn>model
{json_action}
<end_of_turn>
```

### Hardware

- 1× A100 80GB → ~1 hour for 3k examples × 3 epochs.
- 1× RTX 4090 → ~3 hours, viable.
- Local box if available; otherwise rent for $1–3.

### Output

- Merge LoRA into base.
- Quantize to Q4_K_M GGUF.
- Sign + version: `gemma-4-E2B-owllm-v1.0-Q4_K_M.gguf`.

## Step 4 — Eval gate

Held-out 500-example eval set (never in training):

| Metric | Threshold to ship |
| --- | --- |
| Correct action chosen (top-1) | ≥ 85% |
| Correct args (when action correct) | ≥ 90% |
| Hallucinated action name | 0% (grammar enforces this) |
| Median latency (CPU) | < 10s for 200-token plan |
| OOM / crash on 8GB RAM box | 0 |

If a metric fails, do NOT ship. Iterate prompt + corpus + hyperparameters.

## Step 5 — Distribute

- Initial release ships v1.0 GGUF in the bootstrap bundle.
- Auto-updater can fetch a newer `gemma-4-E2B-owllm-v{N}.gguf` independently of app version.
- Each version's eval scores are published in [CHANGELOG.md](../../CHANGELOG.md).

## Telemetry and corpus growth

**Opt-in, off by default.** When enabled, the supervisor uploads `(input, output, was_fix_successful)` triples after each session. UI shows:

> "Help OWLLM learn from this fix?
> Sending: hardware spec, error log (first 200 lines, redacted), action taken, outcome.
> Receiving: nothing."

Uploaded data feeds `failure_corpus.jsonl` for the next fine-tune. We retrain quarterly or whenever we have ~500 new examples, whichever comes first.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Fine-tuned model overfits to past failures, fails on new GPUs | Eval set includes "novel hardware" subset; keep a small % of training data synthetic-but-diverse |
| GGUF release downloads are huge | Ship Q4_K_M only by default; offer Q5/Q6 as opt-in |
| Model gives confidently-wrong fixes | `confirm` trust tier on anything destructive; bounded retry; gave-up signal |
| Corpus poisoned by bad-quality examples | `meta.verified_human` flag; new examples weighted lower until reviewed |

## What "v1 done" looks like

- Corpus has 3000+ labeled examples, 500 held-out.
- Fine-tuned `gemma-4-E2B-owllm-v1.0-Q4_K_M.gguf` clears all eval thresholds.
- Bootstrap can install OWLLM end-to-end on at least 5 different hardware configs (NVIDIA RTX 30/40 series, RTX 20 series, AMD GPU, Intel iGPU, CPU-only) without manual intervention.
- Runtime supervisor catches and fixes ≥ 5 distinct training/inference failure modes from the bug-report backlog.
