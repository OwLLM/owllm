"""Supervisor brain — HTTP client for the bundled llama-server running Gemma 4 E2B.

Skeleton. See LLM/docs/supervisor/ARCHITECTURE.md for design.

Wire-up plan:
- llama-server is spawned by bootstrap.exe (install-time) or by the desktop app
  on launch (runtime). Default port: 8765.
- We talk to it over HTTP /completion with GBNF grammar attached so the model's
  output is always a valid action JSON.
- Diagnose receives a structured trigger event, assembles a context window,
  POSTs to llama-server, returns a parsed Plan.
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
