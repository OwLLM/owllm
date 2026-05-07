"""OWLLM voice output — agents speak their final replies.

The package exposes a single entry point :func:`get_tts_service`. The first
caller starts a worker thread and subscribes to the agent bus for
``MessageKind.REPLY`` messages; every subsequent caller gets the same
instance.

Engines are pluggable via the :class:`TtsBackend` protocol. v1 ships with
:class:`Pyttsx3Backend` (system TTS — Windows SAPI / NSSpeech / espeak).
Future backends (piper, llama-tts, edge-tts) drop in by implementing the
same protocol.
"""
from .tts_service import (
    TtsBackend,
    TtsService,
    get_tts_service,
    is_voice_available,
)
from .piper_backend import (
    PIPER_CATALOG,
    DEFAULT_VOICE_ID as DEFAULT_PIPER_VOICE_ID,
    PiperVoiceCatalogEntry,
    delete_piper_voice,
    download_piper_voice,
    fetch_piper_catalog,
    find_catalog_entry as find_piper_catalog_entry,
    is_piper_importable,
    list_installed_piper_voice_files,
    piper_voices_dir,
)

__all__ = [
    "TtsBackend",
    "TtsService",
    "get_tts_service",
    "is_voice_available",
    "PIPER_CATALOG",
    "DEFAULT_PIPER_VOICE_ID",
    "PiperVoiceCatalogEntry",
    "delete_piper_voice",
    "download_piper_voice",
    "fetch_piper_catalog",
    "find_piper_catalog_entry",
    "is_piper_importable",
    "list_installed_piper_voice_files",
    "piper_voices_dir",
]
