"""
Cross-family validation for Universal Model Runtime Plan (Workstream 6).
Tests capability resolution, required packages, and guardrail defaults per profile
without requiring real model files or GPU.
"""
import os
import sys
from pathlib import Path

llm_dir = Path(__file__).resolve().parent.parent
if str(llm_dir) not in sys.path:
    sys.path.insert(0, str(llm_dir))


def test_base_packages_defined():
    """Base stack is defined and non-empty."""
    from core.envs.capability_matrix import BASE_PACKAGES
    assert isinstance(BASE_PACKAGES, list)
    assert len(BASE_PACKAGES) >= 4
    assert "transformers" in BASE_PACKAGES
    assert "torch" in BASE_PACKAGES


def test_profiles_cover_families():
    """All expected profile_ids have package definitions."""
    from core.envs.capability_matrix import PROFILES
    expected = {"base", "base_peft", "bnb", "bnb_peft", "gptq", "gptq_peft", "awq", "awq_peft", "llamacpp"}
    for pid in expected:
        if pid == "llamacpp":
            continue
        assert pid in PROFILES, f"profile {pid} missing from PROFILES"


def test_guardrail_defaults_per_profile():
    """Guardrail defaults exist for each profile and env override is applied."""
    from core.envs.capability_matrix import GUARDRAIL_DEFAULTS, get_guardrail_max_tokens
    for profile_id in ("base", "base_peft", "bnb", "gptq", "awq", "llamacpp"):
        defaults = GUARDRAIL_DEFAULTS.get(profile_id)
        assert defaults is not None, f"GUARDRAIL_DEFAULTS missing {profile_id}"
        assert "max_new_tokens_text" in defaults
        assert "max_new_tokens_multimodal" in defaults
        cap_text = get_guardrail_max_tokens(profile_id, is_multimodal=False)
        cap_mm = get_guardrail_max_tokens(profile_id, is_multimodal=True)
        assert 64 <= cap_text <= 32768
        assert 64 <= cap_mm <= 32768


def test_guardrail_env_override():
    """Env LLM_MAX_NEW_TOKENS_TEXT overrides profile default."""
    from core.envs.capability_matrix import get_guardrail_max_tokens
    try:
        os.environ["LLM_MAX_NEW_TOKENS_TEXT"] = "512"
        cap = get_guardrail_max_tokens("base", is_multimodal=False)
        assert cap == 512
    finally:
        os.environ.pop("LLM_MAX_NEW_TOKENS_TEXT", None)


def test_resolve_capability_base(tmp_path):
    """resolve_capability returns base profile when no quant/adapter."""
    from core.envs.capability_matrix import resolve_capability
    (tmp_path / "config.json").write_text('{"model_type": "llama"}', encoding="utf-8")
    cap = resolve_capability(str(tmp_path), model_cfg={"use_4bit": False}, adapter_dir=None, model_id=None)
    assert cap["profile_id"] == "base"
    assert "transformers" in cap["required_packages"]
    assert cap["quant_for_env"] == "base"


def test_get_runtime_required_packages_base(tmp_path):
    """get_runtime_required_packages returns non-empty list for base."""
    from core.envs.capability_matrix import get_runtime_required_packages, BASE_PACKAGES
    (tmp_path / "config.json").write_text('{"model_type": "llama"}', encoding="utf-8")
    packages = get_runtime_required_packages(str(tmp_path), model_cfg={}, adapter_dir=None, model_id=None)
    assert isinstance(packages, list)
    assert len(packages) >= len(BASE_PACKAGES)
    for p in BASE_PACKAGES:
        assert p in packages


def test_non_target_profiles_unchanged():
    """Guardrail defaults for one profile do not alter others (regression)."""
    from core.envs.capability_matrix import GUARDRAIL_DEFAULTS, get_guardrail_max_tokens
    base_text = get_guardrail_max_tokens("base", is_multimodal=False)
    bnb_text = get_guardrail_max_tokens("bnb", is_multimodal=False)
    gptq_text = get_guardrail_max_tokens("gptq", is_multimodal=False)
    assert base_text == bnb_text == gptq_text  # same default in matrix
    assert GUARDRAIL_DEFAULTS["base"]["max_new_tokens_text"] == GUARDRAIL_DEFAULTS["bnb"]["max_new_tokens_text"]


def test_multimodal_runtime_packages_include_vision_deps(tmp_path):
    """When model is multimodal, get_runtime_required_packages includes Pillow, timm, einops, open-clip-torch."""
    from core.envs.capability_matrix import get_runtime_required_packages
    (tmp_path / "config.json").write_text(
        '{"model_type": "llama3_2_vision", "architectures": ["Llama3.2VisionForConditionalGeneration"]}',
        encoding="utf-8",
    )
    packages = get_runtime_required_packages(str(tmp_path), model_cfg={}, adapter_dir=None, model_id=None)
    assert "Pillow" in packages
    assert "timm" in packages
    assert "einops" in packages
    assert "open-clip-torch" in packages


def test_text_only_model_no_vision_deps(tmp_path):
    """Non-vision model required packages do not include vision-only deps (regression)."""
    from core.envs.capability_matrix import get_runtime_required_packages
    (tmp_path / "config.json").write_text('{"model_type": "llama", "architectures": ["LlamaForCausalLM"]}', encoding="utf-8")
    packages = get_runtime_required_packages(str(tmp_path), model_cfg={}, adapter_dir=None, model_id=None)
    assert "transformers" in packages
    assert "torch" in packages
    assert "open-clip-torch" not in packages


def test_llamacpp_required_and_fallback_packages(tmp_path):
    """GGUF/llamacpp profile: required_packages only llama-cpp-python; fallback_packages non-empty."""
    from core.envs.capability_matrix import (
        resolve_capability,
        get_runtime_required_packages,
        get_runtime_fallback_packages,
    )
    (tmp_path / "model.gguf").write_bytes(b"GGUF" + (b"\x00" * 256))
    cap = resolve_capability(str(tmp_path), model_cfg={}, adapter_dir=None, model_id=None)
    assert cap.get("profile_id") == "llamacpp"
    assert cap.get("required_packages") == ["llama-cpp-python"]
    fallback = cap.get("fallback_packages", [])
    assert isinstance(fallback, list)
    assert "gguf" in fallback
    assert "sentencepiece" in fallback
    assert "tokenizers" in fallback
    required = get_runtime_required_packages(str(tmp_path), model_cfg={}, adapter_dir=None, model_id=None)
    assert required == ["llama-cpp-python"]
    fallback_get = get_runtime_fallback_packages(str(tmp_path), model_cfg={}, adapter_dir=None, model_id=None)
    assert set(fallback_get) >= {"gguf", "sentencepiece", "tokenizers"}


def test_classify_gguf_backend_incompatible():
    """classify_runtime_failure maps GGUF variant/backend errors to BACKEND_INCOMPATIBLE_MODEL."""
    from core.envs.capability_matrix import classify_runtime_failure
    cases = [
        ("OTHER", "gguf_init_from_file failed block size"),
        ("OTHER", "gguf runtime backend failed for this model. Tried llama-cpp-python"),
        ("OTHER", "gguf runtime backend failed for probe ctransformers: failed to create llm"),
        ("UNSUPPORTED_ARCH", "unsupported arch"),
    ]
    for reason, msg in cases:
        out = classify_runtime_failure(reason, msg)
        assert out.get("category") == "BACKEND_INCOMPATIBLE_MODEL", (
            f"expected BACKEND_INCOMPATIBLE_MODEL for ({reason!r}, {msg[:50]!r}), got {out}"
        )


def test_classify_tokenizer_missing_as_runtime_missing_component():
    """Tokenizer fallback dependency misses must classify as runtime-missing (self-healable)."""
    from core.envs.capability_matrix import classify_runtime_failure
    msg = (
        "RuntimeError: GGUF runtime backend failed for this model. "
        "transformers: Couldn't instantiate the backend tokenizer from one of: ... "
        "You need to have sentencepiece or tiktoken installed to convert a slow tokenizer."
    )
    out = classify_runtime_failure("OTHER", msg)
    assert out.get("category") == "RUNTIME_MISSING_COMPONENT"
    assert "sentencepiece" in (out.get("action") or "").lower() or "tiktoken" in (out.get("action") or "").lower()


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
