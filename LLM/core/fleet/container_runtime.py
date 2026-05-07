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
import shutil
import subprocess
from typing import Optional, Sequence

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


class ContainerRuntime(Runtime):
    """Docker container per agent. Workspace mounted at /workspace."""

    def __init__(
        self,
        *,
        image: str = DEFAULT_IMAGE,
        docker_bin: str = "docker",
    ):
        self._image = image
        self._docker = docker_bin
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
        log_handle.write(
            f"--- agent {claim.agent_id} launched in container "
            f"{container_name!r} at {_utcnow_iso()} ---\n"
            f"image: {self._image}\n"
            f"argv:  {list(argv)}\n"
            f"mount: {layout.clone} → {WORKDIR_INSIDE_CONTAINER}\n\n"
        )
        log_handle.flush()

        cmd = self._build_run_cmd(container_name, layout, argv)
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
        layout: WorkspaceLayout,
        argv: Sequence[str],
    ) -> list:
        """Compose ``docker run`` argv. Public for tests."""
        return [
            self._docker, "run",
            "--rm",                 # auto-cleanup container metadata
            "--name", container_name,
            "-v", f"{layout.clone}:{WORKDIR_INSIDE_CONTAINER}",
            "-w", WORKDIR_INSIDE_CONTAINER,
            self._image,
            *argv,
        ]


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
