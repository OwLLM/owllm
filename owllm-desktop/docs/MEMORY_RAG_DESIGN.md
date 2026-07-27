# OwLLM Memory and RAG Design

This note documents the current memory system and the next architecture steps.
The goal is not to remember everything. The goal is to keep each run fresh while
retrieving a small, relevant, well-labeled history pack when continuity helps.

## What OwLLM Already Has

- **Per-agent episodic memory (`agent_memory`)**: loaded per specialist from the
  recent tail, currently budgeted by characters (`6000` chars / `24` turns).
- **Shared team memory / RAG (`team_memory`)**: durable facts plus
  auto-captured worklog rows, searched with a dependency-free BM25-lite keyword
  ranker.
- **Prompt-injected snapshot**: default budget is about `12` entries total,
  split between relevant facts and recent worklog; lean runs use a lower budget.
- **Memory tools**: `memory_search`, `memory_read`, `memory_write`, plus
  `[REMEMBER ...]` harvesting from plain model replies.
- **Subscription CLI history handling**:
  - Kimi uses an `8` turn / `12000` char current-request-dominant wrapper.
  - Claude, Codex, and Gemini paths each have their own prompt/history shape.
- **Vault sync**: durable facts sync through the GitHub vault; worklog remains
  local.

## Gaps

- **No semantic retrieval**: shared memory uses BM25-lite keyword ranking, so
  paraphrases and conceptual matches can be missed.
- **No model-based memory curator yet**: retrieved items are mostly injected
  directly. The deterministic context-pack formatter now labels memory as
  current-task reference material, but no agent summarizes, labels stale items,
  or chooses memory tiers adaptively.
- **Limited summarization/hierarchy**: per-agent old turns are char-truncated,
  not recursively summarized.
- **Partial proactive retrieval**: team memory is retrieved automatically per
  specialist task, but `agent_memory` is not semantically retrieved and there is
  no adaptive retrieval policy.
- **No token-aware budgeting**: character budgets approximate token usage;
  prompts are not budgeted per model/context window with reserved reply and tool
  headroom.
- **No prompt compression**: system prompt, snapshot, history, and task are
  mostly sent verbatim.
- **No full local-model overflow planner**: dispatch does not trim or summarize
  the assembled message set against the active llama.cpp context size.

## Design Direction

OwLLM should move from "memory injection" to "context curation":

1. Keep the current user request dominant.
2. Retrieve project memory before each specialist dispatch.
3. Label memory by type: durable fact, recent worklog, prior decision, stale or
   ignore, open risk.
4. Summarize older per-agent history into a running digest instead of raw
   truncation.
5. Budget by tokens and model context, not characters.
6. Add semantic retrieval when an embedding path is available, falling back to
   BM25-lite offline.

## Highest-Leverage Next Steps

1. Summarize old per-agent history instead of raw truncation.
2. Add token-aware budgeting by model/context size.
3. Add hybrid dense + sparse retrieval for team memory.
4. Add a Memory Curator / context-pack step that produces a small relevant
   history pack before the team runs.

## Research Basis

- MemGPT: tiered memory and virtual context management.
- Self-RAG: adaptive retrieval rather than blindly stuffing context.
- LongLLMLingua: prompt compression for long-context workloads.
- RULER and LoCoMo: long-context capability is uneven and should be measured.
- GraphRAG and LightRAG: graph-structured retrieval can improve broader
  sensemaking over flat retrieval.
