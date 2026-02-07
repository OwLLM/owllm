#!/usr/bin/env python3
"""
ExLlamaV2 backend for GPTQ models.
Alternative to auto-gptq when enabled via USE_EXLLAMAV2_GPTQ=true.
Provides load_model and generate_text with the same interface as run_adapter_backend.
"""
import os
import logging
from pathlib import Path
from typing import Optional, Tuple, Any

logger = logging.getLogger(__name__)

# ExLlamaV2 is optional; import lazily when backend is selected
_exllama_available: Optional[bool] = None


def _check_exllama_available() -> bool:
    global _exllama_available
    if _exllama_available is not None:
        return _exllama_available
    try:
        import exllamav2  # noqa: F401
        _exllama_available = True
    except ImportError:
        _exllama_available = False
    return _exllama_available


def load_model(
    base_model: str,
    adapter_dir: Optional[str] = None,
    use_4bit: bool = True,
    offload: bool = True,
) -> Tuple[Any, Any]:
    """
    Load a GPTQ model using ExLlamaV2.
    Same signature as run_adapter_backend.load_model for drop-in replacement.
    adapter_dir is ignored (ExLlamaV2 does not support adapters for GPTQ).
    """
    if not _check_exllama_available():
        raise RuntimeError(
            "ExLlamaV2 backend selected but exllamav2 is not installed. "
            "Install with: pip install exllamav2"
        )
    from exllamav2 import (
        ExLlamaV2,
        ExLlamaV2Config,
        ExLlamaV2Cache,
        ExLlamaV2Tokenizer,
    )
    from exllamav2.generator import ExLlamaV2Generator

    model_path = Path(base_model).resolve()
    if not model_path.exists() or not model_path.is_dir():
        raise ValueError(f"Model path does not exist or is not a directory: {base_model}")

    config_path = model_path / "config.json"
    if not config_path.exists():
        raise ValueError(f"config.json not found in model directory: {model_path}")

    # Find weight file: prefer .safetensors (GPTQ models)
    weight_file = None
    for f in model_path.iterdir():
        if f.is_file() and f.suffix == ".safetensors":
            weight_file = f
            break
    if not weight_file:
        raise ValueError(
            f"No .safetensors file found in model directory: {model_path}. "
            "ExLlamaV2 requires GPTQ safetensors weights."
        )

    # Find tokenizer: ExLlamaV2Tokenizer expects tokenizer.model (SentencePiece) or similar
    tokenizer_path = None
    for name in ["tokenizer.model", "tokenizer.json"]:
        cand = model_path / name
        if cand.exists():
            tokenizer_path = cand
            break
    if not tokenizer_path:
        # Fallback: use model dir; some ExLlamaV2 versions accept directory
        tokenizer_path = model_path

    logger.info(f"Loading GPTQ model with ExLlamaV2: {model_path}")
    config = ExLlamaV2Config(str(config_path))
    config.prepare()
    model = ExLlamaV2(config)
    model.load(str(weight_file))
    cache = ExLlamaV2Cache(model)
    tokenizer = ExLlamaV2Tokenizer(str(tokenizer_path))
    generator = ExLlamaV2Generator(model, tokenizer, cache)

    # Return (tokenizer, model) - we store generator on model for generate_text
    # Use a simple wrapper so generate_text can call generator.generate_simple
    class ExLlamaModelWrapper:
        def __init__(self, gen, tok):
            self.generator = gen
            self.tokenizer = tok

    wrapper = ExLlamaModelWrapper(generator, tokenizer)
    return tokenizer, wrapper


def generate_text(
    tokenizer: Any,
    model: Any,
    prompt: str,
    max_new_tokens: int = 128,
    temperature: float = 0.7,
    model_type: str = "base",
    system_prompt: str = "",
) -> str:
    """
    Generate text using ExLlamaV2.
    Same signature as run_adapter_backend.generate_text.
    """
    # model is ExLlamaModelWrapper with .generator and .tokenizer
    gen = model.generator
    tok = model.tokenizer

    # Format prompt (instruct vs base) - simplified; ExLlamaV2 doesn't use HF chat templates
    if model_type == "instruct" and system_prompt:
        full_prompt = f"{system_prompt}\n\n{prompt}"
    else:
        full_prompt = prompt

    gen.settings.temperature = temperature
    gen.settings.top_p = 0.9

    output = gen.generate_simple(full_prompt, max_new_tokens=max_new_tokens)
    text = (output or "").strip()
    if not text:
        raise RuntimeError(
            "ExLlamaV2 generated empty output. "
            "Try increasing max_new_tokens or changing the prompt."
        )
    return text
