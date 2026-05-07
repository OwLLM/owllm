"""Tests for ProcessHandle + ProcessRegistry."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from core.fleet.process import ProcessHandle, ProcessRegistry


# ---------------------------------------------------------------------------
# ProcessHandle
# ---------------------------------------------------------------------------


def test_handle_self_pid_reads_as_running(tmp_path: Path) -> None:
    """No Popen + a live pid → is_running uses signal-0 probe."""
    handle = ProcessHandle(
        agent_id="a", pid=os.getpid(), argv=("self",),
        log_path=tmp_path / "self.log",
    )
    assert handle.is_running() is True
    # No Popen means returncode is unavailable.
    assert handle.returncode() is None


def test_handle_with_popen_tracks_lifecycle(tmp_path: Path) -> None:
    p = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(0.3)"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    handle = ProcessHandle(
        agent_id="a", pid=p.pid, argv=("python",),
        log_path=tmp_path / "x.log", _popen=p,
    )
    assert handle.is_running() is True
    p.wait(timeout=5)
    assert handle.is_running() is False
    assert handle.returncode() == 0


def test_mark_exited_is_idempotent(tmp_path: Path) -> None:
    p = subprocess.Popen(
        [sys.executable, "-c", "pass"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    p.wait(timeout=5)
    handle = ProcessHandle(
        agent_id="a", pid=p.pid, argv=("python",),
        log_path=tmp_path / "x.log", _popen=p,
    )
    handle.mark_exited()
    first = handle.exited_at
    assert first is not None
    handle.mark_exited()
    assert handle.exited_at == first  # not bumped


def test_to_dict_excludes_private_fields(tmp_path: Path) -> None:
    handle = ProcessHandle(
        agent_id="a", pid=42, argv=("x", "y"),
        log_path=tmp_path / "z.log",
    )
    d = handle.to_dict()
    # Public fields present, private ones absent.
    assert d["agent_id"] == "a"
    assert d["pid"] == 42
    assert d["argv"] == ["x", "y"]
    assert "_popen" not in d
    assert "_log_handle" not in d


# ---------------------------------------------------------------------------
# ProcessRegistry
# ---------------------------------------------------------------------------


def test_registry_register_get_pop(tmp_path: Path) -> None:
    r = ProcessRegistry()
    handle = ProcessHandle(
        agent_id="a", pid=1, argv=(),
        log_path=tmp_path / "a.log",
    )
    r.register(handle)
    assert r.get("a") is handle
    assert r.list() == [handle]
    assert r.pop("a") is handle
    assert r.get("a") is None
    assert r.list() == []


def test_registry_register_refuses_duplicate_when_running(tmp_path: Path) -> None:
    r = ProcessRegistry()
    p = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(2)"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        h1 = ProcessHandle(
            agent_id="a", pid=p.pid, argv=(),
            log_path=tmp_path / "a.log", _popen=p,
        )
        r.register(h1)
        h2 = ProcessHandle(
            agent_id="a", pid=p.pid, argv=(),
            log_path=tmp_path / "a.log",
        )
        with pytest.raises(RuntimeError):
            r.register(h2)
    finally:
        p.terminate()
        p.wait(timeout=5)


def test_registry_register_replaces_when_old_one_exited(tmp_path: Path) -> None:
    r = ProcessRegistry()
    p = subprocess.Popen(
        [sys.executable, "-c", "pass"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    p.wait(timeout=5)
    h_old = ProcessHandle(
        agent_id="a", pid=p.pid, argv=(),
        log_path=tmp_path / "a.log", _popen=p,
    )
    r.register(h_old)
    # Old one is already exited; the registry must allow replacement.
    h_new = ProcessHandle(
        agent_id="a", pid=99999, argv=(),
        log_path=tmp_path / "a2.log",
    )
    r.register(h_new)
    assert r.get("a") is h_new


def test_registry_pop_unknown_returns_none() -> None:
    r = ProcessRegistry()
    assert r.pop("ghost") is None


def test_registry_refresh_status_marks_exited(tmp_path: Path) -> None:
    r = ProcessRegistry()
    p = subprocess.Popen(
        [sys.executable, "-c", "pass"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    p.wait(timeout=5)
    handle = ProcessHandle(
        agent_id="a", pid=p.pid, argv=(),
        log_path=tmp_path / "a.log", _popen=p,
    )
    r.register(handle)
    assert handle.exited_at is None
    r.refresh_status()
    assert handle.exited_at is not None
