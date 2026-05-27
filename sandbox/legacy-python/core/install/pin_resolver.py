"""Single source of truth for "what version of <pkg> for <env>?".

Why this exists
---------------
Before this module, the same package had its version pin declared in
up to seven different places:

    LLM/requirements.txt
    LLM/profiles/<arch>.json
    LLM/metadata/hardware_profiles/<arch>.json
    LLM/metadata/compatibility_matrix.json
    LLM/constraints/<env_key>.txt
    LLM/core/envs/env_registry.py     (inline _pkg("name", "name>=...") calls)
    LLM/desktop_app/training_env_manager.py  (REQUIRED_TRAINING_PACKAGES)

Each was edited independently. They drifted. ``safetensors==0.7.0``
landed in profiles for weeks while ``requirements.txt`` said
``>=0.4.5`` — that version range never existed on PyPI, and pip silently
failed to download it for every user, with the error eaten by the
wheelhouse downloader's stderr-discarding loop. We chased the symptoms
for hours and shipped seven separate "fixes" before anyone noticed the
seven-way pin drift.

Design contract
---------------
There is now ONE authoritative pin source per env:

    LLM/profiles/<profile_id>.json   (already exists)

Plus optional extras files for capabilities the main profile doesn't
cover (training packages, vision packages, etc.):

    LLM/profiles/extras/<extra_id>.json

PinResolver loads them on construction and exposes:

    resolver.get(package, env_id)            -> spec string
    resolver.required_for(env_id)            -> {pkg: spec, ...}
    resolver.required_for(env_id, extras=["training"]) -> merged dict
    resolver.resolve_pip_args(env_id, ...)   -> list of pip-ready args

Every other file with package versions becomes a CONSUMER of
PinResolver, not a sibling source. The redundant files
(metadata/hardware_profiles, metadata/compatibility_matrix,
constraints/*.txt) can be deleted or auto-generated from profiles/
in a follow-up commit.

Phantom-version protection
--------------------------
Pair this module with ``LLM/scripts/verify_pins.py`` (already shipped
as cc50f33). Wire that script into pre-commit / CI so any change to
profiles/*.json is validated against PyPI before merge. Phantom pins
become impossible to land.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional


def _normalize(name: str) -> str:
    """PyPI-style normalisation: ``foo_bar.Baz`` -> ``foo-bar-baz``."""
    return re.sub(r"[-_.]+", "-", name).strip().lower()


@dataclass
class ProfileData:
    """In-memory shape of one profile file."""

    profile_id: str
    source_path: Path
    packages: Dict[str, str]  # canonical: keys normalised
    torch_index: Optional[str] = None
    python_version: Dict[str, str] = field(default_factory=dict)
    raw: dict = field(default_factory=dict)

    def get_spec(self, package: str) -> Optional[str]:
        return self.packages.get(_normalize(package))


class PinResolverError(RuntimeError):
    """Resolver-level errors (missing profile file, malformed JSON, etc.)."""


class PinResolver:
    """Read-only registry of "what version of X for env Y?".

    Construct ONCE per process and reuse — file IO happens in
    ``__init__``. If profile files change on disk you can call
    ``reload()`` to pick the changes up; this is rare and not on the
    repair hot path.
    """

    def __init__(
        self,
        project_root: Path,
        *,
        profile_dir: Optional[Path] = None,
        extras_dir: Optional[Path] = None,
    ) -> None:
        self.project_root = Path(project_root).resolve()
        self.profile_dir = (
            Path(profile_dir) if profile_dir else (self.project_root / "profiles")
        )
        self.extras_dir = (
            Path(extras_dir) if extras_dir else (self.profile_dir / "extras")
        )
        self._profiles: Dict[str, ProfileData] = {}
        self._extras: Dict[str, ProfileData] = {}
        self.reload()

    # -----------------------------------------------------------------
    # Loading
    # -----------------------------------------------------------------
    def reload(self) -> None:
        self._profiles = {}
        self._extras = {}
        if self.profile_dir.exists():
            for path in sorted(self.profile_dir.glob("*.json")):
                profile = self._load_profile_file(path)
                if profile is not None:
                    self._profiles[profile.profile_id] = profile
        if self.extras_dir.exists():
            for path in sorted(self.extras_dir.glob("*.json")):
                extra = self._load_profile_file(path, treat_as_extras=True)
                if extra is not None:
                    self._extras[extra.profile_id] = extra

    def _load_profile_file(self, path: Path, *, treat_as_extras: bool = False) -> Optional[ProfileData]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise PinResolverError(f"profile {path} is not valid JSON: {exc}")
        except Exception as exc:
            raise PinResolverError(f"profile {path} could not be read: {exc}")
        if not isinstance(data, dict):
            raise PinResolverError(f"profile {path} root is not an object")

        # The legacy 'packages' key is still authoritative; some profiles
        # also nest extras under 'training_packages' / 'vision_packages'.
        # We treat the file as a single namespace — consumers ask for
        # extras explicitly via required_for(env_id, extras=[...]).
        raw_packages = data.get("packages") or {}
        if treat_as_extras:
            # Extras files use the same shape as a profile but their
            # 'packages' map is the merge layer — no torch_index, no
            # python_version constraints.
            raw_packages = data.get("packages") or {}
        if not isinstance(raw_packages, dict):
            raise PinResolverError(f"profile {path}: 'packages' is not an object")

        normalised: Dict[str, str] = {}
        for pkg_name, spec in raw_packages.items():
            if not isinstance(spec, str):
                continue
            normalised[_normalize(pkg_name)] = spec.strip()

        profile_id = data.get("profile_id") or path.stem
        return ProfileData(
            profile_id=profile_id,
            source_path=path,
            packages=normalised,
            torch_index=data.get("torch_index"),
            python_version=data.get("python_version") or {},
            raw=data,
        )

    # -----------------------------------------------------------------
    # Query
    # -----------------------------------------------------------------
    @property
    def profile_ids(self) -> List[str]:
        return sorted(self._profiles)

    @property
    def extra_ids(self) -> List[str]:
        return sorted(self._extras)

    def get(self, package: str, env_id: str) -> Optional[str]:
        """Return the spec for ``package`` in ``env_id``, or ``None``.

        Returns the raw spec string from the profile (e.g. ``"==2.5.1+cu121"``,
        ``">=4.51.0,<4.60.0"``, or ``"4.12.2"`` — bare versions are also
        accepted).
        """
        profile = self._profiles.get(env_id)
        if profile is None:
            raise PinResolverError(
                f"unknown env_id={env_id!r}; known: {sorted(self._profiles)}"
            )
        return profile.get_spec(package)

    def required_for(
        self,
        env_id: str,
        *,
        extras: Optional[List[str]] = None,
    ) -> Dict[str, str]:
        """All required (package -> spec) mappings for an env.

        ``extras`` optionally merges in extras files (e.g.
        ``["training", "vision"]``) — extras win on key conflict so a
        capability-specific pin can override the base profile.
        """
        profile = self._profiles.get(env_id)
        if profile is None:
            raise PinResolverError(
                f"unknown env_id={env_id!r}; known: {sorted(self._profiles)}"
            )
        merged: Dict[str, str] = dict(profile.packages)
        if extras:
            for extra_id in extras:
                extra = self._extras.get(extra_id)
                if extra is None:
                    raise PinResolverError(
                        f"unknown extras id={extra_id!r}; known: {sorted(self._extras)}"
                    )
                merged.update(extra.packages)
        return merged

    def torch_index_for(self, env_id: str) -> Optional[str]:
        profile = self._profiles.get(env_id)
        if profile is None:
            raise PinResolverError(
                f"unknown env_id={env_id!r}; known: {sorted(self._profiles)}"
            )
        return profile.torch_index

    def resolve_pip_args(
        self,
        env_id: str,
        packages: List[str],
        *,
        extras: Optional[List[str]] = None,
    ) -> List[str]:
        """Materialize a list of pip-install-ready ``"<pkg><spec>"`` strings.

        Used when a caller wants to install a SUBSET of an env's
        required packages — e.g. the per-package "Repair Component"
        button that only acts on one card.

        Unknown packages are returned bare (``"<pkg>"``) so pip will
        install whatever it finds; that's intentional — matches the
        legacy behaviour of "you typed it, we install it" and avoids
        breaking ad-hoc workflows. Add the package to the profile if
        you want a pinned version.
        """
        required = self.required_for(env_id, extras=extras)
        out: List[str] = []
        for pkg in packages:
            spec = required.get(_normalize(pkg))
            if not spec:
                out.append(pkg)
                continue
            # Specs that already start with an operator are appended
            # raw; bare versions get == prefixed.
            if spec.startswith(("==", ">=", "<=", ">", "<", "!=", "~=")) or "," in spec:
                out.append(f"{pkg}{spec}")
            else:
                out.append(f"{pkg}=={spec}")
        return out


def default_resolver(project_root: Optional[Path] = None) -> PinResolver:
    """Process-wide singleton entry point.

    Most callers should use this. Tests can construct their own
    ``PinResolver(project_root=tmp_path)`` directly.
    """
    global _SINGLETON
    if _SINGLETON is None or (project_root and _SINGLETON.project_root != Path(project_root).resolve()):
        if project_root is None:
            project_root = Path(__file__).resolve().parents[2]
        _SINGLETON = PinResolver(project_root=project_root)
    return _SINGLETON


_SINGLETON: Optional[PinResolver] = None
