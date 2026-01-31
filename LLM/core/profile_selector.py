#!/usr/bin/env python3
"""
Profile Selector - Automatically selects package profile based on hardware
Part of the Hardware-Adaptive Installer system
"""

import json
from pathlib import Path
from typing import Dict, Optional, Tuple


class ProfileSelector:
    """
    Selects optimal package version profile based on detected hardware.
    Uses compatibility matrix to match hardware to tested package combinations.
    """
    
    def __init__(self, matrix_path: Path):
        """
        Initialize profile selector with compatibility matrix.
        
        Args:
            matrix_path: Path to compatibility_matrix.json
        """
        with open(matrix_path, 'r', encoding='utf-8') as f:
            self.matrix = json.load(f)
        
        self.profiles = self.matrix["profiles"]
        self.fallback_rules = self.matrix["fallback_rules"]
        # Support both field names for backwards compatibility
        self.compute_map = self.matrix.get("compute_capability_map") or self.matrix.get("compute_capability_to_profile", {})
        self.cuda_map = self.matrix.get("cuda_version_map", {})
        self.common_packages = self.matrix.get("common_packages", {})
    
    def select_profile(self, hardware_profile: Dict, override_profile_id: Optional[str] = None) -> Tuple[str, Dict, list, Dict]:
        """
        Select best profile for the given hardware.
        
        Args:
            hardware_profile: Hardware info from SystemDetector.get_hardware_profile()
            override_profile_id: Optional profile ID to use instead of auto-selection (from user selection)
        
        Returns:
            Tuple of (profile_name, package_versions, warnings, binary_packages)
        """
        warnings = []
        
        # If user has explicitly selected a profile, use it (but validate it exists)
        if override_profile_id:
            if override_profile_id in self.profiles:
                print(f"[PROFILE] Using user-selected profile: '{override_profile_id}'")
                package_versions = self._get_package_versions(override_profile_id)
                binary_packages = self._get_binary_packages(override_profile_id)
                return override_profile_id, package_versions, warnings, binary_packages
            else:
                warnings.append(f"User-selected profile '{override_profile_id}' not found in matrix, falling back to auto-selection")
                print(f"[PROFILE] WARNING: Selected profile '{override_profile_id}' not found, using auto-selection")
        
        # Extract key hardware attributes
        cuda_version = hardware_profile.get("cuda_version")
        compute_cap = hardware_profile.get("compute_capability")
        vram_gb = hardware_profile.get("vram_gb", 0)
        gpu_model = hardware_profile.get("gpu_model", "unknown")
        gpu_count = hardware_profile.get("gpu_count", 0)
        
        # Check for blocking conditions
        if vram_gb > 0 and vram_gb < self.fallback_rules["very_low_vram"]["threshold_gb"]:
            raise ValueError(
                f"GPU VRAM ({vram_gb}GB) is below minimum requirement "
                f"({self.fallback_rules['very_low_vram']['threshold_gb']}GB). "
                f"{self.fallback_rules['very_low_vram']['message']}"
            )
        
        # Warning for low VRAM
        if vram_gb > 0 and vram_gb < self.fallback_rules["low_vram"]["threshold_gb"]:
            warnings.append(self.fallback_rules["low_vram"]["message"])
        
        # Handle mixed GPUs
        if gpu_count > 1:
            all_gpus = hardware_profile.get("all_gpus", [])
            if self._has_mixed_capabilities(all_gpus):
                warnings.append(self.fallback_rules["mixed_gpus"]["message"])
                # Use the lowest compute capability GPU
                compute_cap = min(
                    float(gpu.get("compute_capability", "0")) 
                    for gpu in all_gpus 
                    if gpu.get("compute_capability")
                )
        
        # Primary selection: by compute capability
        selected_profile = None
        if compute_cap:
            compute_cap_str = str(float(compute_cap))
            if compute_cap_str in self.compute_map:
                profile_name = self.compute_map[compute_cap_str]["profile"]
                selected_profile = profile_name
                print(f"[PROFILE] Selected '{profile_name}' based on compute capability {compute_cap}")
            else:
                # Find closest compute capability
                closest = self._find_closest_compute_cap(float(compute_cap))
                if closest:
                    profile_name = self.compute_map[closest]["profile"]
                    selected_profile = profile_name
                    warnings.append(
                        f"Exact compute capability {compute_cap} not in matrix. "
                        f"Using closest: {closest} ({self.compute_map[closest]['architecture']})"
                    )
                    print(f"[PROFILE] Using closest profile '{profile_name}' for compute {compute_cap}")
        
        # Fallback: Detect by GPU model name if compute capability is missing
        if not selected_profile and gpu_model and gpu_model != "unknown":
            gpu_lower = gpu_model.lower()
            # RTX 50 series (Blackwell)
            if any(x in gpu_lower for x in ["rtx 5090", "rtx 5080", "rtx 5070", "rtx 5060"]):
                selected_profile = "cuda124_ampere_ada_blackwell"
                warnings.append(f"Detected {gpu_model} - using RTX 50 series profile")
                print(f"[PROFILE] Selected '{selected_profile}' based on GPU model name")
            # RTX 40 series (Ada Lovelace)
            elif any(x in gpu_lower for x in ["rtx 4090", "rtx 4080", "rtx 4070", "rtx 4060"]):
                selected_profile = "cuda124_ampere_ada_blackwell"
                warnings.append(f"Detected {gpu_model} - using RTX 40 series profile")
                print(f"[PROFILE] Selected '{selected_profile}' based on GPU model name")
            # RTX 30 series (Ampere)
            elif any(x in gpu_lower for x in ["rtx 3090", "rtx 3080", "rtx 3070", "rtx 3060"]):
                selected_profile = "cuda121_ampere"
                warnings.append(f"Detected {gpu_model} - using RTX 30 series profile")
                print(f"[PROFILE] Selected '{selected_profile}' based on GPU model name")
            # RTX 20 series (Turing) + T-series Quadro
            elif any(x in gpu_lower for x in ["rtx 2080", "rtx 2070", "rtx 2060", "t1000", "t600", "t400", "quadro t"]):
                selected_profile = "cuda118_turing"
                warnings.append(f"Detected {gpu_model} - using RTX 20 series / Quadro T profile")
                print(f"[PROFILE] Selected '{selected_profile}' based on GPU model name")
            # A-series workstation
            elif any(x in gpu_lower for x in ["a100", "a30", "a10", "a6000", "a5000", "a4000", "a2000"]):
                selected_profile = "cuda121_ampere"
                warnings.append(f"Detected {gpu_model} - using Ampere workstation profile")
                print(f"[PROFILE] Selected '{selected_profile}' based on GPU model name")
        
        # Secondary selection: by CUDA version
        if not selected_profile and cuda_version:
            # Try exact match
            cuda_short = self._cuda_to_short_version(cuda_version)
            if cuda_short in self.cuda_map:
                selected_profile = self.cuda_map[cuda_short]
                print(f"[PROFILE] Selected '{selected_profile}' based on CUDA {cuda_version}")
            else:
                # Find closest CUDA version
                closest_cuda = self._find_closest_cuda_version(cuda_short)
                if closest_cuda:
                    selected_profile = self.cuda_map[closest_cuda]
                    warnings.append(
                        f"CUDA {cuda_version} not in matrix. Using profile for CUDA {closest_cuda}"
                    )
                    print(f"[PROFILE] Using profile '{selected_profile}' for closest CUDA {closest_cuda}")
        
        # Fallback to default
        if not selected_profile:
            # Try "unknown_gpu" first, then "unknown_older_gpu" as safest fallback
            fallback_rule = self.fallback_rules.get("unknown_gpu") or self.fallback_rules.get("unknown_older_gpu")
            selected_profile = fallback_rule["profile"]
            warnings.append(
                f"Could not determine optimal profile for {gpu_model}. "
                f"Using fallback: {selected_profile}. "
                f"Reason: {fallback_rule['reason']}"
            )
            print(f"[PROFILE] Using fallback profile '{selected_profile}'")
        
        # Get package versions
        package_versions = self._get_package_versions(selected_profile)
        
        # Get binary packages
        binary_packages = self._get_binary_packages(selected_profile)
        
        return selected_profile, package_versions, warnings, binary_packages
    
    def _has_mixed_capabilities(self, gpus: list) -> bool:
        """Check if GPUs have different compute capabilities"""
        capabilities = [gpu.get("compute_capability") for gpu in gpus if gpu.get("compute_capability")]
        return len(set(capabilities)) > 1
    
    def _find_closest_compute_cap(self, target: float) -> Optional[str]:
        """Find closest compute capability in matrix"""
        capabilities = [float(cap) for cap in self.compute_map.keys()]
        if not capabilities:
            return None
        
        # Find closest that is <= target (safer to use older profile)
        valid = [cap for cap in capabilities if cap <= target]
        if valid:
            return str(max(valid))
        
        # If target is older than any in matrix, use oldest
        return str(min(capabilities))
    
    def _cuda_to_short_version(self, cuda_version: str) -> str:
        """Convert CUDA version like '12.4.0' to '12.4'"""
        parts = str(cuda_version).split('.')
        return '.'.join(parts[:2]) if len(parts) >= 2 else str(cuda_version)
    
    def _find_closest_cuda_version(self, target: str) -> Optional[str]:
        """Find closest CUDA version in matrix"""
        try:
            target_float = float(target)
            versions = {float(v): v for v in self.cuda_map.keys()}
            if not versions:
                return None
            
            # Find closest that is <= target
            valid = [v for v in versions.keys() if v <= target_float]
            if valid:
                closest = max(valid)
                return versions[closest]
            
            # If target is older, use oldest in matrix
            return versions[min(versions.keys())]
        except:
            return None
    
    def _get_package_versions(self, profile_name: str) -> Dict[str, str]:
        """
        Get complete package version dictionary for a profile.
        Profile JSON files are the single source of truth. We load packages from
        `LLM/profiles/<profile_name>.json` and then fill missing entries from
        compatibility_matrix common_packages (without overriding profile pins).
        
        Returns:
            Dict of {package_name: exact_version}
        """
        if profile_name not in self.profiles:
            raise ValueError(f"Profile '{profile_name}' not found in compatibility matrix")
        
        # Prefer loading from the profile JSON file (source of truth).
        versions: Dict[str, str] = {}
        try:
            llm_dir = Path(__file__).parent.parent
            profile_path = llm_dir / "profiles" / f"{profile_name}.json"
            if profile_path.exists():
                data = json.loads(profile_path.read_text(encoding="utf-8"))
                versions = dict(data.get("packages", {}) or {})
        except Exception:
            # Fall back to matrix packages if profile JSON can't be read.
            profile = self.profiles[profile_name]
            versions = dict(profile.get("packages", {}) or {})

        # Fill missing keys from common packages without overriding profile pins.
        for k, v in (self.common_packages or {}).items():
            if k not in versions:
                versions[k] = v

        return versions
    
    def _get_binary_packages(self, profile_name: str) -> Dict[str, Dict]:
        """
        Get binary packages dictionary for a profile.
        
        Returns:
            Dict of {package_name: {type, python, url}}
        """
        if profile_name not in self.profiles:
            raise ValueError(f"Profile '{profile_name}' not found in compatibility matrix")
        
        # Prefer profile JSON file (source of truth).
        try:
            llm_dir = Path(__file__).parent.parent
            profile_path = llm_dir / "profiles" / f"{profile_name}.json"
            if profile_path.exists():
                data = json.loads(profile_path.read_text(encoding="utf-8"))
                bp = data.get("binary_packages", {})
                return bp if isinstance(bp, dict) else {}
        except Exception:
            pass

        profile = self.profiles[profile_name]
        return profile.get("binary_packages", {}) or {}
    
    def get_profile_description(self, profile_name: str) -> str:
        """Get human-readable description of a profile"""
        if profile_name in self.profiles:
            return self.profiles[profile_name]["description"]
        return "Unknown profile"
    
    def list_available_profiles(self) -> list:
        """List all available profiles with descriptions"""
        return [
            {
                "name": name,
                "description": profile["description"],
                "hardware": profile.get("hardware", {})
            }
            for name, profile in self.profiles.items()
        ]

