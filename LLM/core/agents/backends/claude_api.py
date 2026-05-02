"""Claude API backend — Anthropic SDK, billed by API key.

Lists models only when ``ANTHROPIC_API_KEY`` is set. The same model ids show
up in the dropdown as the CLI backend, but with "(API)" suffix and routed
through the SDK so calls are billed and don't depend on a Claude Code session.

Vision: when a user message carries an ``attachments`` list of image
items, each image's bytes are inlined as an Anthropic ``image`` content
block alongside the text. Audio attachments are intentionally NOT
re-inlined here — their transcript is already in the message's text body
(see ``orchestrator.run_goal`` and ``attachments.build_augmented_request``).
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
    ("claude-opus-4-7",   "Claude Opus 4.7 (API)",   "premium"),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6 (API)", "mid"),
    ("claude-haiku-4-5",  "Claude Haiku 4.5 (API)",  "cheap"),
]


class ClaudeAPIBackend:
    name = "claude_api"

    def list_entries(self) -> List[ModelEntry]:
        has_key = bool(os.environ.get("ANTHROPIC_API_KEY"))
        note = "" if has_key else "(set ANTHROPIC_API_KEY)"
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
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        try:
            import anthropic
        except ImportError as exc:
            raise RuntimeError(
                "anthropic SDK not installed. Run: pip install anthropic"
            ) from exc

        # Anthropic separates the system prompt from the conversation array.
        system_parts: list[str] = []
        convo: list[dict] = []
        for m in messages:
            role = (m.get("role") or "user").lower()
            content = m.get("content") or ""
            if role == "system":
                system_parts.append(content)
            elif role in ("user", "assistant"):
                # If the user message carries image attachments, build a
                # multi-part content list (image blocks first, then text)
                # so Anthropic sees the picture before the prompt that
                # references it. Otherwise pass the plain string for the
                # cheaper, non-multipart wire format.
                image_paths = extract_image_paths(m) if role == "user" else []
                if image_paths:
                    parts: list[dict] = []
                    for enc in encode_image_paths(image_paths):
                        parts.append(
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": enc.mime,
                                    "data": enc.b64_data,
                                },
                            }
                        )
                    parts.append({"type": "text", "text": content})
                    convo.append({"role": role, "content": parts})
                else:
                    convo.append({"role": role, "content": content})

        client = anthropic.Anthropic()
        # Prompt caching on the system message — large role prompts get reused
        # across the agent loop, so caching here is a real win on long runs.
        system_block = None
        if system_parts:
            system_block = [
                {
                    "type": "text",
                    "text": "\n\n".join(system_parts),
                    "cache_control": {"type": "ephemeral"},
                }
            ]

        kwargs: dict = {
            "model": model_key,
            "max_tokens": 2048,
            "messages": convo or [{"role": "user", "content": "(no input)"}],
        }
        if system_block is not None:
            kwargs["system"] = system_block

        resp = client.messages.create(**kwargs)
        return "".join(block.text for block in resp.content if getattr(block, "text", None))


register_backend(ClaudeAPIBackend())
