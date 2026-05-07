"""Shared info-card painter for the agentic-team canvases.

Both :class:`AgentTeamCanvas` (orbital diagram) and :class:`AgentCanvas`
(graph editor) overlay a top-left "character sheet" panel describing the
selected agent or — when nothing is selected — the team itself.

This module owns the painting code so the two canvases share one visual
language. Each function takes a configured :class:`QPainter` plus a
plain dict of fields and draws the card; no widget state required.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QLinearGradient,
    QPainter,
    QPen,
    QPixmap,
    QRadialGradient,
)


STATUS_IDLE = "idle"
STATUS_ACTIVE = "active"
STATUS_PENDING = "pending"
STATUS_ERROR = "error"


_NEON_CYAN = QColor("#5cf0ff")
_NEON_BLUE = QColor("#74a4ff")
_NEON_VIOLET = QColor("#c08aff")
_NEON_GREEN = QColor("#3cf26b")
_NEON_AMBER = QColor("#ffc060")
_NEON_RED = QColor("#ff7878")
_TEXT_BRIGHT = QColor("#e6f0ff")
_TEXT_DIM = QColor("#7888a8")


def _alpha(c: QColor, a: int) -> QColor:
    return QColor(c.red(), c.green(), c.blue(), max(0, min(255, a)))


def load_owl_pixmap() -> Optional[QPixmap]:
    """Best-effort load of the owl crest used as the team avatar."""
    try:
        owl_path = (
            Path(__file__).resolve().parents[3]
            / "icons"
            / "Page_icons"
            / "owl_agentic.png"
        )
        if owl_path.exists():
            pm = QPixmap(str(owl_path))
            if not pm.isNull():
                return pm
    except Exception:
        pass
    return None


CARD_PICKER_RESERVE = 44
"""Pixels reserved at the bottom of every painted card for the overlay
:class:`ModelPickerButton`. Skill chips and stat rows must paint above
this band so the picker doesn't sit on top of them."""

CARD_MARGIN = 14
CARD_W_MAX = 360
"""Card width matches both painters in this module — kept as a constant
so the canvas can compute the overlay picker's geometry without
duplicating the painter's local layout numbers."""

_PICKER_INSET_X = 12
_PICKER_INSET_Y = 6
_PICKER_HEIGHT = 32


def card_picker_geometry(widget_w: int, agent_card: bool) -> tuple:
    """Return ``(x, y, w, h)`` (widget pixel coords) for the overlay
    :class:`ModelPickerButton` that sits inside the bottom of the painted
    card. ``agent_card`` toggles between agent (264h) and team (244h)
    card heights since the two have different chip / stats areas above."""
    card_w = min(CARD_W_MAX, max(0, widget_w - 2 * CARD_MARGIN))
    card_h = 264 if agent_card else 244
    x = CARD_MARGIN + _PICKER_INSET_X
    y = CARD_MARGIN + card_h - CARD_PICKER_RESERVE + _PICKER_INSET_Y
    w = max(0, card_w - 2 * _PICKER_INSET_X)
    h = _PICKER_HEIGHT
    return x, y, w, h


def paint_agent_card(
    p: QPainter,
    rect,
    *,
    name: str,
    icon: str,
    description: str,
    skills: Iterable[str],
    status: str = STATUS_IDLE,
    model_label: str = "",
    voice_label: str = "",
) -> None:
    """Top-left character-sheet panel for the selected agent.

    Layout: 360×264 panel anchored at (14, 14). Width was trimmed by 20px
    (was 380) and height grew by 44px to host the model picker overlay
    that the canvas widget positions inside this same rectangle.
    """
    margin = 14
    card_w = min(360, rect.width() - 2 * margin)
    card_h = 264
    card = QRectF(margin, margin, card_w, card_h)

    bg = QLinearGradient(card.topLeft(), card.bottomRight())
    bg.setColorAt(0.0, QColor(18, 22, 34, 230))
    bg.setColorAt(1.0, QColor(8, 11, 18, 230))
    p.setBrush(QBrush(bg))

    border_grad = QLinearGradient(card.topLeft(), card.bottomRight())
    border_grad.setColorAt(0.0, _alpha(_NEON_CYAN, 220))
    border_grad.setColorAt(1.0, _alpha(_NEON_VIOLET, 220))
    p.setPen(QPen(QBrush(border_grad), 1.6))
    p.drawRoundedRect(card, 12, 12)

    # Status ribbon.
    status_col = {
        STATUS_IDLE: _NEON_BLUE,
        STATUS_ACTIVE: _NEON_GREEN,
        STATUS_PENDING: _NEON_AMBER,
        STATUS_ERROR: _NEON_RED,
    }.get(status, _NEON_BLUE)
    status_word = {
        STATUS_IDLE: "STANDBY",
        STATUS_ACTIVE: "● ACTIVE",
        STATUS_PENDING: "● PENDING",
        STATUS_ERROR: "● ERROR",
    }.get(status, "STANDBY")

    ribbon = QRectF(card.x() + 8, card.y() + 8, card.width() - 16, 22)
    rg = QLinearGradient(ribbon.topLeft(), ribbon.topRight())
    rg.setColorAt(0.0, _alpha(status_col, 60))
    rg.setColorAt(1.0, _alpha(status_col, 10))
    p.setBrush(QBrush(rg))
    p.setPen(QPen(_alpha(status_col, 120), 1))
    p.drawRoundedRect(ribbon, 6, 6)

    rib_font = QFont()
    rib_font.setPointSize(9)
    rib_font.setBold(True)
    p.setFont(rib_font)
    p.setPen(_TEXT_BRIGHT)
    p.drawText(
        ribbon.adjusted(10, 0, -10, 0),
        Qt.AlignVCenter | Qt.AlignLeft,
        status_word,
    )

    # Picture (emoji icon at large size).
    pic_x = card.x() + 14
    pic_y = card.y() + 38
    pic_size = 100.0
    pic_rect = QRectF(pic_x, pic_y, pic_size, pic_size)

    ring = QRadialGradient(pic_rect.center(), pic_size * 0.7)
    ring.setColorAt(0.0, _alpha(status_col, 90))
    ring.setColorAt(1.0, _alpha(status_col, 0))
    p.setBrush(QBrush(ring))
    p.setPen(Qt.NoPen)
    p.drawEllipse(pic_rect.adjusted(-6, -6, 6, 6))

    p.setBrush(QBrush(QColor(30, 36, 52)))
    p.setPen(QPen(_alpha(_TEXT_BRIGHT, 200), 1.4))
    p.drawEllipse(pic_rect)

    from desktop_app.widgets.agent_icons import paint_icon as _paint_icon
    icon_font = QFont()
    icon_font.setPointSizeF(pic_size * 0.65)
    p.setFont(icon_font)
    p.setPen(_TEXT_BRIGHT)
    _paint_icon(p, pic_rect, icon)

    # Name under the picture.
    name_font = QFont()
    name_font.setPointSize(11)
    name_font.setBold(True)
    p.setFont(name_font)
    p.setPen(_TEXT_BRIGHT)
    name_rect = QRectF(pic_x - 6, pic_y + pic_size + 6, pic_size + 12, 20)
    p.drawText(name_rect, Qt.AlignCenter, name)

    if model_label:
        model_font = QFont()
        model_font.setPointSize(8)
        p.setFont(model_font)
        p.setPen(_TEXT_DIM)
        model_rect = QRectF(pic_x - 6, pic_y + pic_size + 26, pic_size + 12, 16)
        p.drawText(model_rect, Qt.AlignCenter, model_label)

    if voice_label:
        # Voice line under the model line — same dim style so the eye
        # reads them as a "metadata stack" beneath the agent's name.
        voice_font = QFont()
        voice_font.setPointSize(8)
        p.setFont(voice_font)
        p.setPen(_TEXT_DIM)
        voice_rect = QRectF(pic_x - 6, pic_y + pic_size + 42, pic_size + 12, 16)
        # Truncate before drawing — long Piper voice IDs blow past the
        # 100 px column otherwise.
        fm = p.fontMetrics()
        label = f"🔊 {voice_label}"
        if fm.horizontalAdvance(label) > voice_rect.width():
            while label and fm.horizontalAdvance(label + "…") > voice_rect.width():
                label = label[:-1]
            label = label + "…" if label else ""
        p.drawText(voice_rect, Qt.AlignCenter, label)

    # Right half: description + skills.
    info_x = pic_x + pic_size + 18
    info_y = pic_y - 4
    info_w = card.x() + card.width() - 14 - info_x

    desc_font = QFont()
    desc_font.setPointSize(9)
    p.setFont(desc_font)
    p.setPen(_TEXT_BRIGHT)
    desc_rect = QRectF(info_x, info_y, info_w, 70)
    desc = description or "No description provided."
    if len(desc) > 220:
        desc = desc[:217] + "…"
    p.drawText(
        desc_rect,
        Qt.AlignTop | Qt.AlignLeft | Qt.TextWordWrap,
        desc,
    )

    skills_y = info_y + 80
    h_font = QFont()
    h_font.setPointSize(8)
    h_font.setBold(True)
    p.setFont(h_font)
    p.setPen(_TEXT_DIM)
    h_rect = QRectF(info_x, skills_y, info_w, 14)
    p.drawText(h_rect, Qt.AlignLeft, "SKILLS")

    skills_list = list(skills or [])
    chip_y = skills_y + 16
    chip_x = info_x
    chip_h = 18.0
    chip_pad_x = 10
    chip_gap = 6
    chip_font = QFont()
    chip_font.setPointSize(8)
    p.setFont(chip_font)

    shown = 0
    max_shown = 5
    chip_floor = card.y() + card.height() - 12 - CARD_PICKER_RESERVE
    for skill in skills_list:
        label = skill if len(skill) <= 24 else skill[:23] + "…"
        metrics = p.fontMetrics()
        w = metrics.horizontalAdvance(label) + 2 * chip_pad_x
        if chip_x + w > info_x + info_w:
            if shown >= max_shown:
                break
            chip_x = info_x
            chip_y += chip_h + chip_gap
            if chip_y + chip_h > chip_floor:
                break
        chip_rect = QRectF(chip_x, chip_y, w, chip_h)

        chip_bg = QLinearGradient(chip_rect.topLeft(), chip_rect.topRight())
        chip_bg.setColorAt(0.0, _alpha(_NEON_CYAN, 60))
        chip_bg.setColorAt(1.0, _alpha(_NEON_VIOLET, 60))
        p.setBrush(QBrush(chip_bg))
        p.setPen(QPen(_alpha(_NEON_CYAN, 160), 1))
        p.drawRoundedRect(chip_rect, 9, 9)
        p.setPen(_TEXT_BRIGHT)
        p.drawText(chip_rect, Qt.AlignCenter, label)

        chip_x += w + chip_gap
        shown += 1
        if shown >= max_shown:
            break

    remaining = max(0, len(skills_list) - shown)
    if remaining > 0:
        extra = f"+{remaining} more"
        metrics = p.fontMetrics()
        w = metrics.horizontalAdvance(extra) + 2 * chip_pad_x
        if chip_x + w > info_x + info_w:
            chip_x = info_x
            chip_y += chip_h + chip_gap
        if chip_y + chip_h <= chip_floor:
            more_rect = QRectF(chip_x, chip_y, w, chip_h)
            p.setBrush(QBrush(QColor(40, 46, 64, 200)))
            p.setPen(QPen(_alpha(_TEXT_DIM, 160), 1))
            p.drawRoundedRect(more_rect, 9, 9)
            p.setPen(_TEXT_DIM)
            p.drawText(more_rect, Qt.AlignCenter, extra)


def paint_team_card(
    p: QPainter,
    rect,
    *,
    team_name: str,
    team_description: str,
    agent_count: int,
    edge_count: int,
    owl_pixmap: Optional[QPixmap] = None,
) -> None:
    """Top-left card describing the team itself, shown when no agent is
    selected. Same gamey character-sheet visual language as the agent
    card so both canvases speak the same overlay grammar.

    Width / height match :func:`paint_agent_card` (minus the chips area)
    so the overlay model picker sits in the same rectangle regardless of
    which card is currently showing."""
    margin = 14
    card_w = min(360, rect.width() - 2 * margin)
    card_h = 244
    card = QRectF(margin, margin, card_w, card_h)

    bg = QLinearGradient(card.topLeft(), card.bottomRight())
    bg.setColorAt(0.0, QColor(18, 22, 34, 230))
    bg.setColorAt(1.0, QColor(8, 11, 18, 230))
    p.setBrush(QBrush(bg))
    border_grad = QLinearGradient(card.topLeft(), card.bottomRight())
    border_grad.setColorAt(0.0, _alpha(_NEON_CYAN, 220))
    border_grad.setColorAt(1.0, _alpha(_NEON_VIOLET, 220))
    p.setPen(QPen(QBrush(border_grad), 1.6))
    p.drawRoundedRect(card, 12, 12)

    ribbon = QRectF(card.x() + 8, card.y() + 8, card.width() - 16, 22)
    rg = QLinearGradient(ribbon.topLeft(), ribbon.topRight())
    rg.setColorAt(0.0, _alpha(_NEON_CYAN, 60))
    rg.setColorAt(1.0, _alpha(_NEON_VIOLET, 10))
    p.setBrush(QBrush(rg))
    p.setPen(QPen(_alpha(_NEON_CYAN, 120), 1))
    p.drawRoundedRect(ribbon, 6, 6)
    rib_font = QFont()
    rib_font.setPointSize(9)
    rib_font.setBold(True)
    p.setFont(rib_font)
    p.setPen(_TEXT_BRIGHT)
    p.drawText(
        ribbon.adjusted(10, 0, -10, 0),
        Qt.AlignVCenter | Qt.AlignLeft,
        "● TEAM",
    )

    pic_x = card.x() + 14
    pic_y = card.y() + 38
    pic_size = 100.0
    pic_rect = QRectF(pic_x, pic_y, pic_size, pic_size)
    ring = QRadialGradient(pic_rect.center(), pic_size * 0.7)
    ring.setColorAt(0.0, _alpha(_NEON_CYAN, 110))
    ring.setColorAt(1.0, _alpha(_NEON_CYAN, 0))
    p.setBrush(QBrush(ring))
    p.setPen(Qt.NoPen)
    p.drawEllipse(pic_rect.adjusted(-6, -6, 6, 6))
    p.setBrush(QBrush(QColor(30, 36, 52)))
    p.setPen(QPen(_alpha(_TEXT_BRIGHT, 200), 1.4))
    p.drawEllipse(pic_rect)

    if owl_pixmap is not None and not owl_pixmap.isNull():
        target = pic_size * 0.85
        scaled = owl_pixmap.scaled(
            int(target), int(target),
            Qt.KeepAspectRatio, Qt.SmoothTransformation,
        )
        p.drawPixmap(
            QPointF(
                pic_rect.center().x() - scaled.width() / 2,
                pic_rect.center().y() - scaled.height() / 2,
            ),
            scaled,
        )
    else:
        icon_font = QFont()
        icon_font.setPointSizeF(pic_size * 0.65)
        p.setFont(icon_font)
        p.setPen(_TEXT_BRIGHT)
        p.drawText(pic_rect, Qt.AlignCenter, "🧠")

    name_font = QFont()
    name_font.setPointSize(11)
    name_font.setBold(True)
    p.setFont(name_font)
    p.setPen(_TEXT_BRIGHT)
    name_rect = QRectF(pic_x - 6, pic_y + pic_size + 6, pic_size + 12, 20)
    p.drawText(name_rect, Qt.AlignCenter, team_name or "Untitled team")

    info_x = pic_x + pic_size + 18
    info_y = pic_y - 4
    info_w = card.x() + card.width() - 14 - info_x

    desc_font = QFont()
    desc_font.setPointSize(9)
    p.setFont(desc_font)
    p.setPen(_TEXT_BRIGHT)
    desc_rect = QRectF(info_x, info_y, info_w, 96)
    desc = team_description or "No team description provided."
    if len(desc) > 240:
        desc = desc[:237] + "…"
    p.drawText(
        desc_rect,
        Qt.AlignTop | Qt.AlignLeft | Qt.TextWordWrap,
        desc,
    )

    # Push stats above the picker reserve area at the bottom of the card.
    stat_y = card.y() + card.height() - 38 - CARD_PICKER_RESERVE
    h_font = QFont()
    h_font.setPointSize(8)
    h_font.setBold(True)
    p.setFont(h_font)
    p.setPen(_TEXT_DIM)
    p.drawText(QRectF(info_x, stat_y, info_w, 14), Qt.AlignLeft, "AGENTS")
    p.drawText(QRectF(info_x + 90, stat_y, info_w, 14), Qt.AlignLeft, "CONNECTIONS")

    v_font = QFont()
    v_font.setPointSize(11)
    v_font.setBold(True)
    p.setFont(v_font)
    p.setPen(_TEXT_BRIGHT)
    p.drawText(QRectF(info_x, stat_y + 14, info_w, 18), Qt.AlignLeft, str(agent_count))
    p.drawText(QRectF(info_x + 90, stat_y + 14, info_w, 18), Qt.AlignLeft, str(edge_count))
