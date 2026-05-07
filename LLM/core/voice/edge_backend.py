"""Edge-TTS backend — Microsoft Azure neural voices via the public Edge endpoint.

`edge-tts <https://github.com/rany2/edge-tts>`_ wraps the unauthenticated
endpoint that the Edge browser's Read-Aloud feature uses. Quality is
state-of-the-art (the same neural voices Azure ships commercially —
Aria, Jenny, Andrew, Guy, Ryan, and ~80 others across 50+ languages),
free, and needs no API key.

Tradeoff vs Piper / SAPI: requires internet. Each utterance round-trips
to ``speech.platform.bing.com``. We treat Edge as opt-in: the service
factory prefers it over Piper when both are present (better quality
wins), but a missing edge-tts install is fine — Piper / SAPI handle
the offline case.

Audio playback
--------------

edge-tts streams MP3 chunks. Windows ``winsound`` only knows WAV, so
we use ``ctypes.windll.winmm.mciSendString`` — Windows' built-in MCI
multimedia layer plays MP3 natively. macOS ``afplay`` and Linux
``mpg123`` / ``ffplay`` pick up the slack on other platforms.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
import tempfile
import threading
from typing import List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


DEFAULT_VOICE_ID = "en-US-AriaNeural"
"""Edge's general-purpose female US English voice. Used when an agent's
``voice_id`` is empty and no per-agent stable assignment has been made."""


def is_edge_tts_importable() -> bool:
    try:
        import edge_tts  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------


class EdgeTTSBackend:
    """Streams text → MP3 via the Edge Read-Aloud endpoint and plays it.

    Construction is cheap; voice listing is lazy so a flaky network
    doesn't block the GUI thread. The ``edge-tts`` package itself does
    the heavy lifting — we just keep the synchronous façade the rest of
    OWLLM expects (``speak`` is sync; the backing API is async).
    """

    name = "edge"

    def __init__(self) -> None:
        # Import-test so the factory falls through cleanly when the
        # package isn't installed.
        import edge_tts  # noqa: F401
        self._voices_cache: Optional[List] = None
        self._cache_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Voice catalog
    # ------------------------------------------------------------------

    def list_voices(self) -> list:
        """All Edge voices — fetched once, then memoised. Returns an
        empty list when the network call fails so the caller can show
        a graceful "no voices available" state without raising."""
        from .tts_service import VoiceInfo
        with self._cache_lock:
            if self._voices_cache is not None:
                return self._voices_cache

            try:
                import edge_tts
                # edge_tts.list_voices() is async — wrap in a one-shot
                # event loop. Spinning a fresh loop avoids polluting any
                # ambient one a Qt host may have created.
                raw = self._run_async(edge_tts.list_voices())
            except Exception:  # noqa: BLE001
                logger.exception("edge-tts list_voices failed")
                self._voices_cache = []
                return self._voices_cache

            out: List = []
            for v in raw or []:
                short = str(v.get("ShortName") or "")
                if not short:
                    continue
                friendly = str(v.get("FriendlyName") or short)
                # FriendlyName looks like "Microsoft Aria Online (Natural) - English (United States)";
                # keep the speaker + locale parts so the picker stays
                # readable in a narrow combo.
                locale = str(v.get("Locale") or "")
                gender = str(v.get("Gender") or "")
                # Compact display: "Aria — en-US (Female)" — we strip
                # the "Microsoft" prefix and the "Online (Natural)"
                # suffix users don't need to see.
                speaker = self._friendly_speaker(friendly, short)
                label = f"{speaker} — {locale}" + (f" ({gender})" if gender else "")
                out.append(
                    VoiceInfo(
                        id=short,
                        name=label,
                        languages=(locale,) if locale else (),
                        gender=gender,
                    )
                )
            # Sort: locale, then speaker.
            out.sort(key=lambda v: (
                (v.languages[0] if v.languages else ""),
                v.name.lower(),
            ))
            self._voices_cache = out
            return out

    @staticmethod
    def _friendly_speaker(friendly: str, short_name: str) -> str:
        # short_name like "en-US-AriaNeural" → "Aria"
        try:
            tail = short_name.split("-")[-1]
            if tail.endswith("Neural"):
                return tail[: -len("Neural")] or short_name
            return tail or short_name
        except Exception:
            return short_name

    # ------------------------------------------------------------------
    # Speak
    # ------------------------------------------------------------------

    def speak(self, text: str, *, voice_id: str = "", rate: int = 0) -> None:
        """Render ``text`` via Edge and play the MP3. Blocks until
        playback finishes — the surrounding TtsService worker thread
        already serialises utterances, so blocking here is fine."""
        if not text:
            return
        if not voice_id:
            voice_id = DEFAULT_VOICE_ID
        rate_str = self._rate_to_edge_format(rate)

        try:
            mp3_bytes = self._run_async(self._synthesize(text, voice_id, rate_str))
        except Exception:
            logger.exception("edge-tts synthesize failed")
            return
        if not mp3_bytes:
            return

        self._play_mp3(mp3_bytes)

    @staticmethod
    async def _synthesize(text: str, voice_id: str, rate_str: str) -> bytes:
        import edge_tts
        comm = edge_tts.Communicate(text, voice_id, rate=rate_str)
        chunks: List[bytes] = []
        async for ev in comm.stream():
            if ev.get("type") == "audio":
                data = ev.get("data") or b""
                if data:
                    chunks.append(data)
        return b"".join(chunks)

    @staticmethod
    def _rate_to_edge_format(rate: int) -> str:
        """Edge accepts ``+/-N%`` rate offsets relative to the voice's
        default tempo (~175 wpm). Map the OWLLM wpm spinbox value onto
        that range; 0 (the special "default") leaves the rate untouched.
        """
        if not rate or rate <= 0:
            return "+0%"
        delta = int(round((float(rate) - 175.0) / 175.0 * 100.0))
        delta = max(-50, min(100, delta))
        sign = "+" if delta >= 0 else ""
        return f"{sign}{delta}%"

    # ------------------------------------------------------------------
    # Async glue
    # ------------------------------------------------------------------

    @staticmethod
    def _run_async(coro):
        """Run an awaitable to completion on a fresh event loop.

        Why not ``asyncio.run``: the calling thread (the TtsService
        worker) may already have a loop attached from a prior call —
        ``asyncio.run`` raises in that case. Building our own loop and
        closing it afterwards is the documented safe pattern for "I
        just want to drive one coroutine from sync code".
        """
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            try:
                loop.close()
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------------
    # MP3 playback
    # ------------------------------------------------------------------

    @staticmethod
    def _play_mp3(mp3_bytes: bytes) -> None:
        """Write to a temp .mp3 and ask the OS to play it.

        Windows: MCI's ``mciSendString`` plays MP3 natively without any
        third-party deps. macOS: ``afplay``. Linux: try ``mpg123`` then
        ``ffplay`` — both are common but neither is universal, hence
        the fallback chain.
        """
        try:
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
                f.write(mp3_bytes)
                tmp = f.name
        except OSError:
            logger.exception("could not write edge-tts temp mp3")
            return

        try:
            if sys.platform == "win32":
                EdgeTTSBackend._play_mp3_windows(tmp)
            elif sys.platform == "darwin":
                subprocess.run(["afplay", tmp], check=False)
            else:
                # Try a couple of common Linux MP3 players; if none are
                # installed there's not a lot we can do without adding a
                # decoder dep.
                for cmd in (["mpg123", "-q", tmp], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", tmp]):
                    try:
                        subprocess.run(cmd, check=False)
                        break
                    except FileNotFoundError:
                        continue
        except Exception:
            logger.exception("edge-tts playback failed")
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    @staticmethod
    def _play_mp3_windows(path: str) -> None:
        """Play an MP3 synchronously via the Windows MCI layer.

        ``winsound.PlaySound`` is WAV-only. ``mciSendStringW`` exposes
        the full Multimedia Control Interface from any Windows install
        going back to Win 95 — no extra packages required.
        """
        import ctypes
        winmm = ctypes.windll.winmm  # type: ignore[attr-defined]
        # Each MCI call returns 0 on success. We use a stable alias
        # ("owllmedge") so a stuck handle from a previous failed call
        # gets reaped before we open the new one.
        alias = "owllmedge"
        winmm.mciSendStringW(f"close {alias}", None, 0, None)
        # ``mpegvideo`` is the MCI device for MP3 (the name is a relic
        # — it covers all MP3 / MPEG-1 audio).
        rc = winmm.mciSendStringW(
            f'open "{path}" type mpegvideo alias {alias}', None, 0, None
        )
        if rc != 0:
            logger.warning("MCI open failed (rc=%d) for %s", rc, path)
            return
        try:
            winmm.mciSendStringW(f"play {alias} wait", None, 0, None)
        finally:
            winmm.mciSendStringW(f"close {alias}", None, 0, None)
