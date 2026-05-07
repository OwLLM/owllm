"""Tests for slice 5b — CLI --launch-command, cross-process stop
fallback, ContainerRuntime --user flag, RuntimeConfig user field."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from core.fleet.cli import build_parser
from core.fleet.container_runtime import (
    ContainerRuntime,
    container_name_for,
    default_user_id,
)
from core.fleet.manifest import Claim
from core.fleet.process import ProcessHandle
from core.fleet.runtime import WorktreeRuntime
from core.fleet.runtime_config import (
    KIND_CONTAINER,
    USER_HOST_SENTINEL,
    RuntimeConfig,
)
from core.fleet.workspace import CONTEXT_FILE, WorkspaceLayout


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_layout(workspace: Path) -> WorkspaceLayout:
    workspace.mkdir(parents=True, exist_ok=True)
    clone = workspace / "clone"
    clone.mkdir()
    return WorkspaceLayout(
        root=workspace,
        clone=clone,
        context_file=workspace / CONTEXT_FILE,
    )


def _make_claim(workspace: Path) -> Claim:
    return Claim(
        agent_id="a1", target_repo="alpha", branch="agent/x",
        workspace_path=str(workspace), owns_modules=["src/x/**"],
    )


# ---------------------------------------------------------------------------
# CLI --launch-command parser
# ---------------------------------------------------------------------------


def test_cli_spawn_accepts_launch_command_string() -> None:
    args = build_parser().parse_args([
        "spawn",
        "--target-repo", "x", "--branch", "y",
        "--owns", "src/a/**",
        "--launch-command", "claude -p 'follow AGENT_CONTEXT.md'",
    ])
    # The CLI shlex-parses the string into argv at spawn time, but
    # the parsed arg stays as the raw string here.
    import shlex
    assert args.launch_command == "claude -p 'follow AGENT_CONTEXT.md'"
    assert shlex.split(args.launch_command) == [
        "claude", "-p", "follow AGENT_CONTEXT.md",
    ]


def test_cli_spawn_launch_command_default_is_none() -> None:
    args = build_parser().parse_args([
        "spawn",
        "--target-repo", "x", "--branch", "y",
        "--owns", "src/a/**",
    ])
    assert args.launch_command is None


# ---------------------------------------------------------------------------
# WorktreeRuntime.stop fallback (no Popen → os.kill the pid)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="Windows ACL: os.kill cross-process needs PROCESS_TERMINATE "
           "rights that Python's OpenProcess often can't get; on Linux/Mac "
           "this works. The fallback is still wired in — it just can't be "
           "exercised end-to-end here.",
)
def test_stop_without_popen_signals_pid(tmp_path: Path) -> None:
    """A handle reconstructed from disk has _popen=None. Stop must
    still terminate the process, not silently no-op."""
    # Spawn a real long-running process we own from this test.
    p = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        # Build a handle that mimics one rehydrated from disk: same
        # pid, log_path, but _popen=None.
        log = tmp_path / "agent.log"
        log.write_text("placeholder\n", encoding="utf-8")
        handle = ProcessHandle(
            agent_id="a", pid=p.pid, argv=("python",),
            log_path=log,
        )
        assert handle.is_running()

        WorktreeRuntime().stop(handle, timeout=3.0)

        # The process should be dead. wait() with a small timeout
        # confirms — if stop did nothing, this would hang.
        rc = p.wait(timeout=5.0)
        assert rc is not None
        assert handle.is_running() is False
    finally:
        if p.poll() is None:
            p.kill()
            p.wait(timeout=5.0)


def test_stop_without_popen_handles_dead_pid(tmp_path: Path) -> None:
    """Stopping a handle whose pid is already gone should not raise."""
    log = tmp_path / "agent.log"
    log.write_text("", encoding="utf-8")
    # Pid 1 may exist on POSIX (init); use a high-number pid that's
    # almost certainly not running.
    handle = ProcessHandle(
        agent_id="a", pid=99_999_998, argv=(),
        log_path=log,
    )
    # Should swallow the ProcessLookupError silently.
    WorktreeRuntime().stop(handle, timeout=1.0)


# ---------------------------------------------------------------------------
# ContainerRuntime --user flag
# ---------------------------------------------------------------------------


def test_default_user_id_returns_string_on_posix() -> None:
    if hasattr(os, "getuid"):
        uid_gid = default_user_id()
        assert uid_gid is not None
        assert ":" in uid_gid
        uid, gid = uid_gid.split(":")
        assert uid.isdigit() and gid.isdigit()


def test_default_user_id_returns_none_on_windows(monkeypatch) -> None:
    """When os.getuid is missing (Windows), the helper returns None."""
    import core.fleet.container_runtime as crmod
    # Patch os.getuid OUT of the module's view.
    monkeypatch.delattr(os, "getuid", raising=False)
    monkeypatch.delattr(os, "getgid", raising=False)
    assert default_user_id() is None


def test_run_cmd_omits_user_when_unset(tmp_path: Path) -> None:
    rt = ContainerRuntime()
    cmd = rt._build_run_cmd(
        container_name_for("a1"), _make_claim(tmp_path / "ws"),
        _make_layout(tmp_path / "ws"), ["true"],
    )
    assert "--user" not in cmd


def test_run_cmd_includes_user_when_set(tmp_path: Path) -> None:
    rt = ContainerRuntime(user="1000:1000")
    cmd = rt._build_run_cmd(
        container_name_for("a1"), _make_claim(tmp_path / "ws"),
        _make_layout(tmp_path / "ws"), ["true"],
    )
    idx = cmd.index("--user")
    assert cmd[idx + 1] == "1000:1000"


# ---------------------------------------------------------------------------
# RuntimeConfig user field
# ---------------------------------------------------------------------------


def test_runtime_config_user_roundtrips() -> None:
    cfg = RuntimeConfig(kind=KIND_CONTAINER, user="1000:1000")
    out = RuntimeConfig.from_dict(cfg.to_dict())
    assert out.user == "1000:1000"


def test_runtime_config_user_default_is_none() -> None:
    assert RuntimeConfig().user is None


def test_runtime_config_host_sentinel_resolves_at_apply(monkeypatch) -> None:
    """user='host' becomes the actual UID:GID via default_user_id."""
    monkeypatch.setattr(
        ContainerRuntime, "is_available",
        classmethod(lambda cls, **_: True),
    )
    monkeypatch.setattr(
        "core.fleet.runtime_config.default_user_id",
        lambda: "1234:5678",
    )
    cfg = RuntimeConfig(
        kind=KIND_CONTAINER,
        user=USER_HOST_SENTINEL,
        use_default_auth_mounts=False,
    )
    rt = cfg.to_runtime()
    assert isinstance(rt, ContainerRuntime)
    assert rt._user == "1234:5678"


def test_runtime_config_host_sentinel_omits_user_when_unsupported(
    monkeypatch,
) -> None:
    """On Windows, default_user_id returns None — sentinel resolves
    to no --user flag rather than crashing."""
    monkeypatch.setattr(
        ContainerRuntime, "is_available",
        classmethod(lambda cls, **_: True),
    )
    monkeypatch.setattr(
        "core.fleet.runtime_config.default_user_id",
        lambda: None,
    )
    cfg = RuntimeConfig(
        kind=KIND_CONTAINER,
        user=USER_HOST_SENTINEL,
        use_default_auth_mounts=False,
    )
    rt = cfg.to_runtime()
    assert isinstance(rt, ContainerRuntime)
    assert rt._user is None
