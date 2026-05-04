"""Supervisor brain -- HTTP client for the bundled llama-server running Gemma 4 E2B.

Skeleton. See LLM/docs/supervisor/ARCHITECTURE.md for design.

Wire-up plan:
- llama-server is spawned by bootstrap.exe at install time, then shut down
  when bootstrap exits. The desktop app respawns it on demand the first
  time a runtime failure event arrives -- see BOOTSTRAP.md "Model lifecycle".
  Default port: 8765.
- diagnose() ensures the server is alive (health() -> spawn if needed),
  POSTs to /completion with GBNF grammar attached so the model's output
  is always a valid action JSON, then parses + returns a Plan.
- An idle-shutdown timer sends /shutdown after 5 minutes of no requests
  to free the ~1.5 GB RAM the server holds. Next failure respawns it.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional


@dataclass(frozen=True)
class Plan:
    action: str
    args: Mapping[str, Any]
    reason: str
    fallback: Optional["Plan"] = None


class Brain:
    """Talks to the bundled Gemma 4 E2B via llama-server HTTP."""

    def __init__(
        self,
        endpoint: str = "http://127.0.0.1:8765",
        grammar_path: Optional[str] = None,
        max_tokens: int = 512,
        timeout_s: int = 60,
    ) -> None:
        self.endpoint = endpoint
        self.grammar_path = grammar_path
        self.max_tokens = max_tokens
        self.timeout_s = timeout_s

    def diagnose(self, trigger: Mapping[str, Any]) -> Plan:
        """Given a structured failure event, return a Plan.

        Trigger schema documented in LLM/docs/supervisor/EVENTS.md.
        """
        raise NotImplementedError("Skeleton — see LLM/docs/supervisor/ARCHITECTURE.md")

    def health(self) -> bool:
        """Probe llama-server /health. Used by the executor before sending requests."""
        raise NotImplementedError

    def ensure_running(self) -> None:
        """Idempotent: spawn llama-server.exe if /health isn't OK.

        Locates bootstrap/runtime/llama-server.exe and the bundled GGUF,
        spawns hidden via the existing Windows subprocess guard, polls
        /health until ready (timeout 30s). See BOOTSTRAP.md "Model lifecycle".
        """
        raise NotImplementedError

    def shutdown_idle(self) -> None:
        """Send POST /shutdown if last request was >5 minutes ago.

        Wired to a QTimer or asyncio task in the desktop app. Frees the
        ~1.5 GB RAM the server holds when supervisor isn't actively in use.
        """
        raise NotImplementedError
