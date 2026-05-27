"""Supervisor brain -- HTTP client for the bundled llama-server running Gemma 4 E2B.

The brain is the *thinking* half of the supervisor. Given a structured
failure event, it returns a Plan -- one action the supervisor would like
to take. The brain owns the lifecycle of llama-server.exe (spawn on
demand, idle-shutdown after 5 min) and the HTTP wire format.

Lifecycle (see BOOTSTRAP.md "Model lifecycle"):
- bootstrap.exe spawns llama-server during install, then shuts it down.
- The desktop app calls Brain.diagnose() the first time a runtime
  failure event arrives. diagnose() calls ensure_running() which spawns
  llama-server if /health isn't OK. Server holds ~1.5 GB resident.
- After IDLE_SHUTDOWN_S of no diagnose() calls, shutdown_idle() (run by
  a QTimer in the desktop app) sends POST /shutdown.

Production safety: every method swallows network errors and returns a
PROBE_FALLBACK Plan that asks the user to investigate manually. Brain
must NEVER raise into the supervisor's failure-handling code -- the
worst outcome is "model can't help, fall back to rules", not "model
broke the rules path too".

This module has no dependency on Qt or the agent bus -- both seams are
injected at the call site so this is a small, testable HTTP client.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


DEFAULT_ENDPOINT = "http://127.0.0.1:8765"
DEFAULT_PORT = 8765
DEFAULT_MAX_TOKENS = 512
DEFAULT_TIMEOUT_S = 60
HEALTH_TIMEOUT_S = 2
SPAWN_BOOT_TIMEOUT_S = 30
IDLE_SHUTDOWN_S = 300  # 5 minutes

# Conservative completion params. Temperature near 0 because we want the
# same input to yield the same plan; the only "creativity" we want is in
# the args, not in choosing wildly different actions across calls.
DEFAULT_TEMPERATURE = 0.1


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Plan:
    """One supervisor decision. Mirrors the JSON the model emits.

    `fallback` is what to try next if this one fails. Bounded depth (we
    never chain more than 5 fallbacks in the executor) so a malicious
    grammar can't stack arbitrary depth here either.
    """
    action: str
    args: Mapping[str, Any]
    reason: str
    fallback: Optional["Plan"] = None

    @classmethod
    def fallback_unavailable(cls, why: str) -> "Plan":
        """The brain couldn't help; ask the user."""
        return cls(
            action="ask_user",
            args={
                "question": f"Supervisor unavailable ({why}). Try again or solve manually?",
                "options": ["retry", "abort"],
            },
            reason=why,
            fallback=None,
        )

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Plan":
        action = str(d.get("action") or "abort")
        raw_args = d.get("args")
        args = dict(raw_args) if isinstance(raw_args, Mapping) else {}
        reason = str(d.get("reason") or "")
        fb_raw = d.get("fallback")
        fallback: Optional[Plan] = None
        if isinstance(fb_raw, Mapping):
            try:
                fallback = cls.from_dict(fb_raw)
            except Exception:
                fallback = None
        return cls(action=action, args=args, reason=reason, fallback=fallback)


# ---------------------------------------------------------------------------
# Tolerant JSON parser
# ---------------------------------------------------------------------------


def parse_plan_json(text: str) -> Optional[Mapping[str, Any]]:
    """Recover a JSON object from a possibly-noisy completion.

    llama-server with GBNF should always emit clean JSON, but we keep
    the parser defensive: stripped fences, leading prose, trailing
    commentary all tolerated. Returns None when no parse possible.
    """
    if not text:
        return None
    s = text.strip()
    if s.startswith("```"):
        # ```json...``` fence
        nl = s.find("\n")
        if nl >= 0:
            s = s[nl + 1:]
        if s.endswith("```"):
            s = s[: -3]
        s = s.strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    # Extract first balanced { ... }
    start = s.find("{")
    if start < 0:
        return None
    depth = 0
    for i, ch in enumerate(s[start:], start=start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(s[start: i + 1])
                except json.JSONDecodeError:
                    return None
    return None


# ---------------------------------------------------------------------------
# Server discovery (paths to bundled binary + GGUF)
# ---------------------------------------------------------------------------


def _bootstrap_dir() -> Path:
    """Where the bundled llama-server.exe and GGUF model live."""
    return Path(__file__).resolve().parent.parent.parent / "bootstrap"


def _llama_server_path() -> Path:
    if os.name == "nt":
        return _bootstrap_dir() / "runtime" / "llama-server.exe"
    return _bootstrap_dir() / "runtime" / "llama-server"


def _model_path() -> Path:
    """Default bundled model. Concrete file may not exist yet during the
    Phase-0 ship -- that's fine; ensure_running() reports the missing
    artifact and returns False rather than raising."""
    return _bootstrap_dir() / "runtime" / "gemma-4-E2B-it-Q4_K_M.gguf"


def _grammar_path() -> Path:
    return _bootstrap_dir() / "recipes" / "plan.gbnf"


def _system_prompt_path() -> Path:
    return _bootstrap_dir() / "recipes" / "system_prompt.txt"


def _read_system_prompt() -> str:
    p = _system_prompt_path()
    if not p.exists():
        return ""
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return ""


def _read_grammar() -> Optional[str]:
    p = _grammar_path()
    if not p.exists():
        return None
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Brain
# ---------------------------------------------------------------------------


class Brain:
    """HTTP client for the bundled Gemma 4 E2B via llama-server.

    Thread-safe enough for the supervisor's single-shot diagnose loop;
    not meant for concurrent multi-request use. The desktop app
    serializes proposals one-at-a-time anyway (see EVENTS.md
    'Throttling').
    """

    def __init__(
        self,
        endpoint: str = DEFAULT_ENDPOINT,
        *,
        grammar_path: Optional[str] = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        timeout_s: int = DEFAULT_TIMEOUT_S,
        idle_shutdown_s: int = IDLE_SHUTDOWN_S,
        spawner: Optional["Spawner"] = None,
        http_post: Optional["HttpPostFn"] = None,
        http_get: Optional["HttpGetFn"] = None,
        clock: Optional["ClockFn"] = None,
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.grammar_path = grammar_path
        self.max_tokens = max_tokens
        self.timeout_s = timeout_s
        self.idle_shutdown_s = idle_shutdown_s
        # Seams. Production wires defaults; tests inject fakes.
        self._spawn = spawner or _default_spawn
        self._http_post = http_post or _default_http_post
        self._http_get = http_get or _default_http_get
        self._clock = clock or time.monotonic
        self._last_request_ts: float = 0.0
        self._proc: Optional[subprocess.Popen] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def health(self) -> bool:
        """True if /health returns 200 within HEALTH_TIMEOUT_S."""
        try:
            ok, _body = self._http_get(self.endpoint + "/health", HEALTH_TIMEOUT_S)
            return ok
        except Exception:
            return False

    def ensure_running(self) -> bool:
        """Idempotent: return True if /health is OK, otherwise spawn
        llama-server and poll until ready or boot timeout. False on any
        failure -- never raises."""
        if self.health():
            return True
        srv = _llama_server_path()
        model = _model_path()
        if not srv.exists() or not model.exists():
            logger.warning(
                "Brain.ensure_running: bundled artifacts missing "
                "(server=%s exists=%s, model=%s exists=%s). "
                "Supervisor will fall back to rules.",
                srv, srv.exists(), model, model.exists(),
            )
            return False
        try:
            self._proc = self._spawn(srv, model, _grammar_path(), DEFAULT_PORT)
        except Exception:
            logger.exception("Brain.ensure_running: spawn failed")
            return False
        # Poll /health
        deadline = self._clock() + SPAWN_BOOT_TIMEOUT_S
        while self._clock() < deadline:
            if self.health():
                return True
            time.sleep(0.5)
        logger.warning("Brain.ensure_running: server did not become healthy within %ss",
                       SPAWN_BOOT_TIMEOUT_S)
        return False

    def shutdown_idle(self) -> bool:
        """If last diagnose() was >idle_shutdown_s ago and a server is
        running, send POST /shutdown. Returns True iff a shutdown was
        actually sent."""
        if self._last_request_ts == 0.0:
            return False
        idle = self._clock() - self._last_request_ts
        if idle < self.idle_shutdown_s:
            return False
        if not self.health():
            return False
        try:
            self._http_post(self.endpoint + "/shutdown", b"{}", timeout_s=2)
        except Exception:
            # Server might already be down; not an error.
            pass
        self._last_request_ts = 0.0
        return True

    # ------------------------------------------------------------------
    # Diagnose
    # ------------------------------------------------------------------

    def diagnose(self, trigger: Mapping[str, Any]) -> Plan:
        """Given a structured failure event, return a Plan.

        Never raises. On any failure (server down, network error,
        unparseable response), returns Plan.fallback_unavailable() so
        the executor can route to the user safely.
        """
        if not self.ensure_running():
            return Plan.fallback_unavailable("llama-server not available")

        prompt = self._build_prompt(trigger)
        body = self._build_request_body(prompt)

        self._last_request_ts = self._clock()
        try:
            ok, response_body = self._http_post(
                self.endpoint + "/completion", body, timeout_s=self.timeout_s,
            )
        except Exception as e:
            logger.warning("Brain.diagnose: HTTP error: %s", e)
            return Plan.fallback_unavailable(f"HTTP error: {e}")

        if not ok:
            return Plan.fallback_unavailable("llama-server returned non-200")

        try:
            payload = json.loads(response_body)
        except json.JSONDecodeError:
            return Plan.fallback_unavailable("llama-server returned non-JSON envelope")
        content = ""
        if isinstance(payload, Mapping):
            content = str(payload.get("content") or "")

        parsed = parse_plan_json(content)
        if parsed is None:
            return Plan.fallback_unavailable("model output not parseable as JSON")
        try:
            return Plan.from_dict(parsed)
        except Exception as e:
            logger.warning("Brain.diagnose: Plan.from_dict failed: %s", e)
            return Plan.fallback_unavailable("model output not a valid Plan")

    # ------------------------------------------------------------------
    # Prompt + body construction
    # ------------------------------------------------------------------

    def _build_prompt(self, trigger: Mapping[str, Any]) -> str:
        """Format the system + user blocks as a Gemma chat prompt."""
        system = _read_system_prompt() or (
            "You are the OWLLM Supervisor. Emit one JSON action per the schema."
        )
        user = json.dumps({"trigger": dict(trigger)}, ensure_ascii=False, indent=2)
        # Gemma instruct chat template: <start_of_turn>user...<end_of_turn>
        # llama-server applies its own template when /chat/completions is used,
        # but /completion is raw -- so we format manually for explicit control.
        return (
            f"<start_of_turn>user\n{system}\n\n{user}\n<end_of_turn>\n"
            f"<start_of_turn>model\n"
        )

    def _build_request_body(self, prompt: str) -> bytes:
        body: dict[str, Any] = {
            "prompt": prompt,
            "n_predict": self.max_tokens,
            "temperature": DEFAULT_TEMPERATURE,
            "stop": ["<end_of_turn>", "</s>"],
        }
        grammar = _read_grammar()
        if grammar:
            body["grammar"] = grammar
        return json.dumps(body).encode("utf-8")


# ---------------------------------------------------------------------------
# Default seams (production)
# ---------------------------------------------------------------------------


# Function types for testability. Production wires these defaults; tests
# inject fakes via Brain(spawner=..., http_post=..., http_get=..., clock=...).
HttpGetFn = Any  # Callable[[str, int], tuple[bool, bytes]]
HttpPostFn = Any  # Callable[[str, bytes, int], tuple[bool, bytes]]
Spawner = Any    # Callable[[Path, Path, Path, int], subprocess.Popen]
ClockFn = Any    # Callable[[], float]


def _default_http_get(url: str, timeout_s: int) -> tuple[bool, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=timeout_s) as resp:
            return resp.status == 200, resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        return False, b""


def _default_http_post(url: str, body: bytes, timeout_s: int) -> tuple[bool, bytes]:
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return 200 <= resp.status < 300, resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        return False, str(e).encode("utf-8")


def _default_spawn(server: Path, model: Path, grammar: Path, port: int) -> subprocess.Popen:
    """Spawn llama-server hidden on Windows (CREATE_NO_WINDOW), normal POSIX
    elsewhere. Args mirror llama.cpp's release-build CLI; -ngl 0 keeps it
    CPU-only by default. The bootstrap wraps a smarter spawn that picks
    -ngl based on hardware probe; the runtime supervisor does the simple
    safe thing because the model fits comfortably in CPU RAM."""
    args = [
        str(server),
        "--model", str(model),
        "--port", str(port),
        "--ctx-size", "16384",
        "-ngl", "0",
    ]
    if grammar.exists():
        args.extend(["--grammar-file", str(grammar)])

    creation_flags = 0
    if os.name == "nt":
        creation_flags = 0x08000000  # CREATE_NO_WINDOW

    return subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creation_flags,
        close_fds=(os.name != "nt"),
    )
