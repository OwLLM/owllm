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


@pytest.fixture
def registry_root(tmp_path: Path) -> Path:
    return tmp_path / "process_index"


def test_registry_register_get_pop(tmp_path: Path, registry_root: Path) -> None:
    r = ProcessRegistry(registry_root)
    handle = ProcessHandle(
        agent_id="a", pid=os.getpid(), argv=(),
        log_path=tmp_path / "a.log",
    )
    r.register(handle)
    assert r.get("a") is handle
    assert r.list() == [handle]
    assert r.pop("a") is handle
    assert r.get("a") is None
    assert r.list() == []


def test_registry_register_refuses_duplicate_when_running(
    tmp_path: Path, registry_root: Path,
) -> None:
    r = ProcessRegistry(registry_root)
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


def test_registry_register_replaces_when_old_one_exited(
    tmp_path: Path, registry_root: Path,
) -> None:
    r = ProcessRegistry(registry_root)
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


def test_registry_pop_unknown_returns_none(registry_root: Path) -> None:
    r = ProcessRegistry(registry_root)
    assert r.pop("ghost") is None


def test_registry_refresh_status_marks_exited(
    tmp_path: Path, registry_root: Path,
) -> None:
    r = ProcessRegistry(registry_root)
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


# ---------------------------------------------------------------------------
# Cross-process discovery (the disk-backed half)
# ---------------------------------------------------------------------------


def test_register_writes_disk_record(
    tmp_path: Path, registry_root: Path,
) -> None:
    r = ProcessRegistry(registry_root)
    handle = ProcessHandle(
        agent_id="a1", pid=os.getpid(), argv=("python",),
        log_path=tmp_path / "a1.log",
    )
    r.register(handle)
    record = registry_root / "a1.json"
    assert record.exists()
    import json as _json
    data = _json.loads(record.read_text(encoding="utf-8"))
    assert data["agent_id"] == "a1"
    assert data["pid"] == os.getpid()


def test_pop_removes_disk_record(
    tmp_path: Path, registry_root: Path,
) -> None:
    r = ProcessRegistry(registry_root)
    r.register(ProcessHandle(
        agent_id="a1", pid=os.getpid(), argv=(),
        log_path=tmp_path / "x.log",
    ))
    assert (registry_root / "a1.json").exists()
    r.pop("a1")
    assert not (registry_root / "a1.json").exists()


def test_second_registry_sees_first_registrys_records(
    tmp_path: Path, registry_root: Path,
) -> None:
    """The cross-process discovery property — a different
    ProcessRegistry instance pointing at the same root_dir picks up
    handles registered by the first."""
    r1 = ProcessRegistry(registry_root)
    r1.register(ProcessHandle(
        agent_id="from-r1", pid=os.getpid(), argv=("python",),
        log_path=tmp_path / "from-r1.log",
    ))

    r2 = ProcessRegistry(registry_root)
    handle = r2.get("from-r1")
    assert handle is not None
    assert handle.agent_id == "from-r1"
    assert handle.pid == os.getpid()
    # r2 didn't launch the process — its handle has no Popen.
    assert handle._popen is None
    # is_running uses the signal-0 probe and finds the live PID.
    assert handle.is_running() is True


def test_refresh_status_culls_dead_disk_records(
    tmp_path: Path, registry_root: Path, monkeypatch,
) -> None:
    """Records for processes that died without proper pop are removed
    on the next refresh — at most one stale record per crashed launcher.

    Forces ``is_running`` to False rather than relying on a real
    just-reaped pid: on Windows the OS holds the pid live for a few
    ms after ``Popen.wait()`` returns, which makes the natural test
    flaky. The assertion under test is the registry cleanup logic,
    not the ``os.kill(pid, 0)`` probe.
    """
    registry_root.mkdir(parents=True, exist_ok=True)
    record = registry_root / "dead.json"
    record.write_text(
        '{"agent_id": "dead", "pid": 1, "argv": [], '
        '"log_path": "x", "started_at": "2026-05-07T00:00:00Z"}',
        encoding="utf-8",
    )
    monkeypatch.setattr(ProcessHandle, "is_running", lambda self: False)

    r = ProcessRegistry(registry_root)
    r.refresh_status()
    assert not record.exists()


def test_filesystem_unsafe_agent_id_sanitised(
    tmp_path: Path, registry_root: Path,
) -> None:
    r = ProcessRegistry(registry_root)
    r.register(ProcessHandle(
        agent_id="weird/id with spaces",
        pid=os.getpid(),
        argv=(),
        log_path=tmp_path / "x.log",
    ))
    # Slashes + spaces become underscores — safe on every filesystem.
    files = list(registry_root.glob("*.json"))
    assert len(files) == 1
    assert "/" not in files[0].name
    assert " " not in files[0].name
