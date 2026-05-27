"""Image encoding helpers for vision-capable backends.

Both Claude and OpenAI accept image bytes inline in the messages array,
just in different shapes:

* **Claude**:   ``{"type":"image","source":{"type":"base64","media_type":...,"data":...}}``
* **OpenAI**:   ``{"type":"image_url","image_url":{"url":"data:<mime>;base64,<data>"}}``

Both want base64-encoded payload + MIME type, so the heavy lifting (read
the file, sniff the MIME, base64 encode) is shared here. Each backend
just wraps the result in its own envelope.

A safety cap is enforced (8 MB after base64 expansion) — vision payloads
balloon a context window quickly and a 50 MB image makes the round-trip
cost more than any sensible response is worth.
"""
from __future__ import annotations

import base64
import logging
import mimetypes
import os
from dataclasses import dataclass
from typing import Iterable, List, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)


# Base64 inflates by ~33%. Cap the *encoded* payload at 8 MB → roughly
# 6 MB of original image, which is plenty for a phone photo and keeps the
# context cost predictable.
MAX_ENCODED_IMAGE_BYTES = 8 * 1024 * 1024


@dataclass
class EncodedImage:
    """Image ready to splice into a provider-specific content block."""

    mime: str
    b64_data: str
    source_path: str  # for diagnostics / logging only

    def to_data_uri(self) -> str:
        return f"data:{self.mime};base64,{self.b64_data}"


def _guess_mime(path: str) -> str:
    mt, _ = mimetypes.guess_type(path)
    return mt or "image/jpeg"


def encode_image_file(path: str) -> Optional[EncodedImage]:
    """Read + base64-encode one image file.

    Returns ``None`` if the file is missing, unreadable, oversized, or
    not actually an image MIME — in which case the caller should silently
    skip it. We never raise, so a corrupt attachment never breaks an
    otherwise-fine model call.
    """
    if not path or not os.path.isfile(path):
        return None
    mime = _guess_mime(path)
    if not mime.startswith("image/"):
        return None
    try:
        raw = open(path, "rb").read()
    except OSError as exc:
        logger.warning("could not read image %s: %s", path, exc)
        return None
    encoded = base64.b64encode(raw).decode("ascii")
    if len(encoded) > MAX_ENCODED_IMAGE_BYTES:
        logger.warning(
            "image %s rejected: %d encoded bytes exceeds %d cap",
            path, len(encoded), MAX_ENCODED_IMAGE_BYTES,
        )
        return None
    return EncodedImage(mime=mime, b64_data=encoded, source_path=path)


# ---------------------------------------------------------------------------
# Helpers for backend message-pipeline integration
# ---------------------------------------------------------------------------


def extract_image_paths(message: Mapping) -> List[str]:
    """Pull image paths off a single chat message's ``attachments`` field.

    The agent stores attachments on user messages as a list of dicts
    (the serialised :class:`Attachment.to_meta` form). Only image
    attachments are returned here — audio is already inlined as text
    via the orchestrator's prompt augmentation, so backends don't need
    to re-process it.
    """
    raw = message.get("attachments") if hasattr(message, "get") else None
    out: List[str] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        if (item.get("kind") or "") != "image":
            continue
        path = item.get("path") or ""
        if path:
            out.append(path)
    return out


def encode_image_paths(paths: Iterable[str]) -> List[EncodedImage]:
    """Convenience wrapper: skip-on-failure, preserve order."""
    out: List[EncodedImage] = []
    for p in paths:
        enc = encode_image_file(p)
        if enc is not None:
            out.append(enc)
    return out
