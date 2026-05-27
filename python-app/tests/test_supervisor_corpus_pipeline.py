"""End-to-end smoke tests for the 3-stage supervisor corpus pipeline.

Stage 1 (build_failure_corpus.py)   — extracts symptom/fix pairs from a
                                       fake CHANGELOG.md.
Stage 2 (structure_failure_corpus.py) — converts raw -> structured via a
                                       backend (stub here, never touches
                                       the network).
Stage 3 (review_failure_corpus.py)  — accept/reject a structured row,
                                       graduates it to the final corpus.

We test the in-process Python entry points, not the CLI subprocess paths,
so this is fast and runs in CI without any LLM credentials. The point is
to lock in the pipeline contract: a regression on any stage would catch
here before it bites a developer mid-corpus-build.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

# Stage 1 + 2 don't need Qt -- test directly. Stage 3's review() loop is
# input-driven; we only test its persistence helpers.
from tools import build_failure_corpus as builder  # noqa: E402
from tools import structure_failure_corpus as structurer  # noqa: E402
from tools import review_failure_corpus as reviewer  # noqa: E402


# ---------------------------------------------------------------------------
# Stage 1 -- builder
# ---------------------------------------------------------------------------


_SAMPLE_CHANGELOG = """# Changelog

## [Unreleased]

### Fixed
- **CUDA OOM during 7B training**: torch was allocating its full reserved cache before \
the user's batch size budget could kick in. Lowered the default to fit a 24GB card.
- **bitsandbytes ABI mismatch with torch 2.5**: Pin to bnb 0.44.1.

### Changed
- **Subprocess flag fix (Windows)**: pip workers no longer flash a console window. \
Replaces the visibility-first reset path that broke after the launcher split.

### Removed
- Legacy debug tracker — unused after telemetry refactor.
"""


def test_stage1_extracts_fixed_and_failurey_changed(tmp_path):
    """Builder pulls every Fixed bullet plus failure-y Changed bullets,
    drops Removed bullets entirely."""
    cl = tmp_path / "CHANGELOG.md"
    cl.write_text(_SAMPLE_CHANGELOG, encoding="utf-8")
    examples = list(builder.parse_changelog(cl))
    sources = {ex.source for ex in examples}
    # Two Fixed bullets and one failure-y Changed bullet
    assert any("Unreleased:Fixed:0" in s for s in sources)
    assert any("Unreleased:Fixed:1" in s for s in sources)
    assert any("Unreleased:Changed:0" in s for s in sources)
    # Removed section never feeds the corpus
    assert not any("Removed" in s for s in sources)


def test_stage1_tags_carry_categories(tmp_path):
    cl = tmp_path / "CHANGELOG.md"
    cl.write_text(_SAMPLE_CHANGELOG, encoding="utf-8")
    examples = list(builder.parse_changelog(cl))
    cuda_ex = next(ex for ex in examples if "CUDA OOM" in ex.symptom)
    assert "cuda" in cuda_ex.tags
    assert "training" in cuda_ex.tags or "torch" in cuda_ex.tags
    bnb_ex = next(ex for ex in examples if "bitsandbytes" in ex.symptom)
    assert "torch" in bnb_ex.tags or "deps" in bnb_ex.tags


def test_stage1_split_symptom_fix():
    sym, fix = builder._split_symptom_fix(
        "Adapter saved despite teardown crash. Treat as success."
    )
    assert sym.endswith(".")
    assert "Treat as success" in fix


# ---------------------------------------------------------------------------
# Stage 2 -- structurer (with stub backend, no network)
# ---------------------------------------------------------------------------


def test_stage2_stub_backend_routes_to_review_queue(tmp_path):
    """Stub returns needs_review=True for every row -- they should land
    in the review-queue file, never in the structured-output file."""
    raw = tmp_path / "raw.jsonl"
    raw.write_text(json.dumps({
        "source": "test:1",
        "symptom": "torch crashes on Windows after training.",
        "fix": "ignore the teardown crash, the adapter is on disk.",
        "tags": ["windows", "training"],
    }) + "\n", encoding="utf-8")

    out_struct = tmp_path / "structured.jsonl"
    out_review = tmp_path / "review.jsonl"

    backend = structurer.make_backend("stub")
    stats = structurer.Stats()

    rows_iter = structurer.iter_raw(raw, limit=None)
    rows = list(rows_iter)
    assert len(rows) == 1

    # Drive the inner loop directly without going through main()
    for row in rows:
        stats.total += 1
        text = backend.generate(structurer.build_messages(row))
        parsed = structurer.parse_response(text)
        assert parsed is not None
        envelope = {
            "input": parsed.get("input"),
            "output": parsed.get("output"),
            "meta": {
                "source": row.get("source"),
                "tags": row.get("tags", []),
                "structured_by": backend.name,
                "verified_human": False,
                "raw_symptom": row.get("symptom", "")[:500],
            },
        }
        if structurer.is_needs_review(parsed):
            envelope["meta"]["needs_review_reason"] = parsed.get("reason", "")
            with out_review.open("a", encoding="utf-8") as f:
                f.write(json.dumps(envelope) + "\n")
            stats.needs_review += 1
        else:
            with out_struct.open("a", encoding="utf-8") as f:
                f.write(json.dumps(envelope) + "\n")
            stats.structured += 1

    # Stub always flags needs_review
    assert stats.needs_review == 1
    assert stats.structured == 0
    assert not out_struct.exists()
    assert out_review.exists()


def test_stage2_parse_response_strips_markdown_fences():
    text = '```json\n{"action": "install_pkg", "args": {"name": "x"}}\n```'
    parsed = structurer.parse_response(text)
    assert parsed is not None
    assert parsed["action"] == "install_pkg"


def test_stage2_parse_response_recovers_from_trailing_garbage():
    """Models occasionally emit JSON followed by trailing prose.
    The parser should recover the JSON object."""
    text = '{"action": "abort", "args": {}} \n\nThis row was tricky to map.'
    parsed = structurer.parse_response(text)
    assert parsed is not None
    assert parsed["action"] == "abort"


def test_stage2_parse_response_returns_none_for_garbage():
    assert structurer.parse_response("not even close to json") is None


def test_stage2_is_needs_review_detects_explicit_flag():
    assert structurer.is_needs_review({"needs_review": True}) is True


def test_stage2_is_needs_review_detects_missing_output():
    assert structurer.is_needs_review({"input": {"x": 1}, "output": None}) is True


def test_stage2_is_needs_review_passes_well_formed():
    parsed = {
        "input": {"hardware": {}, "trigger": {"kind": "x"}},
        "output": {"action": "install_pkg", "args": {}},
    }
    assert structurer.is_needs_review(parsed) is False


# ---------------------------------------------------------------------------
# Stage 3 -- reviewer persistence helpers
# ---------------------------------------------------------------------------


def test_stage3_load_jsonl_skips_blank_and_malformed(tmp_path):
    p = tmp_path / "x.jsonl"
    p.write_text("\n".join([
        json.dumps({"a": 1}),
        "",
        "not json at all",
        json.dumps({"a": 2}),
    ]), encoding="utf-8")
    rows = reviewer.load_jsonl(p)
    assert [r["a"] for r in rows] == [1, 2]


def test_stage3_load_jsonl_missing_returns_empty(tmp_path):
    rows = reviewer.load_jsonl(tmp_path / "does_not_exist.jsonl")
    assert rows == []


def test_stage3_append_jsonl_creates_dirs(tmp_path):
    target = tmp_path / "deep" / "nest" / "out.jsonl"
    reviewer.append_jsonl(target, {"k": "v"})
    reviewer.append_jsonl(target, {"k": "v2"})
    rows = reviewer.load_jsonl(target)
    assert [r["k"] for r in rows] == ["v", "v2"]
