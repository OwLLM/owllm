"""Tests for the fleet CLI.

Argparse plumbing tests run with no external deps. End-to-end tests
that exercise spawn → list → finish skip when ``git`` isn't on PATH.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from core.fleet.cli import build_parser, main


# ---------------------------------------------------------------------------
# Argparse plumbing
# ---------------------------------------------------------------------------


def test_parser_collects_repeated_owns_and_reads() -> None:
    args = build_parser().parse_args([
        "spawn",
        "--target-repo", "x",
        "--branch", "y",
        "--owns", "src/a/**",
        "--owns", "src/b/**",
        "--reads", "src/c/**",
    ])
    assert args.command == "spawn"
    assert args.owns == ["src/a/**", "src/b/**"]
    assert args.reads == ["src/c/**"]


def test_parser_finish_requires_agent_id() -> None:
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["finish"])  # missing positional


def test_parser_command_required() -> None:
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args([])


def test_list_empty_returns_empty_array(tmp_path: Path, capsys) -> None:
    rc = main([
        "list",
        "--db", str(tmp_path / "m.sqlite"),
        "--workspace-root", str(tmp_path / "ws"),
    ])
    captured = capsys.readouterr()
    assert rc == 0
    assert json.loads(captured.out) == []


# ---------------------------------------------------------------------------
# End-to-end (requires git)
# ---------------------------------------------------------------------------


git_required = pytest.mark.skipif(
    shutil.which("git") is None, reason="git not on PATH",
)


def _git(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        check=True,
        capture_output=True,
    )


def _make_seed_repo(path: Path) -> Path:
    path.mkdir(parents=True)
    _git("init", "-b", "main", str(path))
    _git("-C", str(path), "config", "user.email", "test@example.com")
    _git("-C", str(path), "config", "user.name", "test")
    (path / "README.md").write_text("hi\n", encoding="utf-8")
    _git("-C", str(path), "add", ".")
    _git("-C", str(path), "commit", "-m", "init")
    return path


@git_required
def test_spawn_then_list_then_finish(tmp_path: Path, capsys) -> None:
    target = _make_seed_repo(tmp_path / "target")
    db = tmp_path / "m.sqlite"
    ws_root = tmp_path / "ws"

    rc = main([
        "spawn",
        "--db", str(db), "--workspace-root", str(ws_root),
        "--target-repo", str(target),
        "--branch", "agent/test",
        "--owns", "src/x/**",
        "--reason", "smoke",
        "--agent-id", "a1",
    ])
    captured = capsys.readouterr()
    assert rc == 0, captured.err
    spawned = json.loads(captured.out)
    assert spawned["agent_id"] == "a1"
    assert spawned["branch"] == "agent/test"
    assert Path(spawned["workspace"]).exists()
    assert Path(spawned["context_file"]).exists()

    rc = main([
        "list",
        "--db", str(db), "--workspace-root", str(ws_root),
    ])
    captured = capsys.readouterr()
    listing = json.loads(captured.out)
    assert len(listing) == 1
    assert listing[0]["agent_id"] == "a1"
    assert listing[0]["status"] == "active"

    rc = main([
        "finish", "a1",
        "--db", str(db), "--workspace-root", str(ws_root),
        "--no-push",
    ])
    captured = capsys.readouterr()
    finished = json.loads(captured.out)
    assert finished["released"] is True
    assert not Path(spawned["workspace"]).exists()

    rc = main([
        "list",
        "--db", str(db), "--workspace-root", str(ws_root),
    ])
    captured = capsys.readouterr()
    assert json.loads(captured.out) == []


@git_required
def test_spawn_refuses_overlap_with_existing_branch(tmp_path: Path, capsys) -> None:
    target = _make_seed_repo(tmp_path / "target")
    db = tmp_path / "m.sqlite"
    ws_root = tmp_path / "ws"

    rc = main([
        "spawn",
        "--db", str(db), "--workspace-root", str(ws_root),
        "--target-repo", str(target),
        "--branch", "agent/x",
        "--owns", "src/a/**",
        "--agent-id", "a1",
    ])
    captured = capsys.readouterr()
    assert rc == 0, captured.err

    rc = main([
        "spawn",
        "--db", str(db), "--workspace-root", str(ws_root),
        "--target-repo", str(target),
        "--branch", "agent/x",  # same branch — should be refused
        "--owns", "src/b/**",
        "--agent-id", "a2",
    ])
    captured = capsys.readouterr()
    assert rc == 2
    assert "refused" in captured.err
    assert "branch" in captured.err


@git_required
def test_spawn_releases_claim_on_workspace_failure(tmp_path: Path, capsys) -> None:
    db = tmp_path / "m.sqlite"
    ws_root = tmp_path / "ws"

    rc = main([
        "spawn",
        "--db", str(db), "--workspace-root", str(ws_root),
        "--target-repo", str(tmp_path / "does-not-exist"),
        "--branch", "agent/x",
        "--owns", "src/a/**",
        "--agent-id", "a1",
    ])
    captured = capsys.readouterr()
    assert rc == 3
    assert "workspace setup failed" in captured.err

    # Claim must have been rolled back so a retry can take the same branch.
    rc = main([
        "list",
        "--db", str(db), "--workspace-root", str(ws_root),
    ])
    captured = capsys.readouterr()
    assert json.loads(captured.out) == []


@git_required
def test_heartbeat_active_then_released(tmp_path: Path, capsys) -> None:
    target = _make_seed_repo(tmp_path / "target")
    db = tmp_path / "m.sqlite"
    ws_root = tmp_path / "ws"

    main([
        "spawn",
        "--db", str(db), "--workspace-root", str(ws_root),
        "--target-repo", str(target),
        "--branch", "agent/x",
        "--owns", "src/a/**",
        "--agent-id", "a1",
    ])
    capsys.readouterr()

    rc = main([
        "heartbeat", "a1",
        "--db", str(db), "--workspace-root", str(ws_root),
    ])
    captured = capsys.readouterr()
    assert rc == 0
    assert "heartbeat" in captured.out

    main([
        "finish", "a1",
        "--db", str(db), "--workspace-root", str(ws_root),
        "--no-push",
    ])
    capsys.readouterr()

    # Heartbeat after finish must fail loudly (claim no longer active).
    rc = main([
        "heartbeat", "a1",
        "--db", str(db), "--workspace-root", str(ws_root),
    ])
    captured = capsys.readouterr()
    assert rc == 6
    assert "no active claim" in captured.err


def test_finish_unknown_agent_id(tmp_path: Path, capsys) -> None:
    rc = main([
        "finish", "ghost",
        "--db", str(tmp_path / "m.sqlite"),
        "--workspace-root", str(tmp_path / "ws"),
    ])
    captured = capsys.readouterr()
    assert rc == 4
    assert "unknown agent" in captured.err
