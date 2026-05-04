"""Skill library — discover and install community ``SKILL.md`` packs.

There is no central registry for Claude Code / OpenClaw skills today; the
ecosystem is git-repo-based. This module wraps a curated list of known
sources, shallow-clones them on demand into ``LLM/data/skills/_remote/``,
walks for ``SKILL.md`` files, and lets the Studio install individual
skills into the active skill folder.

Everything is best-effort and offline-tolerant — if ``git`` isn't on
PATH or the user is offline, ``fetch_source`` raises and the UI shows
a friendly error.

Tool name aliasing
==================

Anthropic Claude Code skills reference tools by their CamelCase Anthropic
names (``Read``, ``Bash``, ``Edit``, ``WebFetch``…). OWLLM uses
snake_case ids (``read_file``, ``shell``, ``write_file_with_diff``).
``ALIAS_MAP`` is the translation; ``alias_tool_name`` runs each ``tools:``
entry through it during install so a vanilla Anthropic skill resolves
against our :class:`ToolRegistry` without manual editing.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Curated sources
# ---------------------------------------------------------------------------


@dataclass
class SkillSource:
    """One git-hosted collection of SKILL.md packs."""

    key: str
    """Stable id used as the on-disk folder name (e.g. ``anthropics``)."""
    label: str
    """Human-readable name shown in the Studio."""
    git_url: str
    description: str = ""
    """Where to look inside the cloned repo. Empty = root.

    Some collections nest skills under a subdir (e.g. ``skills/`` or
    ``document-skills/``). The walker still recurses, but starting from
    a subdir keeps unrelated files out of the listing."""
    skills_subpath: str = ""


# Hand-picked initial set. Add more here — the Studio dialog auto-picks
# them up. Keep the list short and high-signal; users can paste any git
# URL via the "Custom source" field.
KNOWN_SOURCES: List[SkillSource] = [
    SkillSource(
        key="anthropics",
        label="Anthropic — official skills",
        git_url="https://github.com/anthropics/skills.git",
        description=(
            "Anthropic's reference SKILL.md collection (PDF, Excel, Word, "
            "PowerPoint helpers). MIT licensed, drop-in compatible."
        ),
    ),
    SkillSource(
        key="superpowers",
        label="obra/superpowers — community skills",
        git_url="https://github.com/obra/superpowers.git",
        description=(
            "Curated community SKILL.md collection — engineering, research, "
            "and writing helpers."
        ),
    ),
]


# ---------------------------------------------------------------------------
# Tool name aliasing (Anthropic Claude Code → OWLLM)
# ---------------------------------------------------------------------------


# Anthropic skills name tools using the CamelCase identifiers from Claude
# Code's tool catalog. Map them onto our snake_case builtin names so an
# unmodified skill resolves against ``builtin_registry()``.
#
# Where there is no direct equivalent we fall through to the lowercased
# name in ``alias_tool_name`` — the runtime simply skips unknown ids,
# which is a strictly better failure mode than the loader rejecting the
# whole skill.
ALIAS_MAP: Dict[str, str] = {
    "Read": "read_file",
    "Write": "write_file_with_diff",
    "Edit": "edit_file",
    "MultiEdit": "edit_file",
    "Bash": "shell",
    "PowerShell": "shell",
    "LS": "list_dir",
    "Glob": "glob_files",
    "Grep": "grep",
    "WebFetch": "http_get",
    "WebSearch": "http_get",
    "TodoWrite": "todo_write",
    # NotebookEdit, Task, etc. — no OWLLM equivalent yet;
    # they'll fall through and be silently dropped at runtime.
}


def alias_tool_name(name: str) -> str:
    """Translate one Anthropic-flavored tool name to its OWLLM id.

    Already-snake_case names pass through untouched, so applying this to
    a native OWLLM SKILL.md is a no-op.
    """
    if not name:
        return name
    if name in ALIAS_MAP:
        return ALIAS_MAP[name]
    # Heuristic: if it's a known OWLLM builtin or already lowercase with
    # underscores, leave it alone. Otherwise lowercase as a last resort.
    if name.islower() or "_" in name:
        return name
    return name.lower()


# ---------------------------------------------------------------------------
# Filesystem layout
# ---------------------------------------------------------------------------


def _llm_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def _remote_root() -> Path:
    """Where shallow clones live. Kept under ``LLM/data/skills/`` so the
    skill loader picks up whatever the user installs without extra
    configuration."""
    return _llm_root() / "data" / "skills" / "_remote"


def _installed_root() -> Path:
    """Where installed skills live. Same dir the SKILL.md loader scans."""
    return _llm_root() / "data" / "skills"


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


@dataclass
class DiscoveredSkill:
    """One SKILL.md found inside a cloned source."""

    source_key: str
    relative_dir: str
    """Path of the skill folder relative to the source clone root."""
    name: str
    description: str
    skill_md_path: Path


def fetch_source(source: SkillSource, *, force: bool = False) -> Path:
    """Shallow-clone (or refresh) ``source`` into the remote cache.

    Returns the local clone path. Raises :class:`RuntimeError` with a
    user-friendly message if git is unavailable or the clone fails.
    """
    git_exe = shutil.which("git")
    if git_exe is None:
        raise RuntimeError(
            "Git is not installed or not on PATH. Install Git to add skill "
            "libraries from the internet."
        )

    target = _remote_root() / source.key
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists() and not force:
        # Best-effort refresh; ignore errors so an offline user can still
        # browse what they cloned previously.
        try:
            subprocess.run(
                [git_exe, "-C", str(target), "pull", "--ff-only", "--quiet"],
                check=False,
                capture_output=True,
                timeout=30,
            )
        except Exception:  # noqa: BLE001
            logger.debug("skill source refresh failed for %s", source.key, exc_info=True)
        return target

    if target.exists() and force:
        shutil.rmtree(target, ignore_errors=True)

    try:
        subprocess.run(
            [git_exe, "clone", "--depth", "1", source.git_url, str(target)],
            check=True,
            capture_output=True,
            timeout=120,
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            f"Could not clone {source.git_url}: {stderr or exc}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Clone of {source.git_url} timed out") from exc

    return target


def discover_skills(source: SkillSource) -> List[DiscoveredSkill]:
    """Walk a (previously-fetched) source for SKILL.md files."""
    root = _remote_root() / source.key
    if not root.exists():
        return []
    start = root / source.skills_subpath if source.skills_subpath else root
    if not start.exists():
        start = root

    out: List[DiscoveredSkill] = []
    for skill_md in start.rglob("SKILL.md"):
        # Skip anything under a hidden directory (e.g. .git).
        if any(part.startswith(".") for part in skill_md.relative_to(root).parts[:-1]):
            continue
        try:
            text = skill_md.read_text(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            continue
        name, description = _peek_frontmatter(text)
        if not name:
            # Fall back to the parent folder name so the user still sees
            # *something* in the picker.
            name = skill_md.parent.name
        out.append(
            DiscoveredSkill(
                source_key=source.key,
                relative_dir=str(skill_md.parent.relative_to(root)),
                name=name,
                description=description,
                skill_md_path=skill_md,
            )
        )
    out.sort(key=lambda s: s.name.lower())
    return out


def _peek_frontmatter(text: str) -> tuple[str, str]:
    """Read just ``name`` and ``description`` from the YAML frontmatter.

    A 1-pass scan instead of importing the full skill_md parser — lets
    the discovery step work even on skills that would later fail to
    fully parse (e.g. malformed list syntax in `tools:`)."""
    if not text.startswith("---"):
        return ("", "")
    end = text.find("\n---", 3)
    if end == -1:
        return ("", "")
    fm = text[3:end]
    name = ""
    desc = ""
    for raw in fm.splitlines():
        line = raw.strip()
        if line.startswith("name:") and not name:
            name = line.split(":", 1)[1].strip().strip('"').strip("'")
        elif line.startswith("description:") and not desc:
            desc = line.split(":", 1)[1].strip().strip('"').strip("'")
    return (name, desc)


# ---------------------------------------------------------------------------
# Install / uninstall
# ---------------------------------------------------------------------------


def install_skill(skill: DiscoveredSkill, *, apply_aliases: bool = True) -> Path:
    """Copy a discovered skill into the active skills folder.

    The copy lands at ``LLM/data/skills/<source_key>__<folder_name>/`` so
    two sources can ship a same-named skill without colliding. If
    ``apply_aliases`` is true (default) the SKILL.md gets a tool-name
    rewrite pass on the way out so Anthropic-flavored ``tools:`` lists
    resolve against our :class:`ToolRegistry`.
    """
    src_dir = skill.skill_md_path.parent
    folder_name = f"{skill.source_key}__{src_dir.name}"
    dest = _installed_root() / folder_name
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src_dir, dest)

    if apply_aliases:
        dest_md = dest / "SKILL.md"
        try:
            text = dest_md.read_text(encoding="utf-8", errors="replace")
            rewritten = _rewrite_tool_aliases(text)
            if rewritten != text:
                dest_md.write_text(rewritten, encoding="utf-8")
        except Exception:  # noqa: BLE001
            logger.exception("alias rewrite failed for %s", dest_md)

    return dest


def uninstall_skill(folder_name: str) -> bool:
    """Remove an installed skill folder. Returns True if anything was deleted."""
    dest = _installed_root() / folder_name
    if not dest.exists() or not dest.is_dir():
        return False
    shutil.rmtree(dest, ignore_errors=True)
    return not dest.exists()


def _rewrite_tool_aliases(text: str) -> str:
    """Rewrite each ``tools:`` list item through :func:`alias_tool_name`.

    Operates only inside the YAML frontmatter so the markdown body stays
    untouched. This is a deliberately tiny line-by-line rewriter — the
    skill_md frontmatter dialect is itself a tiny subset of YAML.
    """
    if not text.startswith("---"):
        return text
    end = text.find("\n---", 3)
    if end == -1:
        return text
    head = text[: 3]
    fm = text[3:end]
    tail = text[end:]

    rewritten_lines: List[str] = []
    inside_tools = False
    for raw in fm.splitlines():
        stripped = raw.strip()
        if stripped.startswith("tools:"):
            inside_tools = True
            rewritten_lines.append(raw)
            continue
        if inside_tools:
            # A YAML list item under `tools:` looks like `  - Read`.
            if stripped.startswith("- "):
                indent = raw[: len(raw) - len(raw.lstrip())]
                value = stripped[2:].strip().strip('"').strip("'")
                rewritten_lines.append(f"{indent}- {alias_tool_name(value)}")
                continue
            # Any non-list, non-blank line ends the tools block.
            if stripped and not stripped.startswith("#"):
                inside_tools = False
        rewritten_lines.append(raw)

    return f"{head}{chr(10).join(rewritten_lines)}{tail}"


# ---------------------------------------------------------------------------
# Catalog helpers (UI convenience)
# ---------------------------------------------------------------------------


def list_installed_remote_folders() -> List[str]:
    """Return folder names under ``LLM/data/skills/`` that look like they
    came from a remote source (prefix ``<source_key>__``)."""
    base = _installed_root()
    if not base.exists():
        return []
    keys = {s.key for s in KNOWN_SOURCES}
    out: List[str] = []
    for child in base.iterdir():
        if not child.is_dir():
            continue
        prefix = child.name.split("__", 1)[0]
        if prefix in keys or "__" in child.name:
            out.append(child.name)
    return sorted(out)


def custom_source_from_url(url: str) -> SkillSource:
    """Build an ad-hoc :class:`SkillSource` from a user-pasted git URL.

    Derives ``key`` from the repo name so re-fetching the same URL
    reuses the same on-disk cache.
    """
    cleaned = url.strip().rstrip("/")
    if cleaned.endswith(".git"):
        cleaned = cleaned[:-4]
    last = cleaned.rsplit("/", 1)[-1] or "custom"
    key = "".join(ch if (ch.isalnum() or ch in "-_") else "_" for ch in last) or "custom"
    return SkillSource(
        key=key,
        label=f"Custom — {last}",
        git_url=url.strip(),
        description="User-supplied git source.",
    )
