"""Golden-image storage for visual regression tests.

Baselines live under `LLM/desktop_app/tests/baselines/<name>.png`
alongside the test files that own them. A baseline is identified
by a single `name` string (the agent passes it, the test author
picks it). The file layout is intentionally flat — no subdirs —
so an agent can list `baselines_dir()` and see exactly what's
covered.

Update workflow:

* `pytest` with no env compares actual vs. baseline. Diff > tolerance
  → test fails, an `<name>.actual.png` is written next to the
  baseline so a human (or agent) can eyeball the failure.
* `pytest` with `OWLLM_UPDATE_BASELINES=1` writes captured PNGs
  to the baseline path on first run AND overwrites stale ones.
  Run after intentionally changing a widget's look.

Atomic writes: every save goes to `<name>.png.tmp` first, then
`os.replace` swaps it in. Prevents a crashed test from leaving
a half-written baseline that breaks the next run.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


# Resolved once at import. `desktop_app/tests/baselines/` keeps the
# golden files inside the tests tree so they ship with the codebase
# and are version-controlled alongside the assertions that pin them.
_BASELINES_DIR = (
    Path(__file__).resolve().parent.parent / "tests" / "baselines"
)


class BaselineMissing(FileNotFoundError):
    """Raised when a baseline is requested but no PNG exists yet.

    Distinct from generic `FileNotFoundError` so test code can
    catch it and auto-write on the `OWLLM_UPDATE_BASELINES=1` path.
    """


@dataclass(frozen=True)
class Baseline:
    """Handle to a single golden PNG on disk.

    Construct via `load_baseline(name)` to read-or-error or
    `save_baseline(name, png_bytes)` to write-or-overwrite.
    """
    name: str
    path: Path
    png: bytes


def baselines_dir() -> Path:
    """Return the directory baselines live in. Creates it on demand.

    Exposed so agent tools can list available baselines without
    inventing a parallel path convention.
    """
    _BASELINES_DIR.mkdir(parents=True, exist_ok=True)
    return _BASELINES_DIR


def load_baseline(name: str) -> Baseline:
    """Read the baseline PNG for `name`.

    Raises `BaselineMissing` if no file exists. Use
    `save_baseline(name, png_bytes)` to seed one.
    """
    path = baselines_dir() / f"{_safe_name(name)}.png"
    if not path.exists():
        raise BaselineMissing(f"no baseline at {path}")
    return Baseline(name=name, path=path, png=path.read_bytes())


def save_baseline(name: str, png: bytes) -> Baseline:
    """Atomically write PNG bytes as the baseline for `name`.

    Overwrites silently. Returns the resulting `Baseline`.
    """
    path = baselines_dir() / f"{_safe_name(name)}.png"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(png)
    os.replace(tmp, path)
    return Baseline(name=name, path=path, png=png)


def save_actual(name: str, png: bytes) -> Path:
    """Write `<name>.actual.png` next to the baseline.

    Called by the diff path when a test fails so a human or agent
    can compare side-by-side. Not atomic — these are throwaway
    artifacts, and a half-written `.actual.png` is no worse than
    no `.actual.png`.
    """
    path = baselines_dir() / f"{_safe_name(name)}.actual.png"
    path.write_bytes(png)
    return path


def _safe_name(name: str) -> str:
    """Sanitize a baseline name for the filesystem.

    Names come from test authors and (eventually) agents. Allow
    letters, digits, `_`, `-`, `.`. Everything else collapses to
    `_` so an agent that passes "Fleet/Page (top)" doesn't blow
    up — that becomes "Fleet_Page__top_".
    """
    safe = []
    for c in name:
        if c.isalnum() or c in ("_", "-", "."):
            safe.append(c)
        else:
            safe.append("_")
    return "".join(safe) or "_"
