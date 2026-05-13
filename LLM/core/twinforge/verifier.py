"""TwinForge verifier — second-opinion subagent.

The VLM ('eyes') sometimes hallucinates: it claimed the agents-page
canvas had "no connection lines" when the React code clearly draws
8 `<line>` spokes. When that happens, the Coder spends its budget
chasing nonexistent gaps and the real problems persist.

This module adds the missing step. Same Claude model as the VLM but
running with code access (the Claude CLI's Read/Grep tools), not just
images. For each VLM finding it:

  1. Reads the relevant replica file(s) and the PySide6 source widget.
  2. Confirms whether SOURCE really shows what the VLM described.
  3. Confirms whether TARGET really lacks it.
  4. Decides which replica file owns the gap (AppShell.tsx /
     AgentsPage.tsx / styles.css / ...).
  5. Tightens the suggested fix into something a per-file Coder can
     apply without re-reading everything.

The output is a list of `VerifiedFinding`s grouped by surface; the
caller then dispatches one parallel Coder per surface.

The whole verification is a SINGLE Claude CLI call (one prompt with
all findings + all replica files). One round-trip ~ N findings is far
cheaper than N CLI spin-ups; the model is plenty wide enough for it.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from core.twinforge.vlm_diff import VLMDifference

_log = logging.getLogger(__name__)


@dataclass
class VerifiedFinding:
    description: str
    severity: str            # high | med | low
    location: str            # human description from the VLM
    suggestion: str          # tightened fix instruction
    status: str              # "verified" | "rejected" | "ambiguous"
    surface: str             # which replica file owns this (basename)
    source_evidence: str     # pointer into PySide6 source proving SOURCE has X
    target_evidence: str     # pointer into React code showing what TARGET has
    rejection_reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _claude_cli_path() -> Optional[str]:
    return shutil.which("claude")


def _run_claude_cli(prompt: str, model: str,
                    *, timeout: Optional[float] = None,
                    cwd: Optional[str] = None) -> str:
    exe = _claude_cli_path()
    if exe is None:
        raise RuntimeError("claude CLI not found on PATH")
    cmd = [exe, "--print", "--model", model,
           "--dangerously-skip-permissions"]
    proc = subprocess.run(
        cmd, input=prompt,
        capture_output=True, text=True,
        timeout=timeout, check=False,
        encoding="utf-8", errors="replace",
        cwd=cwd,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"claude verifier exited {proc.returncode}. "
            f"stderr: {(proc.stderr or '').strip()[:400]} | "
            f"stdout: {(proc.stdout or '').strip()[:400]}"
        )
    return (proc.stdout or "").strip()


def _extract_json(text: str) -> Optional[dict]:
    if not text:
        return None
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        cleaned = re.sub(r"```(?:json)?\s*|\s*```", "", m.group(0))
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            return None


_VERIFIER_PROMPT = """You are TwinForge's verifier subagent.

A perception agent (VLM) just looked at two screenshots and produced a
list of visual differences between SOURCE (Qt reference) and TARGET
(React replica). The VLM sees images only — it doesn't read code. Some
of its findings are wrong: it sometimes claims TARGET is missing
elements that ARE rendered, just styled differently.

Your job: for each VLM finding, verify it against the actual replica
code AND the PySide6 source code, then route it to the correct
replica file so a per-file Coder can fix it.

# YOU MUST USE YOUR TOOLS.
Call Read / Grep on:
  * Replica files (the React app):
{replica_paths}
  * PySide6 source widgets (what produced SOURCE):
{source_widget_paths}
  * The screenshots, if you need them:
    SOURCE: {src_png}
    TARGET: {tgt_png}

# For each finding, output one verdict:

* status="verified" — SOURCE really shows it AND TARGET really lacks
  it (or has it visibly wrong). Worth fixing.

* status="rejected" — VLM was wrong: either SOURCE doesn't show it
  (VLM saw something that isn't there), or TARGET already implements
  it (VLM missed existing code). Set rejection_reason.

* status="ambiguous" — can't tell from code alone (e.g. font weight,
  exact colour shade). Forward it with notes.

For verified findings, set:
  * surface — the basename of the replica file that should be edited
    (e.g. "AppShell.tsx", "AgentsPage.tsx", "styles.css"). Choose the
    file that ACTUALLY contains the element. The ModeBar/HybridFrame/
    SubTabs chrome lives in AppShell.tsx. Page bodies (canvas, panes)
    live in pages/*.tsx. Global classes (.ghost-btn, .status-dot)
    live in styles.css.
  * source_evidence — file:line range pointing at the PySide6 code
    that proves SOURCE has the feature (e.g.
    "LLM/desktop_app/main.py:4280-4310 — _build_app_header sets the
    icon image on each toggle button").
  * target_evidence — file:line range pointing at the React code
    showing the current state (e.g.
    "apps/owllm-desktop/ui/src/AppShell.tsx:85-89 — buttons render
    plain emoji glyph with no <img> tile").
  * suggestion — a tightened, ground-truth-backed fix instruction
    that names the asset / number / colour to apply.

# Return STRICT JSON, no prose:

{{
  "verdicts": [
    {{
      "finding_index": <int — 0-based, matches the input list>,
      "description": "<echo VLM description>",
      "severity":    "high" | "med" | "low",
      "location":    "<echo VLM location>",
      "status":      "verified" | "rejected" | "ambiguous",
      "surface":     "<basename of replica file>" | "",
      "source_evidence": "<file:line — what>" | "",
      "target_evidence": "<file:line — what>" | "",
      "suggestion":  "<tightened actionable fix>" | "",
      "rejection_reason": "<why rejected>" | ""
    }},
    ...
  ]
}}

# VLM FINDINGS (input)
{findings_block}
"""


class ClaudeCodeVerifier:
    """Verifier provider via Claude Code subscription CLI."""
    name = "claude-code-verifier"

    def __init__(self,
                 model: str = "claude-opus-4-7",
                 timeout: Optional[float] = None) -> None:
        self.model = model
        self.timeout = timeout

    def available(self) -> bool:
        return _claude_cli_path() is not None

    def verify(self, *,
               findings: List[VLMDifference],
               replica_files: List[Path],
               source_widget_files: List[Path],
               src_png: str,
               tgt_png: str,
               cwd: Optional[str] = None,
               ) -> List[VerifiedFinding]:
        if not findings:
            return []
        if not self.available():
            return [_unverified(f, "verifier unavailable") for f in findings]

        findings_block = "\n".join(
            f"[{i}] severity={f.severity} location={f.location!r}\n"
            f"    description: {f.description}\n"
            f"    vlm_suggestion: {f.suggestion}"
            for i, f in enumerate(findings)
        )
        replica_paths = "\n".join(f"      - {p}" for p in replica_files)
        source_widget_paths = "\n".join(f"      - {p}" for p in source_widget_files)

        prompt = _VERIFIER_PROMPT.format(
            replica_paths=replica_paths,
            source_widget_paths=source_widget_paths,
            src_png=str(Path(src_png).resolve()),
            tgt_png=str(Path(tgt_png).resolve()),
            findings_block=findings_block,
        )

        try:
            stdout = _run_claude_cli(
                prompt, model=self.model, timeout=self.timeout,
                cwd=cwd,
            )
        except Exception as exc:  # noqa: BLE001
            _log.warning("verifier CLI failed: %r", exc)
            return [_unverified(f, f"verifier crashed: {exc}") for f in findings]

        data = _extract_json(stdout)
        if not data:
            return [_unverified(f, f"verifier returned no JSON: {stdout[:200]!r}") for f in findings]

        verdicts = data.get("verdicts") or []
        out: List[VerifiedFinding] = []
        seen: set[int] = set()
        for v in verdicts:
            try:
                idx = int(v.get("finding_index"))
            except (TypeError, ValueError):
                continue
            if idx in seen or idx < 0 or idx >= len(findings):
                continue
            seen.add(idx)
            f = findings[idx]
            out.append(VerifiedFinding(
                description=str(v.get("description", f.description)).strip()[:400],
                severity=str(v.get("severity", f.severity)).strip().lower()[:6],
                location=str(v.get("location", f.location)).strip()[:200],
                suggestion=str(v.get("suggestion", f.suggestion)).strip()[:600],
                status=str(v.get("status", "ambiguous")).strip().lower()[:12],
                surface=str(v.get("surface", "")).strip()[:200],
                source_evidence=str(v.get("source_evidence", "")).strip()[:300],
                target_evidence=str(v.get("target_evidence", "")).strip()[:300],
                rejection_reason=str(v.get("rejection_reason", "")).strip()[:300],
            ))
        # Backfill any findings the verifier silently dropped — treat as
        # ambiguous so the Coder still considers them.
        for i, f in enumerate(findings):
            if i not in seen:
                out.append(_unverified(f, "verifier did not return a verdict"))
        return out


def _unverified(f: VLMDifference, reason: str) -> VerifiedFinding:
    return VerifiedFinding(
        description=f.description,
        severity=f.severity,
        location=f.location,
        suggestion=f.suggestion,
        status="ambiguous",
        surface="",
        source_evidence="",
        target_evidence="",
        rejection_reason=reason,
    )


def group_by_surface(verified: List[VerifiedFinding]) -> Dict[str, List[VerifiedFinding]]:
    """Bucket verified+ambiguous findings by which replica file owns them.

    Rejected findings are dropped entirely. Verified findings with no
    `surface` (verifier couldn't decide) fall under "unrouted" — the
    caller can choose to spread them across all surfaces or skip them.
    """
    groups: Dict[str, List[VerifiedFinding]] = {}
    for v in verified:
        if v.status == "rejected":
            continue
        key = v.surface or "unrouted"
        groups.setdefault(key, []).append(v)
    return groups


def default_provider() -> Optional[ClaudeCodeVerifier]:
    v = ClaudeCodeVerifier()
    return v if v.available() else None
