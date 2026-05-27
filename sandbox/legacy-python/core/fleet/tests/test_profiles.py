"""Tests for fleet spawn profiles."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.fleet.profiles import (
    BUILTIN_PROFILES,
    CUSTOM,
    DOC_AGENT,
    LIBRARY_MAINTAINER,
    TEST_WRITER,
    Profile,
    ProfileStore,
)


# ---------------------------------------------------------------------------
# Built-ins
# ---------------------------------------------------------------------------


def test_builtin_profiles_are_distinct() -> None:
    names = [p.name for p in BUILTIN_PROFILES]
    assert len(names) == len(set(names))


def test_builtin_profiles_are_marked_builtin() -> None:
    for p in BUILTIN_PROFILES:
        assert p.built_in is True


def test_builtin_test_writer_owns_tests_reads_src() -> None:
    assert "tests/**" in TEST_WRITER.owns_modules
    assert "src/**" in TEST_WRITER.reads_modules


def test_builtin_doc_agent_owns_docs() -> None:
    assert "docs/**" in DOC_AGENT.owns_modules


def test_builtin_library_maintainer_has_long_ttl() -> None:
    assert LIBRARY_MAINTAINER.ttl_seconds > 3600


def test_custom_profile_has_no_modules() -> None:
    assert CUSTOM.owns_modules == ()
    assert CUSTOM.reads_modules == ()


# ---------------------------------------------------------------------------
# Profile (de)serialization
# ---------------------------------------------------------------------------


def test_to_dict_from_dict_roundtrip() -> None:
    out = Profile.from_dict(TEST_WRITER.to_dict())
    # Disk-loaded profiles always come back as built_in=False (you can't
    # mark a custom profile as built-in just by setting a flag in JSON).
    assert out.built_in is False
    assert out.name == TEST_WRITER.name
    assert out.owns_modules == TEST_WRITER.owns_modules
    assert out.reads_modules == TEST_WRITER.reads_modules


def test_launch_command_roundtrip() -> None:
    p = Profile(
        name="x", description="",
        launch_command=("python", "-c", "print('hi')"),
    )
    out = Profile.from_dict(p.to_dict())
    # tuples ↔ lists in JSON; from_dict re-tuples.
    assert out.launch_command == ("python", "-c", "print('hi')")


def test_launch_command_defaults_to_empty_when_missing() -> None:
    p = Profile.from_dict({"name": "minimal"})
    assert p.launch_command == ()


def test_from_dict_supplies_defaults() -> None:
    p = Profile.from_dict({"name": "minimal"})
    assert p.name == "minimal"
    assert p.description == ""
    assert p.owns_modules == ()
    assert p.ttl_seconds == 3600
    assert p.base_branch == "main"


# ---------------------------------------------------------------------------
# ProfileStore — directory loading
# ---------------------------------------------------------------------------


def test_store_returns_only_builtins_when_dir_missing(tmp_path: Path) -> None:
    store = ProfileStore(custom_dir=tmp_path / "does-not-exist")
    names = [p.name for p in store.list_all()]
    assert names == [p.name for p in BUILTIN_PROFILES]


def test_store_loads_custom_profiles(tmp_path: Path) -> None:
    custom_dir = tmp_path / "profiles"
    custom_dir.mkdir()
    (custom_dir / "team-lead.json").write_text(json.dumps({
        "name": "team-lead",
        "description": "Owns the platform layer",
        "icon": "👑",
        "owns_modules": ["src/platform/**"],
        "reads_modules": ["src/**"],
        "default_reason": "Platform stewardship",
        "ttl_seconds": 14400,
        "base_branch": "main",
    }), encoding="utf-8")

    store = ProfileStore(custom_dir=custom_dir)
    names = [p.name for p in store.list_all()]
    assert "team-lead" in names

    p = store.get("team-lead")
    assert p.icon == "👑"
    assert p.owns_modules == ("src/platform/**",)
    assert p.ttl_seconds == 14400
    # Anything loaded from disk is non-built-in by definition.
    assert p.built_in is False


def test_custom_overrides_builtin_by_name(tmp_path: Path) -> None:
    custom_dir = tmp_path / "profiles"
    custom_dir.mkdir()
    # Override the built-in test-writer with a custom version.
    (custom_dir / "test-writer.json").write_text(json.dumps({
        "name": "test-writer",
        "description": "team override",
        "owns_modules": ["spec/**"],
    }), encoding="utf-8")

    store = ProfileStore(custom_dir=custom_dir)
    p = store.get("test-writer")
    assert p.description == "team override"
    assert p.owns_modules == ("spec/**",)
    assert p.built_in is False


def test_malformed_profile_is_skipped(tmp_path: Path, caplog) -> None:
    custom_dir = tmp_path / "profiles"
    custom_dir.mkdir()
    (custom_dir / "broken.json").write_text("{ not json", encoding="utf-8")
    (custom_dir / "valid.json").write_text(json.dumps({
        "name": "valid",
        "description": "ok",
    }), encoding="utf-8")

    store = ProfileStore(custom_dir=custom_dir)
    names = [p.name for p in store.list_all()]
    # Malformed file is dropped; valid one is loaded; built-ins still present.
    assert "valid" in names
    assert "broken" not in names
    assert "custom" in names


def test_store_get_unknown_raises(tmp_path: Path) -> None:
    store = ProfileStore(custom_dir=tmp_path / "profiles")
    with pytest.raises(KeyError):
        store.get("ghost")


# ---------------------------------------------------------------------------
# ProfileStore — mutations (save / delete)
# ---------------------------------------------------------------------------


def test_save_writes_json_and_lists(tmp_path: Path) -> None:
    custom_dir = tmp_path / "profiles"
    store = ProfileStore(custom_dir=custom_dir)
    saved = store.save(Profile(
        name="my-team-lead",
        description="owns the platform layer",
        icon="👑",
        owns_modules=("src/platform/**",),
        default_reason="platform stewardship",
        ttl_seconds=14400,
    ))
    # Saved instance always reports built_in=False.
    assert saved.built_in is False

    # File exists with sanitised name.
    files = list(custom_dir.glob("*.json"))
    assert len(files) == 1
    data = json.loads(files[0].read_text(encoding="utf-8"))
    assert data["name"] == "my-team-lead"
    assert data["owns_modules"] == ["src/platform/**"]

    # Round-trips through list_all.
    names = [p.name for p in store.list_all()]
    assert "my-team-lead" in names


def test_save_refuses_builtin_name(tmp_path: Path) -> None:
    store = ProfileStore(custom_dir=tmp_path / "profiles")
    with pytest.raises(ValueError, match="built-in"):
        store.save(Profile(name="test-writer", description="overrides built-in"))


def test_save_refuses_empty_name(tmp_path: Path) -> None:
    store = ProfileStore(custom_dir=tmp_path / "profiles")
    with pytest.raises(ValueError, match="required"):
        store.save(Profile(name="   ", description="x"))


def test_save_strips_built_in_flag_even_if_set(tmp_path: Path) -> None:
    store = ProfileStore(custom_dir=tmp_path / "profiles")
    saved = store.save(Profile(
        name="custom-x",
        description="claims to be built-in but isn't",
        built_in=True,  # should be stripped
    ))
    assert saved.built_in is False
    # The on-disk JSON also says built_in=false.
    path = next((tmp_path / "profiles").glob("*.json"))
    assert json.loads(path.read_text(encoding="utf-8"))["built_in"] is False


def test_delete_removes_custom_profile(tmp_path: Path) -> None:
    store = ProfileStore(custom_dir=tmp_path / "profiles")
    store.save(Profile(name="kill-me", description=""))
    assert "kill-me" in [p.name for p in store.list_all()]
    assert store.delete("kill-me") is True
    assert "kill-me" not in [p.name for p in store.list_all()]


def test_delete_refuses_builtin(tmp_path: Path) -> None:
    store = ProfileStore(custom_dir=tmp_path / "profiles")
    assert store.delete("test-writer") is False
    # Built-in still listed.
    assert "test-writer" in [p.name for p in store.list_all()]


def test_delete_unknown_returns_false(tmp_path: Path) -> None:
    store = ProfileStore(custom_dir=tmp_path / "profiles")
    assert store.delete("never-existed") is False


def test_save_with_unsafe_name_sanitised_on_disk(tmp_path: Path) -> None:
    store = ProfileStore(custom_dir=tmp_path / "profiles")
    store.save(Profile(name="weird/name with spaces", description="x"))
    files = list((tmp_path / "profiles").glob("*.json"))
    assert len(files) == 1
    assert "/" not in files[0].name
    assert " " not in files[0].name
