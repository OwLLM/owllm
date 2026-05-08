"""Container-isolation wrap for CLI agent backends.

The agents-tab team historically shelled ``claude --print`` (and
``codex exec``) directly on the host. With ``--dangerously-skip-permissions``
the CLI then runs autonomous ``Bash`` against the user's whole filesystem.
This module wraps that subprocess in ``docker run`` when the user has
opted in via ``<fleet_root>/runtime.json`` (the same config the fleet
already uses), so the dangerous tool calls are confined to ``/workspace``.

Scope of this slice
===================

We only wrap the **CLI subprocess** — the one piece that runs the model's
autonomous shell. The OWLLM tool layer (``shell``, ``edit_file``,
``write_file_with_diff``) still executes on the host, gated by OWLLM's
own approval system. Putting *those* in a container is a separate slice
that needs the agent loop itself to move into the container.

Opt-in
======

The function is a no-op unless ALL of these are true:

* ``<fleet_root>/runtime.json`` exists and has ``kind == "container"``
* Docker CLI is installed and the daemon is up
  (``ContainerRuntime.is_available()``)
* The caller passed a real ``host_cwd`` (the project's Location) — without
  a workspace to mount, container isolation has nothing to isolate.

Otherwise the original argv + cwd are returned unchanged.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)


def wrap_cli_for_container(
    argv: List[str],
    *,
    host_cwd: Optional[str],
) -> Tuple[List[str], Optional[str], Optional[dict]]:
    """Optionally wrap a CLI argv in ``docker run``.

    :param argv:     The host argv (e.g. ``[claude.exe, --print, ...]``).
    :param host_cwd: The host cwd where the CLI would run — becomes the
                     ``/workspace`` mount inside the container. ``None``
                     or missing dir disables wrapping.

    :returns: ``(final_argv, final_cwd, info)``. When wrapping is active,
              ``final_argv`` is a ``docker run …`` command, ``final_cwd``
              is ``None`` (Docker handles the workspace mount), and
              ``info`` describes the chosen image/network for log lines.
              When wrapping is not active, returns ``argv`` unchanged,
              ``host_cwd`` unchanged, and ``info=None``.
    """
    if not host_cwd:
        return argv, host_cwd, None
    cwd_path = Path(host_cwd)
    if not cwd_path.is_dir():
        return argv, host_cwd, None

    # Read the user's runtime config. Imports are local so that
    # importing this module never drags PySide6 / fleet config into
    # backends that don't need them.
    try:
        from core.fleet.config import default_runtime_config_path
        from core.fleet.runtime_config import (
            KIND_CONTAINER,
            RuntimeConfig,
        )
        from core.fleet.container_runtime import (
            DEFAULT_IMAGE,
            ContainerRuntime,
            default_auth_mounts,
        )
        from core.agents.agent_image import (
            AGENT_IMAGE_REPO,
            AgentImageError,
            ensure_agent_image,
        )
    except Exception:  # noqa: BLE001 — fleet optional at import time
        logger.debug("container wrap: fleet module unavailable, host fallback")
        return argv, host_cwd, None

    try:
        rc = RuntimeConfig.load(default_runtime_config_path())
    except Exception:  # noqa: BLE001
        logger.exception("container wrap: could not load runtime.json")
        return argv, host_cwd, None

    if rc.kind != KIND_CONTAINER:
        return argv, host_cwd, None
    if not ContainerRuntime.is_available():
        # Match RuntimeConfig.to_runtime()'s policy: warn and fall back
        # rather than refusing to spawn. Better degraded than broken.
        logger.warning(
            "container wrap: kind=container but Docker isn't available — "
            "running CLI on host (unsandboxed)"
        )
        return argv, host_cwd, None

    auth_mounts = []
    if rc.use_default_auth_mounts:
        auth_mounts.extend(default_auth_mounts())
    auth_mounts.extend(rc.extra_auth_mounts)

    # Pick the image. The default in RuntimeConfig is the fleet's
    # generic ``python:3.12-slim``, which doesn't have ``claude``/``codex``
    # — so when the user hasn't pinned a custom image, build (or reuse)
    # OWLLM's agent image with the CLIs preinstalled. A pinned image
    # (anything other than the fleet default) is honored as-is.
    image = rc.image
    if image == DEFAULT_IMAGE:
        try:
            image = ensure_agent_image()
        except AgentImageError as exc:
            logger.warning(
                "container wrap: could not build agent image (%s) — "
                "running CLI on host (unsandboxed)",
                exc,
            )
            return argv, host_cwd, None

    docker_argv: List[str] = [
        "docker", "run",
        "--rm",            # auto-cleanup; we don't track the container by name
        "-i",              # keep stdin open — the prompt is piped in
        "-v", f"{cwd_path}:/workspace:rw",
        "-w", "/workspace",
    ]
    for m in auth_mounts:
        docker_argv.extend(["-v", m.to_docker_v()])
    if rc.network:
        docker_argv.extend(["--network", rc.network])
    if rc.user:
        # Treated literally — the "host" sentinel resolution happens in
        # RuntimeConfig.to_runtime; we don't reuse that path here, so the
        # wrap simply passes whatever string the user wrote. None means
        # default (root inside container).
        docker_argv.extend(["--user", str(rc.user)])
    docker_argv.append(image)
    docker_argv.extend(argv)

    info = {
        "image": image,
        "network": rc.network or "(docker default)",
        "workspace": str(cwd_path),
        "auth_mounts": [m.to_docker_v() for m in auth_mounts],
    }
    logger.info(
        "container wrap: image=%s network=%s workspace=%s",
        info["image"], info["network"], info["workspace"],
    )
    return docker_argv, None, info
