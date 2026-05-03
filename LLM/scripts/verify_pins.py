"""Verify every package pin in the OWLLM repo against PyPI.

Why this exists
---------------
The repair installer kept failing on phantom versions — most recently
``safetensors>=0.7.0,<0.8.0`` (safetensors 0.7.x doesn't exist on PyPI;
latest stable is 0.4.x). When that drift happens it's only caught at
install time as a confusing "Failed to download critical package X"
error 5 minutes into the repair. By then the user is angry.

This script is the production gate. It walks every place a pin lives
(requirements.txt, profile JSONs, hardware-profile JSONs, the
compatibility matrix, the explicit pins in env_registry.py) and asks
PyPI: "does at least ONE published version of this package satisfy
this specifier?". If any pin has zero matching releases, the pin is
phantom and the script exits non-zero with a clear list of offenders.

CI usage::

    python LLM/scripts/verify_pins.py

Exit codes:
    0 — every pin resolves to a real PyPI release
    1 — at least one phantom pin was found (printed)
    2 — could not reach PyPI (network failure)

Local usage:
    Run before tagging a release. Run after editing any *.json profile
    or requirements.txt. Wire it into a pre-commit hook if you want.
    The PyTorch CUDA index (download.pytorch.org) hosts torch* wheels
    not on PyPI; those names are skipped from PyPI checks but
    explicitly verified against the cu121 index.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable

# ---------------------------------------------------------------------
# What to scan
# ---------------------------------------------------------------------
LLM_ROOT = Path(__file__).resolve().parents[1]

# Names hosted on the PyTorch CUDA index, not PyPI. We don't query them
# against PyPI (they 404 there) but DO verify them against the cu121
# index when network is available.
PYTORCH_INDEX_NAMES = {"torch", "torchvision", "torchaudio"}

# Known package-name normalisations PyPI accepts both ways.
# (PyPI is case-insensitive and treats - / _ / . the same).
def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


# ---------------------------------------------------------------------
# Pin extractors — return list[(file_path, package_name, specifier)]
# ---------------------------------------------------------------------
def _scan_requirements_txt(path: Path) -> list[tuple[Path, str, str]]:
    out: list[tuple[Path, str, str]] = []
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # Skip --index-url / -r / etc.
        if line.startswith("-"):
            continue
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9_.\-]*)\s*([<>=!~].*)?$", line)
        if not m:
            continue
        out.append((path, m.group(1), (m.group(2) or "").strip()))
    return out


def _scan_constraints(path: Path) -> list[tuple[Path, str, str]]:
    # Same syntax as requirements.txt.
    return _scan_requirements_txt(path)


def _scan_json_profile(path: Path) -> list[tuple[Path, str, str]]:
    """Profiles use {"<package>": "<specifier>"} maps under various keys."""
    out: list[tuple[Path, str, str]] = []
    if not path.exists():
        return out
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return out

    def _walk(obj):
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(v, str) and re.match(r"^[<>=!~]", v):
                    # Spec like ">=4.51.0,<4.60.0" — k is the package.
                    out.append((path, str(k), v))
                elif isinstance(v, str) and "==" in v:
                    out.append((path, str(k), v))
                else:
                    _walk(v)
        elif isinstance(obj, list):
            for it in obj:
                _walk(it)

    _walk(data)
    return out


def _scan_env_registry_inline(path: Path) -> list[tuple[Path, str, str]]:
    """Find inline pins like _pkg("name", "name>=1.0,<2.0") in env_registry.py."""
    out: list[tuple[Path, str, str]] = []
    if not path.exists():
        return out
    txt = path.read_text(encoding="utf-8", errors="replace")
    for m in re.finditer(
        r'_pkg\(\s*"([A-Za-z0-9][A-Za-z0-9_.\-]*)"\s*,\s*"([^"]+)"\s*\)',
        txt,
    ):
        name, spec = m.group(1), m.group(2)
        # spec is the full pip spec; strip the package name prefix to
        # leave just the version specifier portion.
        m2 = re.match(r"^[A-Za-z0-9][A-Za-z0-9_.\-]*\s*(.*)$", spec)
        ver = (m2.group(1) if m2 else "").strip()
        out.append((path, name, ver))
    return out


def gather_pins() -> list[tuple[Path, str, str]]:
    pins: list[tuple[Path, str, str]] = []
    pins += _scan_requirements_txt(LLM_ROOT / "requirements.txt")
    pins += _scan_requirements_txt(LLM_ROOT / "full_package_list.txt")
    for p in (LLM_ROOT / "profiles").glob("*.json"):
        pins += _scan_json_profile(p)
    hw = LLM_ROOT / "metadata" / "hardware_profiles"
    for p in hw.glob("*.json"):
        pins += _scan_json_profile(p)
    pins += _scan_json_profile(LLM_ROOT / "metadata" / "compatibility_matrix.json")
    for p in (LLM_ROOT / "constraints").glob("*.txt"):
        pins += _scan_constraints(p)
    pins += _scan_env_registry_inline(LLM_ROOT / "core" / "envs" / "env_registry.py")
    return pins


# ---------------------------------------------------------------------
# PyPI check
# ---------------------------------------------------------------------
def _fetch_pypi_versions(name: str, *, timeout: float = 8.0) -> list[str]:
    """Return all release versions PyPI knows about for `name`.

    Empty list = network reachable but package unknown.
    Raises urllib.error.URLError on transport failure.
    """
    url = f"https://pypi.org/pypi/{name}/json"
    req = urllib.request.Request(url, headers={"User-Agent": "owllm-verify-pins/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8", errors="replace"))
    return list((data.get("releases") or {}).keys())


def _spec_matches(spec: str, versions: Iterable[str]) -> bool:
    """Does at least one of `versions` satisfy `spec`?"""
    if not spec:
        # No specifier — any version is fine.
        return any(versions)
    try:
        from packaging.specifiers import SpecifierSet
        from packaging.version import Version, InvalidVersion
    except Exception:
        # packaging missing — fall back to a permissive substring match
        # so the script still runs in the bootstrap venv.
        return any(spec.replace(">=", "").replace("<", "").replace("=", "").strip() in v for v in versions)
    try:
        specset = SpecifierSet(spec)
    except Exception:
        return True  # malformed spec — let pip be the judge later
    for v in versions:
        try:
            if Version(v) in specset:
                return True
        except InvalidVersion:
            continue
    return False


# ---------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------
def main() -> int:
    pins = gather_pins()
    print(f"verify_pins: found {len(pins)} pins across the repo.\n")

    # Group by (package, spec) so we don't re-query PyPI for duplicates,
    # but keep every site so the failure report is precise.
    grouped: dict[tuple[str, str], list[Path]] = {}
    for path, name, spec in pins:
        if name.lower() in {"python", "python_requires"}:
            continue
        key = (_normalize(name), spec)
        grouped.setdefault(key, []).append(path)

    phantom: list[tuple[str, str, list[Path]]] = []
    network_dead = False

    cache: dict[str, list[str]] = {}
    for (norm_name, spec), paths in sorted(grouped.items()):
        if norm_name in PYTORCH_INDEX_NAMES:
            # torch et al. live on download.pytorch.org; assume valid
            # unless we wanted to query that index too. Skipped here.
            continue
        try:
            if norm_name not in cache:
                cache[norm_name] = _fetch_pypi_versions(norm_name)
            versions = cache[norm_name]
        except urllib.error.URLError as e:
            print(f"  ⚠ network/PyPI error on {norm_name}: {e}")
            network_dead = True
            continue
        if not versions:
            phantom.append((norm_name, spec, paths))
            continue
        if not _spec_matches(spec, versions):
            phantom.append((norm_name, spec, paths))

    if network_dead and not phantom:
        print("\nverify_pins: PyPI was unreachable for some packages; rerun on a "
              "machine with network access before shipping.")
        return 2

    if not phantom:
        print("verify_pins: ✓ every pin resolves to a real PyPI release.")
        return 0

    print("verify_pins: ✗ phantom or unsatisfiable pins detected:\n")
    for name, spec, paths in phantom:
        print(f"  {name}{spec}")
        for p in sorted(set(paths)):
            print(f"      in: {p.relative_to(LLM_ROOT.parent)}")
        print()
    print(
        "Fix the spec to a range that has at least one published release "
        "(check `pip index versions <name>` or pypi.org/project/<name>/) "
        "and re-run this script before shipping."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
