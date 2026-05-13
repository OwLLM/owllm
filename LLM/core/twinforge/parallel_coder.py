"""Parallel multi-surface Coder dispatch.

The single-Coder-edits-one-file design from the original TwinForge
made a mistake: it anchored every prompt on a single working file, so
findings that lived in OTHER replica files got ignored. Even when the
prompt explicitly said "you may edit AppShell.tsx too", the model
kept its edits inside the working copy and the chrome problems
persisted.

This module replaces that with a per-surface team. After the
Verifier groups findings by which file owns them:

    AppShell.tsx        : 3 high + 1 med findings
    AgentsPage.tsx      : 2 high findings
    styles.css          : 1 med finding

we spawn ONE Claude CLI per non-empty group, each with:

  * A working copy of JUST that file.
  * ONLY the findings routed to it.
  * The PySide6 source ground-truth for that surface
    (e.g. AppShell.tsx -> main.py::_build_app_header excerpt).
  * The asset list and screenshots.

The N CLIs run in parallel (ThreadPoolExecutor). Each writes to its
own working copy. The caller promotes the working copies back to the
real replica files after all coders finish.

Net effect: the chrome and the page body can be fixed in the same
TwinForge round.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from core.twinforge.coder import CodeFix
from core.twinforge.verifier import VerifiedFinding

_log = logging.getLogger(__name__)


@dataclass
class SurfaceBrief:
    """Per-file work order assembled by the dispatcher."""
    surface: str                       # basename, e.g. "AppShell.tsx"
    replica_path: Path                 # absolute path to the live file
    working_path: Path                 # absolute path to the *_PATCH_*.tsx copy
    findings: List[VerifiedFinding]
    source_excerpt: str                # PySide6 ground-truth excerpt
    asset_block: str                   # repo-relative asset list
    src_png: str
    tgt_png: str
    cwd: str                           # repo root for the CLI


_PER_SURFACE_PROMPT = """You are TwinForge's per-surface coder for
`{surface}`. Another subagent already verified that each finding below
is real (not hallucinated by the VLM) and that this file is where it
should be fixed. You are the only coder editing this file in this
round, so DO NOT skip findings expecting another agent to handle them.

# Working file (edit IN PLACE — do NOT print code back):
  {working_path}

The file is a working copy of:
  {replica_path}
Edits land here. The orchestrator promotes the working copy back
afterwards.

# Reference screenshots
  SOURCE: {src_png}
  TARGET: {tgt_png}

# HARD RULES
1. Use your Edit/Read tools on the working file. Many small Edits
   beats one big Write.
2. Use REAL source assets — every PNG in the asset block below is on
   disk. Reference via `<img src=...>` with the relative URL shown.
   Do NOT invent emoji glyphs or coloured rectangles to stand in for
   the real assets.
3. Use the PySide6 source ground-truth below to find exact numbers:
   sizes, colours, font sizes, geometry. If the source code shows
   `width=114`, set width to 114 in the React file — not 120.
4. Each verified finding includes `source_evidence` (file:line) and
   `target_evidence` (file:line). Read those locations first; the
   exact code is there.
5. Stay inside `{surface}`. If you find yourself wanting to edit a
   different file, leave a TODO in the working file instead.

# When finished
Print one line: "DONE {surface} — N edits applied"
Then briefly enumerate which finding indexes you closed.

# VERIFIED FINDINGS (handle ALL of them — they were chosen for you)
{findings_block}

# PYSIDE6 GROUND TRUTH (excerpts of the Qt code that drew SOURCE)
{source_excerpt}

# AVAILABLE SOURCE ASSETS
{asset_block}
"""


def _claude_cli_path() -> Optional[str]:
    return shutil.which("claude")


def _run_one_coder(brief: SurfaceBrief, *, model: str,
                   timeout: Optional[float] = None) -> CodeFix:
    """Drive one Claude CLI for one surface. Reads the patched file
    back as the CodeFix.patch payload."""
    exe = _claude_cli_path()
    if exe is None:
        return CodeFix(
            description="claude CLI not on PATH",
            file_path=str(brief.replica_path),
            patch="", is_full_file=False, confidence="low",
        )

    findings_block = "\n\n".join(
        f"[{i}] severity={v.severity} location={v.location!r}\n"
        f"    description: {v.description}\n"
        f"    suggestion:  {v.suggestion}\n"
        f"    source_evidence: {v.source_evidence}\n"
        f"    target_evidence: {v.target_evidence}"
        for i, v in enumerate(brief.findings)
    )

    prompt = _PER_SURFACE_PROMPT.format(
        surface=brief.surface,
        working_path=str(brief.working_path),
        replica_path=str(brief.replica_path),
        src_png=brief.src_png,
        tgt_png=brief.tgt_png,
        findings_block=findings_block or "(no findings — should not happen)",
        source_excerpt=brief.source_excerpt or "(no PySide6 excerpt)",
        asset_block=brief.asset_block or "(no asset block)",
    )

    cmd = [exe, "--print", "--model", model,
           "--dangerously-skip-permissions"]
    try:
        proc = subprocess.run(
            cmd, input=prompt,
            capture_output=True, text=True,
            timeout=timeout, check=False,
            encoding="utf-8", errors="replace",
            cwd=brief.cwd,
        )
    except subprocess.TimeoutExpired:
        return CodeFix(
            description=f"{brief.surface}: timeout",
            file_path=str(brief.replica_path),
            patch="", is_full_file=False, confidence="low",
        )

    if proc.returncode != 0:
        return CodeFix(
            description=(
                f"{brief.surface}: claude CLI exit {proc.returncode}. "
                f"stderr={(proc.stderr or '').strip()[:200]} "
                f"stdout={(proc.stdout or '').strip()[:200]}"
            ),
            file_path=str(brief.replica_path),
            patch="", is_full_file=False, confidence="low",
        )

    try:
        new_content = brief.working_path.read_text(encoding="utf-8")
    except OSError as exc:
        return CodeFix(
            description=f"{brief.surface}: could not read patched file: {exc}",
            file_path=str(brief.replica_path),
            patch="", is_full_file=False, confidence="low",
        )

    summary = (proc.stdout or "").splitlines()
    first = next((s.strip() for s in summary if s.strip()), "(no summary)")
    return CodeFix(
        description=first[:300],
        file_path=str(brief.replica_path),
        patch=new_content,
        is_full_file=True,
        confidence="high",
    )


def dispatch_parallel(
    *,
    grouped_findings: Dict[str, List[VerifiedFinding]],
    surface_files: Dict[str, Path],
    source_excerpts: Dict[str, str],
    asset_block: str,
    src_png: str,
    tgt_png: str,
    cwd: str,
    model: str = "claude-opus-4-7",
    timeout: Optional[float] = None,
    max_workers: int = 4,
) -> List[CodeFix]:
    """Dispatch one Claude CLI per surface in parallel.

    Args:
      grouped_findings: surface basename -> verified findings
      surface_files:    surface basename -> absolute Path to the live file
      source_excerpts:  surface basename -> PySide6 ground-truth excerpt
      asset_block:      shared asset list block (paths + relative URLs)
      src_png / tgt_png: screenshot paths (shared)
      cwd:              repo root for the CLIs
      model:            Claude model id
      timeout:          per-call timeout (None = no inner timeout)
      max_workers:      thread pool size

    Returns one CodeFix per launched coder. Each fix's `patch` field is
    the new full-file content read back from the working copy.
    """
    stamp = datetime.now().strftime("%y%m%d_%H%M%S")
    briefs: List[SurfaceBrief] = []
    for surface, findings in grouped_findings.items():
        if surface == "unrouted":
            continue   # no file to edit — skip
        path = surface_files.get(surface)
        if path is None or not path.exists():
            _log.warning("no replica path for surface %s; skipping", surface)
            continue
        if not findings:
            continue
        working = path.with_name(f"{path.stem}_PATCH_{stamp}{path.suffix}")
        shutil.copy2(path, working)
        briefs.append(SurfaceBrief(
            surface=surface,
            replica_path=path,
            working_path=working,
            findings=findings,
            source_excerpt=source_excerpts.get(surface, ""),
            asset_block=asset_block,
            src_png=str(Path(src_png).resolve()),
            tgt_png=str(Path(tgt_png).resolve()),
            cwd=cwd,
        ))

    if not briefs:
        return []

    _log.info("dispatching %d parallel coders: %s",
              len(briefs), [b.surface for b in briefs])

    results: List[CodeFix] = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futs = {
            pool.submit(_run_one_coder, b,
                        model=model, timeout=timeout): b
            for b in briefs
        }
        for fut in as_completed(futs):
            brief = futs[fut]
            try:
                fix = fut.result()
            except Exception as exc:  # noqa: BLE001
                fix = CodeFix(
                    description=f"{brief.surface}: dispatcher exc: {exc}",
                    file_path=str(brief.replica_path),
                    patch="", is_full_file=False, confidence="low",
                )
            results.append(fix)
    return results
