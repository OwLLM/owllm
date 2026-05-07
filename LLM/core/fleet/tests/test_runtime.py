"""Tests for the :class:`Runtime` seam introduced in slice 3a.

The git-side behaviour of :class:`WorktreeRuntime` is already covered
by ``test_workspace.py`` (the existing tests now run *through* the
runtime — they call the ``setup_workspace`` / ``teardown_workspace``
shims, which delegate to ``default_runtime()``). These tests focus on
the seam itself: the ABC contract, the registry, and that a stub
:class:`Runtime` plugged in via :func:`set_default_runtime` actually
takes over the call sites.
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional

import pytest

from core.fleet.manifest import Claim
from core.fleet.runtime import (
    Runtime,
    WorktreeRuntime,
    default_runtime,
    set_default_runtime,
)
from core.fleet.workspace import (
    WorkspaceLayout,
    setup_workspace,
    teardown_workspace,
)


# ---------------------------------------------------------------------------
# Registry hygiene — every test that mutates the default must reset
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_default_runtime():
    yield
    set_default_runtime(None)


# ---------------------------------------------------------------------------
# ABC contract
# ---------------------------------------------------------------------------


def test_runtime_abc_cannot_be_instantiated() -> None:
    with pytest.raises(TypeError):
        Runtime()  # type: ignore[abstract]


def test_worktree_runtime_satisfies_runtime() -> None:
    rt = WorktreeRuntime()
    assert isinstance(rt, Runtime)


# ---------------------------------------------------------------------------
# default_runtime registry
# ---------------------------------------------------------------------------


def test_default_runtime_is_worktree_by_default() -> None:
    assert isinstance(default_runtime(), WorktreeRuntime)


def test_default_runtime_returns_same_instance_each_call() -> None:
    a = default_runtime()
    b = default_runtime()
    assert a is b


def test_set_default_runtime_overrides() -> None:
    custom = WorktreeRuntime()
    set_default_runtime(custom)
    assert default_runtime() is custom


def test_set_default_runtime_none_resets_to_lazy_worktree() -> None:
    set_default_runtime(WorktreeRuntime())
    set_default_runtime(None)
    rt = default_runtime()
    assert isinstance(rt, WorktreeRuntime)


# ---------------------------------------------------------------------------
# Pluggability — shims must route through whichever runtime is current
# ---------------------------------------------------------------------------


class _RecordingRuntime(Runtime):
    """Stub that records calls and returns a synthetic layout."""

    def __init__(self):
        self.setup_calls: List[tuple[Claim, str]] = []
        self.teardown_calls: List[tuple[Claim, bool, bool]] = []
        self.next_pr_url: Optional[str] = None

    def setup(self, claim: Claim, *, base_branch: str = "main") -> WorkspaceLayout:
        self.setup_calls.append((claim, base_branch))
        return WorkspaceLayout.for_claim(claim)

    def teardown(
        self,
        claim: Claim,
        *,
        push: bool = True,
        open_pr: bool = False,
        pr_title: str = "",
        pr_body: str = "",
    ) -> Optional[str]:
        self.teardown_calls.append((claim, push, open_pr))
        return self.next_pr_url


def _make_claim(workspace_path: Path) -> Claim:
    return Claim(
        agent_id="a1",
        target_repo="alpha",
        branch="agent/x",
        workspace_path=str(workspace_path),
        owns_modules=["src/billing/**"],
    )


def test_setup_workspace_shim_routes_through_default(tmp_path: Path) -> None:
    stub = _RecordingRuntime()
    set_default_runtime(stub)

    claim = _make_claim(tmp_path / "ws-a1")
    layout = setup_workspace(claim, base_branch="trunk")

    assert layout == WorkspaceLayout.for_claim(claim)
    assert stub.setup_calls == [(claim, "trunk")]


def test_teardown_workspace_shim_routes_through_default(tmp_path: Path) -> None:
    stub = _RecordingRuntime()
    stub.next_pr_url = "https://example.com/pr/1"
    set_default_runtime(stub)

    claim = _make_claim(tmp_path / "ws-a1")
    pr_url = teardown_workspace(claim, push=False, open_pr=True, pr_title="t")

    assert pr_url == "https://example.com/pr/1"
    assert stub.teardown_calls == [(claim, False, True)]


def test_shim_uses_new_runtime_after_reset(tmp_path: Path) -> None:
    """Two consecutive setups with different runtimes hit the right one."""
    stub_a = _RecordingRuntime()
    stub_b = _RecordingRuntime()

    claim = _make_claim(tmp_path / "ws-a1")

    set_default_runtime(stub_a)
    setup_workspace(claim)
    assert stub_a.setup_calls and not stub_b.setup_calls

    set_default_runtime(stub_b)
    setup_workspace(claim)
    assert len(stub_a.setup_calls) == 1
    assert len(stub_b.setup_calls) == 1
