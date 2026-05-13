"""Claude Code (subscription) providers for TwinForge.

Reuses OWLLM's existing subscription auth pattern from
``core/agents/backends/claude_cli.py`` so the user's logged-in
``claude.ai`` session covers TwinForge too — no API key needed.

Each call shells out to ``claude --print --model <key>``:

  * Prompt + image references are piped via stdin (Windows-safe — the
    .cmd shim chokes on multi-line argv values, but stdin is fine).
  * Claude Code's built-in Read tool loads the referenced PNG files
    from disk; no base64-in-stdin required.
  * Stdout is the model's reply text. We parse the first JSON block
    out of it (same robust pattern the API providers use).

Two providers in this file:

  * ``ClaudeCodeVLM``   — perception (same role as ``AnthropicVLM``)
  * ``ClaudeCodeCoder`` — generation (same role as ``AnthropicCoder``)

They mirror the API providers' interface and slot into the same
``default_provider()`` chain. Available iff the ``claude`` CLI is
installed and on PATH.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, List, Optional

from core.twinforge.vlm_diff import VLMDifference, NullVLM
from core.twinforge.coder import CodeFix, NullCoder


_log = logging.getLogger(__name__)


def _claude_cli_path() -> Optional[str]:
    return shutil.which("claude")


def _run_claude_cli(prompt: str, model: str,
                    *, timeout: Optional[float] = None,
                    cwd: Optional[str] = None) -> str:
    """Invoke ``claude --print`` and return its stdout.

    Mirrors core.agents.backends.claude_cli — same stdin-piped prompt,
    same encoding, same no-inner-timeout philosophy. Raises RuntimeError
    on failure so the caller can fall back to the null provider.
    """
    exe = _claude_cli_path()
    if exe is None:
        raise RuntimeError(
            "Claude CLI not found on PATH. Install with "
            "'npm install -g @anthropic-ai/claude-code' and run "
            "'claude /login' once to authorise the subscription."
        )

    cmd = [exe, "--print", "--model", model,
           "--dangerously-skip-permissions"]
    try:
        proc = subprocess.run(
            cmd, input=prompt,
            capture_output=True, text=True,
            timeout=timeout, check=False,
            encoding="utf-8", errors="replace",
            cwd=cwd,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"claude CLI not callable: {exc}")
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"claude CLI exceeded timeout={timeout}s"
        )
    if proc.returncode != 0:
        raise RuntimeError(
            f"claude CLI exited {proc.returncode}. "
            f"stderr: {(proc.stderr or '').strip()[:400]}"
        )
    return (proc.stdout or "").strip()


def _extract_json(text: str) -> Optional[dict]:
    """Pull the first {...} JSON object out of model output."""
    if not text:
        return None
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        # Sometimes the model wraps the JSON in a fenced code block;
        # strip backticks and try once more.
        cleaned = re.sub(r"```(?:json)?\s*|\s*```", "", m.group(0))
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            return None


# ----------------------------------------------------------------------
# VLM via subscription
# ----------------------------------------------------------------------
_VLM_PROMPT = """You are TwinForge's perception agent. Two screenshots
are on disk at the paths shown below. Use your Read tool to load both,
then list the most important visual differences between them — things
a developer would want to fix in the TARGET to match the SOURCE.

Skip 1-pixel anti-aliasing differences. Focus on what looks obviously
wrong: missing elements, wrong sizes / positions, wrong text content,
wrong colours that read as different to a human glance.

Return STRICT JSON only, no prose around it:

{
  "differences": [
    {
      "description": "<one short sentence>",
      "severity":    "high" | "med" | "low",
      "location":    "<human description: top centre, right pane, …>",
      "suggestion":  "<one-line concrete fix>"
    },
    ...
  ]
}

Limit to %d items, sorted by severity then visual impact. Skip
anything too minor to fix.
"""


class ClaudeCodeVLM:
    """Perception provider that uses the Claude Code subscription CLI.

    Same role as ``AnthropicVLM`` — but routes through
    ``claude --print`` so it uses the user's ``claude.ai`` session
    instead of an API key. Slower per call (CLI spin-up + auth handshake),
    free of credential management, and trivially shareable with anyone
    already running OWLLM.
    """
    name = "claude-code"

    def __init__(self,
                 model: str = "claude-opus-4-7",
                 timeout: Optional[float] = None,
                 ) -> None:
        self.model = model
        self.timeout = timeout

    def available(self) -> bool:
        return _claude_cli_path() is not None

    def compare(self, src_png: str, tgt_png: str,
                *, title: str = "", max_items: int = 12,
                ) -> List[VLMDifference]:
        if not self.available():
            return NullVLM().compare(
                src_png, tgt_png, title=title, max_items=max_items,
            )
        src = str(Path(src_png).resolve())
        tgt = str(Path(tgt_png).resolve())
        prompt = (
            f"# SOURCE image (reference Qt app)\n{src}\n\n"
            f"# TARGET image (React replica)\n{tgt}\n\n"
            f"# CONTEXT\n{title or '(no extra context)'}\n\n"
            + (_VLM_PROMPT % max_items)
        )
        try:
            stdout = _run_claude_cli(
                prompt, model=self.model, timeout=self.timeout,
            )
        except Exception as exc:  # noqa: BLE001
            _log.warning("claude-code VLM call failed: %r", exc)
            return [VLMDifference(
                description=f"claude-code CLI failed: {exc}",
                severity="low",
                suggestion=(
                    "Check that 'claude' is on PATH and you've run "
                    "'claude /login' to authorise the subscription."
                ),
            )]
        data = _extract_json(stdout)
        if not data:
            return [VLMDifference(
                description=f"claude-code returned no JSON: {stdout[:200]!r}",
                severity="low",
            )]
        items = data.get("differences") or []
        out: List[VLMDifference] = []
        for it in items[:max_items]:
            out.append(VLMDifference(
                description=str(it.get("description", "")).strip()[:300],
                severity=str(it.get("severity", "med")).strip().lower()[:6],
                location=str(it.get("location", "")).strip()[:120],
                suggestion=str(it.get("suggestion", "")).strip()[:300],
            ))
        return out


# ----------------------------------------------------------------------
# Coder via subscription
# ----------------------------------------------------------------------
# Rewrite (2026-05-13): the old impl asked Claude to JSON-encode the
# COMPLETE new file content. For a 25k-char HTML page that's a coin-toss
# even on Opus 4.7 — one missed quote and the patch is corrupt. With
# Claude Code's subscription path the model already has Read / Edit /
# Write tools at its disposal. Far better to:
#
#   1. Make a working COPY of the target file (timestamped, never
#      overwrites the FINAL).
#   2. Tell Claude its job is to edit that working copy in-place using
#      its tools, NOT to print code back.
#   3. After it exits, just read the working copy from disk. THAT is
#      the patch.
#
# This eliminates the JSON-escape failure mode entirely and gives the
# Coder native access to the screenshots (Read tool on the PNG paths
# we hand it), so it can ground edits in the same visual data the VLM
# used.
_CODER_TOOL_PROMPT = """You are TwinForge's coder agent.

Your ONLY job: make TARGET match SOURCE more closely. You are NOT a
UI designer adding polish. You are a pixel-matcher closing the gap to
a known reference.

# YOU MUST READ THE SCREENSHOTS BEFORE EDITING.
   Call Read on:
     SOURCE: {src_png}
     TARGET: {tgt_png}
   This is not optional. The whole point is that you can SEE both
   images. If you skip this you will make bad edits.

# HARD RULES — previous runs violated these:

1. **NEVER add visual flourishes the source does not have.**
   Look at SOURCE before adding any new style. If SOURCE doesn't
   have a boxShadow, do not add one. If SOURCE doesn't have a
   gradient or glow filter, do not add one. If SOURCE doesn't have
   "iconChip" / pill / capsule wrappers around emoji icons, do not
   add them.

2. **Use EXACT numbers from the structural diff when given.**
   `width=114` means 114, not 120 or 124.

3. **DO NOT skip high-severity VLM findings just because they
   lack a number.** This is a change from previous instructions.
   For each HIGH-severity VLM item:
     a. Read SOURCE again to confirm what's there.
     b. grep / Read the target HTML to locate the relevant code
        section (use data-ui markers, asset names like
        "owl_studio_square.png" / "owl_agentic.png", or component
        function names like "HybridFrame" / "TeamCanvas").
     c. Make the change the VLM described, copying SOURCE's
        appearance — NOT adding decoration beyond it.
   It's better to attempt a high-severity fix and approximate the
   source than to leave the gap. ONLY skip if SOURCE really doesn't
   show what the VLM claims.

4. **For MED / LOW findings WITHOUT a measurement, be surgical and
   conservative.** Skip if not obvious. (For HIGH, attempt the fix.)

5. **Edits over Writes.** Each Edit changes ONE property. Many small
   Edits. Only use Write when adding a clearly-bounded new region
   (e.g. a missing inline <svg> or <img>); even then keep it small.

6. **Use REAL source assets — never invent emoji or coloured discs
   as stand-ins.** If the section "AVAILABLE SOURCE ASSETS" appears
   below, every PNG listed there is on disk and reachable from the
   replica at the relative URL shown. When replicating an iconic
   element (orchestrator owl, agent role avatars, corner ornaments,
   badges), reference the real PNG via `<img src=...>`. The previous
   run drew agent nodes as coloured discs with emoji glyphs ('SF', '|>',
   '[]' etc.) — that is the wrong direction. Use the listed PNGs.

# Working file (edit IN PLACE — do NOT print code back):
  {target}

# Reference screenshots:
  SOURCE: {src_png}
  TARGET: {tgt_png}

# How to work:
* Read SOURCE and TARGET screenshots (mandatory, see top).
* Read the diff report and VLM findings below.
* Plan: for each HIGH severity finding, decide a concrete fix you
  can make in the working file. For MED/LOW with structural numbers,
  apply them surgically.
* Make Edit calls. Re-grep / Read to verify each one landed.
* When finished, print one line: "DONE — N edits applied" + a brief
  ASCII summary of which findings you addressed. Then exit.

# STRUCTURAL DIFF REPORT (use these exact numbers when present)
{diff_text}

# PERCEPTION FINDINGS (act on HIGH; surgical-only on MED/LOW; skip
# anything SOURCE does not actually show)
{vlm_summary}

{source_context_section}
"""


class ClaudeCodeCoder:
    """Generation provider via Claude Code subscription CLI.

    Lets Claude Code edit the target file with its own Edit/Write tools
    (no JSON-encoded rewrite). The 'patch' on the returned CodeFix is
    just the new file content read back from disk — the actual change
    is already on the filesystem when this method returns.
    """
    name = "claude-code"

    def __init__(self,
                 model: str = "claude-opus-4-7",
                 timeout: Optional[float] = None,
                 ) -> None:
        self.model = model
        self.timeout = timeout

    def available(self) -> bool:
        return _claude_cli_path() is not None

    def patch(self, *,
              diff_text: str,
              vlm_findings: List[Any],
              target_file: str,
              max_changes: int = 6,
              src_png: Optional[str] = None,
              tgt_png: Optional[str] = None,
              source_context: Optional[str] = None,
              ) -> List[CodeFix]:
        if not self.available():
            return NullCoder().patch(
                diff_text=diff_text, vlm_findings=vlm_findings,
                target_file=target_file, max_changes=max_changes,
            )
        target_path = Path(target_file).resolve()
        if not target_path.exists():
            return [CodeFix(
                description=f"target file does not exist: {target_path}",
                file_path=str(target_path), patch="",
                is_full_file=False, confidence="low",
            )]

        # Make a timestamped working COPY. Claude edits this copy; the
        # caller decides whether to promote it. Never touch the
        # original target_file — that's the orchestrator's job.
        from datetime import datetime
        import shutil as _shutil
        stamp = datetime.now().strftime("%y%m%d_%H%M%S")
        suffix = target_path.suffix or ".html"
        working = target_path.with_name(
            f"{target_path.stem}_PATCH_{stamp}{suffix}"
        )
        _shutil.copy2(target_path, working)
        _log.info("claude-code coder editing working copy: %s", working)

        vlm_summary = "\n".join(
            f"- [{getattr(f, 'severity', 'med')}] {getattr(f, 'description', '')} "
            f"(at {getattr(f, 'location', '?')}) -> {getattr(f, 'suggestion', '')}"
            for f in (vlm_findings or [])
        )
        prompt = _CODER_TOOL_PROMPT.format(
            target=str(working),
            src_png=str(Path(src_png).resolve()) if src_png else "(not provided)",
            tgt_png=str(Path(tgt_png).resolve()) if tgt_png else "(not provided)",
            diff_text=diff_text,
            vlm_summary=vlm_summary or "(none)",
            source_context_section=source_context or "",
        )
        try:
            stdout = _run_claude_cli(
                prompt, model=self.model, timeout=self.timeout,
                # CLI cwd = the replica's dir, so relative asset URLs in
                # the HTML (../../../icons/…) resolve to real files when
                # the model wants to peek at them.
                cwd=str(target_path.parent),
            )
        except Exception as exc:  # noqa: BLE001
            return [CodeFix(
                description=f"claude-code CLI failed: {exc}",
                file_path=str(working), patch="",
                is_full_file=False, confidence="low",
            )]

        try:
            new_content = working.read_text(encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            return [CodeFix(
                description=f"could not read patched file back: {exc}",
                file_path=str(working), patch="",
                is_full_file=False, confidence="low",
            )]

        # First line of stdout is typically "DONE — N edits applied".
        first_line = (stdout.splitlines() or [""])[0].strip()[:200] or "(no summary)"
        return [CodeFix(
            description=first_line,
            file_path=str(working),
            patch=new_content,
            is_full_file=True,
            confidence="high",
        )]
