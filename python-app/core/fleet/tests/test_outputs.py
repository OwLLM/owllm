"""Tests for the output registry."""
from __future__ import annotations

from pathlib import Path

import pytest

from core.fleet.outputs import (
    KIND_LIBRARY,
    Artifact,
    ArtifactConflict,
    OutputRegistry,
)


@pytest.fixture
def registry(tmp_path: Path):
    r = OutputRegistry(tmp_path / "outputs" / "registry.sqlite")
    r.open()
    try:
        yield r
    finally:
        r.close()


def _art(name="alpha-lib", version="1.0.0", **kw) -> Artifact:
    defaults = dict(
        publisher_agent_id="a1",
        path="/tmp/alpha-lib-1.0.0.whl",
        kind=KIND_LIBRARY,
        metadata={"size_bytes": 1024},
    )
    defaults.update(kw)
    return Artifact(name=name, version=version, **defaults)


# ---------------------------------------------------------------------------
# Publish + conflict
# ---------------------------------------------------------------------------


def test_publish_inserts_and_lists(registry: OutputRegistry) -> None:
    registry.publish(_art())
    items = registry.list_all()
    assert len(items) == 1
    assert items[0].name == "alpha-lib"
    assert items[0].version == "1.0.0"
    assert items[0].metadata == {"size_bytes": 1024}


def test_publish_collision_raises(registry: OutputRegistry) -> None:
    registry.publish(_art())
    with pytest.raises(ArtifactConflict):
        registry.publish(_art(publisher_agent_id="a2"))


def test_publish_different_versions_ok(registry: OutputRegistry) -> None:
    registry.publish(_art(version="1.0.0"))
    registry.publish(_art(version="1.1.0"))
    assert len(registry.list_versions("alpha-lib")) == 2


def test_publish_different_names_ok(registry: OutputRegistry) -> None:
    registry.publish(_art(name="alpha-lib"))
    registry.publish(_art(name="beta-lib"))
    assert len(registry.list_all()) == 2


def test_publish_refuses_empty_name(registry: OutputRegistry) -> None:
    with pytest.raises(ValueError, match="name"):
        registry.publish(_art(name="  "))


def test_publish_refuses_empty_version(registry: OutputRegistry) -> None:
    with pytest.raises(ValueError, match="version"):
        registry.publish(_art(version=""))


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------


def test_get_specific_version(registry: OutputRegistry) -> None:
    registry.publish(_art(version="1.0.0"))
    registry.publish(_art(version="2.0.0"))
    a = registry.get("alpha-lib", "1.0.0")
    assert a is not None
    assert a.version == "1.0.0"


def test_get_latest_when_no_version(registry: OutputRegistry) -> None:
    """No version arg → newest by published_at."""
    import time
    registry.publish(_art(version="1.0.0"))
    time.sleep(1.1)  # ISO timestamp resolution
    registry.publish(_art(version="2.0.0"))
    latest = registry.get("alpha-lib")
    assert latest is not None
    assert latest.version == "2.0.0"


def test_get_unknown_returns_none(registry: OutputRegistry) -> None:
    assert registry.get("ghost") is None
    registry.publish(_art())
    assert registry.get("alpha-lib", "999.0.0") is None


def test_list_by_publisher(registry: OutputRegistry) -> None:
    registry.publish(_art(name="x", version="1", publisher_agent_id="a1"))
    registry.publish(_art(name="y", version="1", publisher_agent_id="a1"))
    registry.publish(_art(name="z", version="1", publisher_agent_id="a2"))
    by_a1 = registry.list_by_publisher("a1")
    assert {a.name for a in by_a1} == {"x", "y"}


# ---------------------------------------------------------------------------
# Delete + persistence
# ---------------------------------------------------------------------------


def test_delete_removes_record(registry: OutputRegistry) -> None:
    registry.publish(_art())
    assert registry.delete("alpha-lib", "1.0.0") is True
    assert registry.list_all() == []


def test_delete_unknown_returns_false(registry: OutputRegistry) -> None:
    assert registry.delete("alpha-lib", "1.0.0") is False


def test_persistence_across_open(tmp_path: Path) -> None:
    db = tmp_path / "outputs" / "registry.sqlite"
    r1 = OutputRegistry(db)
    r1.open()
    r1.publish(_art())
    r1.close()

    r2 = OutputRegistry(db)
    r2.open()
    try:
        items = r2.list_all()
        assert len(items) == 1
        assert items[0].name == "alpha-lib"
    finally:
        r2.close()
