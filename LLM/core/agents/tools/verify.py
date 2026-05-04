"""Auto-verification loop — run the project's checks after every edit.

Why this exists
===============

A coder agent that edits a file and immediately stops is a coder that
ships bugs. Real engineers run ``pytest`` (or ``ruff``, ``tsc``, ``npm
test``) after every change, see what broke, and fix it before claiming
"done". This module mirrors that workflow:

* The ``verify`` tool runs a configured per-repo command and surfaces
  exit code + stdout + stderr to the agent.
* The :class:`ToolRegistry` auto-invokes ``verify`` after every
  successful ``edit_file`` / ``write_file_with_diff`` and appends the
  result to the edit's output. The agent then sees the breakage in the
  same turn and self-corrects.

Configuration
=============

Auto-verify is **opt-in per repo**. Drop a ``.owllm/verify.json`` in
your repo root (or any ancestor of the edited file) with::

    {
        "command": "pytest -x --tb=short",
        "trigger": "after_edit",          // "after_edit" | "manual"
        "cwd": ".",                       // relative to config file dir
        "timeout_seconds": 60             // 1..300
    }

If no config is found, auto-verify is a no-op — agents can still call
``verify`` manually with an explicit ``command`` arg.

Safety
======

The auto-trigger does NOT route through the approval gate. The user
opted in by creating ``verify.json``; gating would render the loop
useless (every edit would block on approval). The command is hard-
capped at 300s and run with capture_output, so a runaway command can't
spam the chat.

The manual ``verify`` tool DOES require approval when called with an
explicit ``command`` override (since that's effectively a shell call
with arbitrary content). With no override, it replays the configured
command and skips approval.
"""
from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional

from core.agents.tools.base import ArgSpec, Tool, ToolError

logger = logging.getLogger(__name__)


_CONFIG_FILENAME = "verify.json"
_CONFIG_DIRNAME = ".owllm"
_MAX_OUTPUT_CHARS = 16_000  # smaller than the global cap — verify output piles up
_DEFAULT_TIMEOUT = 60
_MAX_TIMEOUT = 300


# ---------------------------------------------------------------------------
# Config discovery
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerifyConfig:
    """Resolved per-repo verify config + the dir it was loaded from."""

    command: str
    trigger: str            # "after_edit" | "manual"
    cwd: Path               # absolute, ready to pass to subprocess
    timeout_seconds: int
    config_path: Path       # the .owllm/verify.json file itself
    auto: bool              # True iff trigger == "after_edit"


def _walk_up(start: Path):
    """Yield ``start`` and each ancestor up to the root."""
    cur = start.resolve()
    yield cur
    while cur.parent != cur:
        cur = cur.parent
        yield cur


def find_verify_config(start: Optional[Path] = None) -> Optional[VerifyConfig]:
    """Walk up from ``start`` (default cwd) looking for ``.owllm/verify.json``.

    Returns ``None`` if no config exists — auto-verify is a no-op then.
    Returns ``None`` (with a warning logged) if a config exists but is
    malformed; we never want a broken config to crash the edit loop.
    """
    base = (start or Path.cwd())
    if base.is_file():
        base = base.parent
    for candidate in _walk_up(base):
        cfg_path = candidate / _CONFIG_DIRNAME / _CONFIG_FILENAME
        if not cfg_path.exists():
            continue
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("ignoring malformed %s: %s", cfg_path, exc)
            return None
        if not isinstance(data, dict):
            logger.warning("verify config must be a JSON object: %s", cfg_path)
            return None

        command = str(data.get("command", "")).strip()
        if not command:
            logger.warning("verify config missing 'command': %s", cfg_path)
            return None

        trigger = str(data.get("trigger", "after_edit")).strip().lower()
        if trigger not in ("after_edit", "manual"):
            logger.warning("verify trigger must be 'after_edit' or 'manual'; got %r", trigger)
            trigger = "after_edit"

        rel_cwd = str(data.get("cwd", ".")).strip() or "."
        cwd = (cfg_path.parent.parent / rel_cwd).resolve()
        if not cwd.exists() or not cwd.is_dir():
            logger.warning("verify cwd does not exist: %s", cwd)
            return None

        try:
            timeout = int(data.get("timeout_seconds", _DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            timeout = _DEFAULT_TIMEOUT
        timeout = max(1, min(timeout, _MAX_TIMEOUT))

        return VerifyConfig(
            command=command,
            trigger=trigger,
            cwd=cwd,
            timeout_seconds=timeout,
            config_path=cfg_path,
            auto=(trigger == "after_edit"),
        )
    return None


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def _truncate(text: str, *, cap: int = _MAX_OUTPUT_CHARS) -> str:
    if len(text) <= cap:
        return text
    return text[:cap] + f"\n\n... [truncated, {len(text) - cap} more chars]"


def run_verify(
    config: VerifyConfig,
    *,
    command_override: Optional[str] = None,
    timeout_override: Optional[int] = None,
) -> str:
    """Execute the configured verify command and return formatted output.

    Never raises — failures (timeout, OSError, non-zero exit) are
    rendered into the returned string so the agent can see them. The
    only way this raises is if ``command`` is empty after the override
    is applied; that's a programming error in the caller.
    """
    cmd = (command_override or config.command).strip()
    if not cmd:
        raise ToolError("verify command is empty")

    timeout = timeout_override if timeout_override is not None else config.timeout_seconds
    timeout = max(1, min(timeout, _MAX_TIMEOUT))

    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=str(config.cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return f"$ {cmd}\nVERIFY TIMED OUT after {timeout}s"
    except OSError as exc:
        return f"$ {cmd}\nVERIFY FAILED to launch: {exc}"

    out = (proc.stdout or "").rstrip()
    err = (proc.stderr or "").rstrip()
    parts = [f"$ {cmd}", f"exit={proc.returncode}"]
    if out:
        parts.append(f"--- stdout ---\n{out}")
    if err:
        parts.append(f"--- stderr ---\n{err}")
    return _truncate("\n".join(parts))


# ---------------------------------------------------------------------------
# Tool definition
# ---------------------------------------------------------------------------


def _verify_tool(args: Mapping[str, Any]) -> str:
    """Manual ``verify`` invocation. Picks up the configured command if
    none is passed; otherwise runs the explicit command in the configured
    cwd (or the current working directory if no config exists).

    Note on approval: the registry decides whether to gate this call.
    The ``invoke`` layer treats explicit-command invocations as
    side-effecting (gated) and configured-command invocations as
    pre-blessed. See the comment at the top of this module.
    """
    cwd_arg = args.get("cwd")
    start = Path(str(cwd_arg)).expanduser() if cwd_arg else Path.cwd()
    config = find_verify_config(start)

    command_override = args.get("command")
    command_override = str(command_override).strip() if command_override else None

    if config is None and not command_override:
        return (
            "no .owllm/verify.json found and no 'command' arg given. "
            "Either drop a config at <repo>/.owllm/verify.json with "
            '{"command": "pytest -x"} or pass command="..." explicitly.'
        )

    if config is None:
        # Manual one-off with no config — run in cwd, default timeout.
        timeout = _DEFAULT_TIMEOUT
        try:
            timeout = int(args.get("timeout_seconds", _DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            pass
        ad_hoc = VerifyConfig(
            command=command_override or "",
            trigger="manual",
            cwd=start.resolve() if start.is_dir() else Path.cwd(),
            timeout_seconds=max(1, min(timeout, _MAX_TIMEOUT)),
            config_path=Path("(none)"),
            auto=False,
        )
        return run_verify(ad_hoc, command_override=command_override)

    timeout_override: Optional[int] = None
    if "timeout_seconds" in args:
        try:
            timeout_override = int(args["timeout_seconds"])
        except (TypeError, ValueError):
            timeout_override = None

    return run_verify(config, command_override=command_override, timeout_override=timeout_override)


verify = Tool(
    name="verify",
    description=(
        "Run the project's verify command (typically tests or a typecheck) "
        "and return exit + stdout + stderr. With no args, runs the command "
        "configured in <repo>/.owllm/verify.json. Pass command=\"...\" to "
        "run an arbitrary one-off (this requires approval). The registry "
        "auto-runs the configured command after every successful edit_file "
        "/ write_file_with_diff so you usually don't need to call this "
        "manually — but it's here when you want to re-check or to run a "
        "different command (lint, build, integration suite)."
    ),
    args=[
        ArgSpec("command", "string", "Override the configured command (requires approval).", required=False),
        ArgSpec("cwd", "string", "Where to look for .owllm/verify.json (default: current cwd).", required=False),
        ArgSpec("timeout_seconds", "integer", "Override timeout (1-300).", required=False),
    ],
    func=_verify_tool,
    requires_approval=True,  # gated *only* when called with a command override; see ToolRegistry
)
