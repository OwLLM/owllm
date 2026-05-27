"""Docker sandbox runner — repro container-side bugs without the user.

Cap 1 of the test-validation agent (see ``docs/TEST_AGENT_REQUIREMENTS.md``).

The agents-tab team runs the Claude/Codex CLI inside a content-hashed
``owllm/agent:<sha>`` container (built by :func:`core.agents.agent_image.ensure_agent_image`).
Bugs that surface only inside that container — host argv path leaks
to ``/workspace``, missing auth file mounts, ``--dangerously-skip-permissions``
failing under root, etc. — historically required the user to repro
before any fix could ship. This module gives the maintainer (or a future
auto-validate step) a one-shot ``run_in_sandbox()`` call: spawn the same
image, mount synthetic auth + a temp workspace, run a command, capture
stdout/stderr/exit.

Public surface
==============

* :class:`AuthFixtures` — synthetic, structurally-valid auth payloads
  (``.claude.json``, ``.codex/auth.json``, ``.gitconfig``). NOT REAL
  CREDENTIALS — they pass startup-time existence checks but anything
  that talks to the real API will (intentionally) fail at the auth gate.
* :class:`SandboxRun` — what a run produced (stdout, stderr, exit, ms).
* :func:`run_in_sandbox` — execute a command in a fresh container with
  fixtures + workspace mounted; capture and return.

Design choices
==============

* Default network is ``none``. Most repros don't need the internet, and
  blocking it makes accidental real-API calls impossible.
* Default user is ``node`` (UID 1000) — matches what the production
  image runs as so we catch any "claude-code refuses root" class of bug.
* Hard resource caps (``--memory``, ``--pids-limit``) so a runaway
  test can't take the host down.
* Workspace is a fresh tmpdir per run, mounted RW at ``/workspace``;
  cleaned up afterwards.
* The container is ``--rm`` so stopped containers don't pile up.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


# Default resource caps — generous enough for real CLI calls, strict
# enough that a runaway loop can't eat the host.
_DEFAULT_MEMORY = "1g"
_DEFAULT_PIDS_LIMIT = 256
_DEFAULT_TIMEOUT_SECONDS = 60


# ---------------------------------------------------------------------------
# Auth fixtures
# ---------------------------------------------------------------------------


@dataclass
class AuthFixtures:
    """Synthetic auth payload bundle.

    Each field is the on-disk content for one of the files the agents
    tab's CLI subprocesses look for. Empty string = "don't write this
    file" (so probes will report it missing).

    Construct via the classmethods (``claude_logged_in_stub``,
    ``codex_logged_in_stub``, ``both_logged_in``, ``empty``) — direct
    construction is for advanced cases.
    """

    claude_json: str = ""
    """Content for ``~/.claude.json``. Must be valid JSON shaped
    enough that Claude Code's startup config-loader accepts it."""

    claude_settings_json: str = ""
    """Content for ``~/.claude/settings.json``. Optional; Claude Code
    writes this itself but the probe is fine without it."""

    codex_auth_json: str = ""
    """Content for ``~/.codex/auth.json``. Codex CLI's stored OAuth blob.
    Stub form: just enough to pass existence checks; real API call
    will fail."""

    gitconfig: str = ""
    """Content for ``~/.gitconfig`` — name + email so git commits made
    inside the container don't error on identity."""

    @classmethod
    def empty(cls) -> "AuthFixtures":
        """No auth files at all — useful for testing the 'missing config'
        error paths."""
        return cls()

    @classmethod
    def claude_logged_in_stub(cls) -> "AuthFixtures":
        """Synthetic Claude Code session.

        The schema is what Claude Code writes after ``claude /login`` —
        we mirror the shape (oauthAccount + expiry + project hash map)
        without any real tokens. Claude Code's startup-time parse
        accepts it; the first ``--print`` call will fail at the API
        auth gate, which is what we want for non-network tests.
        """
        body = {
            "oauthAccount": {
                "emailAddress": "test@example.com",
                "accountUuid": "00000000-0000-0000-0000-000000000000",
                "organizationName": "Test Org",
                "expiresAt": "2099-01-01T00:00:00.000Z",
            },
            "projects": {},
            "mcpServers": {},
            "hasCompletedOnboarding": True,
            "lastOnboardingVersion": "1.0.0",
        }
        return cls(
            claude_json=json.dumps(body, indent=2),
            claude_settings_json=json.dumps({"theme": "dark"}, indent=2),
            gitconfig="[user]\n\tname = Test User\n\temail = test@example.com\n",
        )

    @classmethod
    def codex_logged_in_stub(cls) -> "AuthFixtures":
        """Synthetic Codex CLI session."""
        body = {
            "tokens": {
                "access_token": "test-access-not-real",
                "refresh_token": "test-refresh-not-real",
                "id_token": "test-id-not-real",
                "expires_at": "2099-01-01T00:00:00Z",
            },
            "account_id": "test-account",
        }
        return cls(
            codex_auth_json=json.dumps(body, indent=2),
            gitconfig="[user]\n\tname = Test User\n\temail = test@example.com\n",
        )

    @classmethod
    def both_logged_in(cls) -> "AuthFixtures":
        """Both Claude and Codex stubs (most common test scenario)."""
        c = cls.claude_logged_in_stub()
        x = cls.codex_logged_in_stub()
        c.codex_auth_json = x.codex_auth_json
        return c

    def materialize(self, into: Path) -> Dict[str, str]:
        """Write the fixture files into ``into`` and return a mapping of
        relative path -> absolute path on the host (used to build the
        ``-v`` flags). Files with empty content are skipped — matching
        the "probe should report missing" intent."""
        into.mkdir(parents=True, exist_ok=True)
        out: Dict[str, str] = {}

        if self.claude_json:
            p = into / ".claude.json"
            p.write_text(self.claude_json, encoding="utf-8")
            out[".claude.json"] = str(p)
        if self.claude_settings_json:
            cdir = into / ".claude"
            cdir.mkdir(exist_ok=True)
            p = cdir / "settings.json"
            p.write_text(self.claude_settings_json, encoding="utf-8")
            out[".claude/settings.json"] = str(p)
            # Claude Code may also look at the dir itself.
            out[".claude"] = str(cdir)
        if self.codex_auth_json:
            xdir = into / ".codex"
            xdir.mkdir(exist_ok=True)
            p = xdir / "auth.json"
            p.write_text(self.codex_auth_json, encoding="utf-8")
            out[".codex"] = str(xdir)
        if self.gitconfig:
            p = into / ".gitconfig"
            p.write_text(self.gitconfig, encoding="utf-8")
            out[".gitconfig"] = str(p)
        return out


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------


@dataclass
class SandboxRun:
    """What ``run_in_sandbox`` produced.

    All fields populated even on failure — ``exit_code = -1`` and
    ``timed_out = True`` for hangs, ``stderr`` carries the wrap-layer
    error message on docker-side failures.
    """

    command: List[str]
    image_tag: str
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False
    mounts: List[str] = field(default_factory=list)
    """Each ``-v`` flag value, for forensic logging."""


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class DockerUnavailableError(RuntimeError):
    """Raised when Docker isn't installed or the daemon isn't running.

    Distinct from :class:`AgentImageError` so callers (and pytest skips)
    can disambiguate "docker missing → skip the test entirely" from
    "docker present but image build failed → fail the test"."""


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _docker_available(docker_bin: str = "docker") -> bool:
    """``docker version`` returns 0 within 5s. Same heuristic as
    :func:`core.agents.setup._docker_running` but standalone so this
    module doesn't pull in the larger agent_setup graph."""
    if shutil.which(docker_bin) is None:
        return False
    try:
        creationflags = 0x08000000 if os.name == "nt" else 0
        r = subprocess.run(
            [docker_bin, "version"],
            capture_output=True, text=True, timeout=5,
            creationflags=creationflags,
        )
        return r.returncode == 0
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return False


def _build_run_argv(
    *,
    image_tag: str,
    command: List[str],
    workspace_dir: Path,
    fixture_paths: Dict[str, str],
    network: str,
    memory: str,
    pids_limit: int,
    docker_bin: str,
    extra_env: Optional[Dict[str, str]] = None,
) -> List[str]:
    """Assemble the ``docker run`` argv. Pure function; no side effects."""
    argv: List[str] = [
        docker_bin, "run", "--rm",
        # Always-on safety flags.
        f"--network={network}",
        f"--memory={memory}",
        f"--pids-limit={pids_limit}",
        # Match production: non-root user so claude-code accepts
        # --dangerously-skip-permissions, drop linux caps we don't need.
        "--user=node",
        "--cap-drop=ALL",
        # Workspace.
        "-v", f"{workspace_dir}:/workspace",
        "-w", "/workspace",
    ]

    # Fixture mounts — RO so a wayward command can't overwrite the stubs.
    for relpath, host_abs in fixture_paths.items():
        # Map relpath under host fixtures dir → /home/node/<relpath>.
        # Matches what the production wrap layer does (mounts under
        # /home/node so claude-code finds them at $HOME).
        argv += ["-v", f"{host_abs}:/home/node/{relpath}:ro"]

    if extra_env:
        for k, v in extra_env.items():
            argv += ["-e", f"{k}={v}"]

    argv += [image_tag, *command]
    return argv


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def run_in_sandbox(
    command: List[str],
    *,
    workspace_files: Optional[Dict[str, str]] = None,
    auth_fixtures: Optional[AuthFixtures] = None,
    image_tag: Optional[str] = None,
    timeout_seconds: int = _DEFAULT_TIMEOUT_SECONDS,
    network: str = "none",
    memory: str = _DEFAULT_MEMORY,
    pids_limit: int = _DEFAULT_PIDS_LIMIT,
    extra_env: Optional[Dict[str, str]] = None,
    docker_bin: str = "docker",
) -> SandboxRun:
    """Execute ``command`` inside a one-shot OWLLM agent container.

    Parameters
    ----------
    command
        argv to run as the container's entrypoint replacement. e.g.
        ``["claude", "--version"]`` or ``["sh", "-c", "ls /workspace"]``.
    workspace_files
        Optional ``{filename: content}`` map to seed ``/workspace``
        with before the command runs. Filenames are relative to the
        workspace root; nested paths (``a/b/c.txt``) are supported.
    auth_fixtures
        Optional :class:`AuthFixtures` whose stubs will be mounted RO
        at the container's ``/home/node/`` paths. Defaults to no fixtures
        (the CLI will see no auth files, which is fine for tests that
        don't exercise the auth-loading code).
    image_tag
        Override the agent image. Default is whatever
        :func:`core.agents.agent_image.ensure_agent_image` returns —
        which builds the image on first call.
    timeout_seconds
        Wallclock cap; raises (and sets ``timed_out=True``) when
        exceeded. The docker process is killed; the container is
        ``--rm`` so it cleans up.
    network
        Docker network mode. Default ``none`` blocks all networking
        — appropriate for repros that shouldn't accidentally call
        real APIs. Pass ``"host"`` or ``"bridge"`` for tests that
        need it.
    memory, pids_limit
        Resource caps. Defaults are generous; tighten for stress tests.
    extra_env
        ``{KEY: VALUE}`` map of environment variables to set inside
        the container. Common pick: ``{"NO_COLOR": "1"}`` to make
        output predictable for assertions.
    docker_bin
        Override the ``docker`` executable lookup. Tests use this to
        point at a stub.

    Returns
    -------
    SandboxRun
        Always returns; never raises for the command's failure.
        Inspect ``exit_code``, ``stdout``, ``stderr``, ``timed_out``.
        Raises :class:`DockerUnavailableError` if Docker itself isn't
        usable — that's a setup problem, not a test result.
    """
    if not _docker_available(docker_bin):
        raise DockerUnavailableError(
            f"docker binary {docker_bin!r} not available or daemon not responding"
        )

    if image_tag is None:
        from core.agents.agent_image import ensure_agent_image
        image_tag = ensure_agent_image(docker_bin=docker_bin)

    # Set up a tmp workspace + tmp fixtures dir for this run.
    workspace_dir = Path(tempfile.mkdtemp(prefix="owllm_sandbox_ws_"))
    fixtures_dir = Path(tempfile.mkdtemp(prefix="owllm_sandbox_auth_"))
    try:
        if workspace_files:
            for rel, content in workspace_files.items():
                p = workspace_dir / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content, encoding="utf-8")

        fixture_paths: Dict[str, str] = {}
        if auth_fixtures is not None:
            fixture_paths = auth_fixtures.materialize(fixtures_dir)

        argv = _build_run_argv(
            image_tag=image_tag,
            command=command,
            workspace_dir=workspace_dir,
            fixture_paths=fixture_paths,
            network=network,
            memory=memory,
            pids_limit=pids_limit,
            docker_bin=docker_bin,
            extra_env=extra_env,
        )
        mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "-v"]
        logger.debug("sandbox argv: %s", " ".join(argv))

        creationflags = 0x08000000 if os.name == "nt" else 0
        start = time.monotonic()
        timed_out = False
        try:
            proc = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                creationflags=creationflags,
            )
            exit_code = proc.returncode
            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            exit_code = -1
            stdout = (exc.stdout or b"").decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr = (
                (exc.stderr or b"").decode("utf-8", errors="replace")
                if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            )
            stderr += f"\n[owllm-sandbox] timed out after {timeout_seconds}s"
        duration_ms = int((time.monotonic() - start) * 1000)

        return SandboxRun(
            command=list(command),
            image_tag=image_tag,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            duration_ms=duration_ms,
            timed_out=timed_out,
            mounts=mounts,
        )
    finally:
        # Best-effort cleanup of the host-side temp dirs.
        for d in (workspace_dir, fixtures_dir):
            try:
                shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass
