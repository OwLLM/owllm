"""Tests for manifest claim / overlap / TTL semantics."""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from core.fleet.manifest import (
    GPU_MODE_RO,
    GPU_MODE_RW,
    STATUS_RELEASED,
    Claim,
    ClaimConflict,
    Manifest,
    _modules_overlap,
)


@pytest.fixture
def manifest(tmp_path: Path):
    m = Manifest(tmp_path / "manifest.sqlite")
    m.open()
    try:
        yield m
    finally:
        m.close()


def _make_claim(agent_id: str = "a1", **kw) -> Claim:
    defaults = dict(
        target_repo="alpha",
        branch="feature/x",
        workspace_path=f"/ws/{agent_id}",
        owns_modules=["src/billing/**"],
    )
    defaults.update(kw)
    return Claim(agent_id=agent_id, **defaults)


# -- basic --------------------------------------------------------------------


def test_claim_inserts_and_lists(manifest: Manifest) -> None:
    manifest.claim(_make_claim())
    actives = manifest.list_active()
    assert len(actives) == 1
    assert actives[0].agent_id == "a1"
    assert actives[0].owns_modules == ["src/billing/**"]


def test_release_marks_inactive(manifest: Manifest) -> None:
    manifest.claim(_make_claim())
    assert manifest.release("a1") is True
    assert manifest.list_active() == []
    got = manifest.get("a1")
    assert got is not None
    assert got.status == STATUS_RELEASED


def test_release_unknown_returns_false(manifest: Manifest) -> None:
    assert manifest.release("ghost") is False


# -- overlap on simple dimensions --------------------------------------------


def test_same_branch_conflict(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1"))
    with pytest.raises(ClaimConflict) as exc:
        manifest.claim(_make_claim(
            "a2", workspace_path="/ws/a2", owns_modules=["src/auth/**"],
        ))
    assert exc.value.dimension == "branch"
    assert exc.value.existing_agent_id == "a1"


def test_different_branches_same_repo_ok(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1", branch="feature/x"))
    manifest.claim(_make_claim(
        "a2", branch="feature/y",
        workspace_path="/ws/a2", owns_modules=["src/auth/**"],
    ))
    assert len(manifest.list_active()) == 2


def test_same_workspace_conflict(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1", workspace_path="/ws/shared"))
    with pytest.raises(ClaimConflict) as exc:
        manifest.claim(_make_claim(
            "a2", branch="feature/y",
            workspace_path="/ws/shared", owns_modules=["src/auth/**"],
        ))
    assert exc.value.dimension == "workspace_path"


def test_same_port_conflict(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1", port=8081))
    with pytest.raises(ClaimConflict) as exc:
        manifest.claim(_make_claim(
            "a2", branch="feature/y", workspace_path="/ws/a2",
            owns_modules=["src/auth/**"], port=8081,
        ))
    assert exc.value.dimension == "port"


# -- gpu mode interaction -----------------------------------------------------


def test_gpu_rw_rw_conflict(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1", gpu_slot=0, gpu_mode=GPU_MODE_RW))
    with pytest.raises(ClaimConflict) as exc:
        manifest.claim(_make_claim(
            "a2", branch="feature/y", workspace_path="/ws/a2",
            owns_modules=["src/auth/**"],
            gpu_slot=0, gpu_mode=GPU_MODE_RW,
        ))
    assert exc.value.dimension == "gpu_slot"


def test_gpu_ro_ro_ok(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1", gpu_slot=0, gpu_mode=GPU_MODE_RO))
    manifest.claim(_make_claim(
        "a2", branch="feature/y", workspace_path="/ws/a2",
        owns_modules=["src/auth/**"],
        gpu_slot=0, gpu_mode=GPU_MODE_RO,
    ))
    assert len(manifest.list_active()) == 2


def test_gpu_ro_blocked_by_rw(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1", gpu_slot=0, gpu_mode=GPU_MODE_RW))
    with pytest.raises(ClaimConflict) as exc:
        manifest.claim(_make_claim(
            "a2", branch="feature/y", workspace_path="/ws/a2",
            owns_modules=["src/auth/**"],
            gpu_slot=0, gpu_mode=GPU_MODE_RO,
        ))
    assert exc.value.dimension == "gpu_slot"


# -- module-prefix overlap ----------------------------------------------------


def test_module_prefix_overlap_conflict(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1", owns_modules=["src/billing/**"]))
    with pytest.raises(ClaimConflict) as exc:
        manifest.claim(_make_claim(
            "a2", branch="feature/y", workspace_path="/ws/a2",
            owns_modules=["src/billing/api.py"],
        ))
    assert exc.value.dimension == "owns_modules"


def test_module_disjoint_ok(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1", owns_modules=["src/billing/**"]))
    manifest.claim(_make_claim(
        "a2", branch="feature/y", workspace_path="/ws/a2",
        owns_modules=["src/auth/**"],
    ))
    assert len(manifest.list_active()) == 2


def test_modules_overlap_helper() -> None:
    # Prefix overlap in either direction.
    assert _modules_overlap(["src/a/**"], ["src/a/b.py"]) is not None
    assert _modules_overlap(["src/a/b/**"], ["src/a/**"]) is not None
    # Identical patterns overlap.
    assert _modules_overlap(["src/a/**"], ["src/a/**"]) is not None
    # Adjacent siblings are NOT overlap (the trailing slash protects against
    # 'src/a/' falsely prefixing 'src/ab/').
    assert _modules_overlap(["src/a/**"], ["src/ab/**"]) is None
    # Disjoint top-levels.
    assert _modules_overlap(["src/a/**"], ["src/b/**"]) is None
    # Empty list never conflicts.
    assert _modules_overlap([], ["src/a/**"]) is None


# -- released claims free up dimensions --------------------------------------


def test_released_branch_can_be_reclaimed(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1"))
    manifest.release("a1")
    manifest.claim(_make_claim("a2"))  # same branch, should be allowed now
    assert len(manifest.list_active()) == 1


def test_agent_id_reuse_rejected(manifest: Manifest) -> None:
    """Slice 1a constraint: agent_id is unique across the whole table.

    Re-spawning a finished agent requires a fresh id. Documented in the
    manifest module docstring; if this becomes painful we'll migrate to
    a composite (agent_id, started_at) PK.
    """
    manifest.claim(_make_claim("a1"))
    manifest.release("a1")
    with pytest.raises(ClaimConflict) as exc:
        manifest.claim(_make_claim(
            "a1", branch="feature/y",
            workspace_path="/ws/a1-2", owns_modules=["src/auth/**"],
        ))
    assert exc.value.dimension == "agent_id"


# -- heartbeat / reap ---------------------------------------------------------


def test_heartbeat_updates_timestamp(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1"))
    before = manifest.get("a1").last_heartbeat
    time.sleep(1.1)  # ISO timestamp resolution is 1 second
    assert manifest.heartbeat("a1") is True
    after = manifest.get("a1").last_heartbeat
    assert after > before


def test_heartbeat_unknown_returns_false(manifest: Manifest) -> None:
    assert manifest.heartbeat("ghost") is False


def test_reap_stale_releases_only_expired(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1", ttl_seconds=1))
    manifest.claim(_make_claim(
        "a2", branch="feature/y", workspace_path="/ws/a2",
        owns_modules=["src/auth/**"], ttl_seconds=10_000,
    ))
    far_future = datetime.now(timezone.utc) + timedelta(seconds=60)
    reaped = manifest.reap_stale(now=far_future)
    assert [c.agent_id for c in reaped] == ["a1"]
    assert [c.agent_id for c in manifest.list_active()] == ["a2"]


def test_reap_noop_when_nothing_stale(manifest: Manifest) -> None:
    manifest.claim(_make_claim("a1", ttl_seconds=10_000))
    assert manifest.reap_stale() == []


# -- persistence --------------------------------------------------------------


def test_close_and_reopen_preserves_state(tmp_path: Path) -> None:
    db = tmp_path / "manifest.sqlite"
    m1 = Manifest(db)
    m1.open()
    m1.claim(_make_claim("a1"))
    m1.close()

    m2 = Manifest(db)
    m2.open()
    try:
        actives = m2.list_active()
        assert len(actives) == 1
        assert actives[0].agent_id == "a1"
    finally:
        m2.close()
