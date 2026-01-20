"""
PHASE 2: Environment Key Resolver
Maps model requirements to shared environment keys (e.g., "tf-cu121-t22-base").
Eliminates per-model environment explosion.
"""
from pathlib import Path
from typing import Optional, Dict, Any
import json
import logging
import re

logger = logging.getLogger(__name__)


def encode_torch_mm(version: str) -> str:
    """
    Encode torch major.minor version to compact format.
    
    Examples:
        "2.5.1+cu121" -> "25"
        "2.2.0" -> "22"
        "2.2" -> "22"
    
    Rule: take major.minor only, drop everything after + or additional dots.
    """
    if not version:
        return ""
    
    # Remove everything after + (build suffix)
    version = version.split("+")[0]
    
    # Extract major.minor
    parts = version.split(".")
    if len(parts) >= 2:
        major = parts[0]
        minor = parts[1]
        return f"{major}{minor}"
    elif len(parts) == 1:
        # Single number, assume it's major (e.g., "2" -> "20")
        return f"{parts[0]}0"
    
    return ""


def decode_torch_mm(encoded: str) -> str:
    """
    Decode compact torch version format to major.minor.
    
    Examples:
        "25" -> "2.5"
        "22" -> "2.2"
    """
    if not encoded:
        return None
    
    # Remove 't' prefix if present (from env key like "t22")
    encoded = encoded.lstrip("t")
    
    if len(encoded) >= 2:
        major = encoded[0]
        minor = encoded[1]
        return f"{major}.{minor}"
    
    return None


class EnvKeyResolver:
    """Resolves environment keys from model requirements and hardware profiles"""
    
    def __init__(self):
        """Initialize resolver with profile data"""
        self.llm_dir = Path(__file__).parent.parent.parent
        self.profile_cache: Dict[str, dict] = {}
    
    def get_active_profile_data(self) -> Optional[dict]:
        """Get active hardware profile data (CUDA version, torch build, etc.)"""
        try:
            from setup_state import SetupStateManager
            from system_detector import SystemDetector
            from core.profile_selector import ProfileSelector
            
            state = SetupStateManager()
            override_profile_id = state.get_selected_profile()
            selected_gpu_index = state.get_selected_gpu_index()
            
            detector = SystemDetector()
            hw_profile = detector.get_hardware_profile(selected_gpu_index=selected_gpu_index)
            
            matrix_path = self.llm_dir / "metadata" / "compatibility_matrix.json"
            selector = ProfileSelector(matrix_path)
            profile_id, _pkg_versions, _warnings, _binary_pkgs = selector.select_profile(
                hw_profile,
                override_profile_id=override_profile_id,
            )
            
            # Cache profile data
            if profile_id not in self.profile_cache:
                profile_path = self.llm_dir / "profiles" / f"{profile_id}.json"
                if profile_path.exists():
                    self.profile_cache[profile_id] = json.loads(profile_path.read_text(encoding="utf-8"))
            
            return self.profile_cache.get(profile_id)
        except Exception as e:
            logger.warning(f"Failed to get active profile: {e}")
            return None
    
    def _derive_accelerator(self, profile_data: Optional[dict]) -> str:
        """
        Derive accelerator from profile_data using priority order.
        
        Priority:
        1) If torch string contains +cu### → use that (cu###)
        2) Else if profile_data["torch_index"] contains cu### → use it
        3) Else if profile_data["cuda_version"] exists → map 12.1 → cu121
        4) Else fallback to "cpu"
        """
        if not profile_data:
            return "cpu"
        
        torch_spec = str(profile_data.get("packages", {}).get("torch", ""))
        torch_index = str(profile_data.get("torch_index", ""))
        cuda_version = profile_data.get("cuda_version")
        
        # Priority 1: torch string contains +cu###
        if "+cu" in torch_spec:
            cuda_part = torch_spec.split("+cu")[1]
            # Extract up to 3 digits (cu121, cu124, etc.)
            match = re.search(r'^(\d{1,3})', cuda_part)
            if match:
                return f"cu{match.group(1)}"
        
        # Priority 2: torch_index contains cu###
        if "/whl/cu" in torch_index:
            cuda_part = torch_index.split("/whl/cu")[1].split("/")[0]
            match = re.search(r'^(\d{1,3})', cuda_part)
            if match:
                return f"cu{match.group(1)}"
        
        # Priority 3: cuda_version exists → map 12.1 → cu121
        if cuda_version:
            # Convert "12.1" to "cu121"
            version_str = str(cuda_version).replace(".", "")
            if version_str.isdigit() and len(version_str) >= 2:
                return f"cu{version_str[:3]}"  # Take first 3 digits
        
        # Priority 4: fallback to cpu
        return "cpu"
    
    def _derive_torch_major_minor(self, profile_data: Optional[dict]) -> Optional[str]:
        """
        Derive torch major.minor from profile_data.
        
        Args:
            profile_data: Profile data dict
            
        Returns:
            Torch version as "2.2" or None
        """
        if not profile_data:
            return None
        
        torch_spec = str(profile_data.get("packages", {}).get("torch", ""))
        if not torch_spec:
            return None
        
        # Remove build suffix (everything after +)
        version = torch_spec.split("+")[0]
        
        # Extract major.minor
        parts = version.split(".")
        if len(parts) >= 2:
            return f"{parts[0]}.{parts[1]}"
        
        return None
    
    def resolve_env_key(
        self,
        backend: str,                 # "tf" | "vllm" | "llamacpp"
        accelerator: Optional[str] = None,  # "cu121" | "rocm61" | "mps" | "cpu"
        torch_major_minor: Optional[str] = None,   # "2.2"
        quant: Optional[str] = None,  # "base" | "bnb"
        profile_data: Optional[dict] = None
    ) -> str:
        """
        Resolve environment key from model requirements.
        
        Args:
            backend: Backend type ("tf" | "vllm" | "llamacpp")
            accelerator: Accelerator type (if None, derived from profile_data)
            torch_major_minor: Torch version as "2.2" (if None, derived from profile_data)
            quant: Quantization type "base" | "bnb" (defaults to "base")
            profile_data: Optional profile data (if None, auto-detected)
        
        Returns:
            Environment key string (e.g., "tf-cu121-t22-base")
        
        Examples:
            - tf-cu121-t22-base (transformers, CUDA 12.1, torch 2.2, no quant)
            - tf-cu121-t22-bnb (transformers, CUDA 12.1, torch 2.2, bitsandbytes)
            - vllm-cu121 (vLLM, CUDA 12.1, no torch version in name)
            - llamacpp-cpu (llama.cpp, CPU)
        """
        if profile_data is None:
            profile_data = self.get_active_profile_data()
        
        # Derive accelerator if not provided
        if accelerator is None:
            accelerator = self._derive_accelerator(profile_data)
        
        # Handle backend-specific formats
        if backend == "vllm":
            # vLLM: vllm-<accelerator> (no torch token)
            return f"vllm-{accelerator}"
        
        if backend == "llamacpp":
            # llama.cpp: llamacpp-<accelerator_or_cpu>
            if accelerator == "cpu":
                return "llamacpp-cpu"
            return f"llamacpp-{accelerator}"
        
        # Transformers (tf): tf-<accelerator>-t<mm>-<quant>
        # Derive torch_major_minor if not provided
        if torch_major_minor is None:
            torch_major_minor = self._derive_torch_major_minor(profile_data)
        
        # Default quant to "base"
        if quant is None:
            quant = "base"
        
        # Encode torch version
        torch_encoded = encode_torch_mm(torch_major_minor) if torch_major_minor else ""
        
        if torch_encoded:
            env_key = f"tf-{accelerator}-t{torch_encoded}-{quant}"
        else:
            # Fallback if torch version unknown
            env_key = f"tf-{accelerator}-{quant}"
        
        logger.debug(f"Resolved env_key: {env_key} (backend={backend}, accelerator={accelerator}, torch={torch_major_minor}, quant={quant})")
        return env_key
    
    def parse_env_key(self, env_key: str) -> Dict[str, Any]:
        """
        Parse environment key back into components (supports old + new formats).
        
        Args:
            env_key: Environment key string (old or new format)
        
        Returns:
            Normalized dict with:
            - backend: "tf" | "vllm" | "llamacpp"
            - accelerator: "cu121" | "rocm61" | "mps" | "cpu"
            - torch_mm: "2.2" | None (decoded)
            - quant: "base" | "bnb" | None
        
        Examples:
            parse_env_key("torch-cu121-transformers-bnb") ->
            {"backend": "tf", "accelerator": "cu121", "torch_mm": None, "quant": "bnb"}
            
            parse_env_key("tf-cu121-t22-bnb") ->
            {"backend": "tf", "accelerator": "cu121", "torch_mm": "2.2", "quant": "bnb"}
        """
        parts = env_key.split("-")
        
        result = {
            "backend": "unknown",
            "accelerator": "cpu",
            "torch_mm": None,
            "quant": None
        }
        
        # Detect format: old (torch-*-transformers-*) or new (tf-* or vllm-* or llamacpp-*)
        is_old_format = "torch" in parts and "transformers" in parts
        
        if is_old_format:
            # Old format: torch-cu121-transformers-bnb or torch-cu121-transformers
            # Normalize to new format
            result["backend"] = "tf"
            
            # Extract accelerator
            for p in parts:
                if p.startswith("cu") or p.startswith("rocm") or p == "mps" or p == "cpu":
                    result["accelerator"] = p
                    break
            
            # Extract quant
            if "bnb" in parts:
                result["quant"] = "bnb"
            else:
                # Old transformers without bnb → base
                result["quant"] = "base"
            
            # torch_mm: None for old keys
            # If env metadata/profile exists, would use profile_data["packages"]["torch"] and convert to major.minor
            # For now, set to None - compatibility check does not reject on torch_mm
            result["torch_mm"] = None
            
        else:
            # New format: tf-cu121-t22-base, vllm-cu121, llamacpp-cpu
            if "llamacpp" in parts:
                result["backend"] = "llamacpp"
            elif "vllm" in parts:
                result["backend"] = "vllm"
            elif "tf" in parts:
                result["backend"] = "tf"
            
            # Extract accelerator
            for p in parts:
                if p.startswith("cu") or p.startswith("rocm") or p == "mps" or p == "cpu":
                    result["accelerator"] = p
                    break
            
            # Extract torch_mm (encoded as t22, t25, etc.)
            for p in parts:
                if p.startswith("t") and len(p) > 1 and p[1:].isdigit():
                    # Decode: t22 -> "2.2"
                    decoded = decode_torch_mm(p)
                    result["torch_mm"] = decoded
                    break
            
            # Extract quant
            if "bnb" in parts:
                result["quant"] = "bnb"
            elif "base" in parts:
                result["quant"] = "base"
            else:
                # Default to base if not specified
                result["quant"] = "base"
        
        return result
    
    def get_env_key_display_name(self, env_key: str) -> str:
        """
        Get human-readable name for environment key.
        
        Args:
            env_key: Environment key
        
        Returns:
            Display name
        
        Example:
            "torch-cu121-transformers-bnb" -> "Transformers + Quantization (CUDA 12.1)"
        """
        info = self.parse_env_key(env_key)
        
        # Build display name
        parts = []
        
        if info["backend"] == "transformers":
            parts.append("Transformers")
            if info["quantization"]:
                parts.append("+ Quantization")
        elif info["backend"] == "vllm":
            parts.append("vLLM")
        elif info["backend"] == "llamacpp":
            parts.append("llama.cpp")
        else:
            parts.append(info["backend"].title())
        
        # Add CUDA info
        cuda = info["cuda"]
        if cuda != "cpu":
            cuda_ver = cuda.replace("cu", "")
            if len(cuda_ver) == 3:
                # "121" -> "12.1"
                cuda_display = f"{cuda_ver[0:2]}.{cuda_ver[2]}"
            else:
                cuda_display = cuda_ver
            parts.append(f"(CUDA {cuda_display})")
        else:
            parts.append("(CPU)")
        
        return " ".join(parts)
