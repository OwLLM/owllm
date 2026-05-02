"""Attachments — audio and image inputs that ride along with a goal.

A goal can arrive with one or more attachments:

* **audio** (voice messages from chat / Telegram / WhatsApp)
* **image** (photos sent from chat / Telegram / WhatsApp)

Audio gets passed through :mod:`media_transcribe` so the LLM sees the
spoken words as text. Images currently surface as a labelled stub in
the user request; a follow-up pass will inline image bytes for
vision-capable backends, but the stub keeps every backend usable today.

Files are stored under
``<runtime>/attachments/<goal_id>/<unique-name>`` and removed when the
goal is deleted by ``ProjectStore`` (or manually). The goal id keeps
files together so a single ``rm -rf`` cleans up an entire conversation.
"""
from __future__ import annotations

import logging
import mimetypes
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

logger = logging.getLogger(__name__)


KIND_AUDIO = "audio"
KIND_IMAGE = "image"

# Allow-list of MIME prefixes per kind. Anything outside is rejected at
# save time so a stray PDF or video can't slip into the audio pipeline.
_AUDIO_PREFIXES = ("audio/",)
_IMAGE_PREFIXES = ("image/",)

# Hard cap on a single attachment (50 MB). Keeps the disk usage and
# whisper transcription time bounded; the bridges enforce the same cap
# before downloading remote media.
MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024


@dataclass
class Attachment:
    """One piece of media riding along with a user goal."""

    kind: str               # KIND_AUDIO | KIND_IMAGE
    path: str               # absolute path on disk
    mime: str               # e.g. "audio/ogg" or "image/jpeg"
    source: str = "chat"    # where it came from: "chat" | "telegram" | "whatsapp"
    caption: str = ""       # optional human caption (Telegram photo caption, WA image caption…)
    transcript: str = ""    # filled in for audio after media_transcribe runs
    original_name: str = "" # filename as the user/bridge supplied it (for display)
    duration_sec: float = 0.0  # audio duration if known (transcribers can fill in)

    def is_audio(self) -> bool:
        return self.kind == KIND_AUDIO

    def is_image(self) -> bool:
        return self.kind == KIND_IMAGE

    def display_name(self) -> str:
        return self.original_name or os.path.basename(self.path)

    def to_meta(self) -> dict:
        """Serialisable form for ``Message.meta`` / persistence."""
        return {
            "kind": self.kind,
            "path": self.path,
            "mime": self.mime,
            "source": self.source,
            "caption": self.caption,
            "transcript": self.transcript,
            "original_name": self.original_name,
            "duration_sec": self.duration_sec,
        }

    @classmethod
    def from_meta(cls, raw: dict) -> "Attachment":
        return cls(
            kind=str(raw.get("kind") or KIND_AUDIO),
            path=str(raw.get("path") or ""),
            mime=str(raw.get("mime") or ""),
            source=str(raw.get("source") or "chat"),
            caption=str(raw.get("caption") or ""),
            transcript=str(raw.get("transcript") or ""),
            original_name=str(raw.get("original_name") or ""),
            duration_sec=float(raw.get("duration_sec") or 0.0),
        )


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def _runtime_root() -> Path:
    """Where attachments and bundled runtime artefacts live.

    Resolved from the repo's `LLM/runtime/` directory so attachments
    sit next to the existing whisper / wheelhouse / models folders.
    """
    here = Path(__file__).resolve()
    # core/agents/attachments.py → LLM/runtime
    llm_root = here.parents[2]
    return llm_root / "runtime"


def attachments_dir(goal_id: str) -> Path:
    base = _runtime_root() / "attachments" / (goal_id or "loose")
    base.mkdir(parents=True, exist_ok=True)
    return base


def save_bytes_for_goal(
    goal_id: str,
    data: bytes,
    *,
    suggested_name: str,
    mime: str,
    source: str,
    caption: str = "",
) -> Optional[Attachment]:
    """Persist ``data`` under the goal's attachments dir and return an Attachment.

    Returns ``None`` if the MIME type isn't allow-listed for either
    audio or image, or if the payload exceeds :data:`MAX_ATTACHMENT_BYTES`.
    The cap is enforced here as a defence in depth — the bridges already
    refuse oversized media before downloading.
    """
    if not data:
        return None
    if len(data) > MAX_ATTACHMENT_BYTES:
        logger.warning(
            "attachment %s rejected: %d bytes exceeds %d cap",
            suggested_name, len(data), MAX_ATTACHMENT_BYTES,
        )
        return None
    kind = classify_mime(mime, suggested_name)
    if kind is None:
        logger.warning("attachment %s rejected: unsupported mime %r", suggested_name, mime)
        return None

    base = attachments_dir(goal_id)
    safe = _safe_filename(suggested_name) or f"{uuid.uuid4().hex}.bin"
    target = base / f"{uuid.uuid4().hex[:8]}_{safe}"
    target.write_bytes(data)
    return Attachment(
        kind=kind,
        path=str(target),
        mime=mime or _guess_mime(safe) or "application/octet-stream",
        source=source,
        caption=caption,
        original_name=suggested_name,
    )


def adopt_local_path(
    goal_id: str,
    src_path: str,
    *,
    source: str = "chat",
    caption: str = "",
) -> Optional[Attachment]:
    """Move a local file (e.g. user-picked from Open dialog) into the goal's
    attachment dir.

    The file is *copied* so the user's original isn't deleted — they may
    have picked something from their Documents folder. Returns ``None``
    when the file is missing, oversized, or has an unsupported MIME.
    """
    p = Path(src_path)
    if not p.is_file():
        return None
    try:
        size = p.stat().st_size
    except OSError:
        return None
    if size > MAX_ATTACHMENT_BYTES:
        logger.warning("attachment %s rejected: %d bytes exceeds cap", p.name, size)
        return None
    mime = _guess_mime(p.name) or ""
    kind = classify_mime(mime, p.name)
    if kind is None:
        return None
    try:
        data = p.read_bytes()
    except OSError as exc:
        logger.warning("could not read %s: %s", p, exc)
        return None
    return save_bytes_for_goal(
        goal_id,
        data,
        suggested_name=p.name,
        mime=mime,
        source=source,
        caption=caption,
    )


def _safe_filename(name: str) -> str:
    keep = "._-"
    return "".join(c for c in (name or "") if c.isalnum() or c in keep)[:80]


def _guess_mime(name: str) -> Optional[str]:
    mt, _ = mimetypes.guess_type(name)
    return mt


def classify_mime(mime: str, fallback_name: str = "") -> Optional[str]:
    """Map a MIME type (or filename) to one of our supported kinds.

    Returns ``KIND_AUDIO`` / ``KIND_IMAGE`` or ``None`` if neither fits.
    Falls back to extension-based guessing when ``mime`` is blank — some
    bridges don't always supply a content-type header.
    """
    m = (mime or "").lower().strip()
    if not m and fallback_name:
        m = (_guess_mime(fallback_name) or "").lower()
    if any(m.startswith(p) for p in _AUDIO_PREFIXES):
        return KIND_AUDIO
    if any(m.startswith(p) for p in _IMAGE_PREFIXES):
        return KIND_IMAGE
    return None


# ---------------------------------------------------------------------------
# Prompt augmentation
# ---------------------------------------------------------------------------


def attachments_to_prompt_block(attachments: Sequence[Attachment]) -> str:
    """Render a human-readable block describing the attachments.

    Used to splice a description of the media into the user's text request
    so every backend (including local llama-cpp without vision) sees
    *something* about each attachment. For audio, the transcript itself
    is inlined. For images, a labelled stub is used until the
    vision-passthrough pass lands.
    """
    if not attachments:
        return ""
    lines: List[str] = []
    for i, att in enumerate(attachments, start=1):
        if att.is_audio():
            transcript = (att.transcript or "").strip()
            head = f"[attachment {i} — voice message ({att.display_name()})"
            if att.duration_sec:
                head += f", {att.duration_sec:.1f}s"
            head += "]"
            if transcript:
                lines.append(f"{head}\n{transcript}")
            else:
                lines.append(f"{head}\n(no transcript available)")
        elif att.is_image():
            cap = (att.caption or "").strip()
            head = f"[attachment {i} — image: {att.display_name()}, {att.mime}]"
            lines.append(head + (f"\nUser caption: {cap}" if cap else ""))
    return "\n\n".join(lines)


def build_augmented_request(
    user_text: str,
    attachments: Sequence[Attachment],
) -> str:
    """Combine the user's text with a description of every attachment.

    Returns a single request body the orchestrator can use as-is. When
    there are no attachments, the original text is returned unchanged.
    """
    block = attachments_to_prompt_block(attachments)
    if not block:
        return user_text or ""
    if not (user_text or "").strip():
        return block
    return f"{user_text.strip()}\n\n---\n{block}"


def attachments_to_meta(attachments: Sequence[Attachment]) -> dict:
    """Pack an attachment list into a dict suitable for ``Message.meta``."""
    return {"attachments": [a.to_meta() for a in attachments]}


def attachments_from_meta(meta: Optional[dict]) -> List[Attachment]:
    if not meta:
        return []
    raw = meta.get("attachments") or []
    out: List[Attachment] = []
    for item in raw:
        if isinstance(item, dict):
            try:
                out.append(Attachment.from_meta(item))
            except Exception:
                logger.exception("could not deserialise attachment meta")
    return out
