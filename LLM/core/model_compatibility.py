"""
Model Compatibility Detection and Runtime Capability Checking

This module provides generic detection of model types, library capabilities,
and version-aware parameter passing to avoid hardcoding version requirements.
"""

from typing import Dict, Optional, Tuple
import re


def detect_model_type(model_name: str) -> Dict[str, any]:
    """
    Detect model type and requirements from model name.
    
    Args:
        model_name: HuggingFace model identifier (e.g., "unsloth/gemma-2-2b-it-bnb-4bit")
    
    Returns:
        Dict with:
        - is_unsloth: bool - Model is from unsloth namespace
        - is_quantized: bool - Model requires quantization (bnb-4bit, etc.)
        - model_family: str - Model family (qwen, llama, gemma, mistral, phi, etc.)
        - requires_unsloth: bool - Model explicitly requires unsloth
        - requires_quantization: bool - Model explicitly requires quantization
        - base_model_name: str - Base model name without unsloth/quantization suffixes
    """
    model_lower = model_name.lower()
    
    # Detect unsloth models
    is_unsloth = "/unsloth/" in model_name or "-unsloth-" in model_lower
    
    # Detect quantization
    is_quantized = (
        "bnb" in model_lower or 
        "4bit" in model_lower or 
        "8bit" in model_lower or
        "-4bit" in model_lower or
        "-8bit" in model_lower
    )
    
    # Extract model family
    model_family = _extract_model_family(model_name)
    
    # Determine base model name (remove unsloth/quantization suffixes)
    base_model_name = _extract_base_model_name(model_name)
    
    return {
        "is_unsloth": is_unsloth,
        "is_quantized": is_quantized,
        "model_family": model_family,
        "requires_unsloth": is_unsloth,  # Unsloth models require unsloth library
        "requires_quantization": is_quantized,  # Quantized models require bitsandbytes
        "base_model_name": base_model_name,
        "original_name": model_name,
    }


def _extract_model_family(model_name: str) -> str:
    """Extract model family from model name."""
    model_lower = model_name.lower()

    if "qwen" in model_lower:
        return "qwen"
    elif "llama" in model_lower:
        return "llama"
    elif "gemma" in model_lower:
        return "gemma"
    elif "mistral" in model_lower:
        return "mistral"
    elif "phi" in model_lower:
        return "phi"
    elif "hermes" in model_lower:
        return "hermes"
    else:
        return "unknown"


# --------- Pretty display names for the UI ---------
# Family canonicalisation: lowercase token -> the spelling humans recognise.
_FAMILY_CANONICAL = {
    "gemma": "Gemma", "llama": "Llama", "qwen": "Qwen", "qwen2": "Qwen2",
    "qwen3": "Qwen3", "mistral": "Mistral", "mixtral": "Mixtral",
    "phi": "Phi", "phi3": "Phi3", "hermes": "Hermes", "deepseek": "DeepSeek",
    "yi": "Yi", "tinyllama": "TinyLlama", "starcoder": "StarCoder",
    "starcoder2": "StarCoder2", "codellama": "CodeLlama", "openchat": "OpenChat",
    "zephyr": "Zephyr", "vicuna": "Vicuna", "orca": "Orca", "solar": "SOLAR",
    "stablelm": "StableLM", "minicpm": "MiniCPM", "internlm": "InternLM",
    "glm": "GLM", "smol": "Smol", "smollm": "SmolLM", "smollm2": "SmolLM2",
    "neo": "Neo", "openhermes": "OpenHermes", "wizardlm": "WizardLM",
    "wizardcoder": "WizardCoder", "deepseekcoder": "DeepSeekCoder",
}

# Suffix tokens we know expand to a familiar word.
_SUFFIX_LABELS = {
    "it": "Instruct", "instruct": "Instruct", "chat": "Chat", "base": "Base",
    "code": "Code", "math": "Math", "vision": "Vision", "vl": "Vision",
    "rl": "RL", "dpo": "DPO", "sft": "SFT", "uncensored": "Uncensored",
    "abliterated": "Abliterated", "heretic": "Heretic", "flash": "Flash",
}

# Quantisation / format tags (matched as a whole token).
_QUANT_PATTERNS = [
    (re.compile(r"^Q(\d)_K_M$", re.IGNORECASE), lambda m: f"Q{m.group(1)}_K_M"),
    (re.compile(r"^Q(\d)_K_S$", re.IGNORECASE), lambda m: f"Q{m.group(1)}_K_S"),
    (re.compile(r"^Q(\d)_0$", re.IGNORECASE),   lambda m: f"Q{m.group(1)}_0"),
    (re.compile(r"^IQ(\d)$", re.IGNORECASE),     lambda m: f"IQ{m.group(1)}"),
    (re.compile(r"^bnb$", re.IGNORECASE),        lambda m: "bnb"),
    (re.compile(r"^4bit$", re.IGNORECASE),       lambda m: "4-bit"),
    (re.compile(r"^8bit$", re.IGNORECASE),       lambda m: "8-bit"),
    (re.compile(r"^awq$", re.IGNORECASE),        lambda m: "AWQ"),
    (re.compile(r"^gptq$", re.IGNORECASE),       lambda m: "GPTQ"),
    (re.compile(r"^gguf$", re.IGNORECASE),       lambda m: "GGUF"),
    (re.compile(r"^fp(8|16|32)$", re.IGNORECASE), lambda m: f"FP{m.group(1)}"),
    (re.compile(r"^bf16$", re.IGNORECASE),       lambda m: "BF16"),
]

# Orgs that ARE the upstream weights — appending "(google)" next to "Gemma 2"
# is just noise. Other orgs (unsloth, TheBloke, bartowski, ...) are fine-tuners
# or quantisers and worth showing so users can tell variants apart.
_UPSTREAM_ORGS = {"google", "meta-llama", "qwen", "mistralai", "microsoft",
                  "deepseek-ai", "stabilityai", "huggingfaceh4", "01-ai",
                  "internlm", "thudm", "openchat"}


def split_org_and_repo(folder_or_id: str) -> Tuple[Optional[str], str]:
    """``unsloth__gemma-2-2b-it`` -> ``("unsloth", "gemma-2-2b-it")``.

    Accepts both filesystem-encoded names (``org__repo``) and HF-style
    identifiers (``org/repo``). Returns ``(None, name)`` when no org is
    encoded.
    """
    if not folder_or_id:
        return None, ""
    s = folder_or_id.replace("\\", "/").strip("/")
    if "/" in s:
        org, _, repo = s.partition("/")
        return org or None, repo
    if "__" in s:
        org, _, repo = s.partition("__")
        return org or None, repo
    return None, s


def pretty_model_name(folder_or_id: str, *, include_org: bool = True) -> str:
    """Turn a filesystem/HF identifier into a human-friendly title.

    Examples::

        pretty_model_name("unsloth__gemma-2-2b-it")
            -> "Gemma 2 2B Instruct (unsloth)"
        pretty_model_name("meta-llama/Llama-3.1-8B-Instruct")
            -> "Llama 3.1 8B Instruct"
        pretty_model_name("TheBloke/Mistral-7B-v0.1-GGUF")
            -> "Mistral 7B v0.1 GGUF (TheBloke)"

    The ``include_org`` flag lets compact callers (e.g. the header VRAM
    tooltip) suppress the parenthetical when space is tight.
    """
    if not folder_or_id:
        return ""
    org, repo = split_org_and_repo(folder_or_id)
    if not repo:
        return folder_or_id

    tokens: list[str] = []
    for tok in repo.split("-"):
        if not tok:
            continue
        lower = tok.lower()
        if lower in _FAMILY_CANONICAL:
            tokens.append(_FAMILY_CANONICAL[lower])
            continue
        # Parameter size: 7b / 70b / 1.5b / 100m -> 7B / 70B / 1.5B / 100M.
        if re.fullmatch(r"\d+(?:\.\d+)?[bBmM]", tok):
            tokens.append(tok.upper())
            continue
        if lower in _SUFFIX_LABELS:
            tokens.append(_SUFFIX_LABELS[lower])
            continue
        matched = False
        for pat, formatter in _QUANT_PATTERNS:
            m = pat.match(tok)
            if m:
                tokens.append(formatter(m))
                matched = True
                break
        if matched:
            continue
        # Versions (v0.1 / v2 / v2.0) — keep as-is, lowercased v.
        if re.fullmatch(r"v\d+(?:\.\d+)*", lower):
            tokens.append(tok.lower())
            continue
        # Pure numeric or version-ish (3.1, 2.5) — keep as-is.
        if re.fullmatch(r"\d+(?:\.\d+)*", tok):
            tokens.append(tok)
            continue
        # Fallback: capitalise simple tokens, leave mixed-case alone.
        if tok.isupper() or tok.islower():
            tokens.append(tok.capitalize())
        else:
            tokens.append(tok)

    title = " ".join(tokens) if tokens else repo
    if include_org and org and org.lower() not in _UPSTREAM_ORGS:
        return f"{title} ({org})"
    return title


# Quant tag we try to lift out of a GGUF filename for compact display.
_GGUF_QUANT_RE = re.compile(
    r"(IQ\d(?:_[A-Z]+)?|Q\d_K_[MSL]|Q\d_[01]|Q\d_K|Q\d|FP\d{1,2}|BF16|F16|F32)",
    re.IGNORECASE,
)


def _extract_gguf_quant(gguf_name: str) -> str:
    """Lift the quant tag out of a GGUF filename ("...-Q5_K_M.gguf" -> "Q5_K_M")."""
    if not gguf_name:
        return ""
    base = gguf_name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if base.lower().endswith(".gguf"):
        base = base[:-5]
    m = _GGUF_QUANT_RE.search(base)
    if not m:
        return base
    tag = m.group(1).upper()
    # Normalise rare lowercase forms: "fp16" -> "FP16", "bf16" -> "BF16".
    return tag


def pretty_server_label(
    base_model: str = "",
    *,
    model_id: str = "",
    variant_relpath: str = "",
    port=None,
    include_port: bool = True,
) -> str:
    """Single canonical pretty label for a model/server entry.

    Matches the convention used by the model card
    (``pretty_model_name(model_id, include_org=False)``) so the same model
    reads the same everywhere. When the caller knows a specific weight
    variant (a GGUF quant file), the quant tag is appended so multiple
    weights of the same model can be told apart.

    Examples::

        pretty_server_label(model_id="unsloth/gemma-2-2b-it", port=10502)
            -> "Gemma 2 2B Instruct — port 10502"
        pretty_server_label(
            base_model="C:/.../unsloth__gemma-4-E4B-it-GGUF",
            variant_relpath="gemma-4-E4B-it-Q5_K_M.gguf",
            port=10533,
        )
            -> "Gemma 4 E4B Instruct GGUF · Q5_K_M — port 10533"
    """
    # Prefer model_id (what the card uses). Fall back to the trailing
    # segment of base_model, which may be a filesystem path.
    raw = str(model_id or "").strip()
    if not raw:
        raw = str(base_model or "").replace("\\", "/").strip("/")
        if "/" in raw:
            raw = raw.rsplit("/", 1)[-1]
    title = pretty_model_name(raw, include_org=False) if raw else ""
    if not title:
        title = str(model_id) or "model"
    if variant_relpath:
        quant = _extract_gguf_quant(str(variant_relpath))
        if quant:
            title = f"{title} · {quant}"
    if include_port and port not in (None, "", "?"):
        try:
            title = f"{title} — port {int(port)}"
        except Exception:
            title = f"{title} — port {port}"
    return title


def _extract_base_model_name(model_name: str) -> str:
    """Extract base model name by removing unsloth/quantization suffixes."""
    base = model_name
    
    # Remove unsloth namespace
    if "/unsloth/" in base:
        base = base.replace("/unsloth/", "/")
    base = base.replace("-unsloth-", "-")
    
    # Remove quantization suffixes
    base = re.sub(r"-bnb-4bit$", "", base)
    base = re.sub(r"-bnb-8bit$", "", base)
    base = re.sub(r"-4bit$", "", base)
    base = re.sub(r"-8bit$", "", base)
    
    return base


def check_peft_capabilities() -> Dict[str, any]:
    """
    Check what peft features are available based on installed version.
    
    Returns:
        Dict with:
        - version: str - Installed peft version
        - available: bool - Whether peft is installed
        - supports_ensure_weight_tying: bool - Supports ensure_weight_tying parameter
        - supports_other_features: dict - Other feature flags
    """
    try:
        import peft
        from packaging import version as pkg_version
        
        peft_version = peft.__version__
        ver = pkg_version.parse(peft_version)
        
        # Check for ensure_weight_tying support (added in 0.14.0)
        supports_ensure_weight_tying = ver >= pkg_version.parse("0.14.0")
        
        # Check LoraConfig for available parameters
        try:
            from peft import LoraConfig
            import inspect
            lora_params = set(inspect.signature(LoraConfig.__init__).parameters.keys())
            supports_ensure_weight_tying = supports_ensure_weight_tying or "ensure_weight_tying" in lora_params
        except Exception:
            pass
        
        return {
            "version": peft_version,
            "available": True,
            "supports_ensure_weight_tying": supports_ensure_weight_tying,
            "supports_other_features": {
                # Add other feature checks here as needed
            }
        }
    except ImportError:
        return {
            "version": None,
            "available": False,
            "supports_ensure_weight_tying": False,
            "supports_other_features": {}
        }
    except Exception as e:
        # If version parsing fails, assume older version
        return {
            "version": "unknown",
            "available": True,
            "supports_ensure_weight_tying": False,
            "supports_other_features": {}
        }


def check_unsloth_capabilities() -> Dict[str, any]:
    """
    Check if unsloth is available — WITHOUT importing it.

    Importing unsloth has destructive side-effects: it monkey-patches
    trl.SFTTrainer with UnslothSFTTrainer, prints '🦥 Unsloth: Will
    patch your computer...', and (when imported AFTER transformers/peft)
    leaves trl in a half-patched state that triggers a Windows
    ACCESS_VIOLATION (0xC0000005) somewhere in the dataset/trainer
    pipeline. We use importlib.metadata for the version probe — no
    code execution, no patching.
    """
    import importlib.util
    import importlib.metadata as _md

    spec = importlib.util.find_spec("unsloth")
    if spec is None:
        return {"available": False, "functional": False, "version": None}

    try:
        version = _md.version("unsloth")
    except Exception:
        version = "unknown"

    return {
        "available": True,
        "functional": True,  # presence == usable; real probe happens at use time
        "version": version,
    }


def check_bitsandbytes_capabilities() -> Dict[str, any]:
    """
    Check if bitsandbytes is available and functional.
    
    Returns:
        Dict with:
        - available: bool - Whether bitsandbytes is installed
        - functional: bool - Whether bitsandbytes can be used (requires triton.ops on Windows)
        - version: str - bitsandbytes version if available
    """
    try:
        import bitsandbytes
        from bitsandbytes.nn import Linear8bitLt
        
        version = getattr(bitsandbytes, "__version__", "unknown")
        
        # On Windows, check if triton.ops is available (required for bitsandbytes)
        functional = True
        import sys
        if sys.platform == "win32":
            try:
                import triton.ops
            except ImportError:
                functional = False
        
        return {
            "available": True,
            "functional": functional,
            "version": version
        }
    except ImportError:
        return {
            "available": False,
            "functional": False,
            "version": None
        }
    except Exception as e:
        return {
            "available": True,
            "functional": False,
            "version": "unknown",
            "error": str(e)
        }


def get_compatible_peft_params(
    r: int,
    lora_alpha: int,
    lora_dropout: float,
    target_modules: list,
    bias: str = "none",
    task_type: str = "CAUSAL_LM",
    capabilities: Optional[Dict] = None
) -> Dict[str, any]:
    """
    Return PEFT parameters compatible with installed peft version.
    
    Args:
        r: LoRA rank
        lora_alpha: LoRA alpha
        lora_dropout: LoRA dropout
        target_modules: Target modules for LoRA
        bias: Bias type
        task_type: Task type
        capabilities: Optional pre-computed peft capabilities (if None, will check)
    
    Returns:
        Dict of parameters safe to pass to LoraConfig
    """
    if capabilities is None:
        capabilities = check_peft_capabilities()
    
    params = {
        "r": r,
        "lora_alpha": lora_alpha,
        "target_modules": target_modules,
        "lora_dropout": lora_dropout,
        "bias": bias,
        "task_type": task_type,
    }
    
    # Only add ensure_weight_tying if supported
    if capabilities.get("supports_ensure_weight_tying", False):
        params["ensure_weight_tying"] = True
    
    return params


def get_compatible_unsloth_params(
    r: int,
    lora_alpha: int,
    lora_dropout: float,
    target_modules: list,
    use_gradient_checkpointing: str = "unsloth",
    capabilities: Optional[Dict] = None
) -> Dict[str, any]:
    """
    Return unsloth parameters compatible with installed peft version.
    
    Args:
        r: LoRA rank
        lora_alpha: LoRA alpha
        lora_dropout: LoRA dropout
        target_modules: Target modules for LoRA
        use_gradient_checkpointing: Gradient checkpointing mode
        capabilities: Optional pre-computed peft capabilities (if None, will check)
    
    Returns:
        Dict of parameters safe to pass to FastLanguageModel.get_peft_model
    """
    if capabilities is None:
        capabilities = check_peft_capabilities()
    
    params = {
        "r": r,
        "target_modules": target_modules,
        "lora_alpha": lora_alpha,
        "lora_dropout": lora_dropout,
        "bias": "none",
        "use_gradient_checkpointing": use_gradient_checkpointing,
    }
    
    # Only add ensure_weight_tying if supported
    if capabilities.get("supports_ensure_weight_tying", False):
        params["ensure_weight_tying"] = True
    
    return params


def get_optimal_loading_strategy(model_name: str) -> Tuple[str, Dict[str, any]]:
    """
    Determine optimal loading strategy for a model based on available capabilities.
    
    Args:
        model_name: HuggingFace model identifier
    
    Returns:
        Tuple of (strategy_name, strategy_info)
        strategy_name: "unsloth", "peft", or "base"
        strategy_info: Dict with capabilities and fallback info
    """
    model_info = detect_model_type(model_name)
    peft_caps = check_peft_capabilities()
    unsloth_caps = check_unsloth_capabilities()
    bnb_caps = check_bitsandbytes_capabilities()
    
    # Strategy 1: Try unsloth if model requires it and it's available
    if model_info["requires_unsloth"] and unsloth_caps["functional"] and peft_caps["available"]:
        return ("unsloth", {
            "can_use": True,
            "reason": "Model requires unsloth and it's available",
            "fallback": "peft",
            "capabilities": {
                "peft": peft_caps,
                "unsloth": unsloth_caps,
                "bitsandbytes": bnb_caps
            }
        })
    
    # Strategy 2: Use standard PEFT if peft is available
    if peft_caps["available"]:
        return ("peft", {
            "can_use": True,
            "reason": "Standard PEFT available",
            "fallback": "base",
            "capabilities": {
                "peft": peft_caps,
                "bitsandbytes": bnb_caps
            }
        })
    
    # Strategy 3: Fall back to base transformers
    return ("base", {
        "can_use": True,
        "reason": "Falling back to base transformers (no PEFT)",
        "fallback": None,
        "capabilities": {
            "bitsandbytes": bnb_caps
        }
    })
