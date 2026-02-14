"""
Model Requirement Detector
Detects model requirements from config files and structure to determine environment needs.
"""
from pathlib import Path
from typing import Optional, Dict, Any, List
import json
import os
import logging

logger = logging.getLogger(__name__)


def detect_model_requirements(model_path: str, adapter_dir: Optional[str] = None) -> Dict[str, Any]:
    """
    Detect model requirements from config files and structure.
    
    Returns:
      {
        "backend_required": None | "llamacpp",
        "quantization": "none" | "bnb" | "gptq" | "awq" | "gguf" | "other",
        "needs_bnb": bool,                    # True ONLY when bnb is required
        "notes": List[str]                    # decision trace
      }
    """
    notes: List[str] = []
    model_path_obj = Path(model_path)
    
    # Step A: Load config.json if exists
    config = None
    config_path = model_path_obj / "config.json"
    if config_path.exists():
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
            notes.append("loaded config.json")
        except Exception as e:
            logger.warning(f"Failed to load config.json from {model_path}: {e}")
            notes.append(f"config.json exists but failed to load: {e}")
    
    # Step B: GGUF detection by filesystem
    if _has_gguf_files(model_path_obj) or (adapter_dir and _has_gguf_files(Path(adapter_dir))):
        notes.append("detected gguf files")
        return {
            "backend_required": "llamacpp",
            "quantization": "gguf",
            "needs_bnb": False,
            "runtime_contract": "llamacpp",
            "notes": notes
        }
    
    # Step C: GPTQ/AWQ detection (already quantized)
    gptq_awq_result = _detect_gptq_awq(model_path_obj, config, adapter_dir, notes)
    if gptq_awq_result:
        return gptq_awq_result
    
    # Step D: bnb detection (ONLY for transformers 4/8-bit)
    # Only if GPTQ/AWQ not detected
    bnb_result = _detect_bnb_requirement(model_path_obj, config, adapter_dir, notes)
    if bnb_result:
        return bnb_result
    
    # Default
    notes.append("default: no special requirements")
    return {
        "backend_required": None,
        "quantization": "none",
        "needs_bnb": False,
        "runtime_contract": "transformers",
        "notes": notes
    }


def _has_gguf_files(path: Path) -> bool:
    """Check if directory contains any .gguf files"""
    if not path.exists() or not path.is_dir():
        return False
    try:
        for item in path.iterdir():
            if item.is_file() and item.suffix == ".gguf":
                return True
            if item.is_dir():
                # Recursively check subdirectories (but limit depth to avoid deep scans)
                if _has_gguf_files(item):
                    return True
    except Exception:
        pass
    return False


def _detect_gptq_awq(model_path: Path, config: Optional[dict], adapter_dir: Optional[str], notes: List[str]) -> Optional[Dict[str, Any]]:
    """Detect GPTQ/AWQ quantization (already quantized, does not need bnb)"""
    quant_method = None
    
    # Check config.json quantization_config.quant_method
    if config:
        quant_config = config.get("quantization_config", {})
        if isinstance(quant_config, dict):
            quant_method = quant_config.get("quant_method", "").lower()
            if quant_method in ("gptq", "awq"):
                notes.append(f"detected {quant_method} via config.json.quantization_config.quant_method")
                return {
                    "backend_required": None,
                    "quantization": quant_method,
                    "needs_bnb": False,
                    "runtime_contract": "transformers",
                    "notes": notes
                }
    
    # Check filenames: contains gptq or awq
    model_name_lower = model_path.name.lower()
    if "gptq" in model_name_lower:
        notes.append("detected gptq via filename")
        return {
            "backend_required": None,
            "quantization": "gptq",
            "needs_bnb": False,
            "runtime_contract": "transformers",
            "notes": notes
        }
    if "awq" in model_name_lower:
        notes.append("detected awq via filename")
        return {
            "backend_required": None,
            "quantization": "awq",
            "needs_bnb": False,
            "runtime_contract": "transformers",
            "notes": notes
        }
    
    # Check weight files in model directory
    if model_path.exists() and model_path.is_dir():
        try:
            for item in model_path.iterdir():
                if item.is_file():
                    name_lower = item.name.lower()
                    if "gptq" in name_lower:
                        notes.append("detected gptq via weight filename")
                        return {
                            "backend_required": None,
                            "quantization": "gptq",
                            "needs_bnb": False,
                            "runtime_contract": "transformers",
                            "notes": notes
                        }
                    if "awq" in name_lower:
                        notes.append("detected awq via weight filename")
                        return {
                            "backend_required": None,
                            "quantization": "awq",
                            "needs_bnb": False,
                            "runtime_contract": "transformers",
                            "notes": notes
                        }
        except Exception:
            pass
    
    return None


def _detect_bnb_requirement(model_path: Path, config: Optional[dict], adapter_dir: Optional[str], notes: List[str]) -> Optional[Dict[str, Any]]:
    """Detect if bitsandbytes is needed (ONLY for transformers 4/8-bit runtime quantization)"""
    
    # Check config.json quantization_config for bnb indicators
    if config:
        quant_config = config.get("quantization_config", {})
        if isinstance(quant_config, dict):
            # Check quant_method first - if it's gptq/awq, we should have caught it earlier, but double-check
            quant_method = quant_config.get("quant_method", "").lower()
            if quant_method in ("gptq", "awq"):
                # Should not reach here, but safety check
                return None
            
            # Check for bnb-specific indicators
            if quant_method and ("bnb" in quant_method or "bitsandbytes" in quant_method):
                notes.append("detected bnb via config.json.quantization_config.quant_method")
                return {
                    "backend_required": None,
                    "quantization": "bnb",
                    "needs_bnb": True,
                    "runtime_contract": "transformers",
                    "notes": notes
                }
            
            # Check load_in_4bit or load_in_8bit
            if quant_config.get("load_in_4bit") is True or quant_config.get("load_in_8bit") is True:
                notes.append("detected bnb via config.json.quantization_config.load_in_4bit/8bit")
                return {
                    "backend_required": None,
                    "quantization": "bnb",
                    "needs_bnb": True,
                    "runtime_contract": "transformers",
                    "notes": notes
                }
            
            # Check for bnb_4bit_* keys
            if any(key.startswith("bnb_4bit_") for key in quant_config.keys()):
                notes.append("detected bnb via config.json.quantization_config.bnb_4bit_* keys")
                return {
                    "backend_required": None,
                    "quantization": "bnb",
                    "needs_bnb": True,
                    "runtime_contract": "transformers",
                    "notes": notes
                }
    
    # Check model directory name tokens: bnb, bitsandbytes, nf4
    model_name_lower = model_path.name.lower()
    if any(token in model_name_lower for token in ["bnb", "bitsandbytes", "nf4"]):
        notes.append(f"detected bnb via model directory name: {model_path.name}")
        return {
            "backend_required": None,
            "quantization": "bnb",
            "needs_bnb": True,
            "runtime_contract": "transformers",
            "notes": notes
        }
    
    # Check adapter config (PEFT) metadata if present
    if adapter_dir:
        adapter_path = Path(adapter_dir)
        adapter_config_path = adapter_path / "adapter_config.json"
        if adapter_config_path.exists():
            try:
                with open(adapter_config_path, 'r', encoding='utf-8') as f:
                    adapter_config = json.load(f)
                
                # Check if adapter indicates 4-bit base
                base_model_config = adapter_config.get("base_model_config", {})
                if isinstance(base_model_config, dict):
                    quant_config = base_model_config.get("quantization_config", {})
                    if isinstance(quant_config, dict):
                        if quant_config.get("load_in_4bit") is True or quant_config.get("load_in_8bit") is True:
                            notes.append("detected bnb via adapter_config.json base_model_config.quantization_config")
                            return {
                                "backend_required": None,
                                "quantization": "bnb",
                                "needs_bnb": True,
                                "runtime_contract": "transformers",
                                "notes": notes
                            }
            except Exception as e:
                logger.debug(f"Could not read adapter_config.json: {e}")
    
    return None
