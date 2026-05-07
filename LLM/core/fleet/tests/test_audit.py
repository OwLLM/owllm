"""Tests for the fleet audit log."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.fleet.audit import (
    EVENT_FINISH,
    EVENT_HEARTBEAT,
    EVENT_SPAWN,
    AuditLog,
)


@pytest.fixture
def audit_path(tmp_path: Path) -> Path:
    return tmp_path / "audit.log.jsonl"


def test_log_appends_one_jsonl_line_per_event(audit_path: Path) -> None:
    a = AuditLog(audit_path)
    a.log(EVENT_SPAWN, agent_id="a1", branch="agent/x")
    a.log(EVENT_FINISH, agent_id="a1", pushed=True)

    lines = audit_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    rec0 = json.loads(lines[0])
    assert rec0["event"] == "spawn"
    assert rec0["agent_id"] == "a1"
    assert rec0["branch"] == "agent/x"
    assert "ts" in rec0
    rec1 = json.loads(lines[1])
    assert rec1["event"] == "finish"
    assert rec1["pushed"] is True


def test_log_creates_parent_dir(tmp_path: Path) -> None:
    nested = tmp_path / "deeply" / "nested" / "audit.jsonl"
    AuditLog(nested).log(EVENT_HEARTBEAT, agent_id="a1")
    assert nested.exists()


def test_tail_returns_oldest_first(audit_path: Path) -> None:
    a = AuditLog(audit_path)
    for i in range(10):
        a.log(EVENT_HEARTBEAT, agent_id=f"a{i}")
    last3 = a.tail(3)
    assert [e["agent_id"] for e in last3] == ["a7", "a8", "a9"]


def test_tail_on_missing_file_returns_empty(tmp_path: Path) -> None:
    a = AuditLog(tmp_path / "never_written.jsonl")
    assert a.tail() == []


def test_corrupted_lines_are_skipped(audit_path: Path) -> None:
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    audit_path.write_text(
        '{"event": "spawn", "agent_id": "good"}\n'
        "this is not json\n"
        '{"event": "finish", "agent_id": "good"}\n',
        encoding="utf-8",
    )
    out = AuditLog(audit_path).tail()
    assert [e["event"] for e in out] == ["spawn", "finish"]


def test_iter_all_streams_in_order(audit_path: Path) -> None:
    a = AuditLog(audit_path)
    a.log(EVENT_SPAWN, agent_id="a1")
    a.log(EVENT_HEARTBEAT, agent_id="a1")
    a.log(EVENT_FINISH, agent_id="a1")
    out = list(a.iter_all())
    assert [e["event"] for e in out] == ["spawn", "heartbeat", "finish"]


def test_log_swallows_serialisation_failures(audit_path: Path, caplog) -> None:
    """An event with a non-JSON-serialisable detail must not raise —
    audit failures must never bring down the action being recorded."""
    class _NotSerialisable:
        def __repr__(self):
            raise RuntimeError("nope")

    a = AuditLog(audit_path)
    # default=str catches most things; this object's repr also raises,
    # so json.dumps will fail. The audit log must absorb it silently.
    a.log(EVENT_SPAWN, agent_id="a1", weird=_NotSerialisable())
    # And subsequent events still work.
    a.log(EVENT_FINISH, agent_id="a1")
    assert a.tail()[-1]["event"] == "finish"


def test_concurrent_writes_dont_interleave(audit_path: Path) -> None:
    """All lines parse as JSON even under threaded writers."""
    import threading

    a = AuditLog(audit_path)

    def hammer(label: str) -> None:
        for i in range(50):
            a.log(EVENT_HEARTBEAT, agent_id=f"{label}-{i}")

    threads = [threading.Thread(target=hammer, args=(c,)) for c in "abcde"]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    lines = audit_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 250
    for line in lines:
        json.loads(line)  # raises if any line was torn
