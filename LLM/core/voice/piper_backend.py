"""Piper TTS backend — neural voices, fully local, CPU-friendly.

`Piper <https://github.com/rhasspy/piper>`_ is the open-source neural
TTS engine OWLLM uses for the "natural voice" upgrade over Windows
SAPI. Voice models are small (~12-60 MB ONNX files), run faster than
realtime on CPU, and produce noticeably more natural speech than the
SAPI voices that ship with Windows.

Files on disk
-------------

Voice files live under ``LLM/data/voices/piper/`` with two companion
files per voice:

* ``<voice_id>.onnx``       — the model weights
* ``<voice_id>.onnx.json``  — config (sample rate, phoneme map, …)

If the directory is empty or the ``piper-tts`` package isn't importable
the backend constructor raises so :func:`tts_service._select_backend`
falls through to the next backend (pyttsx3 / SAPI).

Audio playback
--------------

Synthesised WAV bytes go to a temp file then through the platform's
built-in audio player — ``winsound`` on Windows, ``afplay`` on macOS,
``aplay`` on Linux. No new audio dependencies.
"""
from __future__ import annotations

import io
import logging
import os
import subprocess
import sys
import tempfile
import threading
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Voice catalog (curated subset of rhasspy/piper-voices)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PiperVoiceCatalogEntry:
    voice_id: str    # filename stem, e.g. "en_US-amy-low"
    label: str       # display name in the picker
    language: str    # display language tag
    quality: str     # "low" / "medium" / "high"
    size_mb: int     # approximate combined download size in MB
    url_onnx: str
    url_json: str


_HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"


def _hf_pair(lang: str, region: str, name: str, quality: str) -> Tuple[str, str]:
    """Build the (onnx, json) URL pair for a HuggingFace-hosted voice."""
    base = (
        f"{_HF_BASE}/{lang}/{lang}_{region}/{name}/{quality}/"
        f"{lang}_{region}-{name}-{quality}"
    )
    return (base + ".onnx", base + ".onnx.json")


# Small curated set: covers male/female, US/UK, low and medium quality.
# "low" voices are ~12 MB and 16 kHz — perfect for first-install download.
# "medium" voices are ~60 MB and 22 kHz — sound noticeably better.
PIPER_CATALOG: Tuple[PiperVoiceCatalogEntry, ...] = (
    PiperVoiceCatalogEntry(
        "en_US-amy-low",
        "Amy — US English, female (low)",
        "English (US)", "low", 12,
        *_hf_pair("en", "US", "amy", "low"),
    ),
    PiperVoiceCatalogEntry(
        "en_US-ryan-low",
        "Ryan — US English, male (low)",
        "English (US)", "low", 12,
        *_hf_pair("en", "US", "ryan", "low"),
    ),
    PiperVoiceCatalogEntry(
        "en_US-lessac-medium",
        "Lessac — US English, neutral (medium)",
        "English (US)", "medium", 60,
        *_hf_pair("en", "US", "lessac", "medium"),
    ),
    PiperVoiceCatalogEntry(
        "en_US-libritts_r-medium",
        "LibriTTS-R — US English, multi-speaker (medium)",
        "English (US)", "medium", 75,
        *_hf_pair("en", "US", "libritts_r", "medium"),
    ),
    PiperVoiceCatalogEntry(
        "en_GB-alan-low",
        "Alan — UK English, male (low)",
        "English (UK)", "low", 12,
        *_hf_pair("en", "GB", "alan", "low"),
    ),
    PiperVoiceCatalogEntry(
        "en_GB-northern_english_male-medium",
        "Northern English Male (medium)",
        "English (UK)", "medium", 60,
        *_hf_pair("en", "GB", "northern_english_male", "medium"),
    ),
)


DEFAULT_VOICE_ID = "en_US-amy-low"
"""Voice the one-click "Install natural voices" path downloads. Smallest
combined size (~12 MB) so the install finishes in seconds even on slow
links — users can download bigger / different voices afterwards."""


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------


def piper_voices_dir() -> Path:
    """Where Piper ONNX voice files live."""
    llm_root = Path(__file__).resolve().parent.parent.parent
    return llm_root / "data" / "voices" / "piper"


def list_installed_piper_voice_files() -> List[Path]:
    """ONNX voice files present on disk, sorted by name."""
    d = piper_voices_dir()
    if not d.exists():
        return []
    return sorted(d.glob("*.onnx"))


def find_catalog_entry(voice_id: str) -> Optional[PiperVoiceCatalogEntry]:
    for entry in PIPER_CATALOG:
        if entry.voice_id == voice_id:
            return entry
    return None


def is_piper_importable() -> bool:
    """True if ``import piper`` succeeds."""
    try:
        import piper  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# Voice downloader
# ---------------------------------------------------------------------------


ProgressFn = Callable[[str], None]


def download_piper_voice(
    entry: PiperVoiceCatalogEntry,
    *,
    progress: Optional[ProgressFn] = None,
) -> Path:
    """Download the ONNX + JSON pair for ``entry`` into ``piper_voices_dir()``.

    Returns the ONNX path. Skips files that already exist with non-zero
    size — re-running this is cheap and idempotent.

    ``progress`` is a ``Callable[[str], None]`` invoked with short status
    strings; the UI pipes these into a progress label.
    """
    d = piper_voices_dir()
    d.mkdir(parents=True, exist_ok=True)
    onnx_path = d / f"{entry.voice_id}.onnx"
    json_path = d / f"{entry.voice_id}.onnx.json"
    p = progress or (lambda _msg: None)

    # Lazy import — keeps the module load cost zero on machines that
    # never trigger a download.
    import requests

    # JSON first: small, fast, and PiperVoice.load() reads both. If the
    # JSON 404s we'd rather know before pulling the 60 MB ONNX.
    for url, dest in ((entry.url_json, json_path), (entry.url_onnx, onnx_path)):
        if dest.exists() and dest.stat().st_size > 0:
            p(f"already have {dest.name}")
            continue
        p(f"downloading {dest.name} from {url.split('/')[-2]}/…")
        try:
            with requests.get(url, stream=True, timeout=120) as r:
                r.raise_for_status()
                tmp = dest.with_suffix(dest.suffix + ".part")
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1 << 16):
                        if chunk:
                            f.write(chunk)
                tmp.replace(dest)
        except Exception:
            # Clean up partials so a retry isn't confused by half-downloads.
            for stray in (dest, dest.with_suffix(dest.suffix + ".part")):
                try:
                    if stray.exists():
                        stray.unlink()
                except OSError:
                    pass
            raise
        p(f"saved {dest.name} ({dest.stat().st_size // 1024} KB)")
    return onnx_path


def delete_piper_voice(voice_id: str) -> bool:
    """Remove a voice's onnx + json. Returns True if anything was deleted."""
    d = piper_voices_dir()
    removed = False
    for suffix in (".onnx", ".onnx.json"):
        p = d / f"{voice_id}{suffix}"
        try:
            if p.exists():
                p.unlink()
                removed = True
        except OSError:
            logger.exception("could not delete %s", p)
    return removed


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------


class PiperBackend:
    """Drives Piper neural TTS via the ``piper-tts`` Python package.

    The constructor raises if either:

    * ``piper-tts`` isn't importable — the package was never installed.
    * No ``*.onnx`` voices exist under :func:`piper_voices_dir` — Piper
      is useless without at least one model.

    :func:`tts_service._select_backend` catches the raise and falls
    through to the next backend, so a missing / empty install degrades
    gracefully back to SAPI.
    """

    name = "piper"

    def __init__(self) -> None:
        # Import-test here, NOT at module top-level, so importing this
        # file is always cheap. The factory probes the constructor.
        import piper  # noqa: F401
        if not list_installed_piper_voice_files():
            raise RuntimeError(
                "no Piper voices installed; download one first via "
                "core.voice.piper_backend.download_piper_voice"
            )
        self._cached_voice = None
        self._cached_voice_path: Optional[str] = None
        self._lock = threading.Lock()

    def list_voices(self) -> list:
        # Imported here to avoid a cycle: tts_service imports this module
        # via ``_select_backend`` *only* when probing — pulling VoiceInfo
        # at module top would invert the dependency.
        from .tts_service import VoiceInfo
        out = []
        for path in list_installed_piper_voice_files():
            stem = path.stem  # e.g. "en_US-amy-low"
            entry = find_catalog_entry(stem)
            display = entry.label if entry is not None else stem
            out.append(
                VoiceInfo(
                    id=str(path),
                    name=display,
                    languages=(entry.language,) if entry is not None else (),
                    gender="",
                )
            )
        return out

    def speak(self, text: str, *, voice_id: str = "", rate: int = 0) -> None:
        if not text:
            return
        path = self._resolve_voice_path(voice_id)
        if path is None:
            return
        with self._lock:
            voice = self._ensure_voice_loaded(path)
            if voice is None:
                return
            wav_bytes = self._synthesize_to_wav(voice, text, rate)
        if wav_bytes:
            self._play_wav(wav_bytes)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _resolve_voice_path(self, voice_id: str) -> Optional[Path]:
        """``voice_id`` is the absolute ONNX path (what ``list_voices``
        returns). Fall back to the first installed voice if the caller
        passed an empty string or a stale path."""
        if voice_id:
            cand = Path(voice_id)
            if cand.exists():
                return cand
        files = list_installed_piper_voice_files()
        return files[0] if files else None

    def _ensure_voice_loaded(self, path: Path):
        if self._cached_voice_path == str(path) and self._cached_voice is not None:
            return self._cached_voice
        from piper import PiperVoice
        try:
            self._cached_voice = PiperVoice.load(str(path))
            self._cached_voice_path = str(path)
            return self._cached_voice
        except Exception:
            logger.exception("Piper voice load failed: %s", path)
            self._cached_voice = None
            self._cached_voice_path = None
            return None

    @staticmethod
    def _synthesize_to_wav(voice, text: str, rate: int) -> bytes:
        """Render text → WAV bytes. ``rate`` (wpm) doesn't map cleanly
        to Piper's length_scale, so we approximate: Piper's default is
        ~175 wpm at length_scale=1.0; we invert the ratio to get a
        rough wpm match."""
        length_scale = None
        if rate and rate > 0:
            length_scale = max(0.5, min(2.0, 175.0 / float(rate)))
        try:
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wav:
                kwargs = {}
                if length_scale is not None:
                    kwargs["length_scale"] = length_scale
                voice.synthesize(text, wav, **kwargs)
            return buf.getvalue()
        except Exception:
            logger.exception("Piper synthesize failed")
            return b""

    @staticmethod
    def _play_wav(wav_bytes: bytes) -> None:
        """Write WAV to a temp file and hand it to the OS audio player.

        Synchronous on Windows (winsound blocks until done); asynchronous
        on macOS/Linux is fine because the calling worker thread is
        already serialized — every Piper utterance plays end-to-end before
        the next one starts.
        """
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(wav_bytes)
                tmp = f.name
        except OSError:
            logger.exception("could not write piper temp wav")
            return
        try:
            if sys.platform == "win32":
                import winsound
                winsound.PlaySound(tmp, winsound.SND_FILENAME)
            elif sys.platform == "darwin":
                subprocess.run(["afplay", tmp], check=False)
            else:
                # ``aplay`` is part of alsa-utils, present on every
                # mainstream Linux distro. ``-q`` suppresses the banner.
                subprocess.run(["aplay", "-q", tmp], check=False)
        except Exception:
            logger.exception("audio playback failed")
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
