"""Source-repo context bundle for the code-aware Coder.

TwinForge has three coder personas (see project_twinforge_three_agents):

  1. **Code-aware** — sees the source repo: real asset PNGs, widget
     source, team JSONs. Knows the exact PNG that draws the centre owl
     and uses ``<img src=...>`` instead of inventing emoji glyphs.
  2. **GUI-only** — pixel-only input, must segment assets out of
     screenshots itself.
  3. **Tester** — no generation, only verification + interaction.

This module is for #1. It walks a repo, enumerates assets and source
files we care about, and renders a markdown section the Coder can drop
into its prompt:

    # AVAILABLE SOURCE ASSETS
    The OWLLM repo ships these PNGs (use real paths, do NOT invent emoji):
      icons/Page_icons/owl_agentic.png        770017 bytes
      icons/Page_icons/owl_studio_square.png    ...
      ...
    Replica relative path from this HTML: ../../../icons/Page_icons/

    # SOURCE WIDGET CODE (the Qt code that produced SOURCE)
    desktop_app/widgets/agent_team_canvas.py (excerpt — paintEvent and
    asset references):
      ... source code ...

The Coder is then expected to reference real paths when replicating
elements, instead of approximating with colored discs + emoji.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional, Tuple


# Default cap so we don't blow the prompt on a huge widget file.
_DEFAULT_WIDGET_EXCERPT_CHARS = 12_000


@dataclass
class AssetEntry:
    abs_path: Path
    repo_rel: str       # e.g. "icons/Page_icons/owl_agentic.png"
    size_bytes: int


@dataclass
class SourceContext:
    """Bundle of source-repo context to inject into the Coder prompt.

    Configure once for a given replica use-case (e.g. "OWLLM agents
    page"), then call ``format_for_prompt(replica_path)`` to render
    the markdown section the Coder receives.
    """
    repo_root: Path
    asset_dirs: List[Path] = field(default_factory=list)
    widget_files: List[Path] = field(default_factory=list)
    team_files: List[Path] = field(default_factory=list)
    # Replica files the Coder is allowed to edit (in addition to its
    # primary working copy). For the React port the agents page chrome
    # lives in AppShell.tsx, the page body in AgentsPage.tsx — both
    # need to be reachable when the Coder is fixing a layout issue
    # that spans the boundary.
    replica_files: List[Path] = field(default_factory=list)
    widget_excerpt_chars: int = _DEFAULT_WIDGET_EXCERPT_CHARS

    # ------------------------------------------------------------------
    # Factories
    # ------------------------------------------------------------------
    @classmethod
    def for_owllm_agents_page(cls, repo_root: Path | str) -> "SourceContext":
        """Pre-configured for the OWLLM agents-page replica use case."""
        root = Path(repo_root).resolve()
        ui_src = root / "apps" / "owllm-desktop" / "ui" / "src"
        return cls(
            repo_root=root,
            asset_dirs=[
                root / "icons" / "Page_icons",
                root / "icons" / "Page_icons" / "CornersNew",
            ],
            widget_files=[
                root / "LLM" / "desktop_app" / "widgets" / "agent_team_canvas.py",
                root / "LLM" / "desktop_app" / "widgets" / "agent_canvas.py",
            ],
            team_files=list(
                (root / "LLM" / "core" / "agents" / "teams").glob("*.json")
            ),
            # The chrome + page-body split for the agents tab.
            replica_files=[
                ui_src / "AppShell.tsx",
                ui_src / "pages" / "AgentsPage.tsx",
                ui_src / "styles.css",
            ],
        )

    # ------------------------------------------------------------------
    # Asset enumeration
    # ------------------------------------------------------------------
    def assets(self) -> List[AssetEntry]:
        out: List[AssetEntry] = []
        seen: set[str] = set()
        for d in self.asset_dirs:
            if not d.exists() or not d.is_dir():
                continue
            for f in sorted(d.iterdir()):
                if not f.is_file():
                    continue
                if f.suffix.lower() not in (".png", ".svg", ".jpg", ".jpeg"):
                    continue
                rel = f.resolve().relative_to(self.repo_root).as_posix()
                if rel in seen:
                    continue
                seen.add(rel)
                try:
                    sz = f.stat().st_size
                except OSError:
                    sz = -1
                out.append(AssetEntry(abs_path=f, repo_rel=rel, size_bytes=sz))
        return out

    # ------------------------------------------------------------------
    # Widget-source excerpts — keep the bits that matter for replication
    # (asset paths, drawn shapes, colours, sizes), skip the rest.
    # ------------------------------------------------------------------
    def _widget_excerpt(self, p: Path) -> str:
        if not p.exists():
            return f"(missing: {p})"
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return f"(read error: {exc})"
        # Slice the file at the cap rather than truncating mid-line.
        if len(text) > self.widget_excerpt_chars:
            text = text[: self.widget_excerpt_chars]
            # Trim back to a complete line.
            cut = text.rfind("\n")
            if cut > 0:
                text = text[:cut]
            text += "\n# ... (truncated)\n"
        return text

    def _team_excerpt(self, p: Path) -> str:
        if not p.exists():
            return f"(missing: {p})"
        try:
            return p.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            return f"(read error: {exc})"

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------
    def _relpath_from(self, replica_path: Path, target: Path) -> str:
        """Relative POSIX path from ``replica_path``'s parent to ``target``."""
        try:
            rel = os.path.relpath(target, start=replica_path.parent)
            return Path(rel).as_posix()
        except ValueError:
            return target.as_posix()

    def format_for_prompt(self,
                          replica_path: Optional[Path] = None,
                          *,
                          include_widgets: bool = True,
                          include_teams: bool = True,
                          include_replica: bool = True,
                          ) -> str:
        """Render the markdown section the Coder receives.

        ``replica_path`` is the HTML/code file being edited — used so
        asset paths can be quoted as proper relative URLs the replica
        can actually load.
        """
        lines: List[str] = []
        assets = self.assets()

        # Section 1 — assets (always)
        lines.append("# AVAILABLE SOURCE ASSETS")
        lines.append(
            "The source repo ships these image assets. Reference them via "
            "`<img src=...>` (or equivalent) using the relative path "
            "shown below - do NOT invent emoji glyphs or coloured discs "
            "as stand-ins for real assets."
        )
        if replica_path is not None and assets:
            # Show the common base dir as a relative URL the replica can use.
            base_dir = assets[0].abs_path.parent
            rel_base = self._relpath_from(replica_path, base_dir)
            lines.append(f"\nRelative base path from this replica: `{rel_base}/`")
        lines.append("")
        if not assets:
            lines.append("(no assets discovered — check asset_dirs)")
        else:
            lines.append("```")
            for a in assets:
                if replica_path is not None:
                    rel_url = self._relpath_from(replica_path, a.abs_path)
                    lines.append(
                        f"{a.repo_rel:<50} {a.size_bytes:>8}  "
                        f"src=\"{rel_url}\""
                    )
                else:
                    lines.append(f"{a.repo_rel:<50} {a.size_bytes:>8}")
            lines.append("```")

        # Section 2 — widget source (optional)
        if include_widgets and self.widget_files:
            lines.append("")
            lines.append("# SOURCE WIDGET CODE")
            lines.append(
                "These are the Python widgets that PRODUCED the SOURCE "
                "screenshot. Use them to learn EXACT colours, sizes, "
                "positions, and which asset PNG is drawn at each location."
            )
            for wf in self.widget_files:
                rel = wf.resolve().relative_to(self.repo_root).as_posix() \
                    if str(wf).startswith(str(self.repo_root)) else str(wf)
                lines.append(f"\n## {rel}\n")
                lines.append("```python")
                lines.append(self._widget_excerpt(wf))
                lines.append("```")

        # Section 2.5 — replica files (the React port's editable surface)
        if include_replica and self.replica_files:
            lines.append("")
            lines.append("# REPLICA FILES (you may Edit any of these)")
            lines.append(
                "Your primary working copy is the file passed as the "
                "Working file at the top of this prompt — but the agents "
                "page chrome (HybridFrame, ModeBar, SubTabs) lives in "
                "AppShell.tsx, the page body in AgentsPage.tsx, and "
                "global classes in styles.css. Use your Edit tool on "
                "whichever file actually contains the element you need "
                "to change. Both must be valid TSX/CSS after your edits "
                "— Vite hot-reload picks the change up immediately."
            )
            for rf in self.replica_files:
                if not rf.exists():
                    continue
                rel = rf.resolve().relative_to(self.repo_root).as_posix() \
                    if str(rf).startswith(str(self.repo_root)) else str(rf)
                lines.append(f"\n## {rel}\n")
                lang = "tsx" if rf.suffix == ".tsx" else (
                    "css" if rf.suffix == ".css" else "ts"
                )
                lines.append(f"```{lang}")
                try:
                    lines.append(rf.read_text(encoding="utf-8", errors="replace")[:self.widget_excerpt_chars])
                except OSError as exc:
                    lines.append(f"(read error: {exc})")
                lines.append("```")

        # Section 3 — team JSONs (optional)
        if include_teams and self.team_files:
            lines.append("")
            lines.append("# TEAM DEFINITIONS")
            lines.append(
                "Each team JSON lists its agent roles and their owl icon "
                "(format: `owl:owl_<name>` → `icons/Page_icons/owl_<name>.png`)."
            )
            for tf in self.team_files:
                rel = tf.resolve().relative_to(self.repo_root).as_posix() \
                    if str(tf).startswith(str(self.repo_root)) else str(tf)
                lines.append(f"\n## {rel}\n")
                lines.append("```json")
                lines.append(self._team_excerpt(tf))
                lines.append("```")

        return "\n".join(lines)
