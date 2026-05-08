"""Claude CLI backend — uses the user's logged-in claude.ai subscription.

Calls ``claude --print --model <model> --append-system-prompt <sys> <prompt>``
in non-interactive mode. The CLI handles auth via the user's ``~/.claude``
session — no API key required.

If the CLI isn't on PATH, the backend still lists its models but marks them
unavailable so the UI can show a "(install claude CLI)" hint.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
from typing import List, Mapping, Optional

from core.agents.backends._container_wrap import wrap_cli_for_container
from core.agents.backends.base import ModelEntry, register_backend

logger = logging.getLogger(__name__)


# Subset of Claude models worth showing in a dropdown. Keeping this short
# rather than auto-discovering keeps the row count sane and matches what
# ``claude --model <X>`` accepts as friendly aliases.
_MODELS = [
    # (key, display, cost_tier)
    ("claude-opus-4-7",   "Claude Opus 4.7 (subscription)",   "premium"),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6 (subscription)", "mid"),
    ("claude-haiku-4-5",  "Claude Haiku 4.5 (subscription)",  "cheap"),
]


# Hard cap so a hung CLI invocation doesn't pin an agent worker forever.
# Outer goal wall-time is the real safety net; this is the inner timeout.
# Tightened from 300s -> 180s after user feedback that 5-minute waits
# *feel* indistinguishable from a true hang. 3 min is long enough for any
# legitimate Claude turn (Opus on a long context) and short enough that
# Cancel feels responsive.
_CLI_TIMEOUT_SECONDS = 180


class ClaudeCLIBackend:
    name = "claude_cli"

    def list_entries(self) -> List[ModelEntry]:
        installed = shutil.which("claude") is not None
        note = "" if installed else "(install: npm i -g @anthropic-ai/claude-code)"
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
        skip_permissions: bool = False,
    ) -> str:
        # Resolve the CLI to its absolute path (with extension on Windows —
        # 'claude' is a .cmd shim, and subprocess on Windows without shell=True
        # can't find a .cmd from its bare name).
        exe = shutil.which("claude")
        if exe is None:
            raise RuntimeError(
                "Claude CLI not found on PATH. Install with "
                "'npm install -g @anthropic-ai/claude-code' and run 'claude /login' first."
            )

        # Pipe the prompt via stdin instead of passing it as a CLI argument.
        # The reason: Windows cmd.exe (the .cmd shim's host) cannot pass an
        # argument that contains newlines — the role + tools prompt has
        # several. Passing it as argv made claude see an empty prompt and
        # bail with "Input must be provided either through stdin or as a
        # prompt argument when using --print". Stdin sidesteps this entirely
        # and is what the official CLI docs recommend for long inputs.
        combined_prompt = _combine_for_stdin(messages)

        cmd = [exe, "--print", "--model", model_key]
        # When the user has explicitly toggled the Super User card's
        # auto-approve, skip the Claude CLI's permission gate too. Without
        # this, OWLLM's internal gate is open but the CLI subprocess
        # still surfaces per-file/per-tool prompts inside its own model
        # session — the user sees the team "ask for permission" via the
        # orchestrator's text and can't actually grant it from the OWLLM
        # UI. The flag pushes the trust the user already gave through to
        # the CLI's sandbox.
        if skip_permissions:
            cmd.append("--dangerously-skip-permissions")

        # Use the project's Location as the subprocess cwd when provided.
        # This is what makes ``trust_writes`` actually work: the Claude CLI
        # reads ``.claude/settings.local.json`` from its CWD, so without
        # this the trust file (materialized into <Location>/.claude/) is
        # never consulted by the agent.
        run_cwd = cwd if cwd and os.path.isdir(cwd) else None

        # Optionally containerize: when the user enabled kind=container in
        # ``<fleet_root>/runtime.json`` and Docker is available, the CLI
        # subprocess is wrapped in ``docker run``. Project location becomes
        # the container's ``/workspace`` mount, ``~/.claude`` is mounted RO
        # for auth. Anything claude --print's autonomous Bash decides to
        # run is then confined to that workspace instead of touching the
        # whole host filesystem.
        cmd, run_cwd, _container_info = wrap_cli_for_container(
            cmd, host_cwd=run_cwd,
        )

        try:
            proc = subprocess.run(
                cmd,
                input=combined_prompt,
                capture_output=True,
                text=True,
                timeout=_CLI_TIMEOUT_SECONDS,
                check=False,
                encoding="utf-8",
                errors="replace",
                cwd=run_cwd,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"claude CLI timed out after {_CLI_TIMEOUT_SECONDS}s")
        except FileNotFoundError as exc:
            raise RuntimeError(f"claude CLI not callable: {exc}")
        except OSError as exc:
            raise RuntimeError(f"claude CLI invocation failed: {exc}")

        if proc.returncode != 0:
            stderr = (proc.stderr or "").strip()
            raise RuntimeError(
                f"claude CLI exited {proc.returncode}. "
                f"If this is your first run, try 'claude /login' once. "
                f"stderr: {stderr[:400]}"
            )
        return (proc.stdout or "").strip()


def _combine_for_stdin(messages: List[Mapping[str, str]]) -> str:
    """Flatten the chat history into one prompt for the CLI's stdin.

    The system prompt goes at the top wrapped in clear delimiters so the
    model recognises it as instructions. We don't use Claude's
    ``--append-system-prompt`` flag because passing a multi-line string as
    an argv value breaks on Windows cmd.exe.
    """
    parts: list[str] = []
    for m in messages:
        role = (m.get("role") or "user").lower()
        content = m.get("content") or ""
        if role == "system":
            parts.append("=== SYSTEM ===\n" + content)
        elif role == "assistant":
            parts.append("=== ASSISTANT (previous turn) ===\n" + content)
        else:
            parts.append("=== USER ===\n" + content)
    return "\n\n".join(parts) if parts else "(no input)"


register_backend(ClaudeCLIBackend())
