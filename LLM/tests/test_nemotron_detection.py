"""
Unit tests for NemotronH vs generic Nemotron detection.

Verifies that only explicit NemotronH identity triggers cache path,
not generic 'nemotron' in model name (e.g. Llama-3.1-Nemotron-Nano).
"""
import pytest
import sys
import os
from pathlib import Path
from unittest.mock import MagicMock

llm_dir = Path(__file__).parent.parent
sys.path.insert(0, str(llm_dir))


def _is_nemotron_h_strict(model_class_name: str, config_class_name: str, model_type_attr: str, arch_str: str) -> bool:
    """Replicate the narrowed NemotronH check from run_adapter_backend.generate_text."""
    return (
        model_type_attr == "nemotron_h"
        or "NemotronH" in model_class_name
        or "NemotronH" in config_class_name
        or "nemotronh" in arch_str
    )


class TestNemotronHDetection:
    """Narrowed detection: only NemotronH, not generic Nemotron."""

    def test_nemotron_h_model_type(self):
        assert _is_nemotron_h_strict("SomeClass", "SomeConfig", "nemotron_h", "") is True

    def test_nemotron_h_in_class_name(self):
        assert _is_nemotron_h_strict("NemotronHForCausalLM", "Config", "llama", "") is True

    def test_nemotron_h_in_config_class(self):
        assert _is_nemotron_h_strict("LlamaForCausalLM", "NemotronHConfig", "llama", "") is True

    def test_nemotron_h_in_arch(self):
        # Backend uses arch_str lowercased
        assert _is_nemotron_h_strict("LlamaForCausalLM", "LlamaConfig", "llama", "nemotronh 1b") is True

    def test_generic_nemotron_nano_not_nemotron_h(self):
        # Llama-3.1-Nemotron-Nano-8B is not NemotronH; should not trigger cache path
        assert _is_nemotron_h_strict("LlamaForCausalLM", "LlamaConfig", "llama", "llama nemotron nano") is False

    def test_nemotron_in_name_only_not_sufficient(self):
        assert _is_nemotron_h_strict("NemotronNano", "NemotronNanoConfig", "llama", "") is False
