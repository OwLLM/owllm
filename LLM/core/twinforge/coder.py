"""Coder providers — the 'hands' of TwinForge.

The agent's missing capability: take the diff report + VLM findings +
the current state of the replica file, and emit a code patch that
closes the gap. Different models excel at this than at perception; the
generation provider is therefore separate from `VLMProvider`. By
default both default to the same Anthropic model so a single API key
covers the whole loop.

Output contract — `CodeFix` is what every provider returns:

  description : short human summary of the change
  file_path   : which file to modify (relative to repo root)
  patch       : full new file content OR a unified diff (provider decides)
  is_full_file: True if `patch` is the entire new file, False if diff
  confidence  : "high" | "med" | "low"

The agent applies fixes by writing the new file (when `is_full_file`)
or by running `patch` (when it's a unified diff). For the OWLLM replica
use case we default to full-file rewrites — Anthropic models are
markedly better at "emit a full corrected file" than at unified-diff
arithmetic on long files.

Adding a new provider is a 30-line file: implement `patch(...)`. No
core changes.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import List, Optional, Protocol, Any


_log = logging.getLogger(__name__)


@dataclass
class CodeFix:
    description: str
    file_path: str
    patch: str
    is_full_file: bool = True
    confidence: str = "med"   # "high" | "med" | "low"

    def to_dict(self) -> dict:
        return asdict(self)


class CoderProvider(Protocol):
    name: str
    def patch(self, *,
              diff_text: str,
              vlm_findings: List[Any],
              target_file: str,
              max_changes: int = 6,
              ) -> List[CodeFix]: ...


# ----------------------------------------------------------------------
# NullCoder — used when no provider is configured. Returns an empty
# list but emits one informational note, same style as NullVLM.
# ----------------------------------------------------------------------
class NullCoder:
    name = "null"
    model = "—"

    def available(self) -> bool:
        return False

    def patch(self, *, diff_text: str, vlm_findings: List[Any],
              target_file: str, max_changes: int = 6) -> List[CodeFix]:
        return [CodeFix(
            description=(
                "Coder provider unavailable — set ANTHROPIC_API_KEY in "
                "the environment (or wire a different provider) to "
                "enable autonomous patching."
            ),
            file_path="(none)",
            patch="",
            is_full_file=False,
            confidence="low",
        )]


# ----------------------------------------------------------------------
# AnthropicCoder — calls /v1/messages with the diff report, VLM list,
# and the current target file. Asks for STRICT JSON containing a list
# of CodeFix dicts where each `patch` field is the COMPLETE new file
# content for the file being modified (rationale in the module
# docstring).
# ----------------------------------------------------------------------
_PROMPT = """You are TwinForge's coder agent. You receive:

  * A structural diff report from a UI replica vs its reference.
  * A list of perceived visual differences (VLM findings).
  * The current state of the target file the user is iterating on.

Your job: emit code changes that close the biggest gaps. Focus on the
HIGH-severity findings first. Skip anything you'd estimate is more
than 50 lines of new code (those go to a human).

Return STRICT JSON ONLY, no prose around it, in this shape:

{
  "fixes": [
    {
      "description": "<one short sentence — what this fix does>",
      "file_path":   "<path/to/file/being/changed.html>",
      "patch":       "<the COMPLETE new file content>",
      "is_full_file": true,
      "confidence":  "high"
    },
    ...
  ]
}

Limit to at most %d fixes, sorted by impact. Prefer one well-targeted
edit over many speculative ones.
"""


class AnthropicCoder:
    name = "anthropic"

    def __init__(self,
                 api_key: Optional[str] = None,
                 model: str = "claude-opus-4-7",
                 max_tokens: int = 16384,
                 timeout: float = 240.0,
                 ) -> None:
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self.model = model
        self.max_tokens = max_tokens
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.api_key)

    def patch(self, *, diff_text: str, vlm_findings: List[Any],
              target_file: str, max_changes: int = 6) -> List[CodeFix]:
        if not self.api_key:
            return NullCoder().patch(
                diff_text=diff_text, vlm_findings=vlm_findings,
                target_file=target_file, max_changes=max_changes,
            )
        import requests

        # Truncate the target file at a sensible cap so we don't burn
        # context on long files. 200k chars is enough for any UI replica
        # we'd realistically iterate on.
        target_content = ""
        try:
            target_content = Path(target_file).read_text(encoding="utf-8")[:200_000]
        except Exception as exc:  # noqa: BLE001
            _log.warning("could not read target file %r: %r", target_file, exc)

        vlm_summary = "\n".join(
            f"- [{getattr(f, 'severity', 'med')}] {getattr(f, 'description', '')} "
            f"(at {getattr(f, 'location', '?')}) → {getattr(f, 'suggestion', '')}"
            for f in (vlm_findings or [])
        )

        user_prompt = _PROMPT % max_changes
        user_prompt += (
            "\n\n# STRUCTURAL DIFF REPORT\n"
            f"{diff_text}\n\n"
            "# VLM FINDINGS\n"
            f"{vlm_summary or '(none)'}\n\n"
            f"# TARGET FILE — {target_file}\n```\n{target_content}\n```\n"
        )

        body = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": [{"role": "user", "content": user_prompt}],
        }
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        try:
            r = requests.post(
                "https://api.anthropic.com/v1/messages",
                json=body, headers=headers, timeout=self.timeout,
            )
            r.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            return [CodeFix(
                description=f"Coder API call failed: {exc}",
                file_path="(none)", patch="",
                is_full_file=False, confidence="low",
            )]

        try:
            payload = r.json()
            text = "".join(
                block.get("text", "")
                for block in payload.get("content", [])
                if block.get("type") == "text"
            ).strip()
        except Exception as exc:  # noqa: BLE001
            return [CodeFix(
                description=f"could not parse Coder response: {exc}",
                file_path="(none)", patch="",
                is_full_file=False, confidence="low",
            )]
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return [CodeFix(
                description=f"Coder returned no JSON: {text[:200]!r}",
                file_path="(none)", patch="",
                is_full_file=False, confidence="low",
            )]
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError as exc:
            return [CodeFix(
                description=f"Coder JSON malformed: {exc}",
                file_path="(none)", patch="",
                is_full_file=False, confidence="low",
            )]
        items = data.get("fixes") or []
        out: List[CodeFix] = []
        for it in items[:max_changes]:
            out.append(CodeFix(
                description=str(it.get("description", "")).strip()[:300],
                file_path=str(it.get("file_path", "")).strip()[:400],
                patch=str(it.get("patch", "")),
                is_full_file=bool(it.get("is_full_file", True)),
                confidence=str(it.get("confidence", "med")).strip().lower()[:6],
            ))
        return out


def default_provider() -> CoderProvider:
    """Pick the best provider available in the current environment."""
    p = AnthropicCoder()
    if p.available():
        return p
    return NullCoder()
