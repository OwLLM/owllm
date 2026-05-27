"""Auto-build of the OWLLM agent container image.

The agents-tab team's containerized CLI/tool calls need a Docker image
that has ``claude``, ``codex``, ``python3``, and ``git`` available. We
ship the recipe (``LLM/runtime/agent_container/Dockerfile``) and build
it on demand, content-hashed so editing the Dockerfile bumps the tag
and forces a rebuild on next Run. The user does not have to ``docker
build`` anything by hand.

Public API
==========

* :data:`AGENT_IMAGE_REPO` — repo half of the tag (``"owllm/agent"``).
* :func:`agent_image_tag` — what tag *should* exist for the current
  Dockerfile (``"owllm/agent:<sha-7>"``).
* :func:`ensure_agent_image` — return the tag, building if needed.
  Raises :class:`AgentImageError` on docker failure (caller decides
  whether to fall back to host execution).

The build is cooperative: if two threads / processes call
:func:`ensure_agent_image` at the same time and the image isn't built,
both will try to build. ``docker build`` is idempotent on the same tag,
so the second build just no-ops against the layer cache. We don't
serialize because the cost (one extra cache hit) is dwarfed by the
locking complexity that would be needed across processes.
"""
from __future__ import annotations

import hashlib
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


AGENT_IMAGE_REPO = "owllm/agent"
"""Repo half of the auto-built image tag. The full tag is
``owllm/agent:<short-content-hash>``; bumping the Dockerfile bumps the
hash, which makes the old image stale without deleting it."""

_BUILD_TIMEOUT_SECONDS = 600  # 10 min — claude-code + codex npm install is slow


class AgentImageError(RuntimeError):
    """Raised when the image could not be built or located."""


def dockerfile_path() -> Path:
    """Absolute path to the shipped Dockerfile.

    Computed from this file's location so it works whether OWLLM was
    installed, run from source, or vendored into another project."""
    return (
        Path(__file__).resolve().parent.parent.parent
        / "runtime" / "agent_container" / "Dockerfile"
    )


def _content_hash(path: Path) -> str:
    """SHA-256 of the Dockerfile, truncated to 12 hex chars.

    12 chars = ~48 bits = effectively zero collision risk for the small
    number of Dockerfile revisions this project will accumulate, while
    keeping the image tag short enough to read in ``docker image ls``.
    """
    h = hashlib.sha256(path.read_bytes()).hexdigest()
    return h[:12]


def agent_image_tag(dockerfile: Optional[Path] = None) -> str:
    """Return the tag the current Dockerfile *should* have.

    Pure function — does not touch Docker. Used both by the build path
    (target tag) and by callers that want to log "we expect <tag>"
    without forcing a rebuild.
    """
    df = dockerfile or dockerfile_path()
    if not df.is_file():
        raise AgentImageError(f"agent Dockerfile missing: {df}")
    return f"{AGENT_IMAGE_REPO}:{_content_hash(df)}"


def _docker_inspect_image(tag: str, *, docker_bin: str = "docker") -> bool:
    """True iff ``docker image inspect <tag>`` reports the image exists."""
    try:
        r = subprocess.run(
            [docker_bin, "image", "inspect", tag],
            capture_output=True, text=True, timeout=10,
        )
    except (FileNotFoundError, subprocess.SubprocessError) as e:
        logger.debug("docker image inspect raised: %s", e)
        return False
    return r.returncode == 0


def _docker_build(
    tag: str,
    dockerfile: Path,
    *,
    docker_bin: str = "docker",
    log_callback=None,
) -> None:
    """Build ``tag`` from the given Dockerfile. Raises on failure.

    Streams the docker output line-by-line into ``log_callback`` so the
    UI can surface progress (it's a long-ish build the first time).
    """
    cmd = [
        docker_bin, "build",
        "-t", tag,
        "-f", str(dockerfile),
        str(dockerfile.parent),  # build context = the Dockerfile's dir
    ]
    logger.info("building agent image: %s", " ".join(cmd))
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as e:
        raise AgentImageError(f"could not exec docker build: {e}") from e

    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            line = line.rstrip()
            if log_callback is not None:
                try:
                    log_callback(line)
                except Exception:  # noqa: BLE001
                    logger.debug("agent image log_callback raised", exc_info=True)
            else:
                logger.info("[agent image build] %s", line)
        rc = proc.wait(timeout=_BUILD_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise AgentImageError(
            f"agent image build exceeded {_BUILD_TIMEOUT_SECONDS}s"
        )

    if rc != 0:
        raise AgentImageError(f"docker build exited {rc} for tag {tag!r}")


def ensure_agent_image(
    *,
    docker_bin: str = "docker",
    log_callback=None,
) -> str:
    """Return the agent image tag, building it if it isn't already cached.

    No-op fast path: if ``docker image inspect <expected-tag>`` succeeds,
    we return immediately. The expensive ``docker build`` only runs on
    the first Run after install or after a Dockerfile edit.
    """
    if shutil.which(docker_bin) is None:
        raise AgentImageError(f"{docker_bin!r} not on PATH")

    tag = agent_image_tag()

    if _docker_inspect_image(tag, docker_bin=docker_bin):
        logger.debug("agent image already present: %s", tag)
        return tag

    logger.info("agent image %s not present — building", tag)
    _docker_build(
        tag, dockerfile_path(),
        docker_bin=docker_bin, log_callback=log_callback,
    )
    return tag
