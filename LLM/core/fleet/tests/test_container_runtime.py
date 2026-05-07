"""Tests for the Docker-backed ContainerRuntime.

Two layers:

* **Unit tests** (always run) — verify the ``docker run`` argv,
  the container-name sanitisation, the ``ProcessHandle.metadata``
  contents. No real Docker required.
* **Integration tests** (gated on ``ContainerRuntime.is_available()``)
  — actually run a tiny image, check the log captured stdout, stop
  the container, and confirm cleanup. Skipped silently when Docker
  isn't on the test host.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from core.fleet.container_runtime import (
    CONTAINER_NAME_PREFIX,
    DEFAULT_IMAGE,
    WORKDIR_INSIDE_CONTAINER,
    ContainerRuntime,
    container_name_for,
)
from core.fleet.manifest import Claim
from core.fleet.workspace import CONTEXT_FILE, WorkspaceLayout


def _make_layout(workspace: Path) -> WorkspaceLayout:
    workspace.mkdir(parents=True, exist_ok=True)
    clone = workspace / "clone"
    clone.mkdir()
    return WorkspaceLayout(
        root=workspace,
        clone=clone,
        context_file=workspace / CONTEXT_FILE,
    )


def _make_claim(workspace: Path, agent_id: str = "a1") -> Claim:
    return Claim(
        agent_id=agent_id,
        target_repo="alpha",
        branch="agent/x",
        workspace_path=str(workspace),
        owns_modules=["src/x/**"],
    )


# ---------------------------------------------------------------------------
# Container name sanitisation
# ---------------------------------------------------------------------------


def test_container_name_prefixes_agent_id() -> None:
    name = container_name_for("a1b2c3d4")
    assert name.startswith(CONTAINER_NAME_PREFIX)
    assert "a1b2c3d4" in name


def test_container_name_replaces_unsafe_chars() -> None:
    name = container_name_for("weird/name with spaces")
    # Docker names: [a-zA-Z0-9][a-zA-Z0-9_.-]*
    for ch in name[len(CONTAINER_NAME_PREFIX):]:
        assert ch.isalnum() or ch in "-_."


# ---------------------------------------------------------------------------
# Argv composition (no Docker needed)
# ---------------------------------------------------------------------------


def test_run_cmd_includes_workspace_mount(tmp_path: Path) -> None:
    layout = _make_layout(tmp_path / "ws-a1")
    rt = ContainerRuntime(image="alpine:3.20")
    cmd = rt._build_run_cmd(
        container_name_for("a1"), layout, ["echo", "hi"],
    )
    assert "docker" in cmd[0]
    assert "run" in cmd
    assert "--rm" in cmd
    assert "--name" in cmd
    assert "-v" in cmd
    assert "-w" in cmd
    assert WORKDIR_INSIDE_CONTAINER in cmd
    assert "alpine:3.20" in cmd
    # The mount spec joins clone path → /workspace.
    mount_arg = cmd[cmd.index("-v") + 1]
    assert mount_arg.endswith(f":{WORKDIR_INSIDE_CONTAINER}")
    assert str(layout.clone) in mount_arg
    # User argv comes last, in order.
    assert cmd[-2:] == ["echo", "hi"]


def test_run_cmd_uses_default_image_when_unspecified(tmp_path: Path) -> None:
    layout = _make_layout(tmp_path / "ws-a1")
    rt = ContainerRuntime()
    cmd = rt._build_run_cmd(container_name_for("a1"), layout, ["true"])
    assert DEFAULT_IMAGE in cmd


# ---------------------------------------------------------------------------
# is_available
# ---------------------------------------------------------------------------


def test_is_available_false_when_docker_not_on_path() -> None:
    with patch("shutil.which", return_value=None):
        assert ContainerRuntime.is_available() is False


def test_is_available_false_when_docker_version_fails() -> None:
    class _Result:
        returncode = 1
    with patch("shutil.which", return_value="/usr/bin/docker"), \
         patch("subprocess.run", return_value=_Result()):
        assert ContainerRuntime.is_available() is False


# ---------------------------------------------------------------------------
# setup / teardown delegation
# ---------------------------------------------------------------------------


def test_setup_teardown_delegate_to_inner(tmp_path: Path) -> None:
    """Spy that the ContainerRuntime delegates workspace lifecycle
    to the WorktreeRuntime instead of duplicating it."""
    rt = ContainerRuntime()
    with patch.object(rt._inner, "setup", return_value="layout-ok") as s:
        result = rt.setup(_make_claim(tmp_path / "ws"), base_branch="trunk")
    s.assert_called_once()
    # base_branch threaded through.
    _, kwargs = s.call_args
    assert kwargs.get("base_branch") == "trunk"
    assert result == "layout-ok"

    with patch.object(rt._inner, "teardown", return_value="https://pr") as t:
        result = rt.teardown(
            _make_claim(tmp_path / "ws"), push=False, open_pr=True,
            pr_title="t", pr_body="b",
        )
    t.assert_called_once()
    _, kwargs = t.call_args
    assert kwargs == {
        "push": False, "open_pr": True, "pr_title": "t", "pr_body": "b",
    }
    assert result == "https://pr"


# ---------------------------------------------------------------------------
# start — argv validation
# ---------------------------------------------------------------------------


def test_start_rejects_empty_argv(tmp_path: Path) -> None:
    rt = ContainerRuntime()
    layout = _make_layout(tmp_path / "ws-a1")
    with pytest.raises(ValueError):
        rt.start(_make_claim(tmp_path / "ws-a1"), layout, [])


# ---------------------------------------------------------------------------
# Integration — actually launch a tiny container (gated on Docker)
# ---------------------------------------------------------------------------


docker_required = pytest.mark.skipif(
    not ContainerRuntime.is_available(),
    reason="docker not available on this host",
)


@docker_required
def test_start_runs_container_and_captures_stdout(tmp_path: Path) -> None:
    """End-to-end: docker run a one-shot command, verify the log
    captures stdout."""
    layout = _make_layout(tmp_path / "ws-a1")
    claim = _make_claim(tmp_path / "ws-a1")
    rt = ContainerRuntime(image="alpine:3.20")

    handle = rt.start(claim, layout, ["echo", "hello-from-container"])
    try:
        rc = handle._popen.wait(timeout=120)
    finally:
        handle.close_log()

    assert rc == 0, handle.log_path.read_text(encoding="utf-8")
    assert handle.metadata["container_name"].startswith(CONTAINER_NAME_PREFIX)
    log = handle.log_path.read_text(encoding="utf-8")
    assert "hello-from-container" in log
    # Preamble includes mount info so users can debug.
    assert "container" in log.lower()
    assert "mount" in log.lower()


@docker_required
def test_workspace_mount_visible_inside_container(tmp_path: Path) -> None:
    """The clone directory IS the agent's /workspace — write a file
    locally, see it from inside the container."""
    layout = _make_layout(tmp_path / "ws-a1")
    (layout.clone / "hello.txt").write_text("from host\n", encoding="utf-8")
    claim = _make_claim(tmp_path / "ws-a1")
    rt = ContainerRuntime(image="alpine:3.20")

    handle = rt.start(claim, layout, ["cat", "hello.txt"])
    try:
        rc = handle._popen.wait(timeout=120)
    finally:
        handle.close_log()

    assert rc == 0
    log = handle.log_path.read_text(encoding="utf-8")
    assert "from host" in log


@docker_required
def test_stop_terminates_running_container(tmp_path: Path) -> None:
    layout = _make_layout(tmp_path / "ws-a1")
    claim = _make_claim(tmp_path / "ws-a1")
    rt = ContainerRuntime(image="alpine:3.20")

    handle = rt.start(claim, layout, ["sleep", "60"])
    # Give Docker a moment to actually start the container.
    time.sleep(2.0)
    assert handle.is_running(), "container should be alive"

    rc = rt.stop(handle, timeout=10.0)
    assert handle.is_running() is False
    # rc may be a Docker-stopped sentinel (137 SIGKILL, 143 SIGTERM,
    # or similar). What matters is that the container is gone.
    assert rc is not None or handle.returncode() is not None
