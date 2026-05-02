"""Audio transcription via faster-whisper.

Lazy-loaded so the (heavy) model only initialises when a goal arrives
with an audio attachment. The model is cached as a process-wide
singleton — subsequent calls reuse the in-memory model. The model
files are downloaded on first use into ``LLM/runtime/whisper/`` and
reused thereafter.

Defaults:

* model size: ``base`` (multilingual; ~145 MB on disk; reasonable CPU
  speed on a modern laptop). Override with the ``OWLLM_WHISPER_MODEL``
  env var (``tiny``, ``base``, ``small``, ``medium``, ``large-v3``).
* compute type: ``int8`` (CTranslate2 quantised — fastest on CPU,
  trivially small memory footprint).

Failure mode: if ``faster-whisper`` isn't installed, every transcribe
call returns an empty string and logs a warning. The caller (see
:func:`process_attachments`) is responsible for surfacing that to the
user via the prompt block instead of crashing the goal.
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Iterable, Optional, Sequence

from .attachments import Attachment

logger = logging.getLogger(__name__)


_DEFAULT_MODEL = "base"
_DEFAULT_COMPUTE = "int8"

_lock = threading.Lock()
_model = None  # type: ignore[var-annotated]
_model_load_error: Optional[str] = None


def _runtime_root() -> Path:
    here = Path(__file__).resolve()
    return here.parents[2] / "runtime"


def _whisper_cache_dir() -> Path:
    p = _runtime_root() / "whisper"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _resolve_model_size() -> str:
    return (os.environ.get("OWLLM_WHISPER_MODEL") or _DEFAULT_MODEL).strip() or _DEFAULT_MODEL


def is_available() -> bool:
    """Return True if faster-whisper is importable in the current env."""
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _ensure_model():
    """Lazy-create (and cache) the WhisperModel.

    Returns ``None`` if faster-whisper isn't installed or model load
    fails — callers must tolerate a None model and skip transcription
    instead of crashing the run.
    """
    global _model, _model_load_error
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            _model_load_error = (
                "faster-whisper is not installed in this env — "
                "audio attachments will be passed through without a transcript. "
                f"({exc})"
            )
            logger.warning(_model_load_error)
            return None
        try:
            size = _resolve_model_size()
            cache = str(_whisper_cache_dir())
            logger.info("loading faster-whisper model %s (cache=%s)", size, cache)
            _model = WhisperModel(
                size,
                device="cpu",
                compute_type=_DEFAULT_COMPUTE,
                download_root=cache,
            )
            return _model
        except Exception as exc:  # noqa: BLE001
            _model_load_error = f"could not load whisper model: {exc}"
            logger.exception("whisper model load failed")
            _model = None
            return None


def last_load_error() -> Optional[str]:
    """Diagnostic helper: returns the last model-load error, if any."""
    return _model_load_error


def transcribe_audio(path: str, *, language: Optional[str] = None) -> tuple[str, float]:
    """Transcribe a single audio file.

    Returns ``(text, duration_sec)``. On any failure (model not
    installed, model load error, file unreadable, etc.) returns
    ``("", 0.0)`` so the caller can still proceed.

    ``language`` is optional — leave None to let whisper auto-detect,
    which works for English and Italian (the user's two languages).
    Pass an ISO-639 code (``"en"``, ``"it"``) to skip detection and
    save a few hundred ms.
    """
    if not path or not os.path.isfile(path):
        return "", 0.0
    model = _ensure_model()
    if model is None:
        return "", 0.0
    try:
        segments, info = model.transcribe(
            path,
            language=language,
            vad_filter=True,  # drops silence — produces cleaner transcripts on voice notes
            beam_size=1,      # greedy — fastest, quality is fine for short voice messages
        )
        # ``segments`` is a generator; force iteration so the model finishes work.
        text = "".join(seg.text for seg in segments).strip()
        duration = float(getattr(info, "duration", 0.0) or 0.0)
        return text, duration
    except Exception:  # noqa: BLE001
        logger.exception("whisper transcription failed for %s", path)
        return "", 0.0


def process_attachments(attachments: Sequence[Attachment]) -> None:
    """Run transcription on every audio attachment in-place.

    Mutates each ``Attachment``'s ``transcript`` and ``duration_sec``
    fields. Image attachments are left untouched (vision routing is a
    separate concern handled by the backend layer). Safe to call with
    an empty sequence.
    """
    for att in attachments:
        if not att.is_audio():
            continue
        if att.transcript:
            continue  # already transcribed (e.g. cached from a re-run)
        text, duration = transcribe_audio(att.path)
        att.transcript = text
        if duration:
            att.duration_sec = duration
