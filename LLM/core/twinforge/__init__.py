"""TwinForge — cross-platform UI replication + testing agent.

Architecture
------------
Two LLM-backed providers + many platform adapters, all over a tiny
generic core:

    [adapters/qt]                  capture
    [adapters/web]    ─────────►   structural tree dump + screenshot
    [adapters/uia]  (future)       ───────────────────────►
    [adapters/flutter] (future)                            │
                                                            ▼
                                  [diff.py]      region-aware metrics
                                                 (pixel %, SSIM, ΔE,
                                                  style mismatch, …)
                                                            │
                                                            ▼
       perception API    ───►   [vlm_diff.py]   "list what differs"
                                                            │
                                                            ▼
       generation API    ───►   [coder.py]      "patch the target to
                                                 close the gap"
                                                            │
                                                            ▼
                                  [html_report.py / agent.py]
                                                 written to disk

Providers are pluggable. By default both perception and generation use
the same Anthropic model (configurable). New backends slot in by
implementing the provider protocol — no core changes.

The whole pipeline is platform-blind: it just sees `CaptureResult`s
and produces `RegionDiff` / `VLMDifference` / `CodeFix` objects.
"""
