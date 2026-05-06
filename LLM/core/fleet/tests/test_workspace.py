"""Tests for workspace setup / teardown.

These exercise real ``git`` and ``shutil`` operations against tiny
on-disk repos under ``tmp_path``. ``git`` must be on PATH; if it
isn't, every test in this module skips with a clear reason.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from core.fleet.manifest import Claim
from core.fleet.workspace import (
    CLONE_SUBDIR,
    CONTEXT_FILE,
    WorkspaceError,
    WorkspaceLayout,
    setup_workspace,
    teardown_workspace,
)


pytestmark = pytest.mark.skipif(
    shutil.which("git") is None,
    reason="git not on PATH",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _git(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        check=True,
        capture_output=True,
    )


def _make_seed_repo(path: Path, default_branch: str = "main") -> Path:
    """Create a minimal non-bare git repo with one commit on ``default_branch``."""
    path.mkdir(parents=True, exist_ok=True)
    _git("init", "-b", default_branch, str(path))
    _git("-C", str(path), "config", "user.email", "test@example.com")
    _git("-C", str(path), "config", "user.name", "test")
    (path / "README.md").write_text("hello\n", encoding="utf-8")
    _git("-C", str(path), "add", ".")
    _git("-C", str(path), "commit", "-m", "init")
    return path


def _make_bare_repo_with_main(tmp_path: Path) -> Path:
    """Bare repo seeded with one commit on ``main`` so clones/pushes work."""
    bare = tmp_path / "target.git"
    _git("init", "--bare", "-b", "main", str(bare))
    seed = tmp_path / "seed"
    _git("clone", str(bare), str(seed))
    _git("-C", str(seed), "config", "user.email", "test@example.com")
    _git("-C", str(seed), "config", "user.name", "test")
    (seed / "README.md").write_text("hello\n", encoding="utf-8")
    _git("-C", str(seed), "add", ".")
    _git("-C", str(seed), "commit", "-m", "init")
    _git("-C", str(seed), "push", "origin", "main")
    return bare


def _make_claim(workspace_path: Path, target_repo: Path | str, **kw) -> Claim:
    defaults = dict(
        agent_id="a1",
        target_repo=str(target_repo),
        branch="agent/test",
        workspace_path=str(workspace_path),
        owns_modules=["src/billing/**"],
        reads_modules=["src/platform/**"],
        port=8081,
        gpu_slot=0,
        reason="implement test feature",
    )
    defaults.update(kw)
    return Claim(**defaults)


# ---------------------------------------------------------------------------
# setup_workspace
# ---------------------------------------------------------------------------


def test_setup_creates_layout(tmp_path: Path) -> None:
    target = _make_seed_repo(tmp_path / "target")
    workspace = tmp_path / "ws-a1"

    layout = setup_workspace(_make_claim(workspace, target))

    assert layout.root.is_dir()
    assert layout.clone.is_dir()
    assert (layout.clone / ".git").is_dir()
    assert layout.context_file.is_file()
    assert layout.context_file.parent == layout.root
    # AGENT_CONTEXT.md must NOT live inside the clone — that would
    # leak it into the target repo's working tree.
    assert not (layout.clone / CONTEXT_FILE).exists()


def test_setup_checks_out_agent_branch(tmp_path: Path) -> None:
    target = _make_seed_repo(tmp_path / "target")
    workspace = tmp_path / "ws-a1"
    layout = setup_workspace(_make_claim(workspace, target))

    branch = subprocess.run(
        ["git", "-C", str(layout.clone), "rev-parse", "--abbrev-ref", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    assert branch == "agent/test"


def test_setup_writes_context_with_claim_fields(tmp_path: Path) -> None:
    target = _make_seed_repo(tmp_path / "target")
    workspace = tmp_path / "ws-a1"
    claim = _make_claim(
        workspace, target,
        owns_modules=["src/billing/**", "tests/billing/**"],
        reads_modules=["src/platform/**"],
        reason="implement refund flow",
    )
    layout = setup_workspace(claim)

    ctx = layout.context_file.read_text(encoding="utf-8")
    assert "implement refund flow" in ctx
    assert "src/billing/**" in ctx
    assert "tests/billing/**" in ctx
    assert "src/platform/**" in ctx
    assert claim.agent_id in ctx
    assert claim.branch in ctx


def test_setup_refuses_existing_workspace(tmp_path: Path) -> None:
    target = _make_seed_repo(tmp_path / "target")
    workspace = tmp_path / "ws-a1"
    workspace.mkdir()
    with pytest.raises(WorkspaceError):
        setup_workspace(_make_claim(workspace, target))


def test_setup_cleans_up_on_clone_failure(tmp_path: Path) -> None:
    workspace = tmp_path / "ws-a1"
    bad = tmp_path / "does-not-exist"
    with pytest.raises(WorkspaceError):
        setup_workspace(_make_claim(workspace, bad))
    # No partial workspace left behind — broker state stays clean.
    assert not workspace.exists()


def test_setup_with_custom_base_branch(tmp_path: Path) -> None:
    target = _make_seed_repo(tmp_path / "target", default_branch="trunk")
    workspace = tmp_path / "ws-a1"
    layout = setup_workspace(
        _make_claim(workspace, target),
        base_branch="trunk",
    )
    branch = subprocess.run(
        ["git", "-C", str(layout.clone), "rev-parse", "--abbrev-ref", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    assert branch == "agent/test"


# ---------------------------------------------------------------------------
# teardown_workspace
# ---------------------------------------------------------------------------


def test_teardown_removes_workspace(tmp_path: Path) -> None:
    target = _make_seed_repo(tmp_path / "target")
    workspace = tmp_path / "ws-a1"
    claim = _make_claim(workspace, target)
    setup_workspace(claim)
    assert workspace.exists()

    pr_url = teardown_workspace(claim, push=False, open_pr=False)

    assert pr_url is None
    assert not workspace.exists()


def test_teardown_pushes_branch_to_bare_remote(tmp_path: Path) -> None:
    bare = _make_bare_repo_with_main(tmp_path)
    workspace = tmp_path / "ws-a1"
    claim = _make_claim(workspace, bare)
    layout = setup_workspace(claim)

    # Identity for the clone so the agent commit is valid.
    _git("-C", str(layout.clone), "config", "user.email", "test@example.com")
    _git("-C", str(layout.clone), "config", "user.name", "test")
    (layout.clone / "agent_change.txt").write_text("hello\n", encoding="utf-8")
    _git("-C", str(layout.clone), "add", ".")
    _git("-C", str(layout.clone), "commit", "-m", "agent commit")

    teardown_workspace(claim, push=True, open_pr=False)

    branches = subprocess.run(
        ["git", "-C", str(bare), "branch"],
        check=True, capture_output=True, text=True,
    ).stdout
    assert "agent/test" in branches
    assert not workspace.exists()


def test_teardown_when_workspace_missing_is_noop(tmp_path: Path) -> None:
    target = _make_seed_repo(tmp_path / "target")
    workspace = tmp_path / "ws-a1"
    claim = _make_claim(workspace, target)
    # No setup — workspace doesn't exist.
    assert teardown_workspace(claim, push=False, open_pr=False) is None


def test_teardown_removes_workspace_even_on_push_failure(tmp_path: Path) -> None:
    """Bug-protection: a failed push must not leak the workspace dir.

    Pushing to a non-bare remote without ``receive.denyCurrentBranch``
    set fails by default. We use that to simulate a push failure and
    confirm teardown still cleans up.
    """
    target = _make_seed_repo(tmp_path / "target")
    workspace = tmp_path / "ws-a1"
    claim = _make_claim(workspace, target)
    layout = setup_workspace(claim)

    _git("-C", str(layout.clone), "config", "user.email", "test@example.com")
    _git("-C", str(layout.clone), "config", "user.name", "test")
    (layout.clone / "x.txt").write_text("x\n", encoding="utf-8")
    _git("-C", str(layout.clone), "add", ".")
    _git("-C", str(layout.clone), "commit", "-m", "x")

    # The agent's branch != target's checked-out branch (target is on main),
    # so this push variant SHOULD succeed. Force a failure by pushing to a
    # bogus remote ref.
    _git("-C", str(layout.clone), "remote", "set-url", "origin",
         str(tmp_path / "bogus-no-repo"))

    with pytest.raises(WorkspaceError):
        teardown_workspace(claim, push=True, open_pr=False)

    # Even though push failed, teardown's finally clause removed the dir.
    assert not workspace.exists()


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------


def test_layout_for_claim_paths(tmp_path: Path) -> None:
    claim = _make_claim(tmp_path / "ws-a1", tmp_path / "target")
    layout = WorkspaceLayout.for_claim(claim)
    assert layout.root == tmp_path / "ws-a1"
    assert layout.clone == tmp_path / "ws-a1" / CLONE_SUBDIR
    assert layout.context_file == tmp_path / "ws-a1" / CONTEXT_FILE
