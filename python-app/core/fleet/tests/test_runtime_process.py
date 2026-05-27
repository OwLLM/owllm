"""Tests for the WorktreeRuntime.start / stop process-launch path.

Slice 3b additions. Bypass git entirely — we manually construct the
layout so the test runs in milliseconds rather than seconds.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from core.fleet.manifest import Claim
from core.fleet.runtime import LOG_FILE_NAME, WorktreeRuntime
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
# start
# ---------------------------------------------------------------------------


def test_start_launches_subprocess_and_writes_log(tmp_path: Path) -> None:
    layout = _make_layout(tmp_path / "ws-a1")
    claim = _make_claim(tmp_path / "ws-a1")
    rt = WorktreeRuntime()

    handle = rt.start(
        claim, layout,
        [sys.executable, "-c", "print('hello from agent')"],
    )
    try:
        rc = handle._popen.wait(timeout=10)
    finally:
        handle.close_log()

    assert rc == 0
    assert handle.pid > 0
    assert handle.argv[0] == sys.executable
    assert handle.log_path == layout.root / LOG_FILE_NAME
    log_text = handle.log_path.read_text(encoding="utf-8")
    assert "hello from agent" in log_text
    # Preamble lands in the log so users can see what was run.
    assert claim.agent_id in log_text


def test_start_writes_log_at_workspace_root_not_in_clone(tmp_path: Path) -> None:
    """The log must NOT live inside ``clone/`` — that would land it
    in the target repo's working tree."""
    layout = _make_layout(tmp_path / "ws-a1")
    claim = _make_claim(tmp_path / "ws-a1")
    rt = WorktreeRuntime()

    handle = rt.start(
        claim, layout, [sys.executable, "-c", "pass"],
    )
    try:
        handle._popen.wait(timeout=10)
    finally:
        handle.close_log()

    assert handle.log_path.parent == layout.root
    assert not (layout.clone / LOG_FILE_NAME).exists()


def test_start_rejects_empty_argv(tmp_path: Path) -> None:
    layout = _make_layout(tmp_path / "ws-a1")
    claim = _make_claim(tmp_path / "ws-a1")
    rt = WorktreeRuntime()
    with pytest.raises(ValueError):
        rt.start(claim, layout, [])


# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------


def test_stop_terminates_long_running_process(tmp_path: Path) -> None:
    layout = _make_layout(tmp_path / "ws-a1")
    claim = _make_claim(tmp_path / "ws-a1")
    rt = WorktreeRuntime()

    handle = rt.start(
        claim, layout,
        [sys.executable, "-c", "import time; time.sleep(60)"],
    )
    assert handle.is_running()
    rc = rt.stop(handle, timeout=3.0)

    assert handle.is_running() is False
    # rc may be a non-zero signal-encoded value on some platforms;
    # the only guarantee is that the process is gone.
    assert rc is not None or handle.returncode() is not None


def test_stop_on_already_exited_is_safe(tmp_path: Path) -> None:
    layout = _make_layout(tmp_path / "ws-a1")
    claim = _make_claim(tmp_path / "ws-a1")
    rt = WorktreeRuntime()

    handle = rt.start(
        claim, layout, [sys.executable, "-c", "pass"],
    )
    handle._popen.wait(timeout=10)

    # stop after natural exit should not raise; should close the log
    # handle and return the recorded returncode.
    rc = rt.stop(handle, timeout=1.0)
    assert rc == 0
    assert handle.is_running() is False
