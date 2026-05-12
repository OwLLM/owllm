"""Vision-language-model diff — the missing 'eyes' for the agent.

What it does
------------
Sends two screenshots (source + target) to a vision-capable LLM with a
structured prompt asking it to list visual differences in the form
the user would normally surface manually. The output is treated as
another diff dimension alongside `pixel_pct`, `ssim`, and `mean_lab_distance`
in the per-region report, plus a top-level "perceived differences" list
that captures things no widget-tree-based aligner can see:

  * Untagged decorative elements (frame badges, owl crests, background art)
  * Custom-painted regions (the QPainter-drawn agent canvas — one widget
    on the Qt side, dozens of perceived 'objects' to a human)
  * Semantic content (`an owl avatar is missing from the centre`,
    `the right-pane MODEL picker row is absent`)
  * State coverage (`the source shows a selected agent but the target
    doesn't`)

Why it matters
--------------
The original agent (v1–v9) was *implicitly* doing this — me staring at
two screenshots in chat and listing what differed. The structural agent
we built since then does measurement; VLM diff adds back perception so
the two complement each other.

Architecture
------------
`VLMProvider` is the interface; one provider impl per backend. Today:

  * `AnthropicVLM` — uses the Anthropic Messages API
                     (https://api.anthropic.com/v1/messages) directly
                     via the `requests` library. Avoids the SDK's
                     dependency churn.

  * `NullVLM`     — no-op stub used when no API key is configured, so
                     the rest of the pipeline keeps working.

Adding a new provider is a 30-line file: implement `compare(src_png,
tgt_png) -> list[VLMDifference]`. No core changes.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List, Optional, Protocol


_log = logging.getLogger(__name__)


@dataclass
class VLMDifference:
    """One difference the VLM perceived between the two images."""
    description: str
    severity: str = "med"          # "high" | "med" | "low"
    location: str = ""             # human description, e.g. "top centre"
    suggestion: str = ""           # how to fix in the target
    src_box: Optional[list] = None  # [x, y, w, h] if VLM gave coords; else None
    tgt_box: Optional[list] = None

    def to_dict(self) -> dict:
        return asdict(self)


class VLMProvider(Protocol):
    name: str
    def compare(self, src_png: str, tgt_png: str,
                *, title: str = "", max_items: int = 12,
                ) -> List[VLMDifference]: ...


# ----------------------------------------------------------------------
# NullVLM — used when no provider is configured. Returns an empty list
# but emits one informational note so the report can surface "VLM diff
# disabled, set ANTHROPIC_API_KEY to enable" rather than silently skip.
# ----------------------------------------------------------------------
class NullVLM:
    name = "null"

    def compare(self, src_png: str, tgt_png: str,
                *, title: str = "", max_items: int = 12,
                ) -> List[VLMDifference]:
        return [VLMDifference(
            description=(
                "VLM diff unavailable — set ANTHROPIC_API_KEY in the "
                "environment (or wire a different provider) to enable "
                "perception-based diff."
            ),
            severity="low",
            location="(global)",
            suggestion="export ANTHROPIC_API_KEY=…",
        )]


# ----------------------------------------------------------------------
# AnthropicVLM — calls /v1/messages with both images attached. We use
# `requests` directly because the anthropic SDK has a tendency to break
# whenever pydantic / typing_extensions disagree (which they do in this
# venv right now).
# ----------------------------------------------------------------------
_PROMPT = """You are a UI replication QA agent comparing two screenshots.

* SOURCE — the reference application (Qt desktop).
* TARGET — a React replica being built to match SOURCE.

Your job: list the most important visual differences between them, in a
way a developer can use as a punch-list to improve the TARGET. Focus on
things that look obviously wrong, not 1-pixel anti-aliasing differences.

For each difference, give:
  - description : one short sentence; what's different
  - severity    : "high" (whole element wrong / missing), "med"
                   (size/position/colour clearly off), or "low" (subtle)
  - location    : a quick human description of where it is, e.g.
                  "top-centre badge", "right pane, model picker row",
                  "central agent canvas, orchestrator crest"
  - suggestion  : 1-line concrete fix the developer can apply

Return STRICT JSON only, no prose around it, in this shape:

{
  "differences": [
    {
      "description": "...",
      "severity": "high",
      "location": "...",
      "suggestion": "..."
    },
    ...
  ]
}

Limit to at most %d differences, sorted by severity then visual impact.
Skip any difference you'd consider too minor to fix.
"""


class AnthropicVLM:
    name = "anthropic"

    def __init__(self,
                 api_key: Optional[str] = None,
                 model: str = "claude-opus-4-7",
                 max_tokens: int = 4096,
                 timeout: float = 60.0,
                 ) -> None:
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self.model = model
        self.max_tokens = max_tokens
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.api_key)

    def compare(self, src_png: str, tgt_png: str,
                *, title: str = "", max_items: int = 12,
                ) -> List[VLMDifference]:
        if not self.api_key:
            return NullVLM().compare(src_png, tgt_png,
                                     title=title, max_items=max_items)
        import requests  # local import — only needed when we actually call
        from PIL import Image
        from io import BytesIO

        def _png_b64(p: str, max_w: int = 1500) -> str:
            """Re-encode + downscale large screenshots so we don't burn
            VLM context on full-resolution pixels. 1500 px wide is the
            sweet spot: still legible for buttons/labels, ~10x smaller
            payload than the raw 1700-px capture."""
            img = Image.open(p).convert("RGB")
            if img.width > max_w:
                r = max_w / img.width
                img = img.resize((max_w, int(img.height * r)), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="PNG", optimize=True)
            return base64.b64encode(buf.getvalue()).decode("ascii")

        src_b64 = _png_b64(src_png)
        tgt_b64 = _png_b64(tgt_png)
        user_prompt = _PROMPT % max_items
        if title:
            user_prompt = f"# Context\n{title}\n\n" + user_prompt

        body = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Image 1 — SOURCE (reference Qt app):"},
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": src_b64,
                    }},
                    {"type": "text", "text": "Image 2 — TARGET (React replica):"},
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": tgt_b64,
                    }},
                    {"type": "text", "text": user_prompt},
                ],
            }],
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
            _log.warning("VLM API call failed: %r", exc)
            return [VLMDifference(
                description=f"VLM diff call failed: {exc}",
                severity="low", location="(global)",
                suggestion="check the network / API key / model name",
            )]

        try:
            payload = r.json()
            text = "".join(
                block.get("text", "")
                for block in payload.get("content", [])
                if block.get("type") == "text"
            ).strip()
        except Exception as exc:  # noqa: BLE001
            return [VLMDifference(
                description=f"could not parse VLM response: {exc}",
                severity="low",
            )]

        # Pull the first {...} JSON block out of the response — the
        # model usually returns clean JSON but occasionally wraps it in
        # prose despite the prompt. Robust to both.
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return [VLMDifference(
                description=f"VLM returned no JSON: {text[:200]!r}",
                severity="low",
            )]
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError as exc:
            return [VLMDifference(
                description=f"VLM JSON malformed: {exc}",
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


def default_provider() -> VLMProvider:
    """Pick the best provider available in the current environment."""
    p = AnthropicVLM()
    if p.available():
        return p
    return NullVLM()
