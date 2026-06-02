"""Tests for the Qt-friendly fleet service wrapper.

Slice 2a coverage: synchronous broker interactions and same-thread
signal emission. The async ``spawn_async``/``finish_async`` paths
involve :class:`QThread` and a real Qt event loop; they're tested by
the underlying broker + workspace tests already, and can get a
proper end-to-end test via ``pytest-qt`` later.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from core.fleet.broker import Broker, PoolConfig
from core.fleet.manifest import Manifest

from desktop_app.fleet_service import FleetService


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_claim(
    db: Path,
    ws: Path,
    *,
    agent_id: str = "a1",
    branch: str = "agent/x",
    owns: tuple[str, ...] = ("src/billing/**",),
    ttl_seconds: int = 3600,
) -> None:
    m = Manifest(db)
    m.open()
    try:
        Broker(
            m,
            PoolConfig(workspace_root=ws, port_range=range(8081, 8085)),
        ).spawn_claim(
            agent_id=agent_id,
            target_repo="alpha",
            branch=branch,
            owns_modules=list(owns),
            ttl_seconds=ttl_seconds,
        )
    finally:
        m.close()


@pytest.fixture
def service(tmp_path: Path) -> FleetService:
    svc = FleetService(
        db_path=str(tmp_path / "manifest.sqlite"),
        workspace_root=str(tmp_path / "workspaces"),
        port_low=8081,
        port_high=8085,
    )
    yield svc
    svc.shutdown()


# ---------------------------------------------------------------------------
# Construction + read paths
# ---------------------------------------------------------------------------


def test_list_active_empty(service: FleetService) -> None:
    assert service.list_active() == []


def test_list_active_returns_seeded_claim(tmp_path: Path) -> None:
    _seed_claim(tmp_path / "manifest.sqlite", tmp_path / "workspaces")
    svc = FleetService(
        db_path=str(tmp_path / "manifest.sqlite"),
        workspace_root=str(tmp_path / "workspaces"),
    )
    try:
        actives = svc.list_active()
        assert len(actives) == 1
        assert actives[0]["agent_id"] == "a1"
        # The dict view comes from dataclasses.asdict — sanity-check
        # the keys most likely to be consumed by the UI.
        for key in ("target_repo", "branch", "owns_modules",
                    "port", "status", "ttl_seconds"):
            assert key in actives[0]
    finally:
        svc.shutdown()


def test_list_all_includes_released(tmp_path: Path) -> None:
    _seed_claim(tmp_path / "manifest.sqlite", tmp_path / "workspaces")
    svc = FleetService(
        db_path=str(tmp_path / "manifest.sqlite"),
        workspace_root=str(tmp_path / "workspaces"),
    )
    try:
        # release the seeded claim via the underlying broker
        svc._broker.release("a1")
        assert svc.list_active() == []
        all_claims = svc.list_all()
        assert len(all_claims) == 1
        assert all_claims[0]["status"] == "released"
    finally:
        svc.shutdown()


# ---------------------------------------------------------------------------
# Heartbeat / reap
# ---------------------------------------------------------------------------


def test_heartbeat_returns_true_for_active(tmp_path: Path) -> None:
    _seed_claim(tmp_path / "manifest.sqlite", tmp_path / "workspaces")
    svc = FleetService(
        db_path=str(tmp_path / "manifest.sqlite"),
        workspace_root=str(tmp_path / "workspaces"),
    )
    try:
        assert svc.heartbeat("a1") is True
        assert svc.heartbeat("ghost") is False
    finally:
        svc.shutdown()


def test_reap_returns_empty_when_nothing_stale(service: FleetService) -> None:
    assert service.reap_stale() == []


# ---------------------------------------------------------------------------
# Signals — same-thread direct connections fire synchronously
# ---------------------------------------------------------------------------


def test_claims_changed_emitted_on_heartbeat(tmp_path: Path) -> None:
    _seed_claim(tmp_path / "manifest.sqlite", tmp_path / "workspaces")
    svc = FleetService(
        db_path=str(tmp_path / "manifest.sqlite"),
        workspace_root=str(tmp_path / "workspaces"),
    )
    try:
        received = []
        svc.claims_changed.connect(received.append)
        svc.heartbeat("a1")
        assert len(received) == 1
        # Payload is the active claim list
        assert received[0][0]["agent_id"] == "a1"
    finally:
        svc.shutdown()


def test_claims_changed_emitted_on_refresh(service: FleetService) -> None:
    received = []
    service.claims_changed.connect(received.append)
    service.refresh()
    assert received == [[]]


def test_claims_changed_not_emitted_on_failed_heartbeat(
    service: FleetService,
) -> None:
    received = []
    service.claims_changed.connect(received.append)
    service.heartbeat("ghost")  # no-op, no state change
    assert received == []
