# P1-4 · Model warmup / broken GGUF / OOM legibility — notes

Completed 2026-06-13. Probes: 5 classifier unit tests with real llama.cpp
stderr shapes (CUDA OOM, Vulkan OOM, corrupt-magic GGUF, unknown
architecture, clean log → None) + a LIVE probe that fed the actual
llama-server.exe a corrupt GGUF and asserted the classifier names it
bad_model (probe_broken_gguf_named_by_classifier, 0.61s).

## The three distinct messages

1. **Cold/warmup** — streamLocalChat already retried 503/502 against the
   /health-backed supervisor (NO sleeps; llama-ready event exists). What
   was missing: when the 120s retry budget expires while STILL 503, the
   error now says "still warming up … watch the Server page", instead of
   falling through to a generic HTTP error.
2. **Broken GGUF** — server.rs keeps a rolling 120-line stderr tail per
   child; on the running→dead transition, `classify_crash(tail)` names the
   cause. Patterns: "invalid magic", "unknown model architecture",
   "error loading model", … → "model file broken or incompatible;
   re-download / update the engine".
3. **OOM** — "out of memory", "cudaMalloc failed", "ErrorOutOfDeviceMemory",
   "failed to allocate", … → "didn't fit in memory; smaller quant / fewer
   GPU layers / smaller context".

Frontend: terminal network errors in streamLocalChat now consult
server_status FIRST (local endpoints only — `infer.remote` guards it), so
"crashed because OOM" reaches the chat bubble instead of "network error".

## Lessons

- stderr names the cause where exit codes can't: OOM and bad-GGUF often
  die with the SAME NTSTATUS. The pre-existing `crash_hint_for(code)` is
  now the fallback, stderr classification the primary.
- Current llama-server (the shipped build) prints "invalid magic
  characters: 'Junk', expected 'GGUF'" — keep the match on the stable
  prefix "invalid magic", not the full sentence (wording varies across
  llama.cpp versions).
- streamLocalChat is genuinely SHARED (AgentsPage imports it) — local-path
  fixes don't need the §0.4 double-edit; that rule is for the CLOUD
  dispatch copies.

## Remaining risks

- OOM classification is unit-tested against real stderr shapes but not
  live-triggered (no way to safely OOM the dev 4090 quickly). If a user
  reports a misclassified OOM, capture their Server-page log tail and add
  it to the test set.
- In-flight OOM (model loaded, dies mid-generation on KV growth) kills
  the SSE stream mid-read — consumeOpenAISse will surface a read error,
  not the named cause, until the NEXT request consults server_status.
