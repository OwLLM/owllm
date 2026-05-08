"""Container-isolation wrap for agent subprocess calls.

The agents-tab team runs three kinds of host subprocess that can touch
the user's filesystem and network:

* ``claude --print …`` (claude_cli backend)
* ``codex exec …``     (codex_cli backend)
* the OWLLM ``shell`` tool (e.g. ``pytest -x``, ``git status``)

When the user has opted in via ``<fleet_root>/runtime.json`` (the same
config the fleet uses), all three are wrapped in ``docker run`` here.
Project Location bind-mounts at ``/workspace``; ``~/.claude`` and the
other auth dirs mount RO so the in-container CLIs reuse the host login.
The dangerous tool calls then can't escape ``/workspace``.

Public API
==========

* :func:`wrap_cli_for_container`   — wraps an argv list (Claude/Codex CLI).
* :func:`wrap_shell_for_container` — wraps a shell-string command (the
  OWLLM ``shell`` tool, which calls ``subprocess.run(cmd, shell=True)``).

Both share the same opt-in gates and the same internal docker argv
builder. Either falls back to host execution when:

* the caller passed no usable ``host_cwd`` (no project Location to mount)
* ``runtime.json`` selects ``kind=worktree`` (user explicitly opted out)
* Docker isn't installed / daemon is down
* the agent image can't be built

Falling back beats freezing the team.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import List, Optional, Tuple, Union

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal: opt-in gate + docker argv builder
# ---------------------------------------------------------------------------


def _resolve_container_request(
    host_cwd: Optional[str],
) -> Optional[Tuple[Path, "RuntimeConfigT", str, list, dict]]:  # type: ignore[name-defined]
    """Decide whether to wrap. Returns the inputs the wrap needs, or
    ``None`` if any gate fails (caller should fall back to host).

    Tuple shape on success: ``(workspace_path, runtime_config,
    image_tag, auth_mounts, info_seed)``.
    """
    if not host_cwd:
        return None
    cwd_path = Path(host_cwd)
    if not cwd_path.is_dir():
        return None

    # Imports are local so that importing this module never drags
    # PySide6/fleet/agent-image dependencies into backends that don't
    # need them.
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
            AgentImageError,
            ensure_agent_image,
        )
    except Exception:  # noqa: BLE001
        logger.debug("container wrap: fleet module unavailable, host fallback")
        return None

    try:
        rc = RuntimeConfig.load(default_runtime_config_path())
    except Exception:  # noqa: BLE001
        logger.exception("container wrap: could not load runtime.json")
        return None

    if rc.kind != KIND_CONTAINER:
        return None
    if not ContainerRuntime.is_available():
        logger.warning(
            "container wrap: kind=container but Docker isn't available — "
            "running on host (unsandboxed)"
        )
        return None

    auth_mounts = []
    if rc.use_default_auth_mounts:
        auth_mounts.extend(default_auth_mounts())
    auth_mounts.extend(rc.extra_auth_mounts)

    # Pick the image. The fleet's generic default (``python:3.12-slim``)
    # has neither claude nor codex, so when the user hasn't pinned a
    # specific image we auto-build OWLLM's agent image. Custom images
    # are honored as-is.
    image = rc.image
    if image == DEFAULT_IMAGE:
        try:
            image = ensure_agent_image()
        except AgentImageError as exc:
            logger.warning(
                "container wrap: could not build agent image (%s) — "
                "running on host (unsandboxed)",
                exc,
            )
            return None

    info = {
        "image": image,
        "network": rc.network or "(docker default)",
        "workspace": str(cwd_path),
        "auth_mounts": [m.to_docker_v() for m in auth_mounts],
    }
    return cwd_path, rc, image, auth_mounts, info


def _build_docker_argv(
    cwd_path: Path,
    rc,
    image: str,
    auth_mounts: list,
    inner_argv: List[str],
) -> List[str]:
    """Compose ``docker run … <image> <inner_argv>``."""
    docker_argv: List[str] = [
        "docker", "run",
        "--rm",            # auto-cleanup; container name is ephemeral
        "-i",              # keep stdin open for prompt-piped CLI calls
        "-v", f"{cwd_path}:/workspace:rw",
        "-w", "/workspace",
    ]
    for m in auth_mounts:
        docker_argv.extend(["-v", m.to_docker_v()])
    if rc.network:
        docker_argv.extend(["--network", rc.network])
    if rc.user:
        # Treated literally; the "host" sentinel resolution happens in
        # RuntimeConfig.to_runtime() (which we don't go through here).
        docker_argv.extend(["--user", str(rc.user)])
    docker_argv.append(image)
    docker_argv.extend(inner_argv)
    return docker_argv


# ---------------------------------------------------------------------------
# Public wrap functions
# ---------------------------------------------------------------------------


def wrap_cli_for_container(
    argv: List[str],
    *,
    host_cwd: Optional[str],
) -> Tuple[List[str], Optional[str], Optional[dict]]:
    """Optionally wrap a CLI argv in ``docker run``.

    :param argv:     The host argv (e.g. ``[claude.exe, --print, ...]``).
    :param host_cwd: The host cwd where the CLI would run — becomes the
                     ``/workspace`` mount inside the container.

    :returns: ``(final_argv, final_cwd, info)``. When wrapping is active
              the argv is ``docker run …`` and ``final_cwd=None``. When
              wrapping is inactive the argv and cwd are returned
              unchanged.
    """
    resolved = _resolve_container_request(host_cwd)
    if resolved is None:
        return argv, host_cwd, None
    cwd_path, rc, image, auth_mounts, info = resolved

    docker_argv = _build_docker_argv(cwd_path, rc, image, auth_mounts, argv)
    logger.info(
        "container wrap (cli): image=%s workspace=%s",
        info["image"], info["workspace"],
    )
    return docker_argv, None, info


def wrap_shell_for_container(
    cmd: str,
    *,
    host_cwd: Optional[str],
) -> Tuple[Union[str, List[str]], Optional[str], bool, Optional[dict]]:
    """Optionally wrap a shell-string command in ``docker run … sh -c``.

    Mirrors :func:`wrap_cli_for_container` for the OWLLM ``shell`` tool,
    which historically calls ``subprocess.run(cmd, shell=True, cwd=…)``.

    :param cmd:      The shell command line (e.g. ``"pytest -x"``).
    :param host_cwd: The host cwd the shell tool would run in — becomes
                     ``/workspace`` inside the container.

    :returns: ``(final_cmd, final_cwd, use_shell, info)``.

              * Container active: ``final_cmd`` is a docker-run argv list
                ending in ``["sh", "-c", cmd]``, ``final_cwd=None``,
                ``use_shell=False`` (subprocess takes a list, not a
                shell-interpreted string).
              * Container inactive: ``final_cmd`` is the original
                ``cmd`` string, ``final_cwd`` is ``host_cwd``,
                ``use_shell=True`` (preserves the host's previous
                behavior of letting the OS shell parse the line).
    """
    resolved = _resolve_container_request(host_cwd)
    if resolved is None:
        return cmd, host_cwd, True, None
    cwd_path, rc, image, auth_mounts, info = resolved

    inner_argv = ["sh", "-c", cmd]
    docker_argv = _build_docker_argv(
        cwd_path, rc, image, auth_mounts, inner_argv,
    )
    logger.info(
        "container wrap (shell): image=%s workspace=%s cmd=%s",
        info["image"], info["workspace"],
        cmd if len(cmd) <= 80 else cmd[:77] + "…",
    )
    return docker_argv, None, False, info
