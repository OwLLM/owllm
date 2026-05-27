"""
Unit tests for canonical model identity resolver.

Covers: derive_from_model_path, to_canonical_id, resolve_config_key
normalization matrix (org/repo, org__repo, org_repo, model_*) and
onboarding lookup determinism / env binding authority.
"""
import pytest
import sys
from pathlib import Path

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))

from core.model_id_resolver import (
    derive_from_model_path,
    to_canonical_id,
    resolve_config_key,
    resolve_onboarding_identity,
)


class TestDeriveFromModelPath:
    """Normalization matrix: org/repo, org__repo, org_repo, model_*."""

    def test_double_underscore_to_slash(self):
        assert derive_from_model_path("/some/path/nvidia__nemotron") == "nvidia/nemotron"
        assert derive_from_model_path("nvidia__nemotron") == "nvidia/nemotron"
        assert derive_from_model_path("org__repo") == "org/repo"

    def test_single_underscore_to_slash(self):
        assert derive_from_model_path("/path/org_repo") == "org/repo"
        assert derive_from_model_path("org_repo") == "org/repo"
        assert derive_from_model_path("nvidia_nemotron") == "nvidia/nemotron"

    def test_no_derivation(self):
        # Single token (no underscore) or empty -> None
        assert derive_from_model_path("single") is None
        assert derive_from_model_path("nodash") is None
        assert derive_from_model_path("") is None
        # Name with slash (not folder name) or no __/single _ pattern
        assert derive_from_model_path("/path/with/slash/name") is None
        # Single-underscore names are derived (e.g. model_123 -> model/123, random_folder -> random/folder)
        assert derive_from_model_path("random_folder") == "random/folder"
        assert derive_from_model_path("model_123") == "model/123"

    def test_empty_or_invalid(self):
        assert derive_from_model_path(None) is None
        assert derive_from_model_path("   ") is None


class TestToCanonicalId:
    """Canonical ID resolution for onboarding/StateStore lookups."""

    def test_already_hf_style(self):
        assert to_canonical_id("org/repo") == "org/repo"
        assert to_canonical_id("nvidia/nemotron") == "nvidia/nemotron"

    def test_derived_from_path(self):
        assert to_canonical_id("org_repo", base_model_path="/x/org_repo") == "org/repo"
        assert to_canonical_id("model_1", model_cfg={"base_model": "/models/nvidia__nemotron"}) == "nvidia/nemotron"

    def test_fallback_unchanged(self):
        assert to_canonical_id("model_123") == "model_123"
        assert to_canonical_id("adapter_xyz") == "adapter_xyz"
        assert to_canonical_id("model_123", model_cfg={}) == "model_123"


class TestResolveConfigKey:
    """Config key resolution from model ID or path."""

    def test_key_in_config(self):
        config = {"models": {"org_repo": {"base_model": "/path/org_repo"}, "other": {"base_model": "/other"}}}
        assert resolve_config_key("org_repo", config) == "org_repo"

    def test_path_matches_base_model(self):
        # Use same path for key and config so resolve() matches on any OS
        same_path = str(Path("models/nvidia__nemotron").resolve())
        config = {"models": {"my_key": {"base_model": same_path}}}
        assert resolve_config_key(same_path, config) == "my_key"

    def test_no_config_returns_input(self):
        assert resolve_config_key("org/repo", None) == "org/repo"
        assert resolve_config_key("org/repo", {}) == "org/repo"

    def test_not_found_returns_none(self):
        config = {"models": {"a": {"base_model": "/other"}}}
        assert resolve_config_key("/nonexistent/path", config) is None


class TestIntegrityAndOnboardingAuthority:
    """StateStore integrity report shape and onboarding env_key as source of truth (unit-level)."""

    def test_integrity_report_keys(self):
        """run_integrity_checks returns expected report keys."""
        from core.state_store import get_state_store
        store = get_state_store()
        report = store.run_integrity_checks(env_root=None, repair_safe=False)
        assert "duplicate_onboarding" in report
        assert "missing_env_for_ready" in report
        assert "canonical_mismatch" in report
        assert "repaired" in report
        assert "errors" in report
        assert isinstance(report["duplicate_onboarding"], list)
        assert isinstance(report["errors"], list)


class TestResolveOnboardingIdentity:
    def test_prefers_ready_canonical_id(self):
        statuses = {
            "unsloth_gemma-2-2b-it-bnb-4bit": "BROKEN",
            "unsloth/gemma-2-2b-it-bnb-4bit": "READY",
        }

        out = resolve_onboarding_identity(
            "unsloth_gemma-2-2b-it-bnb-4bit",
            model_cfg={"base_model": r"C:\models\unsloth__gemma-2-2b-it-bnb-4bit"},
            get_status=lambda mid: statuses.get(mid),
            strict=False,
        )
        assert out["onboarding_id"] == "unsloth/gemma-2-2b-it-bnb-4bit"
        assert out["status"] == "READY"

    def test_strict_mode_raises_on_conflicting_alias_statuses(self):
        statuses = {
            "deepseek-ai_deepseek-coder-6.7b-instruct": "READY",
            "deepseek-ai/deepseek-coder-6.7b-instruct": "BROKEN",
        }
        with pytest.raises(RuntimeError):
            resolve_onboarding_identity(
                "deepseek-ai_deepseek-coder-6.7b-instruct",
                model_cfg={"base_model": r"C:\models\deepseek-ai__deepseek-coder-6.7b-instruct"},
                get_status=lambda mid: statuses.get(mid),
                strict=True,
            )
