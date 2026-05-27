"""Model VRAM requirements estimation and GPU compatibility checking"""
from __future__ import annotations
import re
from typing import Optional, Tuple, Dict


def estimate_model_vram(model_id: str, model_name: Optional[str] = None) -> Optional[float]:
    """
    Estimate VRAM requirements for a model based on parameter count and quantization.
    
    Args:
        model_id: HuggingFace model ID (e.g., "unsloth/Llama-3.3-70B-Instruct-bnb-4bit")
        model_name: Optional model name for additional parsing
        
    Returns:
        Estimated VRAM in GB, or None if cannot determine
    """
    # Combine model_id and model_name for parsing
    search_text = (model_id + " " + (model_name or "")).lower()
    
    # Extract parameter count (e.g., "70B", "7B", "32B", "405B", "1B", "2B")
    param_match = re.search(r'(\d+(?:\.\d+)?)\s*b', search_text)
    if not param_match:
        # Try alternative patterns like "70-b", "70b" without space
        param_match = re.search(r'(\d+(?:\.\d+)?)[-_\s]?b(?:it)?', search_text)
    
    if not param_match:
        return None
    
    try:
        params_b = float(param_match.group(1))
    except (ValueError, AttributeError):
        return None
    
    # Detect quantization type
    # 4-bit formats: BitsAndBytes, GPTQ, AWQ, INT4, Q4, etc.
    is_4bit = any(keyword in search_text for keyword in [
        "4-bit", "4bit", "bnb-4bit", "bnb4bit", "q4", "4b",
        "int4", "gptq", "awq", "gptq-int4", "awq-4bit"
    ])
    # 8-bit formats
    is_8bit = any(keyword in search_text for keyword in [
        "8-bit", "8bit", "bnb-8bit", "bnb8bit", "q8", "8b", "int8"
    ])
    is_fp16 = any(keyword in search_text for keyword in ["fp16", "float16", "half"])
    is_bf16 = any(keyword in search_text for keyword in ["bf16", "bfloat16"])
    is_fp32 = any(keyword in search_text for keyword in ["fp32", "float32", "float"])
    
    # VRAM multipliers per billion parameters (approximate)
    # These account for model weights + KV cache + activations
    if is_4bit:
        multiplier = 0.5  # ~0.5 GB per billion params for 4-bit
    elif is_8bit:
        multiplier = 1.0  # ~1 GB per billion params for 8-bit
    elif is_fp16 or is_bf16:
        multiplier = 2.0  # ~2 GB per billion params for FP16/BF16
    elif is_fp32:
        multiplier = 4.0  # ~4 GB per billion params for FP32
    else:
        # Default: assume 4-bit if model name contains "bnb" or "unsloth" (common pattern)
        if "bnb" in search_text or "unsloth" in search_text:
            multiplier = 0.5
        else:
            # Conservative default: assume FP16
            multiplier = 2.0
    
    # Base VRAM = params * multiplier
    base_vram = params_b * multiplier
    
    # Add overhead for KV cache, activations, and system
    # For inference: ~2GB overhead
    # For fine-tuning: additional ~4-8GB overhead (we'll use inference estimate here)
    overhead = 2.0
    
    # Check if vision/multimodal (add 20% overhead)
    is_vision = any(keyword in search_text for keyword in ["vision", "vl", "multimodal", "llava", "clip", "visual"])
    if is_vision:
        overhead *= 1.2
    
    total_vram = base_vram + overhead
    
    return round(total_vram, 1)


def get_compatibility_rating(model_vram_gb: float, user_vram_gb: float) -> Tuple[str, str]:
    """
    Get compatibility rating (green/orange/red) based on model VRAM vs user GPU VRAM.
    
    Conservative thresholds for 24GB GPU:
    - RED: >20GB required (cannot inference)
    - ORANGE: 12-20GB required (can inference but difficult/impossible to fine-tune)
    - GREEN: <12GB required (can both inference and fine-tune)
    
    Args:
        model_vram_gb: Estimated VRAM required by model
        user_vram_gb: Available VRAM on user's GPU
        
    Returns:
        Tuple of (color, message) where color is "green", "orange", or "red"
    """
    if model_vram_gb > user_vram_gb * 0.83:  # >83% of VRAM = >20GB for 24GB GPU
        return ("red", f"✗ Too Large ({model_vram_gb:.1f}GB required)")
    elif model_vram_gb > user_vram_gb * 0.5:  # >50% of VRAM = >12GB for 24GB GPU
        return ("orange", f"⚠ Inference Only ({model_vram_gb:.1f}GB required)")
    else:  # <50% of VRAM = <12GB for 24GB GPU
        return ("green", f"✓ Good for {int(user_vram_gb)}GB ({model_vram_gb:.1f}GB required)")


def get_model_compatibility_badge(model_id: str, model_name: Optional[str], user_vram_gb: float) -> Optional[Dict[str, str]]:
    """
    Get compatibility badge info for a model card.
    
    Args:
        model_id: HuggingFace model ID
        model_name: Optional model name
        user_vram_gb: User's GPU VRAM in GB
        
    Returns:
        Dict with 'color', 'text', and 'tooltip' keys, or None if cannot determine
    """
    model_vram = estimate_model_vram(model_id, model_name)
    
    if model_vram is None:
        return None
    
    color, message = get_compatibility_rating(model_vram, user_vram_gb)
    
    # Create tooltip with more details
    tooltip = f"Model requires ~{model_vram:.1f}GB VRAM. Your GPU has {user_vram_gb:.1f}GB."
    if color == "red":
        tooltip += " This model is too large to run on your GPU."
    elif color == "orange":
        tooltip += " This model can run for inference but may struggle with fine-tuning."
    else:
        tooltip += " This model should work well for both inference and fine-tuning."
    
    return {
        "color": color,
        "text": message,
        "tooltip": tooltip
    }
