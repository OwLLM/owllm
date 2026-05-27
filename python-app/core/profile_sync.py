"""
Profile synchronization utility.

Treats the JSON files under `LLM/profiles/` as the single source of truth
and generates the derived artifacts used throughout the app:
- `metadata/compatibility_matrix.json`
- `metadata/dependencies.json`
- `metadata/hardware_profiles/*.json`
- `requirements.txt`

Usage:
    python -m core.profile_sync generate   # regenerate all derived files
    python -m core.profile_sync check      # verify derived files are up-to-date
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

ROOT = Path(__file__).resolve().parent.parent
PROFILES_DIR = ROOT / "profiles"
HARDWARE_PROFILES_DIR = ROOT / "metadata" / "hardware_profiles"
COMPAT_MATRIX_PATH = ROOT / "metadata" / "compatibility_matrix.json"
DEPENDENCIES_PATH = ROOT / "metadata" / "dependencies.json"
REQUIREMENTS_PATH = ROOT / "requirements.txt"


@dataclass
class Profile:
    profile_id: str
    data: dict
    path: Path


REQUIRED_KEYS = {
    "format_version",
    "architecture",
    "cuda_version",
    "profile_id",
    "description",
    "torch_index",
    "hardware",
    "packages",
}


def load_profiles() -> List[Profile]:
    profiles: List[Profile] = []
    for path in sorted(PROFILES_DIR.glob("*.json")):
        if path.name.lower() == "README.md".lower():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        missing = REQUIRED_KEYS - set(data.keys())
        if missing:
            raise ValueError(f"Profile {path.name} missing keys: {sorted(missing)}")
        profiles.append(Profile(profile_id=data["profile_id"], data=data, path=path))
    if not profiles:
        raise RuntimeError("No profiles found in profiles directory")
    return profiles


def compute_common_packages(profiles: List[Profile]) -> Dict[str, str]:
    """
    Find packages that have the exact same version across all profiles.
    """
    if not profiles:
        return {}
    common = dict(profiles[0].data["packages"])
    for prof in profiles[1:]:
        keys_to_remove = []
        for pkg, ver in common.items():
            if pkg not in prof.data["packages"] or prof.data["packages"][pkg] != ver:
                keys_to_remove.append(pkg)
        for k in keys_to_remove:
            common.pop(k, None)
    return common


def normalize_cuda_version(cuda_version: str) -> str:
    """
    Convert cuda_version like '12.4' to key 'cu124'.
    """
    parts = cuda_version.strip().split(".")
    if len(parts) >= 2:
        return f"cu{parts[0]}{parts[1]}"
    return f"cu{parts[0]}"


def build_compute_capability_map(profiles: List[Profile]) -> Dict[str, dict]:
    """
    Map compute capability string -> profile choice.
    If multiple profiles list the same capability, prefer the one with the highest CUDA version.
    """
    def cuda_numeric(p: Profile) -> float:
        try:
            return float(p.data.get("cuda_version", "0").replace("+", ""))
        except Exception:
            return 0.0

    profiles_sorted = sorted(profiles, key=cuda_numeric, reverse=True)
    mapping: Dict[str, dict] = {}
    for prof in profiles_sorted:
        arch = prof.data.get("architecture", "unknown")
        for cap in prof.data.get("hardware", {}).get("compute_capability", []):
            cap_str = str(cap)
            if cap_str not in mapping:
                mapping[cap_str] = {"architecture": arch.capitalize(), "profile": prof.profile_id}
    return mapping


def build_compatibility_matrix(profiles: List[Profile], template: dict | None) -> dict:
    common_pkgs = compute_common_packages(profiles)
    matrix_profiles = {}
    for prof in profiles:
        # copy packages but drop common ones to keep matrix concise
        packages = dict(prof.data["packages"])
        for k in common_pkgs.keys():
            packages.pop(k, None)
        matrix_profiles[prof.profile_id] = {
            "description": prof.data.get("description", ""),
            "hardware": prof.data.get("hardware", {}),
            "packages": packages,
            "tested": prof.data.get("tested", False),
            "tested_on": prof.data.get("tested_on", []),
            "notes": prof.data.get("notes", ""),
            "binary_packages": prof.data.get("binary_packages", {}),
        }

    return {
        "format_version": "1.0",
        "description": (template or {}).get(
            "description",
            "Generated from profiles in LLM/profiles (single source of truth).",
        ),
        "profiles": matrix_profiles,
        "fallback_rules": (template or {}).get("fallback_rules", {}),
        "compute_capability_map": build_compute_capability_map(profiles),
        "common_packages": common_pkgs,
        "blacklist": (template or {}).get("blacklist", {"packages": [], "reason": ""}),
        "unsupported": (template or {}).get("unsupported", {}),
    }


def build_dependencies_manifest(profiles: List[Profile], template: dict | None) -> dict:
    template = template or {}
    # Pick the first profile as default for requirements generation
    default_profile = profiles[0]
    pkgs = default_profile.data["packages"]

    # Build CUDA configs from profiles
    cuda_configs = {}
    for prof in profiles:
        cuda_key = normalize_cuda_version(prof.data["cuda_version"])
        if cuda_key in cuda_configs:
            continue
        torch_index = prof.data.get("torch_index")
        cuda_configs[cuda_key] = {
            "cuda_driver_min": prof.data.get("cuda_version"),
            "torch_index": torch_index,
            "packages": {
                k: v
                for k, v in prof.data["packages"].items()
                if k in ("torch", "torchvision", "torchaudio")
            },
        }

    core_dependencies = []
    critical_pkgs = {
        "torch",
        "torchvision",
        "torchaudio",
        "transformers",
        "accelerate",
        "peft",
        "tokenizers",
        "uvicorn",
        "fastapi",
        "pydantic",
        "PySide6",
        "PySide6-Essentials",
        "PySide6-Addons",
    }
    for idx, (name, ver) in enumerate(pkgs.items()):
        # Torch family is installed per CUDA config; keep placeholder token
        if name in ("torch", "torchvision", "torchaudio"):
            version_spec = "FROM_CUDA_CONFIG"
        else:
            version_spec = ver
        core_dependencies.append(
            {
                "name": name,
                "version": version_spec,
                "order": idx,
                "critical": name in critical_pkgs or name.startswith("torch"),
            }
        )

    return {
        "format_version": template.get("format_version", "1.0"),
        "python_min": template.get("python_min", "3.10"),
        "python_max": template.get("python_max", "3.12"),
        "cuda_configs": cuda_configs,
        "core_dependencies": core_dependencies,
        "optional_packages": template.get("optional_packages", []),
        "global_blacklist": template.get("global_blacklist", []),
        "verification_tests": template.get("verification_tests", []),
        "post_install_cleanup": template.get("post_install_cleanup", []),
    }


def build_requirements_txt(profiles: List[Profile]) -> str:
    default_profile = profiles[0]
    lines = [
        "# Auto-generated by core/profile_sync.py",
        f"# Source profile: {default_profile.profile_id}",
        "# Do not edit manually. Edit profiles JSON instead and re-run the generator.",
        "",
    ]
    for name, ver in default_profile.data["packages"].items():
        # Torch wheels are selected per CUDA config and installed by installer; skip here
        if name in ("torch", "torchvision", "torchaudio"):
            continue
        # Avoid torch wheels with local suffix in requirements to let installer handle via cuda_index
        if ver and ver[0].isdigit():
            lines.append(f"{name}=={ver}")
        else:
            lines.append(f"{name}{ver if ver else ''}")
    return "\n".join(lines) + "\n"


def write_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def generate() -> List[str]:
    """
    Generate all derived artifacts. Returns list of files written.
    """
    profiles = load_profiles()

    # Load templates if they exist to preserve non-package metadata
    compat_template = json.loads(COMPAT_MATRIX_PATH.read_text(encoding="utf-8")) if COMPAT_MATRIX_PATH.exists() else None
    deps_template = json.loads(DEPENDENCIES_PATH.read_text(encoding="utf-8")) if DEPENDENCIES_PATH.exists() else None

    files_written: List[str] = []

    # compatibility_matrix.json
    compat = build_compatibility_matrix(profiles, compat_template)
    write_json(COMPAT_MATRIX_PATH, compat)
    files_written.append(str(COMPAT_MATRIX_PATH))

    # dependencies.json
    deps = build_dependencies_manifest(profiles, deps_template)
    write_json(DEPENDENCIES_PATH, deps)
    files_written.append(str(DEPENDENCIES_PATH))

    # hardware_profiles (mirror of profiles for backward compatibility)
    HARDWARE_PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    for prof in profiles:
        dest = HARDWARE_PROFILES_DIR / f"{prof.profile_id}.json"
        write_json(dest, prof.data)
        files_written.append(str(dest))

    # requirements.txt
    REQUIREMENTS_PATH.write_text(build_requirements_txt(profiles), encoding="utf-8")
    files_written.append(str(REQUIREMENTS_PATH))

    return files_written


def check() -> Tuple[bool, List[str]]:
    """
    Verify that generated artifacts are up-to-date. Returns (is_clean, outdated_files).
    """
    import tempfile
    import filecmp

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        # Temporarily redirect output paths
        global COMPAT_MATRIX_PATH, DEPENDENCIES_PATH, REQUIREMENTS_PATH, HARDWARE_PROFILES_DIR
        orig_paths = (COMPAT_MATRIX_PATH, DEPENDENCIES_PATH, REQUIREMENTS_PATH, HARDWARE_PROFILES_DIR)
        COMPAT_MATRIX_PATH = tmp / "compatibility_matrix.json"
        DEPENDENCIES_PATH = tmp / "dependencies.json"
        REQUIREMENTS_PATH = tmp / "requirements.txt"
        HARDWARE_PROFILES_DIR = tmp / "hardware_profiles"

        generated = generate()

        # Restore originals
        COMPAT_MATRIX_PATH, DEPENDENCIES_PATH, REQUIREMENTS_PATH, HARDWARE_PROFILES_DIR = orig_paths

        # Compare files
        outdated: List[str] = []
        compare_pairs = [
            (tmp / "compatibility_matrix.json", orig_paths[0]),
            (tmp / "dependencies.json", orig_paths[1]),
            (tmp / "requirements.txt", orig_paths[2]),
        ]

        for gen, dest in compare_pairs:
            if not dest.exists() or not filecmp.cmp(gen, dest, shallow=False):
                outdated.append(str(dest))

        # hardware profiles compare individually
        gen_hw_dir = tmp / "hardware_profiles"
        if gen_hw_dir.exists():
            for gen_file in gen_hw_dir.glob("*.json"):
                dest_file = orig_paths[3] / gen_file.name
                if not dest_file.exists() or not filecmp.cmp(gen_file, dest_file, shallow=False):
                    outdated.append(str(dest_file))

        return (len(outdated) == 0, outdated)


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in {"generate", "check"}:
        print("Usage: python -m core.profile_sync [generate|check]")
        sys.exit(1)

    command = sys.argv[1]
    if command == "generate":
        files = generate()
        print("Generated/updated:")
        for f in files:
            print(f" - {f}")
    elif command == "check":
        ok, outdated = check()
        if ok:
            print("All generated artifacts are up to date.")
            sys.exit(0)
        else:
            print("Outdated artifacts detected:")
            for f in outdated:
                print(f" - {f}")
            sys.exit(1)


if __name__ == "__main__":
    main()
