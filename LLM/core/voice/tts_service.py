"""TTS service — speaks agent REPLY messages from the bus.

Why this lives in ``core`` and not ``desktop_app``:

* The voice loop is a pure runtime concern (subscribe to bus, synthesize,
  play). The agent bus is shared across the GUI, MCP bridges, and any
  headless runner; routing the voice through ``core`` means a future CLI
  or daemon mode gets agent voices for free.
* The desktop page only owns the UI affordances (mute toggle, voice picker)
  and the call to :func:`get_tts_service` on page open.

Threading model:

* ``pyttsx3`` engines are NOT thread-safe and must be driven from a single
  owner thread. We start a daemon ``threading.Thread`` per process; every
  bus callback pushes a job to a ``queue.Queue`` and returns immediately
  (the bus contract: subscribers must not block).
* The owner thread loops on the queue, instantiating a fresh engine per
  utterance. Reusing one engine across utterances looks tempting, but
  pyttsx3 leaks SAPI state on Windows when ``runAndWait`` is called more
  than once on the same engine — fresh engine per utterance is the
  documented escape hatch.

Backend swap:

* The :class:`TtsBackend` protocol exposes ``speak(text, voice_id, rate)``
  and ``list_voices()``. Adding a piper / llama-tts / edge-tts backend
  is a new file plus one line in :func:`_select_backend`.
"""
from __future__ import annotations

import hashlib
import logging
import queue
import threading
from dataclasses import dataclass
from typing import Iterable, List, Optional, Protocol

from core.agents.bus import get_bus
from core.agents.message import Message, MessageKind

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Backend protocol + pyttsx3 implementation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VoiceInfo:
    """One synthesizer voice. ``id`` is what the user picks; everything else
    is for display in the picker."""

    id: str
    name: str
    languages: tuple = ()
    gender: str = ""


class TtsBackend(Protocol):
    """One synthesis engine. Implementations must be import-safe at module
    load time (no engine instantiation) so the desktop app doesn't crash on
    a machine where the engine is missing."""

    def list_voices(self) -> List[VoiceInfo]: ...
    def speak(self, text: str, *, voice_id: str = "", rate: int = 0) -> None: ...
    @property
    def name(self) -> str: ...


class Pyttsx3Backend:
    """Drives the system TTS engine via pyttsx3.

    Spawns a fresh engine per utterance — see module docstring for the
    leak-avoidance reason.
    """

    name = "pyttsx3"

    def __init__(self) -> None:
        # Import is deferred until first use so the agents tab doesn't
        # crash on machines that haven't installed pyttsx3 yet.
        import pyttsx3  # noqa: F401  — import smoke test
        self._cached_voices: Optional[List[VoiceInfo]] = None

    def list_voices(self) -> List[VoiceInfo]:
        if self._cached_voices is not None:
            return self._cached_voices
        import pyttsx3
        engine = pyttsx3.init()
        try:
            raw = engine.getProperty("voices") or []
            voices: List[VoiceInfo] = []
            for v in raw:
                voices.append(
                    VoiceInfo(
                        id=getattr(v, "id", "") or "",
                        name=getattr(v, "name", "") or "",
                        languages=tuple(getattr(v, "languages", ()) or ()),
                        gender=str(getattr(v, "gender", "") or ""),
                    )
                )
            self._cached_voices = voices
            return voices
        finally:
            try:
                engine.stop()
            except Exception:  # noqa: BLE001
                pass
            del engine

    def speak(self, text: str, *, voice_id: str = "", rate: int = 0) -> None:
        if not text:
            return
        import pyttsx3
        engine = pyttsx3.init()
        try:
            if voice_id:
                try:
                    engine.setProperty("voice", voice_id)
                except Exception:  # noqa: BLE001 — bad id falls back to default
                    logger.debug("pyttsx3: unknown voice_id %r, using default", voice_id)
            if rate and rate > 0:
                try:
                    engine.setProperty("rate", int(rate))
                except Exception:  # noqa: BLE001
                    pass
            engine.say(text)
            engine.runAndWait()
        finally:
            try:
                engine.stop()
            except Exception:  # noqa: BLE001
                pass
            del engine


def _select_backend() -> Optional[TtsBackend]:
    """Pick the first backend that imports cleanly. ``None`` = no voice."""
    try:
        return Pyttsx3Backend()
    except Exception as exc:  # noqa: BLE001
        logger.warning("pyttsx3 unavailable, voice disabled: %s", exc)
        return None


def is_voice_available() -> bool:
    """Cheap probe the UI can use to gray out the voice toggle."""
    return _select_backend() is not None


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


@dataclass
class _Job:
    text: str
    voice_id: str
    rate: int


class TtsService:
    """Bus-subscribed worker that speaks agent REPLY messages.

    Public surface is small on purpose:

    * :meth:`set_enabled` — global mute (page-level toggle).
    * :meth:`speak` — manual ad-hoc utterance (used by the "preview voice"
      button in the agent studio).
    * :meth:`voices` — list installed voices for the picker.

    Per-agent overrides come from :class:`AgentDefinition` (``voice_id``,
    ``voice_rate``, ``voice_enabled``); the service looks them up live so
    a Studio edit takes effect on the next REPLY without a restart.
    """

    # Hard cap on the spoken portion of a reply. Long replies become
    # uncomfortably long monologues — agents are streaming text, not
    # speeches. The cap matches what the 3D speech-bubble layer renders so
    # the audio and the bubble agree.
    MAX_CHARS = 600

    def __init__(self, backend: Optional[TtsBackend] = None) -> None:
        self._backend = backend if backend is not None else _select_backend()
        self._enabled = self._backend is not None
        self._queue: "queue.Queue[Optional[_Job]]" = queue.Queue(maxsize=64)
        self._thread: Optional[threading.Thread] = None
        self._sub_id: Optional[int] = None
        self._lock = threading.Lock()
        self._stable_voice_cache: dict = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the worker thread + bus subscription. Idempotent."""
        if self._backend is None:
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            t = threading.Thread(
                target=self._run, name="OWLLM-TTS", daemon=True
            )
            self._thread = t
            t.start()
            if self._sub_id is None:
                self._sub_id = get_bus().subscribe(
                    self._on_bus_message,
                    kinds=[MessageKind.REPLY],
                )

    def stop(self) -> None:
        """Stop the worker and unsubscribe. Used by tests; the live process
        leaves the daemon thread running until exit."""
        with self._lock:
            if self._sub_id is not None:
                try:
                    get_bus().unsubscribe(self._sub_id)
                except Exception:  # noqa: BLE001
                    pass
                self._sub_id = None
            try:
                self._queue.put_nowait(None)
            except queue.Full:
                pass
            self._thread = None

    # ------------------------------------------------------------------
    # Public surface
    # ------------------------------------------------------------------

    @property
    def available(self) -> bool:
        """True if a backend was found at construction time."""
        return self._backend is not None

    def set_enabled(self, enabled: bool) -> None:
        """Page-level mute. Off = drop new jobs; in-flight utterance
        finishes naturally."""
        self._enabled = bool(enabled) and self._backend is not None

    @property
    def enabled(self) -> bool:
        return self._enabled

    def voices(self) -> List[VoiceInfo]:
        if self._backend is None:
            return []
        try:
            return self._backend.list_voices()
        except Exception:  # noqa: BLE001
            logger.exception("voice enumeration failed")
            return []

    def speak(self, text: str, *, voice_id: str = "", rate: int = 0) -> None:
        """Queue an utterance directly. Bypasses ``set_enabled`` only for
        the empty-text early return — the page must check ``enabled`` itself
        for the manual case."""
        if not self._backend or not text:
            return
        try:
            self._queue.put_nowait(
                _Job(text=text[: self.MAX_CHARS], voice_id=voice_id, rate=rate)
            )
        except queue.Full:
            # The queue is generous (64 jobs). If we're past that the user
            # is firing replies faster than the engine can speak — drop the
            # oldest to keep the audio close to "live".
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(
                    _Job(text=text[: self.MAX_CHARS], voice_id=voice_id, rate=rate)
                )
            except Exception:  # noqa: BLE001
                pass

    def stable_voice_for(self, agent_name: str) -> str:
        """Pick a deterministic voice for ``agent_name`` from the installed
        set. Used when an agent has no explicit ``voice_id`` so distinct
        agents still get distinct voices."""
        if not self._backend:
            return ""
        cached = self._stable_voice_cache.get(agent_name)
        if cached is not None:
            return cached
        voices = self.voices()
        if not voices:
            return ""
        h = hashlib.sha1(agent_name.encode("utf-8")).digest()
        idx = int.from_bytes(h[:4], "big") % len(voices)
        chosen = voices[idx].id
        self._stable_voice_cache[agent_name] = chosen
        return chosen

    # ------------------------------------------------------------------
    # Bus + worker
    # ------------------------------------------------------------------

    def _on_bus_message(self, msg: Message) -> None:
        """Bus subscriber. MUST return fast — pushes a job and exits."""
        if not self._enabled or msg.kind != MessageKind.REPLY:
            return
        agent = msg.from_agent
        if not agent or not msg.body:
            return
        # Resolve voice config from the agent definition. We do this every
        # time so a Studio edit takes effect on the next REPLY without a
        # service restart.
        voice_id, rate, enabled = self._resolve_voice_config(agent)
        if not enabled:
            return
        text = _strip_markup(msg.body)
        if not text:
            return
        self.speak(text, voice_id=voice_id, rate=rate)

    def _resolve_voice_config(self, agent_name: str) -> tuple:
        """Look up ``voice_id``/``voice_rate``/``voice_enabled`` for the
        named agent. Falls back to a stable auto-assigned voice when the
        agent has no explicit choice. Returns ``(voice_id, rate, enabled)``.
        """
        try:
            from core.agents.agent_definitions import get_definition
        except Exception:  # noqa: BLE001 — bus is alive even if defs are broken
            return self.stable_voice_for(agent_name), 0, True
        try:
            d = get_definition(agent_name)
        except Exception:  # noqa: BLE001
            d = None
        if d is None:
            return self.stable_voice_for(agent_name), 0, True
        if not d.voice_enabled:
            return "", 0, False
        voice_id = d.voice_id or self.stable_voice_for(agent_name)
        return voice_id, int(d.voice_rate or 0), True

    def _run(self) -> None:
        """Worker loop — owns the engine and serializes utterances."""
        while True:
            try:
                job = self._queue.get()
            except Exception:  # noqa: BLE001
                continue
            if job is None:
                return
            if not self._enabled:
                continue
            try:
                self._backend.speak(  # type: ignore[union-attr]
                    job.text, voice_id=job.voice_id, rate=job.rate
                )
            except Exception:  # noqa: BLE001 — never let one bad utterance kill the loop
                logger.exception("TTS speak failed")


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------


_service: Optional[TtsService] = None
_service_lock = threading.Lock()


def get_tts_service() -> TtsService:
    """Return (and lazily start) the process-wide :class:`TtsService`."""
    global _service
    with _service_lock:
        if _service is None:
            _service = TtsService()
            _service.start()
        return _service


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_MD_NOISE_PATTERNS: Iterable[tuple] = (
    # Code fences and inline code — read aloud they sound like garbage.
    ("```", "\n"),
)


def _strip_markup(text: str) -> str:
    """Trim markdown / control noise so the synth doesn't read backticks
    and bracket pairs aloud. Cheap heuristics — not a full parser."""
    if not text:
        return ""
    # Drop fenced code blocks entirely.
    out_parts: List[str] = []
    in_fence = False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        out_parts.append(line)
    s = "\n".join(out_parts)
    # Strip inline code and link decoration without touching the link text.
    import re
    s = re.sub(r"`([^`]+)`", r"\1", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    s = re.sub(r"[*_~]+", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s
