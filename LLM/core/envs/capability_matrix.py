"""
Universal capability matrix for all supported model families.
Single source of truth for required packages and env quant selection.
Used by both onboarding and runtime preflight so they never disagree.
"""
from pathlib import Path
from typing import Any, Dict, List, Optional
import os
import logging

logger = logging.getLogger(__name__)

# Base stack required for all transformers-based inference
BASE_PACKAGES = ["protobuf", "transformers", "tokenizers", "torch", "accelerate"]

# Optional stacks keyed by capability
PACKAGES_BY_CAPABILITY = {
    "peft": ["peft"],
    "bnb": ["bitsandbytes"],
    "gptq_autogptq": ["optimum", "auto-gptq"],
    "gptq_exllamav2": ["exllamav2"],
    "awq": ["autoawq"],
}

# Capability profile id -> list of capability keys that add packages
PROFILES = {
    "base": ["base"],
    "base_peft": ["base", "peft"],
    "bnb": ["base", "bnb"],
    "bnb_peft": ["base", "bnb", "peft"],
    "gptq": ["base", "gptq_autogptq"],  # overridden to gptq_exllamav2 when config says so
    "gptq_peft": ["base", "peft", "gptq_autogptq"],
    "awq": ["base", "awq"],
    "awq_peft": ["base", "peft", "awq"],
}


def _detect_gptq_backend(model_id: Optional[str] = None) -> str:
    """Return 'exllamav2' or 'auto-gptq' from llm_backends.yaml for model_id."""
    try:
        import yaml
        # LLM root: core/envs/capability_matrix.py -> parent.parent = core, parent.parent.parent = LLM
        llm_root = Path(__file__).resolve().parent.parent.parent
        config_path = llm_root / "configs" / "llm_backends.yaml"
        if not config_path.exists():
            return "auto-gptq"
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        model_cfg = (cfg or {}).get("models", {}).get(model_id or "", {})
        return "exllamav2" if model_cfg.get("gptq_backend") == "exllamav2" else "auto-gptq"
    except Exception:
        return "auto-gptq"


def resolve_capability(
    model_path: str,
    model_cfg: Optional[Dict[str, Any]] = None,
    adapter_dir: Optional[str] = None,
    model_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Resolve capability profile and required packages for a model.
    Single source of truth for onboarding and runtime preflight.

    Args:
        model_path: Path to base model directory
        model_cfg: Optional config dict (e.g. from llm_backends.yaml) with use_4bit, adapter_dir, etc.
        adapter_dir: Optional adapter directory (overrides model_cfg adapter_dir for detection)
        model_id: Optional model id (for gptq_backend lookup)

    Returns:
        {
            "profile_id": str,
            "required_packages": List[str],
            "quant_for_env": "base" | "bnb",
            "needs_peft": bool,
            "needs_bnb": bool,
            "is_gptq": bool,
            "is_multimodal": bool,
            "notes": List[str],
        }
    """
    from core.envs.model_requirement_detector import detect_model_requirements

    model_cfg = model_cfg or {}
    adapter_dir = adapter_dir or model_cfg.get("adapter_dir")
    use_4bit_cfg = bool(model_cfg.get("use_4bit", True))
    model_path_obj = Path(model_path)
    notes: List[str] = []

    req = detect_model_requirements(str(model_path), adapter_dir)
    quantization = req.get("quantization", "none")
    needs_bnb = bool(req.get("needs_bnb", False))
    needs_peft = bool(adapter_dir)
    is_gptq = quantization == "gptq"
    is_awq = quantization == "awq"

    # OS-specific policy: Windows + use_4bit + non-GPTQ => require bnb (no silent FP16 fallback)
    if os.name == "nt" and use_4bit_cfg and not is_gptq and not is_awq:
        if not needs_bnb:
            notes.append("Windows + use_4bit: requiring bitsandbytes for runtime (config use_4bit=true)")
        needs_bnb = True

    # Build package list from profile
    if req.get("backend_required") == "llamacpp":
        return {
            "profile_id": "llamacpp",
            # GGUF runtime requires at least one backend package.
            # We require llama-cpp-python as the default stable backend.
            "required_packages": ["llama-cpp-python"],
            "quant_for_env": "base",
            "needs_peft": False,
            "needs_bnb": False,
            "is_gptq": False,
            "is_multimodal": False,
            "notes": notes + list(req.get("notes", [])),
        }

    # Transformers path
    if is_gptq:
        gptq_backend = _detect_gptq_backend(model_id)
        if gptq_backend == "exllamav2":
            capability_keys = ["base", "gptq_exllamav2"]
        else:
            capability_keys = ["base", "gptq_autogptq"]
        if needs_peft:
            capability_keys.insert(1, "peft")
        profile_id = "gptq_peft" if needs_peft else "gptq"
    elif is_awq:
        capability_keys = ["base", "awq"]
        if needs_peft:
            capability_keys.insert(1, "peft")
        profile_id = "awq_peft" if needs_peft else "awq"
    elif needs_bnb:
        capability_keys = ["base", "bnb"]
        if needs_peft:
            capability_keys.append("peft")
        profile_id = "bnb_peft" if needs_peft else "bnb"
    else:
        capability_keys = ["base"]
        if needs_peft:
            capability_keys.append("peft")
        profile_id = "base_peft" if needs_peft else "base"

    required_packages: List[str] = []
    for key in capability_keys:
        if key == "base":
            required_packages.extend(BASE_PACKAGES)
        elif key in PACKAGES_BY_CAPABILITY:
            for pkg in PACKAGES_BY_CAPABILITY[key]:
                if pkg not in required_packages:
                    required_packages.append(pkg)

    quant_for_env = "bnb" if needs_bnb else "base"

    # Multimodal: require vision stack so runtime preflight matches onboarding probe (parity).
    is_multimodal = _is_multimodal_config_static(str(model_path_obj))
    if is_multimodal:
        for pkg in ["Pillow", "timm", "einops", "open-clip-torch"]:
            if pkg not in required_packages:
                required_packages.append(pkg)

    return {
        "profile_id": profile_id,
        "required_packages": required_packages,
        "quant_for_env": quant_for_env,
        "needs_peft": needs_peft,
        "needs_bnb": needs_bnb,
        "is_gptq": is_gptq,
        "is_multimodal": is_multimodal,
        "notes": notes + list(req.get("notes", [])),
    }


def _is_multimodal_config_static(model_path_str: str) -> bool:
    """Return True if config.json indicates vision/multimodal model (no heavy imports)."""
    import json
    config_path = os.path.join(model_path_str, "config.json")
    if not os.path.isfile(config_path):
        return False
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
    except Exception:
        return False
    arch = config.get("architectures") or []
    model_type = (config.get("model_type") or "").lower()
    arch_str = " ".join(arch).lower()
    vision_hints = (
        "llava", "mllama", "qwen2vl", "qwen2_vl", "vision", "image", "vl",
        "llama3_2_vision", "llama3.2_vision", "idefics", "blip", "git", "pix2struct",
    )
    if any(h in model_type for h in vision_hints):
        return True
    if any(h in arch_str for h in vision_hints):
        return True
    return False


def get_runtime_required_packages(
    model_path: str,
    model_cfg: Optional[Dict[str, Any]] = None,
    adapter_dir: Optional[str] = None,
    model_id: Optional[str] = None,
) -> List[str]:
    """
    Return the exact list of package names required at runtime for this model.
    Use this in both onboarding (to ensure env has them) and runtime preflight (to fail fast if missing).
    """
    cap = resolve_capability(
        model_path=model_path,
        model_cfg=model_cfg,
        adapter_dir=adapter_dir,
        model_id=model_id,
    )
    return cap.get("required_packages", BASE_PACKAGES.copy())


def get_runtime_contract(profile_id: str) -> Dict[str, Any]:
    """
    Backend runtime contract for preflight/probe stages.
    """
    if profile_id == "llamacpp":
        return {
            "backend": "llamacpp",
            "required_imports": ["llama_cpp"],
            "requires_probe": True,
            "notes": ["GGUF runtime must load via llama_cpp primary backend or explicit fallback."],
        }
    if profile_id in ("gptq", "gptq_peft"):
        return {
            "backend": "transformers",
            "required_imports": ["transformers", "torch"],
            "requires_probe": True,
            "notes": ["Quantized GPTQ runtime requires compatible loader stack."],
        }
    if profile_id in ("awq", "awq_peft"):
        return {
            "backend": "transformers",
            "required_imports": ["transformers", "torch"],
            "requires_probe": True,
            "notes": ["AWQ runtime requires compatible quantization stack."],
        }
    return {
        "backend": "transformers",
        "required_imports": ["transformers", "torch", "tokenizers"],
        "requires_probe": True,
        "notes": ["Transformers runtime requires config/tokenizer/probe success."],
    }


def classify_runtime_failure(reason_code: Optional[str], error_message: Optional[str]) -> Dict[str, str]:
    """
    Normalize probe/startup failures into a stable category + repair action.
    """
    reason = (reason_code or "OTHER").strip().upper()
    msg = (error_message or "").strip()
    low = msg.lower()

    if reason == "RUNTIME_MISSING_COMPONENT":
        return {
            "category": "RUNTIME_MISSING_COMPONENT",
            "action": "Repair environment runtime components for selected backend, then retry.",
        }
    if reason == "MISSING_PACKAGE":
        return {
            "category": "RUNTIME_MISSING_COMPONENT",
            "action": "Install missing package(s) in the model environment and rerun onboarding.",
        }
    if reason == "UNSUPPORTED_ARCH":
        return {
            "category": "BACKEND_INCOMPATIBLE_MODEL",
            "action": "Switch backend/runtime path or use a compatible model variant.",
        }
    if "gguf_init_from_file" in low or "block size" in low:
        return {
            "category": "BACKEND_INCOMPATIBLE_MODEL",
            "action": "Selected GGUF variant is incompatible with available runtime backend. Try another variant or repair backend.",
        }
    if "no .gguf files found" in low or "missing shard" in low or "missing" in low and "model" in low:
        return {
            "category": "MODEL_FILE_CORRUPT",
            "action": "Repair/download model files and validate integrity before retrying.",
        }
    if "timeout" in low or "health check failed" in low:
        return {
            "category": "ENVIRONMENT_CORRUPT",
            "action": "Repair or recreate environment, then rerun onboarding.",
        }
    if "unauthenticated requests to the hf hub" in low or "401" in low or "403" in low:
        return {
            "category": "NETWORK_OR_AUTH",
            "action": "Set valid HF token/network access and retry onboarding.",
        }
    return {
        "category": "ENVIRONMENT_CORRUPT",
        "action": "Run repair/re-onboard for this model environment and review startup logs.",
    }


# Guardrails by model family: defaults for token caps and timeouts (configurable via env).
# Keys must match profile_id from resolve_capability. Env overrides applied in get_guardrail_max_tokens.
GUARDRAIL_DEFAULTS: Dict[str, Dict[str, int]] = {
    "base": {"max_new_tokens_text": 4096, "max_new_tokens_multimodal": 1024},
    "base_peft": {"max_new_tokens_text": 4096, "max_new_tokens_multimodal": 1024},
    "bnb": {"max_new_tokens_text": 4096, "max_new_tokens_multimodal": 1024},
    "bnb_peft": {"max_new_tokens_text": 4096, "max_new_tokens_multimodal": 1024},
    "gptq": {"max_new_tokens_text": 4096, "max_new_tokens_multimodal": 1024},
    "gptq_peft": {"max_new_tokens_text": 4096, "max_new_tokens_multimodal": 1024},
    "awq": {"max_new_tokens_text": 4096, "max_new_tokens_multimodal": 1024},
    "awq_peft": {"max_new_tokens_text": 4096, "max_new_tokens_multimodal": 1024},
    "llamacpp": {"max_new_tokens_text": 4096, "max_new_tokens_multimodal": 1024},
}


def get_guardrail_max_tokens(
    profile_id: str,
    is_multimodal: bool,
) -> int:
    """
    Per-family token cap for generation. Env LLM_MAX_NEW_TOKENS_TEXT / LLM_MAX_NEW_TOKENS_MULTIMODAL
    override the profile default when set.
    """
    key = "max_new_tokens_multimodal" if is_multimodal else "max_new_tokens_text"
    defaults = GUARDRAIL_DEFAULTS.get(profile_id) or GUARDRAIL_DEFAULTS.get("base", {})
    default_val = defaults.get(key, 1024 if is_multimodal else 4096)
    env_key = "LLM_MAX_NEW_TOKENS_MULTIMODAL" if is_multimodal else "LLM_MAX_NEW_TOKENS_TEXT"
    try:
        env_val = os.environ.get(env_key, "").strip()
        if env_val:
            return max(64, min(32768, int(env_val)))
    except (ValueError, TypeError):
        pass
    return max(64, min(32768, default_val))
