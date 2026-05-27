"""Tests for RuntimeConfig serialisation + runtime selection."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.fleet.container_runtime import (
    ContainerRuntime,
    Mount,
    NETWORK_NONE,
)
from core.fleet.runtime import WorktreeRuntime
from core.fleet.runtime_config import (
    KIND_CONTAINER,
    KIND_WORKTREE,
    RuntimeConfig,
)


# ---------------------------------------------------------------------------
# Defaults + serialisation
# ---------------------------------------------------------------------------


def test_default_is_container() -> None:
    # Sandboxing is the safer default. Falls back to worktree at
    # to_runtime() when Docker isn't actually available.
    cfg = RuntimeConfig()
    assert cfg.kind == KIND_CONTAINER
    assert cfg.use_default_auth_mounts is True
    assert cfg.enforce_module_mounts is False


def test_to_dict_from_dict_roundtrip() -> None:
    cfg = RuntimeConfig(
        kind=KIND_CONTAINER,
        image="my:img",
        network=NETWORK_NONE,
        use_default_auth_mounts=False,
        extra_auth_mounts=[
            Mount("/host/x", "/c/x", "ro"),
        ],
        enforce_module_mounts=True,
    )
    out = RuntimeConfig.from_dict(cfg.to_dict())
    assert out == cfg


def test_save_and_load(tmp_path: Path) -> None:
    path = tmp_path / "runtime.json"
    cfg = RuntimeConfig(kind=KIND_CONTAINER, image="x:1")
    cfg.save(path)
    loaded = RuntimeConfig.load(path)
    assert loaded.kind == KIND_CONTAINER
    assert loaded.image == "x:1"


def test_load_missing_file_returns_defaults(tmp_path: Path) -> None:
    cfg = RuntimeConfig.load(tmp_path / "absent.json")
    assert cfg == RuntimeConfig()


def test_load_malformed_returns_defaults(tmp_path: Path) -> None:
    path = tmp_path / "bad.json"
    path.write_text("{ not json", encoding="utf-8")
    cfg = RuntimeConfig.load(path)
    assert cfg == RuntimeConfig()


def test_unknown_kind_falls_back_to_worktree(tmp_path: Path, caplog) -> None:
    import logging
    caplog.set_level(logging.WARNING)
    path = tmp_path / "x.json"
    path.write_text(json.dumps({"kind": "borg-collective"}), encoding="utf-8")
    cfg = RuntimeConfig.load(path)
    assert cfg.kind == KIND_WORKTREE
    assert any("borg-collective" in r.message for r in caplog.records)


def test_bad_mount_entries_are_skipped_with_warning(tmp_path: Path, caplog) -> None:
    import logging
    caplog.set_level(logging.WARNING)
    path = tmp_path / "x.json"
    path.write_text(json.dumps({
        "kind": KIND_CONTAINER,
        "extra_auth_mounts": [
            {"host_path": "/h/a", "container_path": "/c/a", "mode": "ro"},
            {"missing-required-keys": True},
        ],
    }), encoding="utf-8")
    cfg = RuntimeConfig.load(path)
    assert len(cfg.extra_auth_mounts) == 1
    assert cfg.extra_auth_mounts[0].host_path == "/h/a"


def test_save_creates_parent_dir(tmp_path: Path) -> None:
    deep = tmp_path / "nested" / "deeper" / "runtime.json"
    RuntimeConfig().save(deep)
    assert deep.exists()


# ---------------------------------------------------------------------------
# to_runtime() — type selection
# ---------------------------------------------------------------------------


def test_worktree_kind_returns_worktree_runtime() -> None:
    rt = RuntimeConfig(kind=KIND_WORKTREE).to_runtime()
    assert isinstance(rt, WorktreeRuntime)


def test_container_kind_returns_container_when_docker_available(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        ContainerRuntime, "is_available",
        classmethod(lambda cls, **_: True),
    )
    rt = RuntimeConfig(
        kind=KIND_CONTAINER, image="x:1",
        use_default_auth_mounts=False,
    ).to_runtime()
    assert isinstance(rt, ContainerRuntime)


def test_container_kind_falls_back_to_worktree_when_no_docker(
    monkeypatch, caplog,
) -> None:
    import logging
    caplog.set_level(logging.WARNING)
    monkeypatch.setattr(
        ContainerRuntime, "is_available",
        classmethod(lambda cls, **_: False),
    )
    rt = RuntimeConfig(kind=KIND_CONTAINER).to_runtime()
    assert isinstance(rt, WorktreeRuntime)
    assert any("docker" in r.message.lower() for r in caplog.records)
