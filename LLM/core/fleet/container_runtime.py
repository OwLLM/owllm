"""Docker-backed isolation runtime.

Slice 4-c-a — first cut. ``ContainerRuntime.start`` runs the agent
inside an ephemeral Docker container with the workspace clone mounted
at ``/workspace``; everything outside that mount simply doesn't exist
to the agent. That gives us **host filesystem isolation** for free —
the agent can't read ``~/.ssh``, can't write ``/usr/local``, can't
see other agents' workspaces. Per-module rw/ro mount tables and
network/GPU policy land in 4-c-b and 4-c-c.

Composition over inheritance: setup/teardown delegate to
:class:`WorktreeRuntime`. Cloning the target repo is the same
operation either way; only the *process launch* changes.

Why subprocess instead of the ``docker`` Python SDK: matches the
existing pattern (we shell out to ``git`` and ``gh``) and avoids a
new transitive dependency on ``requests``. ``docker run`` blocks
until the container exits, so :class:`subprocess.Popen` becomes a
1:1 proxy for the container lifecycle — ``Popen.poll()`` returning
None means the container is still up.

To opt in process-wide::

    from core.fleet import ContainerRuntime, set_default_runtime
    set_default_runtime(ContainerRuntime(image="python:3.12-slim"))

The fleet's CLI, UI service, and existing tests all pick it up
through the ``default_runtime()`` registry without any other code
change.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence

from core.fleet.manifest import Claim
from core.fleet.process import ProcessHandle, _utcnow_iso
from core.fleet.runtime import LOG_FILE_NAME, Runtime, WorktreeRuntime
from core.fleet.workspace import WorkspaceLayout

logger = logging.getLogger(__name__)


DEFAULT_IMAGE = "python:3.12-slim"
"""Sensible default for agents that need a Python toolchain. Override
via the constructor for image-specific or smaller bases."""

CONTAINER_NAME_PREFIX = "fleet-"
WORKDIR_INSIDE_CONTAINER = "/workspace"

# Network policy values accepted by the constructor — mirror Docker's
# own naming so users who already know the platform aren't surprised.
NETWORK_BRIDGE = "bridge"   # Docker default — outbound + DNS, no inbound
NETWORK_HOST = "host"       # share host network namespace
NETWORK_NONE = "none"       # offline; loopback only


@dataclass(frozen=True)
class Mount:
    """One bind mount from host to container.

    ``mode`` is ``"rw"`` (default) or ``"ro"``. Both paths must be
    absolute; relative paths cause Docker to error confusingly.
    """

    host_path: str
    container_path: str
    mode: str = "rw"

    def to_docker_v(self) -> str:
        """Render as the value of a ``-v host:container:mode`` flag."""
        return f"{self.host_path}:{self.container_path}:{self.mode}"


def default_user_id() -> Optional[str]:
    """Return ``"<uid>:<gid>"`` on POSIX, ``None`` on Windows.

    Used as the default for ContainerRuntime's ``--user`` flag so
    files the agent creates inside the container land on the host
    owned by the calling user instead of root. On Windows / Docker
    Desktop the user-namespace translation handles this for you, so
    the flag is omitted.
    """
    if hasattr(os, "getuid") and hasattr(os, "getgid"):
        return f"{os.getuid()}:{os.getgid()}"
    return None


def default_auth_mounts() -> List[Mount]:
    """Best-effort common-CLI auth mounts.

    Walks the host's home directory for the auth files+dirs the major
    agent CLIs use (claude, codex, gh, anthropic, openai, git) and
    returns ``ro`` mounts for the ones that exist. Missing entries are
    skipped silently — the user might not have every CLI installed.

    Both files and directories are supported (Docker bind-mount
    handles both transparently). Specifically:

    * Claude Code stores login state in ``~/.claude.json`` (a FILE)
      AND additional project state in ``~/.claude/`` (a DIR). Both
      are required — without ``.claude.json`` the in-container CLI
      reports "Claude configuration file not found at: /root/.claude.json".

    * Codex CLI varies by platform: Linux uses ``~/.config/codex/``,
      Windows/macOS often use ``~/.codex/``. We list both candidates
      and mount whichever exists.

    * gh CLI: ``~/.config/gh/`` on Linux/macOS,
      ``~/AppData/Roaming/GitHub CLI/`` on Windows.

    The container destination uses ``/root/<basename>`` because
    Docker's default user is root unless you pass ``--user``.
    """
    home = Path.home()
    candidates = [
        # (host path relative to ~, container path)
        # Claude Code — DIR state + FILE config
        (".claude",                          "/root/.claude"),
        (".claude.json",                     "/root/.claude.json"),
        # Codex — Linux XDG path AND home-dot path (Windows / macOS variant)
        (".config/codex",                    "/root/.config/codex"),
        (".codex",                           "/root/.codex"),
        # API-key style auth dirs (rare but cheap to include)
        (".anthropic",                       "/root/.anthropic"),
        (".openai",                          "/root/.openai"),
        # gh CLI — POSIX path AND Windows path
        (".config/gh",                       "/root/.config/gh"),
        ("AppData/Roaming/GitHub CLI",       "/root/.config/gh"),
        # Git — without this, in-container ``git commit`` complains
        # about missing user.name / user.email.
        (".gitconfig",                       "/root/.gitconfig"),
    ]
    mounts: List[Mount] = []
    seen_dests: set = set()
    for rel, dest in candidates:
        host = home / rel
        # Skip entries that don't exist on the host.
        if not host.exists():
            continue
        # Don't double-mount the same container path (e.g., both
        # ``.config/gh`` and ``AppData/Roaming/GitHub CLI`` map to
        # ``/root/.config/gh``). First match wins, which is the
        # platform-native one given the order above.
        if dest in seen_dests:
            continue
        seen_dests.add(dest)
        mounts.append(Mount(
            host_path=str(host),
            container_path=dest,
            mode="ro",
        ))
    return mounts


class ContainerRuntime(Runtime):
    """Docker container per agent. Workspace mounted at /workspace."""

    def __init__(
        self,
        *,
        image: str = DEFAULT_IMAGE,
        docker_bin: str = "docker",
        auth_mounts: Optional[Sequence[Mount]] = None,
        network: Optional[str] = None,
        gpu_runtime: Optional[str] = None,
        enforce_module_mounts: bool = False,
        user: Optional[str] = None,
    ):
        """Configure the container runtime.

        :param image:        Docker image to run agents inside.
        :param docker_bin:   ``docker`` CLI path (override for podman, etc.).
        :param auth_mounts:  ``Mount`` records bind-mounted on every
                             container start. Use :func:`default_auth_mounts`
                             for sensible defaults; pass ``[]`` to skip.
        :param network:      ``--network`` value passed to ``docker run``.
                             ``None`` = Docker default (bridge); use
                             :data:`NETWORK_NONE` for offline isolation
                             or :data:`NETWORK_HOST` to share the host net.
        :param gpu_runtime:  Override Docker's GPU runtime label. Most
                             setups don't need this — when ``claim.gpu_slot``
                             is set we just pass ``--gpus device=N``.
        :param enforce_module_mounts:
                             When True, the workspace is mounted **ro**
                             and each path in ``claim.owns_modules`` is
                             bind-mounted **rw** on top. The agent
                             physically cannot write outside its declared
                             modules. When False (default), the whole
                             workspace is rw — owns/reads stay advisory.
        :param user:         Value passed to ``--user`` (``"uid:gid"``).
                             ``None`` means root inside the container.
                             On POSIX, pass :func:`default_user_id` to
                             keep host file ownership sane; on Windows
                             / Docker Desktop the translation layer
                             handles this without ``--user``.
        """
        self._image = image
        self._docker = docker_bin
        self._auth_mounts: List[Mount] = list(auth_mounts or [])
        self._network = network
        self._gpu_runtime = gpu_runtime
        self._enforce_module_mounts = enforce_module_mounts
        self._user = user
        # Composition: workspace lifecycle is identical to plain
        # WorktreeRuntime — only the process launch differs.
        self._inner = WorktreeRuntime()

    # ------------------------------------------------------------------
    # Availability
    # ------------------------------------------------------------------

    @classmethod
    def is_available(cls, *, docker_bin: str = "docker") -> bool:
        """True iff the ``docker`` CLI is on PATH and the daemon
        responds to ``docker version``."""
        if shutil.which(docker_bin) is None:
            return False
        try:
            result = subprocess.run(
                [docker_bin, "version"],
                capture_output=True, text=True, timeout=5.0,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False
        return result.returncode == 0

    # ------------------------------------------------------------------
    # setup / teardown — pure delegation
    # ------------------------------------------------------------------

    def setup(
        self,
        claim: Claim,
        *,
        base_branch: str = "main",
    ) -> WorkspaceLayout:
        return self._inner.setup(claim, base_branch=base_branch)

    def teardown(
        self,
        claim: Claim,
        *,
        push: bool = True,
        open_pr: bool = False,
        pr_title: str = "",
        pr_body: str = "",
    ) -> Optional[str]:
        return self._inner.teardown(
            claim, push=push, open_pr=open_pr,
            pr_title=pr_title, pr_body=pr_body,
        )

    # ------------------------------------------------------------------
    # start / stop — Docker-driven
    # ------------------------------------------------------------------

    def start(
        self,
        claim: Claim,
        layout: WorkspaceLayout,
        argv: Sequence[str],
    ) -> ProcessHandle:
        if not argv:
            raise ValueError("argv must be non-empty")

        container_name = container_name_for(claim.agent_id)
        log_path = layout.root / LOG_FILE_NAME
        log_handle = log_path.open("a", encoding="utf-8", buffering=1)
        cmd = self._build_run_cmd(container_name, claim, layout, argv)
        log_handle.write(
            f"--- agent {claim.agent_id} launched in container "
            f"{container_name!r} at {_utcnow_iso()} ---\n"
            f"image:   {self._image}\n"
            f"argv:    {list(argv)}\n"
            f"network: {self._network or '(docker default)'}\n"
            f"gpu:     {claim.gpu_slot if claim.gpu_slot is not None else '(none)'}\n"
            f"mounts:  {layout.clone} → {WORKDIR_INSIDE_CONTAINER}\n"
        )
        for m in self._auth_mounts:
            log_handle.write(
                f"         {m.host_path} → {m.container_path} ({m.mode})\n"
            )
        log_handle.write("\n")
        log_handle.flush()

        try:
            popen = subprocess.Popen(
                cmd,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
        except OSError:
            try:
                log_handle.close()
            except Exception:
                pass
            raise

        handle = ProcessHandle(
            agent_id=claim.agent_id,
            pid=popen.pid,  # docker CLI's pid; container's is opaque
            argv=tuple(argv),
            log_path=log_path,
            metadata={
                "container_name": container_name,
                "image": self._image,
                "network": self._network or "",
                "gpu_slot": claim.gpu_slot if claim.gpu_slot is not None else "",
            },
            _popen=popen,
            _log_handle=log_handle,
        )
        logger.info(
            "agent %s container started: name=%s image=%s",
            claim.agent_id, container_name, self._image,
        )
        return handle

    def stop(
        self,
        handle: ProcessHandle,
        *,
        timeout: float = 5.0,
    ) -> Optional[int]:
        # Try the Docker-aware stop first: docker stop sends SIGTERM
        # then SIGKILL after --time. The docker CLI process attached
        # via `docker run` exits as soon as the container does, so
        # waiting on Popen reports the container's exit.
        container_name = handle.metadata.get("container_name")
        if container_name:
            try:
                subprocess.run(
                    [self._docker, "stop", "--time", str(int(timeout)),
                     container_name],
                    capture_output=True, text=True,
                    timeout=timeout + 5.0,
                )
            except (subprocess.SubprocessError, OSError) as e:
                logger.warning(
                    "docker stop failed for %s: %s — falling back to Popen",
                    container_name, e,
                )

        rc: Optional[int] = None
        popen = handle._popen
        if popen is not None:
            try:
                rc = popen.wait(timeout=timeout + 2.0)
            except subprocess.TimeoutExpired:
                # Docker-aware stop didn't bring the CLI down. Force.
                logger.warning(
                    "docker CLI for %s did not exit; killing Popen",
                    handle.agent_id,
                )
                popen.kill()
                try:
                    rc = popen.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    logger.error(
                        "docker CLI for %s ignored kill — leaking handle",
                        handle.agent_id,
                    )

        handle.mark_exited()
        handle.close_log()
        return rc

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _build_run_cmd(
        self,
        container_name: str,
        claim: Claim,
        layout: WorkspaceLayout,
        argv: Sequence[str],
    ) -> list:
        """Compose ``docker run`` argv. Public for tests."""
        cmd: List[str] = [
            self._docker, "run",
            "--rm",                 # auto-cleanup container metadata
            "--name", container_name,
        ]
        # Workspace mount(s). Either:
        # - whole clone rw (default), or
        # - whole clone ro + each owned module rw on top
        for v in self._workspace_mounts(claim, layout):
            cmd.extend(["-v", v])
        cmd.extend(["-w", WORKDIR_INSIDE_CONTAINER])
        # Auth + ad-hoc bind mounts.
        for m in self._auth_mounts:
            cmd.extend(["-v", m.to_docker_v()])
        # Network policy. None = let Docker pick its default (bridge).
        if self._network:
            cmd.extend(["--network", self._network])
        # GPU passthrough. Pinned slot from the claim becomes
        # `--gpus device=N`. The custom runtime override is rarely
        # needed but available for non-NVIDIA setups.
        if claim.gpu_slot is not None:
            cmd.extend(["--gpus", f"device={claim.gpu_slot}"])
        if self._gpu_runtime:
            cmd.extend(["--runtime", self._gpu_runtime])
        if self._user:
            cmd.extend(["--user", self._user])
        cmd.append(self._image)
        cmd.extend(argv)
        return cmd


    def _workspace_mounts(
        self,
        claim: Claim,
        layout: WorkspaceLayout,
    ) -> List[str]:
        """Return the list of ``-v`` mount specs for workspace + modules.

        Default (``enforce_module_mounts=False``): one rw mount of
        the whole clone. Same as 4-c-a.

        Strict (``enforce_module_mounts=True``): the whole clone ro,
        plus one rw bind-mount per translatable owned module on top.
        Docker resolves nested mounts longest-path-wins, so the
        per-module rw mounts shadow the outer ro for their subpaths.

        For owned modules whose directory doesn't yet exist on disk,
        we ``mkdir`` it so the bind-mount has a target. The agent's
        files land there directly via the bind, and a finished
        clone's git ``status`` shows them as untracked.
        """
        if not self._enforce_module_mounts:
            return [f"{layout.clone}:{WORKDIR_INSIDE_CONTAINER}:rw"]

        mounts: List[str] = [
            f"{layout.clone}:{WORKDIR_INSIDE_CONTAINER}:ro",
        ]
        for pattern in claim.owns_modules:
            rel = _module_to_path(pattern)
            if rel is None:
                logger.warning(
                    "agent %s: owns_modules pattern %r is too dynamic "
                    "to bind-mount; falling back to whole-clone ro for it",
                    claim.agent_id, pattern,
                )
                continue
            host = layout.clone / rel
            try:
                host.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                logger.warning(
                    "agent %s: could not pre-create %s for bind-mount: %s",
                    claim.agent_id, host, e,
                )
                continue
            container = f"{WORKDIR_INSIDE_CONTAINER}/{rel}"
            mounts.append(f"{host}:{container}:rw")
        return mounts


def _module_to_path(pattern: str) -> Optional[str]:
    """Translate an owns-module glob into a relative path under the clone.

    Returns None for patterns that aren't a single deterministic
    path (e.g. ``**/*.py``, ``src/*/util.py``). The caller must
    then decide how to handle them — today we skip with a warning.

    Examples accepted::

        src/billing/**     → src/billing
        src/billing/*      → src/billing
        src/billing        → src/billing
        src/billing/api.py → src/billing/api.py
    """
    p = pattern.replace("\\", "/").rstrip("/")
    for suffix in ("/**", "/*"):
        if p.endswith(suffix):
            p = p[: -len(suffix)]
    if any(ch in p for ch in "*?["):
        return None
    return p.strip("/")


def container_name_for(agent_id: str) -> str:
    """Sanitise ``agent_id`` into a Docker-legal container name.

    Docker rules: ``[a-zA-Z0-9][a-zA-Z0-9_.-]*``. We prepend ``fleet-``
    so the prefix doubles as a discoverability tag (``docker ps
    --filter name=fleet-``).
    """
    safe = "".join(
        c if (c.isalnum() or c in "-_.") else "-"
        for c in agent_id
    )
    return f"{CONTAINER_NAME_PREFIX}{safe}"
