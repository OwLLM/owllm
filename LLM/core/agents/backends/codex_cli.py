"""Codex CLI backend — uses the user's logged-in ChatGPT subscription.

Calls ``codex exec --model <model> "<prompt>"``. Auth lives in the user's
``~/.codex`` session — no API key required.

If the CLI isn't on PATH, the backend still lists rows but marks them
unavailable so the UI shows a "(install codex)" hint.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
from typing import List, Mapping, Optional

from core.agents.backends._container_wrap import wrap_cli_for_container
from core.agents.backends.base import (
    ModelEntry,
    register_backend,
    render_messages_as_prompt,
)

logger = logging.getLogger(__name__)


# Codex CLI accepts arbitrary OpenAI model ids. Curated short list keeps the
# dropdown readable; users who want others can edit this file.
_MODELS = [
    # (key, display, cost_tier)
    ("gpt-5",       "GPT-5 (subscription)",       "premium"),
    ("gpt-5-codex", "GPT-5 Codex (subscription)", "premium"),
    ("o3",          "o3 (subscription)",          "premium"),
]


# No per-call CLI timeout by default — see claude_cli.py for the full
# rationale. The goal-level wall_time_seconds is the real safety net.
# Override (opt-in) via OWLLM_AGENT_CLI_TIMEOUT_SECONDS.
def _resolve_cli_timeout() -> Optional[int]:
    try:
        v = int((os.environ.get("OWLLM_AGENT_CLI_TIMEOUT_SECONDS") or "").strip() or "0")
        if v > 0:
            return v
    except (TypeError, ValueError):
        pass
    return None


_CLI_TIMEOUT_SECONDS = _resolve_cli_timeout()


class CodexCLIBackend:
    name = "codex_cli"

    def list_entries(self) -> List[ModelEntry]:
        installed = shutil.which("codex") is not None
        note = "" if installed else "(install: npm i -g @openai/codex)"
        return [
            ModelEntry(
                backend=self.name,
                model_key=key,
                display=display + (f"  {note}" if note else ""),
                available=installed,
                note=note,
                cost_tier=tier,
            )
            for key, display, tier in _MODELS
        ]

    def generate(
        self,
        messages: List[Mapping[str, str]],
        model_key: str,
        *,
        cwd: Optional[str] = None,
    ) -> str:
        # Resolve the absolute path (incl. extension on Windows where 'codex'
        # is a .cmd shim) so subprocess doesn't FileNotFoundError on the bare
        # name.
        exe = shutil.which("codex")
        if exe is None:
            raise RuntimeError(
                "Codex CLI not found on PATH. Install with "
                "'npm install -g @openai/codex' and run 'codex login' first."
            )

        # Pipe via stdin — same reason as claude_cli: Windows cmd.exe can't
        # carry a multi-line argv value through the .cmd shim, so the long
        # role+tools prompt must travel through stdin.
        prompt = render_messages_as_prompt(messages)
        cmd = [exe, "exec", "--model", model_key, "-"]  # '-' means read prompt from stdin

        # When the agents page provides the project's Location, run the
        # subprocess in that directory so codex reads its own ~/.codex
        # session AND the working tree the user actually wants edited.
        run_cwd = cwd if cwd and os.path.isdir(cwd) else None

        # Optionally containerize — same plumbing as claude_cli. With
        # kind=container in runtime.json, codex exec runs inside Docker
        # with /workspace = project location and ~/.config/codex mounted
        # RO for auth. Keeps autonomous shelling sandboxed.
        cmd, run_cwd, _container_info = wrap_cli_for_container(
            cmd, host_cwd=run_cwd,
        )

        try:
            proc = subprocess.run(
                cmd,
                input=prompt,
                capture_output=True,
                text=True,
                timeout=_CLI_TIMEOUT_SECONDS,
                check=False,
                encoding="utf-8",
                errors="replace",
                cwd=run_cwd,
            )
        except subprocess.TimeoutExpired:
            # Only reachable when OWLLM_AGENT_CLI_TIMEOUT_SECONDS is set.
            chars = len(prompt or "")
            roles = [m.get("role", "?") for m in messages]
            raise RuntimeError(
                f"codex CLI exceeded OWLLM_AGENT_CLI_TIMEOUT_SECONDS="
                f"{_CLI_TIMEOUT_SECONDS}s (sent {chars} chars across "
                f"{len(messages)} messages [{','.join(roles[:5])}"
                f"{'...' if len(roles) > 5 else ''}], model={model_key}). "
                f"Unset or raise the env var to remove the inner cap."
            )
        except FileNotFoundError as exc:
            raise RuntimeError(f"codex CLI not callable: {exc}")
        except OSError as exc:
            raise RuntimeError(f"codex CLI invocation failed: {exc}")

        if proc.returncode != 0:
            stderr = (proc.stderr or "").strip()
            raise RuntimeError(
                f"codex CLI exited {proc.returncode}. "
                f"If this is your first run, try 'codex login' once. "
                f"stderr: {stderr[:400]}"
            )
        return (proc.stdout or "").strip()


register_backend(CodexCLIBackend())
