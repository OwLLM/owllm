"""Shared agent icon resolver.

Agent ``definition.icon`` strings come in two flavours:

- An emoji glyph (legacy default — e.g. ``"🛠️"``).
- An owl-image reference of the form ``"owl:<basename>"``, mapping to a
  PNG under ``<repo-root>/icons/Page_icons/<basename>.png``.

This module is the one place that knows how to load those PNGs and how
to render either flavour into a Qt widget or QPainter rect, so every
canvas / picker / card stays consistent.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional, Tuple

from PySide6.QtCore import QRectF, QSize, Qt
from PySide6.QtGui import QFont, QIcon, QPainter, QPixmap


# Qt's default font on Windows often lacks emoji glyphs, so palette
# entries like "🛠️" / "📡" render as blank tofu boxes. Forcing
# ``Segoe UI Emoji`` everywhere we paint an emoji icon fixes that.
_EMOJI_FAMILY = "Segoe UI Emoji"


OWL_PREFIX = "owl:"

# Owl PNGs offered in the Studio avatar picker. Order matters — it's the
# row order in the picker grid. The orchestrator-specific ``owl_agentic``
# is reserved for the team crest and intentionally omitted here.
OWL_ICON_BASENAMES: Tuple[str, ...] = (
    "owl_orchestrator1",
    "owl_coder",
    "owl_operator",
    "owl_critic",
    "owl_SSH",
    "owl_asssitant",
    "owl_documentation",
    "owl_webapp",
    "owl_chat",
    "owl_coding",
    "owl_agentic",
    "owl_defence",
    "owl_models",
    "owl_server",
    "owl_thunder",
    "owl_tools",
    "owl_training",
    "owl_ready",
    "owl_download",
)


def _icons_dir() -> Path:
    # widgets/ -> desktop_app/ -> LLM/ -> repo root
    return Path(__file__).resolve().parents[3] / "icons" / "Page_icons"


_pixmap_cache: dict[str, QPixmap] = {}


def is_owl_icon(icon: Optional[str]) -> bool:
    return bool(icon) and icon.startswith(OWL_PREFIX)


def owl_basename(icon: str) -> str:
    return icon[len(OWL_PREFIX):] if is_owl_icon(icon) else icon


def owl_label(basename: str) -> str:
    """Pretty label for tooltips: ``owl_coder`` → ``Coder``."""
    name = basename
    if name.startswith("owl_"):
        name = name[4:]
    return name.replace("_", " ").title()


def owl_pixmap(basename: str) -> Optional[QPixmap]:
    """Load and cache the PNG for an owl icon. Returns None if missing."""
    if basename in _pixmap_cache:
        pm = _pixmap_cache[basename]
        return pm if not pm.isNull() else None
    path = _icons_dir() / f"{basename}.png"
    pm = QPixmap(str(path)) if path.exists() else QPixmap()
    _pixmap_cache[basename] = pm
    return pm if not pm.isNull() else None


def resolve_pixmap(icon: Optional[str]) -> Optional[QPixmap]:
    """Return a QPixmap for any ``owl:*`` icon string. Else None."""
    if not is_owl_icon(icon):
        return None
    return owl_pixmap(owl_basename(icon))


def list_owl_icons() -> Iterable[Tuple[str, QPixmap]]:
    """Yield (icon_string, pixmap) for each available owl PNG.

    Skips entries whose PNG can't be loaded so the picker never shows a
    blank tile.
    """
    for base in OWL_ICON_BASENAMES:
        pm = owl_pixmap(base)
        if pm is not None:
            yield f"{OWL_PREFIX}{base}", pm


def _emoji_font_for(point_size: int) -> QFont:
    f = QFont(_EMOJI_FAMILY)
    f.setPointSize(point_size)
    return f


def apply_to_button(button, icon: str, *, size: int = 28) -> None:
    """Apply an icon string to a QAbstractButton (text vs QIcon).

    For emoji we also force a font that has the glyphs.
    """
    pm = resolve_pixmap(icon)
    if pm is not None:
        button.setText("")
        button.setIcon(QIcon(pm))
        button.setIconSize(QSize(size, size))
    else:
        button.setIcon(QIcon())
        # Match the font size to ~70% of the button's icon-equivalent
        # box so the glyph reads at a similar weight to the PNG tiles.
        button.setFont(_emoji_font_for(max(10, int(size * 0.55))))
        button.setText(icon or "🤖")


def apply_to_label(label, icon: str, *, size: int = 28) -> None:
    """Apply an icon string to a QLabel (pixmap vs text)."""
    pm = resolve_pixmap(icon)
    if pm is not None:
        label.setPixmap(
            pm.scaled(
                size,
                size,
                Qt.KeepAspectRatio,
                Qt.SmoothTransformation,
            )
        )
        label.setText("")
    else:
        label.setPixmap(QPixmap())
        label.setFont(_emoji_font_for(max(10, int(size * 0.55))))
        label.setText(icon or "🤖")


def paint_icon(p: QPainter, rect: QRectF, icon: Optional[str], *, fallback: str = "🤖") -> None:
    """Draw an icon (PNG or emoji) centred inside ``rect``.

    On the emoji path we force ``Segoe UI Emoji`` so the glyph isn't a
    blank tofu box, while preserving the caller's pen/colour.
    """
    pm = resolve_pixmap(icon)
    if pm is None:
        original = p.font()
        emoji_font = _emoji_font_for(max(10, int(min(rect.width(), rect.height()) * 0.55)))
        p.setFont(emoji_font)
        p.drawText(rect, Qt.AlignCenter, icon or fallback)
        p.setFont(original)
        return
    target_size = min(rect.width(), rect.height())
    scaled = pm.scaled(
        int(target_size),
        int(target_size),
        Qt.KeepAspectRatio,
        Qt.SmoothTransformation,
    )
    x = rect.x() + (rect.width() - scaled.width()) / 2.0
    y = rect.y() + (rect.height() - scaled.height()) / 2.0
    p.drawPixmap(int(x), int(y), scaled)
