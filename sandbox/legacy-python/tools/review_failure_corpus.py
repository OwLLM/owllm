"""Stage 3 of the supervisor corpus pipeline -- human review CLI.

Walks `failure_corpus_structured.jsonl` row by row, shows the user the raw
symptom + the model's structured output, and lets them ACCEPT / REJECT / EDIT
each row. Accepted rows graduate to `failure_corpus.jsonl` (the file the
fine-tune actually trains on) with `meta.verified_human=true`.

This is intentionally a tiny terminal UI -- review is the bottleneck, but it
benefits more from low-friction binary decisions than from polish.

Keyboard:
    a / enter  -> accept (write to final corpus)
    r          -> reject (drop)
    e          -> edit JSON in $EDITOR (or notepad on Windows fallback)
    s          -> skip (leave for later, neither accept nor reject)
    q          -> save progress and quit
    h          -> help

Usage:
    python LLM/tools/review_failure_corpus.py
    python LLM/tools/review_failure_corpus.py --include-review-queue
    python LLM/tools/review_failure_corpus.py --resume   # continues where last quit
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
STRUCTURED = REPO_ROOT / "LLM" / "bootstrap" / "recipes" / "failure_corpus_structured.jsonl"
REVIEW_QUEUE = REPO_ROOT / "LLM" / "bootstrap" / "recipes" / "failure_corpus_needs_review.jsonl"
FINAL = REPO_ROOT / "LLM" / "bootstrap" / "recipes" / "failure_corpus.jsonl"
PROGRESS = REPO_ROOT / "LLM" / "bootstrap" / "recipes" / ".review_progress.json"


# ---------------------------------------------------------------------------
# Pretty-print
# ---------------------------------------------------------------------------


def show(row: Mapping[str, Any], idx: int, total: int) -> None:
    src = (row.get("meta") or {}).get("source", "?")
    tags = ", ".join((row.get("meta") or {}).get("tags") or [])
    print()
    print("=" * 78)
    print(f"[{idx + 1}/{total}]  source={src}  tags=[{tags}]")
    print("-" * 78)
    raw = (row.get("meta") or {}).get("raw_symptom", "")
    if raw:
        print("RAW SYMPTOM:")
        for line in raw.splitlines()[:8]:
            print(f"  {line}")
        if len(raw.splitlines()) > 8:
            print(f"  ... [{len(raw.splitlines()) - 8} more lines]")
        print()
    print("STRUCTURED:")
    print(json.dumps(
        {"input": row.get("input"), "output": row.get("output")},
        indent=2, ensure_ascii=False,
    ))
    nrr = (row.get("meta") or {}).get("needs_review_reason")
    if nrr:
        print(f"\nMODEL NOTE: {nrr}")


def edit_row(row: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Open the row's input/output in $EDITOR; return updated row or None on no-change."""
    editable = {"input": row.get("input"), "output": row.get("output")}
    fd, tmp_path = tempfile.mkstemp(suffix=".json", text=True)
    os.close(fd)
    Path(tmp_path).write_text(
        json.dumps(editable, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    editor = os.environ.get("EDITOR")
    if not editor:
        editor = "notepad" if os.name == "nt" else "vi"
    try:
        subprocess.run([editor, tmp_path], check=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"editor failed: {e}")
        Path(tmp_path).unlink(missing_ok=True)
        return None

    try:
        edited = json.loads(Path(tmp_path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"edit produced invalid JSON: {e}")
        Path(tmp_path).unlink(missing_ok=True)
        return None
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    new_row = dict(row)
    new_row["input"] = edited.get("input")
    new_row["output"] = edited.get("output")
    return new_row


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def load_jsonl(path: Path) -> list[Mapping[str, Any]]:
    if not path.exists():
        return []
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def append_jsonl(path: Path, row: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def load_progress() -> dict[str, int]:
    if not PROGRESS.exists():
        return {}
    try:
        return json.loads(PROGRESS.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_progress(state: dict[str, int]) -> None:
    PROGRESS.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS.write_text(json.dumps(state, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Loop
# ---------------------------------------------------------------------------


HELP = """
Commands:
  a / <enter>  accept (write to final corpus, mark verified_human)
  r            reject (drop this row)
  e            open in editor, then re-prompt
  s            skip (leave in queue)
  q            save progress + quit
  h            this help
"""


def review(rows: list[Mapping[str, Any]], source_label: str, start: int = 0) -> int:
    """Returns the index of the next-unreviewed row (for resume)."""
    i = start
    while i < len(rows):
        row = rows[i]
        show(row, i, len(rows))
        try:
            choice = input("\n[a/r/e/s/q/h]> ").strip().lower()
        except EOFError:
            print()
            return i
        if choice in ("", "a"):
            row = dict(row)
            meta = dict(row.get("meta") or {})
            meta["verified_human"] = True
            row["meta"] = meta
            append_jsonl(FINAL, row)
            i += 1
        elif choice == "r":
            i += 1
        elif choice == "s":
            i += 1
        elif choice == "e":
            new_row = edit_row(row)
            if new_row is not None:
                rows[i] = new_row
            # don't advance -- re-prompt so user can accept the edit
        elif choice == "q":
            return i
        elif choice == "h":
            print(HELP)
        else:
            print("unknown -- h for help")
    return i


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--include-review-queue", action="store_true",
                    help="also walk failure_corpus_needs_review.jsonl")
    ap.add_argument("--resume", action="store_true",
                    help="continue from last saved progress")
    args = ap.parse_args()

    progress = load_progress() if args.resume else {}

    structured_rows = load_jsonl(STRUCTURED)
    if not structured_rows:
        print(f"no structured rows at {STRUCTURED}", file=sys.stderr)
        print("run LLM/tools/structure_failure_corpus.py first", file=sys.stderr)
        return 2

    print(f"reviewing {len(structured_rows)} structured rows -> {FINAL.relative_to(REPO_ROOT)}")
    print("(h for help)")

    start = progress.get("structured", 0) if args.resume else 0
    next_idx = review(structured_rows, "structured", start=start)
    progress["structured"] = next_idx
    save_progress(progress)

    if args.include_review_queue:
        review_rows = load_jsonl(REVIEW_QUEUE)
        if review_rows:
            print(f"\nreviewing {len(review_rows)} flagged rows from queue")
            start = progress.get("review_queue", 0) if args.resume else 0
            next_idx = review(review_rows, "review_queue", start=start)
            progress["review_queue"] = next_idx
            save_progress(progress)

    # final stats
    final_rows = load_jsonl(FINAL)
    print()
    print(f"final corpus: {len(final_rows)} verified rows -> {FINAL.relative_to(REPO_ROOT)}")
    if len(final_rows) >= 3000:
        print("ready for fine-tuning (target was 3k+ examples).")
    else:
        print(f"need {3000 - len(final_rows)} more examples to reach the v1 target.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
