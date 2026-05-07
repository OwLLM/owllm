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
# Dynamic catalog (HuggingFace voices.json)
# ---------------------------------------------------------------------------


_VOICES_MANIFEST_URL = (
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json"
)


def _manifest_cache_path() -> Path:
    """Where the parsed voices.json gets cached. Same dir as the voice
    files so the data dir stays self-contained."""
    return piper_voices_dir() / "_voices_manifest.json"


def _entry_from_manifest_record(voice_id: str, record: dict) -> Optional[PiperVoiceCatalogEntry]:
    """Convert one ``voices.json`` record into a catalog entry.

    voices.json shape (excerpt)::

        "en_US-amy-low": {
            "key": "en_US-amy-low",
            "language": {"name_native": "English",
                         "country_english": "United States",
                         "code": "en_US"},
            "quality": "low",
            "files": {
                "en/en_US/amy/low/en_US-amy-low.onnx": {"size_bytes": 12345},
                "en/en_US/amy/low/en_US-amy-low.onnx.json": {"size_bytes": 4321}
            }
        }

    Returns ``None`` if the record is missing the required onnx + json
    file pair — Piper voices that don't ship those two are unusable
    here regardless of what else they advertise.
    """
    files = record.get("files") or {}
    onnx_path = next(
        (p for p in files if p.endswith(f"/{voice_id}.onnx")),
        None,
    )
    json_path = next(
        (p for p in files if p.endswith(f"/{voice_id}.onnx.json")),
        None,
    )
    if onnx_path is None or json_path is None:
        return None

    quality = str(record.get("quality") or "")
    lang = record.get("language") or {}
    # Prefer the English language name so users searching "spanish",
    # "german" etc. find the right voices. Fall back to native spelling
    # only if english isn't available.
    lang_english = str(lang.get("name_english") or "")
    lang_native = str(lang.get("name_native") or "")
    country = str(lang.get("country_english") or "")
    primary = lang_english or lang_native
    if primary and country and country.lower() not in primary.lower():
        language_label = f"{primary} ({country})"
    else:
        language_label = primary or country or "?"
    # Native spelling is appended in parentheses when it differs from
    # english — visible to users who recognise their own language better
    # in its native form, and still searchable against either spelling.
    if lang_native and lang_english and lang_native.lower() != lang_english.lower():
        language_label = f"{language_label} · {lang_native}"

    # Derive a friendly speaker name from the voice_id ("en_US-amy-low" → "Amy").
    parts = voice_id.split("-")
    speaker = parts[1] if len(parts) >= 2 else voice_id
    label = f"{speaker.replace('_', ' ').title()} — {language_label} ({quality})"

    onnx_size = int((files.get(onnx_path) or {}).get("size_bytes") or 0)
    json_size = int((files.get(json_path) or {}).get("size_bytes") or 0)
    size_mb = max(1, (onnx_size + json_size) // (1024 * 1024))

    base = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
    return PiperVoiceCatalogEntry(
        voice_id=voice_id,
        label=label,
        language=language_label,
        quality=quality,
        size_mb=size_mb,
        url_onnx=f"{base}/{onnx_path}",
        url_json=f"{base}/{json_path}",
    )


def _parse_manifest(data: dict) -> Tuple[PiperVoiceCatalogEntry, ...]:
    """Turn the raw voices.json dict into an ordered tuple of entries.

    Sort: language label, then quality (low → medium → high → x_low …),
    then voice_id. That keeps voices for the same language grouped in
    the dialog list — much easier to skim than a random hash order.
    """
    quality_rank = {"x_low": 0, "low": 1, "medium": 2, "high": 3}
    out: List[PiperVoiceCatalogEntry] = []
    for voice_id, rec in data.items():
        if not isinstance(rec, dict):
            continue
        entry = _entry_from_manifest_record(voice_id, rec)
        if entry is not None:
            out.append(entry)

    out.sort(
        key=lambda e: (
            e.language.lower(),
            quality_rank.get(e.quality, 99),
            e.voice_id,
        )
    )
    return tuple(out)


def _load_cached_manifest() -> Optional[Tuple[PiperVoiceCatalogEntry, ...]]:
    """Read + parse the on-disk cache if present."""
    path = _manifest_cache_path()
    if not path.exists():
        return None
    try:
        import json
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data:
            return _parse_manifest(data)
    except Exception:  # noqa: BLE001
        logger.exception("could not read cached voices manifest at %s", path)
    return None


def fetch_piper_catalog(
    *,
    force_refresh: bool = False,
    timeout: float = 15.0,
) -> Tuple[PiperVoiceCatalogEntry, ...]:
    """Return the live Piper voices catalog.

    Order of preference:

    1. On-disk cache (instant) unless ``force_refresh=True``.
    2. HuggingFace voices.json (~200 KB). On success the response is
       written to the cache so subsequent opens are instant.
    3. Hard-coded :data:`PIPER_CATALOG` — the curated subset shipped
       with OWLLM, used when the network is unavailable.

    Network failures NEVER raise — the manager dialog must always open,
    even offline. The caller can detect "fell back to static" by
    comparing identity with ``PIPER_CATALOG``.
    """
    if not force_refresh:
        cached = _load_cached_manifest()
        if cached is not None:
            return cached

    try:
        import json
        import requests
        r = requests.get(_VOICES_MANIFEST_URL, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        if not isinstance(data, dict) or not data:
            raise ValueError("voices.json is empty or wrong shape")
        # Persist the raw dict — re-parsing on next open is cheap and
        # lets us evolve the parser without a re-fetch.
        cache = _manifest_cache_path()
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )
        return _parse_manifest(data)
    except Exception:  # noqa: BLE001
        logger.warning(
            "could not fetch piper voices manifest; falling back to "
            "the curated catalog",
            exc_info=True,
        )
        return PIPER_CATALOG


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
    """Look up a voice in the static catalog, falling back to the cached
    dynamic catalog if the static set doesn't have it. The default-voice
    install path uses this to find the URL for ``DEFAULT_VOICE_ID``."""
    for entry in PIPER_CATALOG:
        if entry.voice_id == voice_id:
            return entry
    cached = _load_cached_manifest()
    if cached is not None:
        for entry in cached:
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
        """Render text → WAV bytes.

        piper-tts 1.2+ split synthesis into two methods:

        * ``synthesize(text, syn_config=...)`` returns an iterable of
          ``AudioChunk`` (raw PCM only, no WAV header).
        * ``synthesize_wav(text, wav_file, syn_config=...)`` writes a
          full RIFF/WAV stream to a ``wave.Wave_write`` handle.

        We use ``synthesize_wav`` when present (1.2+) and fall back to
        the legacy single-arg synthesize-to-wav signature for very old
        piper-tts builds. ``rate`` (wpm) is mapped onto
        ``SynthesisConfig.length_scale`` — Piper's default is ~175 wpm
        at length_scale=1.0, so we invert that ratio.
        """
        length_scale: Optional[float] = None
        if rate and rate > 0:
            length_scale = max(0.5, min(2.0, 175.0 / float(rate)))

        # Build a config if available — only the new API consumes it.
        cfg = None
        if length_scale is not None:
            try:
                from piper import SynthesisConfig
                cfg = SynthesisConfig(length_scale=length_scale)
            except Exception:  # noqa: BLE001
                cfg = None

        buf = io.BytesIO()
        try:
            with wave.open(buf, "wb") as wav:
                if hasattr(voice, "synthesize_wav"):
                    if cfg is not None:
                        voice.synthesize_wav(text, wav, syn_config=cfg)
                    else:
                        voice.synthesize_wav(text, wav)
                else:
                    # Legacy piper-tts < 1.2 wrote the WAV directly.
                    if length_scale is not None:
                        voice.synthesize(text, wav, length_scale=length_scale)
                    else:
                        voice.synthesize(text, wav)
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
