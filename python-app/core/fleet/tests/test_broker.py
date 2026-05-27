"""Tests for broker pool allocation + lifecycle."""
from __future__ import annotations

from pathlib import Path

import pytest

from core.fleet.broker import Broker, PoolConfig, PoolExhausted
from core.fleet.manifest import GPU_MODE_RO, GPU_MODE_RW, ClaimConflict, Manifest


@pytest.fixture
def broker(tmp_path: Path):
    m = Manifest(tmp_path / "manifest.sqlite")
    m.open()
    pool = PoolConfig(
        workspace_root=tmp_path / "workspaces",
        port_range=range(8081, 8085),  # 4 ports: 8081..8084
        gpu_slots=(0, 1),
    )
    try:
        yield Broker(m, pool)
    finally:
        m.close()


# -- pool allocation ----------------------------------------------------------


def test_spawn_allocates_default_port_and_workspace(broker: Broker) -> None:
    claim = broker.spawn_claim("a1", "alpha", "feature/x", ["src/billing/**"])
    assert claim.port == 8081
    assert claim.workspace_path.endswith("a1")


def test_spawn_skips_used_port(broker: Broker) -> None:
    broker.spawn_claim("a1", "alpha", "feature/x", ["src/billing/**"])
    c2 = broker.spawn_claim("a2", "alpha", "feature/y", ["src/auth/**"])
    assert c2.port == 8082


def test_pool_exhausted_when_full(broker: Broker) -> None:
    for i, branch in enumerate(["bx", "by", "bz", "bw"]):
        broker.spawn_claim(f"a{i}", "alpha", branch, [f"src/m{i}/**"])
    with pytest.raises(PoolExhausted) as exc:
        broker.spawn_claim("a4", "alpha", "bv", ["src/m4/**"])
    assert exc.value.pool == "ports"


def test_explicit_port_collision(broker: Broker) -> None:
    broker.spawn_claim(
        "a1", "alpha", "feature/x", ["src/billing/**"], port=8081,
    )
    with pytest.raises(PoolExhausted) as exc:
        broker.spawn_claim(
            "a2", "alpha", "feature/y", ["src/auth/**"], port=8081,
        )
    assert exc.value.pool == "ports"


def test_release_frees_port_for_next_spawn(broker: Broker) -> None:
    broker.spawn_claim("a1", "alpha", "feature/x", ["src/billing/**"])
    broker.release("a1")
    c2 = broker.spawn_claim("a2", "alpha", "feature/y", ["src/auth/**"])
    assert c2.port == 8081


# -- gpu allocation -----------------------------------------------------------


def test_rw_allocates_distinct_slots(broker: Broker) -> None:
    c1 = broker.spawn_claim("a1", "alpha", "bx", ["src/m1/**"])
    c2 = broker.spawn_claim("a2", "alpha", "by", ["src/m2/**"])
    assert {c1.gpu_slot, c2.gpu_slot} == {0, 1}


def test_rw_falls_back_to_none_when_pool_empty(broker: Broker) -> None:
    broker.spawn_claim("a1", "alpha", "bx", ["src/m1/**"])
    broker.spawn_claim("a2", "alpha", "by", ["src/m2/**"])
    # Pool is now full of rw slots; third agent should get gpu_slot=None
    # (caller decided the broker should auto-pick; we degrade gracefully).
    c3 = broker.spawn_claim("a3", "alpha", "bz", ["src/m3/**"])
    assert c3.gpu_slot is None


def test_ro_does_not_consume_slot(broker: Broker) -> None:
    broker.spawn_claim(
        "a1", "alpha", "bx", ["src/m1/**"],
        gpu_slot=0, gpu_mode=GPU_MODE_RO,
    )
    broker.spawn_claim(
        "a2", "alpha", "by", ["src/m2/**"],
        gpu_slot=0, gpu_mode=GPU_MODE_RO,
    )
    assert len(broker.list_active()) == 2


# -- module overlap propagates from manifest ---------------------------------


def test_module_overlap_propagates(broker: Broker) -> None:
    broker.spawn_claim("a1", "alpha", "bx", ["src/billing/**"])
    with pytest.raises(ClaimConflict) as exc:
        broker.spawn_claim("a2", "alpha", "by", ["src/billing/api.py"])
    assert exc.value.dimension == "owns_modules"


# -- lifecycle observability --------------------------------------------------


def test_list_active_reflects_state(broker: Broker) -> None:
    broker.spawn_claim("a1", "alpha", "bx", ["src/billing/**"])
    broker.spawn_claim("a2", "alpha", "by", ["src/auth/**"])
    assert {c.agent_id for c in broker.list_active()} == {"a1", "a2"}
    broker.release("a1")
    assert {c.agent_id for c in broker.list_active()} == {"a2"}


def test_get_returns_claim_or_none(broker: Broker) -> None:
    broker.spawn_claim("a1", "alpha", "bx", ["src/billing/**"])
    assert broker.get("a1") is not None
    assert broker.get("ghost") is None


def test_heartbeat_only_for_active(broker: Broker) -> None:
    broker.spawn_claim("a1", "alpha", "bx", ["src/billing/**"])
    assert broker.heartbeat("a1") is True
    broker.release("a1")
    assert broker.heartbeat("a1") is False
