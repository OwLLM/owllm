"""OpenAI API backend — official SDK, billed by API key.

Vision: when a user message carries an ``attachments`` list with image
items, each image's bytes are inlined as an OpenAI ``image_url`` content
part (as a ``data:`` URI) alongside the text. Audio attachments are NOT
re-inlined here — their transcript is already in the message body via
``orchestrator.run_goal`` / ``attachments.build_augmented_request``.
"""
from __future__ import annotations

import logging
import os
from typing import Any, List, Mapping

from core.agents.backends.base import ModelEntry, register_backend
from core.agents.vision import encode_image_paths, extract_image_paths

logger = logging.getLogger(__name__)


_MODELS = [
    # (key, display, cost_tier)
    ("gpt-5",       "GPT-5 (API)",       "premium"),
    ("gpt-5-codex", "GPT-5 Codex (API)", "premium"),
    ("gpt-4o",      "GPT-4o (API)",      "mid"),
    ("o3",          "o3 (API)",          "premium"),
]


class OpenAIAPIBackend:
    name = "openai_api"

    def list_entries(self) -> List[ModelEntry]:
        has_key = bool(os.environ.get("OPENAI_API_KEY"))
        note = "" if has_key else "(set OPENAI_API_KEY)"
        return [
            ModelEntry(
                backend=self.name,
                model_key=key,
                display=display + (f"  {note}" if note else ""),
                available=has_key,
                note=note,
                cost_tier=tier,
            )
            for key, display, tier in _MODELS
        ]

    def generate(self, messages: List[Mapping[str, Any]], model_key: str) -> str:
        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY not set")
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise RuntimeError(
                "openai SDK not installed. Run: pip install openai"
            ) from exc

        # Build the OpenAI messages array. User messages with images
        # become a multipart ``content`` list (image_url parts + a text
        # part); plain text messages stay as the cheaper string form.
        clean: list[dict] = []
        for m in messages:
            role = (m.get("role") or "user").lower()
            if role not in ("system", "user", "assistant"):
                continue
            content = m.get("content") or ""
            image_paths = extract_image_paths(m) if role == "user" else []
            if image_paths:
                parts: list[dict] = []
                for enc in encode_image_paths(image_paths):
                    parts.append(
                        {
                            "type": "image_url",
                            "image_url": {"url": enc.to_data_uri()},
                        }
                    )
                if content:
                    parts.append({"type": "text", "text": content})
                clean.append({"role": role, "content": parts})
            else:
                clean.append({"role": role, "content": content})
        if not clean:
            clean = [{"role": "user", "content": "(no input)"}]

        client = OpenAI()
        resp = client.chat.completions.create(model=model_key, messages=clean)
        return (resp.choices[0].message.content or "").strip()


register_backend(OpenAIAPIBackend())
