"""Build the supervisor fine-tune corpus by mining CHANGELOG.md and git log.

See LLM/docs/supervisor/FINETUNE.md "Step 1 — Build the failure corpus".

Output: LLM/bootstrap/recipes/failure_corpus_raw.jsonl

This produces *raw* labeled candidates — natural-language symptom + fix pairs
extracted from the project's own history. A second pass (LLM-assisted, gated
by human review) converts each candidate into the structured
{input: {hardware, trigger, current_env, error_log_tail},
 output: {action, args, reason, fallback}} schema documented in FINETUNE.md.

Why two stages: CHANGELOG entries are prose, the fine-tune needs JSON.
Doing the structuring inline would require an LLM call per row; running it
as a separate batch step lets us review, retry, and version-control the
raw → structured transform independently.

Usage:
    python LLM/tools/build_failure_corpus.py
    python LLM/tools/build_failure_corpus.py --since 2025-01-01
    python LLM/tools/build_failure_corpus.py --max-commits 500
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
OUT_PATH = REPO_ROOT / "LLM" / "bootstrap" / "recipes" / "failure_corpus_raw.jsonl"

FIX_KEYWORDS = (
    "fix", "bug", "crash", "regression", "error",
    "broken", "fail", "ModuleNotFoundError", "ImportError",
    "OOM", "CUDA", "ABI", "wheel", "venv",
)


@dataclass
class RawExample:
    """A scraped natural-language symptom→fix pair awaiting structuring."""
    source: str          # e.g. "changelog:Unreleased:Fixed:0" or "git:0c84a3f"
    symptom: str         # natural-language description of what failed
    fix: str             # natural-language description of the resolution
    tags: list[str]      # heuristic categories: cuda, deps, dataset, qprocess, ...
    raw_text: str        # full original text for re-extraction if needed


# ---------------------------------------------------------------------------
# CHANGELOG.md parser
# ---------------------------------------------------------------------------

_RELEASE_HDR = re.compile(r"^##\s+\[(?P<version>[^\]]+)\]")
_SECTION_HDR = re.compile(r"^###\s+(?P<section>\w+)")
_BULLET = re.compile(r"^\s*[-*]\s+(?P<body>.+)$")
_BOLD_PREFIX = re.compile(r"^\*\*(?P<title>[^*]+)\*\*\s*[:.–-]?\s*(?P<rest>.*)$")


def parse_changelog(path: Path) -> Iterable[RawExample]:
    if not path.exists():
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    version = "unknown"
    section = None
    bullet_idx = 0
    current: list[str] | None = None

    def flush():
        nonlocal current, bullet_idx
        if current is None:
            return
        body = "\n".join(current).strip()
        if body and section in {"Fixed", "Changed"}:
            yield_ex = _build_example_from_bullet(body, version, section, bullet_idx)
            if yield_ex is not None:
                bullet_idx += 1
                examples_out.append(yield_ex)
        current = None

    examples_out: list[RawExample] = []

    for raw in lines:
        if (m := _RELEASE_HDR.match(raw)):
            flush()
            version = m.group("version")
            section = None
            bullet_idx = 0
            continue
        if (m := _SECTION_HDR.match(raw)):
            flush()
            section = m.group("section")
            bullet_idx = 0
            continue
        if (m := _BULLET.match(raw)):
            flush()
            current = [m.group("body")]
            continue
        # continuation of a bullet — indented or blank-line-separated prose
        if current is not None and (raw.startswith("  ") or raw.startswith("\t")):
            current.append(raw.strip())
            continue
        if current is not None and raw.strip() == "":
            current.append("")
            continue
        # any other line ends the current bullet
        flush()

    flush()
    yield from examples_out


def _build_example_from_bullet(
    body: str, version: str, section: str, idx: int,
) -> RawExample | None:
    title, rest = _split_title(body)
    if not title and not rest:
        return None

    # Heuristic: section "Fixed" → bullet describes a real failure + fix.
    # Section "Changed" → only include if it mentions failure-y keywords
    # (some refactors are fixes in disguise: "replaced subprocess loop that …").
    full = f"{title}\n{rest}".strip()
    if section == "Changed" and not _looks_failurey(full):
        return None

    symptom, fix = _split_symptom_fix(full)
    return RawExample(
        source=f"changelog:{version}:{section}:{idx}",
        symptom=symptom,
        fix=fix,
        tags=_classify(full),
        raw_text=full,
    )


def _split_title(body: str) -> tuple[str, str]:
    m = _BOLD_PREFIX.match(body)
    if m:
        return m.group("title").strip(), m.group("rest").strip()
    return "", body.strip()


def _looks_failurey(text: str) -> bool:
    low = text.lower()
    return any(k.lower() in low for k in FIX_KEYWORDS)


def _split_symptom_fix(text: str) -> tuple[str, str]:
    """Best-effort split of "X happened. We did Y." into (X, Y).

    Heuristic: the first sentence is usually the symptom, the rest the fix.
    """
    parts = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)
    if len(parts) == 2:
        return parts[0].strip(), parts[1].strip()
    return text.strip(), ""


def _classify(text: str) -> list[str]:
    low = text.lower()
    tags: list[str] = []
    for tag, needles in _TAGS.items():
        if any(n in low for n in needles):
            tags.append(tag)
    return tags or ["uncategorized"]


_TAGS: dict[str, tuple[str, ...]] = {
    "cuda":          ("cuda", "cudnn", "nvidia", "vram", "gpu"),
    "torch":         ("torch", "pytorch", "bitsandbytes", "bnb", "abi"),
    "deps":          ("pip", "wheel", "venv", "site-packages", "modulenotfound", "importerror", "package"),
    "subprocess":    ("subprocess", "qprocess", "popen", "createprocess", "console", "win_subprocess"),
    "windows":       ("hwnd", "qwidget", "createprocess", "win32", "windows"),
    "training":      ("training", "finetune", "lora", "dataset", "tokenize"),
    "inference":     ("inference", "model load", "probe", "gguf", "llama-cpp", "completion"),
    "ui":            ("qlabel", "qpushbutton", "splash", "tab", "widget", "page"),
    "mcp":           ("mcp", "github_importer"),
    "installer":     ("installer", "bootstrap", "onboarding", "self_heal"),
}


# ---------------------------------------------------------------------------
# git log parser
# ---------------------------------------------------------------------------


def parse_git_log(repo: Path, since: str | None, max_commits: int) -> Iterable[RawExample]:
    fmt = "%H%x1f%s%x1f%b%x1e"  # unit-separator + record-separator
    cmd = ["git", "log", f"--pretty=format:{fmt}", f"--max-count={max_commits}"]
    if since:
        cmd.append(f"--since={since}")
    try:
        out = subprocess.check_output(cmd, cwd=repo, text=True, errors="replace")
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"warning: git log failed: {e}", file=sys.stderr)
        return

    records = [r for r in out.split("\x1e") if r.strip()]
    for rec in records:
        try:
            sha, subject, body = rec.split("\x1f", 2)
        except ValueError:
            continue
        subject = subject.strip()
        if not _looks_failurey(subject):
            continue
        symptom, fix = _split_symptom_fix(f"{subject}\n{body}".strip())
        yield RawExample(
            source=f"git:{sha[:7]}",
            symptom=symptom,
            fix=fix,
            tags=_classify(f"{subject}\n{body}"),
            raw_text=f"{subject}\n{body}".strip(),
        )


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--since", default=None, help="git --since (e.g. 2025-01-01)")
    ap.add_argument("--max-commits", type=int, default=2000)
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    ap.add_argument("--dry-run", action="store_true", help="print stats, don't write")
    args = ap.parse_args()

    examples: list[RawExample] = []
    examples.extend(parse_changelog(CHANGELOG))
    examples.extend(parse_git_log(REPO_ROOT, args.since, args.max_commits))

    seen: set[str] = set()
    deduped: list[RawExample] = []
    for ex in examples:
        key = ex.symptom[:200].lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(ex)

    print(f"changelog + git -> {len(examples)} candidates, {len(deduped)} after dedup")
    by_tag: dict[str, int] = {}
    for ex in deduped:
        for t in ex.tags:
            by_tag[t] = by_tag.get(t, 0) + 1
    for tag, n in sorted(by_tag.items(), key=lambda kv: -kv[1]):
        print(f"  {tag:14s} {n}")

    if args.dry_run:
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        for ex in deduped:
            f.write(json.dumps(asdict(ex), ensure_ascii=False) + "\n")
    print(f"\nwrote {len(deduped)} raw candidates -> {args.out.relative_to(REPO_ROOT)}")
    print("next: structure these into the {input, output} schema (see FINETUNE.md).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
