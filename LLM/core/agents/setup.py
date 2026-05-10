"""Agent-runtime setup state — what's installed, what's missing, what to do.

When a fresh user installs OWLLM and clicks Run on the agents tab, the
containerised CLI path needs Docker installed + running, the host's
claude/codex CLIs logged in, and the agent image built. None of those
are guaranteed on a clean machine. This module centralises the checks
so the UI can surface nuanced state ("Docker missing", "Not logged
in", "Image building…") instead of the binary on/off the sandbox
badge previously showed, and so :func:`ensure_agent_image` can fail
fast with an actionable message when the environment isn't ready.

Public API
==========

* :class:`AgentSetupStatus` — read-only dataclass describing every
  prerequisite plus a synthesised summary state for the UI.
* :func:`check_agent_setup` — runs every check, returns a status.
  Cheap (small subprocess + filesystem checks); safe to call from a
  ~5s QTimer.

The summary state is one of:

* ``READY``           — sandbox is on, all good
* ``HOST_FALLBACK``   — Docker / claude not present, host mode active
* ``BUILDING``        — image build in progress (set externally — this
                        module doesn't track build state, the agents
                        page does)
* ``NOT_LOGGED_IN``   — Docker fine but claude/codex have no session
* ``DOCKER_DOWN``     — Docker installed but daemon not responding
* ``DOCKER_MISSING``  — Docker CLI not on PATH

Auto-install / auto-heal note
==============================

Most prerequisites can't be auto-installed (Docker requires admin +
reboot, claude /login requires a browser flow). What we *can* do
without user intervention:

* auto-build the agent image on first containerised Run (handled by
  :func:`core.agents.agent_image.ensure_agent_image`)
* retry the build on transient failures (handled by the agents page
  setup flow, not this module)
* detect every prerequisite proactively so the user gets one clear
  list of "do these three things" instead of cryptic errors as they
  hit each missing piece sequentially

For the things we can't auto-install, this module returns the exact
shell command the user can paste — surfacing actionable guidance is
the closest the app can get to "auto-installing" admin-bound tools.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)


class SetupState(str, Enum):
    """Summary state for the sandbox-status badge."""

    READY = "ready"
    HOST_FALLBACK = "host_fallback"
    NOT_LOGGED_IN = "not_logged_in"
    DOCKER_DOWN = "docker_down"
    DOCKER_MISSING = "docker_missing"


@dataclass(frozen=True)
class AgentSetupStatus:
    """Snapshot of the agent-container prerequisite state.

    Intentionally read-only — callers compose the UI / fix-it
    instructions from these flags rather than the module deciding
    what to render. The ``recommendations`` list contains
    one-liner shell commands or human-readable steps the user
    can take, ordered by impact (most blocking first).
    """

    docker_installed: bool
    """``docker`` CLI is on PATH."""

    docker_running: bool
    """``docker version`` returns 0. Implies docker_installed."""

    claude_cli_on_host: bool
    """The host has ``claude`` CLI installed (used for first-time login)."""

    claude_logged_in: bool
    """``~/.claude.json`` exists with a non-empty body — the host
    Claude Code session has been initialised."""

    codex_cli_on_host: bool
    """The host has ``codex`` CLI installed."""

    codex_logged_in: bool
    """``~/.codex/`` or ``~/.config/codex/`` exists with auth payload."""

    state: SetupState
    """Synthesised summary for the badge."""

    recommendations: List[str]
    """Ordered list of fix-it actions (most-blocking first)."""

    def is_container_ready(self) -> bool:
        """True iff a containerised Run has every prerequisite met
        (Docker up, at least one CLI logged in)."""
        return (
            self.docker_running
            and (self.claude_logged_in or self.codex_logged_in)
        )


# ---------------------------------------------------------------------------
# Probes — each returns a single boolean fact. Kept small so they can be
# unit-tested with simple mocks.
# ---------------------------------------------------------------------------


def _docker_installed() -> bool:
    return shutil.which("docker") is not None


def _docker_running() -> bool:
    """``docker version`` returns 0 within 5s. Covers both 'CLI missing'
    (FileNotFoundError) and 'daemon not responding' (non-zero exit).
    Subprocess flags suppress the Windows console flash."""
    try:
        creationflags = 0x08000000 if os.name == "nt" else 0
        r = subprocess.run(
            ["docker", "version"],
            capture_output=True, text=True, timeout=5,
            creationflags=creationflags,
        )
        return r.returncode == 0
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return False


def _claude_cli_on_host() -> bool:
    return shutil.which("claude") is not None


def _claude_logged_in() -> bool:
    """Login state heuristic: ``~/.claude.json`` exists with non-empty
    JSON-ish body. We don't try to parse the schema — just enough to
    distinguish "the user has run claude /login at least once" from
    "fresh install"."""
    cfg = Path.home() / ".claude.json"
    if not cfg.is_file():
        return False
    try:
        size = cfg.stat().st_size
        return size > 32  # tiny stub configs are likely empty/uninitialised
    except OSError:
        return False


def _codex_cli_on_host() -> bool:
    return shutil.which("codex") is not None


def _codex_logged_in() -> bool:
    """Codex stores auth in ``~/.codex/`` (Windows / macOS) or
    ``~/.config/codex/`` (POSIX). Either with a non-empty payload
    counts as logged-in."""
    home = Path.home()
    for candidate in (home / ".codex", home / ".config" / "codex"):
        if candidate.is_dir():
            try:
                if any(candidate.iterdir()):
                    return True
            except OSError:
                continue
    return False


# ---------------------------------------------------------------------------
# Public — run every probe, synthesise a state, build recommendations.
# ---------------------------------------------------------------------------


def check_agent_setup() -> AgentSetupStatus:
    """Run every prerequisite probe and return a synthesised status."""
    docker_installed = _docker_installed()
    docker_running = _docker_running() if docker_installed else False
    claude_cli = _claude_cli_on_host()
    claude_logged = _claude_logged_in() if claude_cli else False
    codex_cli = _codex_cli_on_host()
    codex_logged = _codex_logged_in() if codex_cli else False

    # State priority (worst-first so the UI surfaces the most blocking
    # piece): missing docker > docker down > no auth > ready.
    if not docker_installed:
        state = SetupState.DOCKER_MISSING
    elif not docker_running:
        state = SetupState.DOCKER_DOWN
    elif not (claude_logged or codex_logged):
        state = SetupState.NOT_LOGGED_IN
    else:
        state = SetupState.READY

    return AgentSetupStatus(
        docker_installed=docker_installed,
        docker_running=docker_running,
        claude_cli_on_host=claude_cli,
        claude_logged_in=claude_logged,
        codex_cli_on_host=codex_cli,
        codex_logged_in=codex_logged,
        state=state,
        recommendations=_build_recommendations(
            docker_installed, docker_running,
            claude_cli, claude_logged,
            codex_cli, codex_logged,
        ),
    )


def _build_recommendations(
    docker_installed: bool, docker_running: bool,
    claude_cli: bool, claude_logged: bool,
    codex_cli: bool, codex_logged: bool,
) -> List[str]:
    """Ordered fix-it list. Returns paste-ready commands or actionable
    sentences. Most-blocking item first so the user can stop reading
    after fixing the first one and rechecking."""
    recs: List[str] = []
    if not docker_installed:
        recs.append(
            "Install Docker Desktop from https://www.docker.com/products/docker-desktop/ "
            "— OWLLM uses it to sandbox agent CLI calls. Without it, the team "
            "runs unsandboxed (still works, less isolated)."
        )
    elif not docker_running:
        recs.append(
            "Start Docker Desktop (the daemon isn't responding to ``docker version``)."
        )

    # CLI install / login. Show one-liner only — the user picks which
    # backend they want logged in.
    if not claude_cli and not codex_cli:
        recs.append(
            "Install at least one CLI:  npm install -g @anthropic-ai/claude-code  "
            "or  npm install -g @openai/codex"
        )
    elif claude_cli and not claude_logged:
        recs.append("Run on host:  claude /login")
    elif codex_cli and not codex_logged:
        recs.append("Run on host:  codex login")

    return recs
