"""Animated boot loader for the Agentic Team page.

Shown while the Requirements scan is still resolving (~1-2 minutes on a
fresh start because every critical package is probed via ``pip list``
plus per-package import smoke-tests). The user said it's a long wait —
make the wait feel intentional instead of hung.

Visual: an OWLLM crest in the centre with two counter-rotating rings,
surrounded by a hex constellation of agent nodes. Light pulses travel
along the inter-node beams. A status line below picks up live updates
from whatever's actually running (which package is being probed, etc.).

Pure ``QWidget`` + ``paintEvent`` + ``QTimer`` — no QGraphicsScene
heavyweight, no external animation framework. ~30 fps paint loop, low
CPU when off-screen because Qt suspends paints for hidden widgets.
"""
from __future__ import annotations

import math
import random
from pathlib import Path
from typing import List, Optional, Tuple

from PySide6.QtCore import QPointF, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
    QRadialGradient,
)
from PySide6.QtWidgets import QSizePolicy, QWidget


# Theme — neon cyan / violet on near-black.
_BG_DARK = QColor("#0a0d14")
_BG_GRAD_TOP = QColor("#101522")
_BG_GRAD_BOT = QColor("#06080d")

_NEON_CYAN = QColor("#5cf0ff")
_NEON_BLUE = QColor("#74a4ff")
_NEON_VIOLET = QColor("#c08aff")
_NEON_PINK = QColor("#ff7ed1")
_NEON_GREEN = QColor("#7dff9b")

_TEXT_BRIGHT = QColor("#e6f0ff")
_TEXT_DIM = QColor("#7888a8")


def _mix(a: QColor, b: QColor, t: float) -> QColor:
    t = max(0.0, min(1.0, t))
    return QColor(
        int(a.red() + (b.red() - a.red()) * t),
        int(a.green() + (b.green() - a.green()) * t),
        int(a.blue() + (b.blue() - a.blue()) * t),
        int(a.alpha() + (b.alpha() - a.alpha()) * t),
    )


def _alpha(c: QColor, a: int) -> QColor:
    return QColor(c.red(), c.green(), c.blue(), max(0, min(255, a)))


_ACRONYMS = {"ux", "ui", "api", "mcp", "gpu", "be", "fe", "qa", "cli", "sql", "db"}


def _display_label(full_name: str) -> str:
    short = (full_name or "").rsplit(".", 1)[-1]
    if not short:
        return full_name
    words = []
    for w in short.replace("-", "_").split("_"):
        w = w.strip()
        if not w:
            continue
        words.append(w.upper() if w.lower() in _ACRONYMS else w.capitalize())
    return " ".join(words) or full_name


class AgentCanvasLoader(QWidget):
    """Animated loading splash for the Agents page.

    Use ``set_agent_names(...)`` to sync the constellation to the actual
    project team. Use ``set_status(text)`` to update the line shown under
    the crest as the underlying scan progresses. Emit-able convenience:
    connect ``RequirementCheckThread.package_checked`` to a slot that
    forwards `pkg_name` here.
    """

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMinimumSize(420, 320)
        self.setAttribute(Qt.WA_StyledBackground, False)
        self.setAutoFillBackground(False)

        self._phase = 0.0
        self._status_text = "Booting agent runtime…"
        self._sub_text = "Resolving the cu121 profile env, probing packages, warming up the bus."
        self._agent_names: List[str] = ["orchestrator", "researcher", "coder", "operator", "critic", "scribe"]

        # Background star field — fixed positions so it doesn't crawl
        # randomly each frame, but each star has its own twinkle phase.
        self._stars: List[Tuple[float, float, float, float]] = []
        rng = random.Random(0xBEEF)
        for _ in range(80):
            self._stars.append((
                rng.random(),                     # x in [0, 1]
                rng.random(),                     # y in [0, 1]
                0.7 + rng.random() * 1.6,         # size px
                rng.random() * math.tau,          # twinkle phase offset
            ))

        # Pulse particles travel along beams. Each is (beam_index, t_offset).
        self._pulses: List[Tuple[int, float]] = []
        for i in range(12):
            self._pulses.append((i % 6, (i * 0.18) % 1.0))

        # Owl crest pixmap — replaces the old 🦉 emoji glyph in the centre.
        # Loaded once and re-scaled per paint via Qt's smooth-transformation
        # path so the file IO doesn't rerun every frame. Falls back to the
        # emoji draw if the asset is missing.
        self._owl_pixmap: Optional[QPixmap] = None
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
                    self._owl_pixmap = pm
        except Exception:
            self._owl_pixmap = None

        self._timer = QTimer(self)
        self._timer.setInterval(33)  # ~30 fps
        self._timer.timeout.connect(self._tick)
        self._timer.start()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def set_status(self, text: str) -> None:
        if text and text != self._status_text:
            self._status_text = text
            self.update()

    def set_sub_status(self, text: str) -> None:
        if text != self._sub_text:
            self._sub_text = text
            self.update()

    def set_agent_names(self, names: List[str]) -> None:
        names = list(names) if names else []
        if not names:
            names = ["orchestrator"]
        # Cap displayed nodes so the constellation stays readable.
        if len(names) > 8:
            names = names[:8]
        self._agent_names = names
        self.update()

    def stop(self) -> None:
        """Halt the animation timer. Called when the page swaps the loader out."""
        self._timer.stop()

    # ------------------------------------------------------------------
    # Animation tick
    # ------------------------------------------------------------------

    def _tick(self) -> None:
        self._phase = (self._phase + 0.012) % math.tau
        for i, (beam_i, t) in enumerate(self._pulses):
            t = (t + 0.011 + (beam_i % 3) * 0.001) % 1.0
            self._pulses[i] = (beam_i, t)
        self.update()

    # ------------------------------------------------------------------
    # Painting
    # ------------------------------------------------------------------

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHints(QPainter.Antialiasing | QPainter.TextAntialiasing | QPainter.SmoothPixmapTransform)

        rect = self.rect()
        self._paint_background(p, rect)
        self._paint_starfield(p, rect)

        cx = rect.width() / 2.0
        cy = rect.height() / 2.0 - 18  # leave room below for status text

        radius = min(rect.width(), rect.height() * 1.4) * 0.32
        node_positions = self._compute_node_positions(cx, cy, radius)

        # Draw beams (under nodes).
        self._paint_beams(p, cx, cy, node_positions)

        # Draw the central crest.
        self._paint_crest(p, cx, cy, radius * 0.36)

        # Draw nodes on top.
        self._paint_nodes(p, node_positions)

        # Status text below the crest.
        self._paint_status_text(p, rect, cy + radius + 30)

    def _paint_background(self, p: QPainter, rect: QRectF) -> None:
        grad = QLinearGradient(0, 0, 0, rect.height())
        grad.setColorAt(0.0, _BG_GRAD_TOP)
        grad.setColorAt(1.0, _BG_GRAD_BOT)
        p.fillRect(rect, QBrush(grad))

        # Soft vignette of cyan/violet.
        glow = QRadialGradient(
            QPointF(rect.width() / 2, rect.height() / 2),
            max(rect.width(), rect.height()) * 0.7,
        )
        glow.setColorAt(0.0, _alpha(_NEON_VIOLET, 22))
        glow.setColorAt(0.5, _alpha(_NEON_BLUE, 12))
        glow.setColorAt(1.0, _alpha(_BG_DARK, 0))
        p.fillRect(rect, QBrush(glow))

    def _paint_starfield(self, p: QPainter, rect: QRectF) -> None:
        w, h = rect.width(), rect.height()
        for x_n, y_n, size, ph in self._stars:
            twinkle = 0.5 + 0.5 * math.sin(self._phase * 2.0 + ph)
            alpha = int(60 + 140 * twinkle)
            col = _alpha(_NEON_CYAN if (ph * 13) % 1 < 0.5 else _TEXT_BRIGHT, alpha)
            p.setBrush(QBrush(col))
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(x_n * w, y_n * h), size, size)

    def _compute_node_positions(self, cx: float, cy: float, radius: float) -> List[QPointF]:
        n = len(self._agent_names)
        positions = []
        # Slow orbital rotation so the constellation feels alive.
        rot = self._phase * 0.35
        for i, _ in enumerate(self._agent_names):
            theta = (math.tau * i) / n + rot - math.pi / 2  # start at top
            x = cx + radius * math.cos(theta)
            y = cy + radius * math.sin(theta)
            positions.append(QPointF(x, y))
        return positions

    def _paint_beams(self, p: QPainter, cx: float, cy: float, positions: List[QPointF]) -> None:
        centre = QPointF(cx, cy)

        # Spokes from centre to each node.
        for i, pos in enumerate(positions):
            grad = QLinearGradient(centre, pos)
            grad.setColorAt(0.0, _alpha(_NEON_CYAN, 110))
            grad.setColorAt(1.0, _alpha(_NEON_BLUE, 30))
            pen = QPen(QBrush(grad), 1.4)
            pen.setCapStyle(Qt.RoundCap)
            p.setPen(pen)
            p.drawLine(centre, pos)

        # Adjacent ring connections — softer, dotted feel.
        n = len(positions)
        for i in range(n):
            a = positions[i]
            b = positions[(i + 1) % n]
            grad = QLinearGradient(a, b)
            grad.setColorAt(0.0, _alpha(_NEON_VIOLET, 90))
            grad.setColorAt(1.0, _alpha(_NEON_PINK, 90))
            pen = QPen(QBrush(grad), 1.0)
            pen.setStyle(Qt.DashLine)
            p.setPen(pen)
            p.drawLine(a, b)

        # Travelling light pulses along the spokes.
        for beam_i, t in self._pulses:
            if beam_i >= n:
                continue
            target = positions[beam_i]
            x = cx + (target.x() - cx) * t
            y = cy + (target.y() - cy) * t
            head_alpha = int(255 * (1.0 - abs(0.5 - t) * 1.2))
            head_alpha = max(40, head_alpha)
            head_col = _alpha(_mix(_NEON_CYAN, _NEON_VIOLET, t), head_alpha)

            # Soft halo first.
            grad = QRadialGradient(QPointF(x, y), 16)
            grad.setColorAt(0.0, _alpha(head_col, 200))
            grad.setColorAt(1.0, _alpha(head_col, 0))
            p.setBrush(QBrush(grad))
            p.setPen(Qt.NoPen)
            p.drawEllipse(QPointF(x, y), 14, 14)

            # Bright core.
            p.setBrush(QBrush(head_col))
            p.drawEllipse(QPointF(x, y), 3.0, 3.0)

    def _paint_crest(self, p: QPainter, cx: float, cy: float, r: float) -> None:
        # Outer rotating ring.
        outer = QRectF(cx - r, cy - r, r * 2, r * 2)
        pen = QPen(_alpha(_NEON_CYAN, 220), 2.4)
        p.setPen(pen)
        p.setBrush(Qt.NoBrush)
        start_deg = -int(math.degrees(self._phase * 0.9)) % 360
        # Draw three arcs to leave gaps for that "loading" look.
        for arc_offset in (0, 130, 240):
            p.drawArc(outer, (start_deg + arc_offset) * 16, 60 * 16)

        # Inner counter-rotating ring.
        inner = QRectF(cx - r * 0.7, cy - r * 0.7, r * 1.4, r * 1.4)
        pen2 = QPen(_alpha(_NEON_VIOLET, 200), 1.8)
        p.setPen(pen2)
        start_deg2 = int(math.degrees(self._phase * 1.6)) % 360
        for arc_offset in (0, 110, 230):
            p.drawArc(inner, (start_deg2 + arc_offset) * 16, 70 * 16)

        # Soft glowing core.
        core = QRadialGradient(QPointF(cx, cy), r * 0.8)
        pulse = 0.5 + 0.5 * math.sin(self._phase * 2.6)
        core.setColorAt(0.0, _alpha(_NEON_CYAN, int(80 + 60 * pulse)))
        core.setColorAt(0.6, _alpha(_NEON_BLUE, int(30 + 30 * pulse)))
        core.setColorAt(1.0, _alpha(_BG_DARK, 0))
        p.setBrush(QBrush(core))
        p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(cx, cy), r * 0.78, r * 0.78)

        # Centre glyph — owl_agentic crest as a pixmap, with the emoji
        # path kept as a fallback for environments where the asset can't
        # be located.
        if self._owl_pixmap is not None and not self._owl_pixmap.isNull():
            target = r * 1.5  # fit comfortably inside the glowing core
            scaled = self._owl_pixmap.scaled(
                int(target),
                int(target),
                Qt.KeepAspectRatio,
                Qt.SmoothTransformation,
            )
            p.drawPixmap(
                QPointF(cx - scaled.width() / 2, cy - scaled.height() / 2),
                scaled,
            )
        else:
            font = QFont()
            font.setPointSizeF(max(20.0, r * 0.85))
            p.setFont(font)
            p.setPen(_TEXT_BRIGHT)
            glyph_rect = QRectF(cx - r, cy - r, r * 2, r * 2)
            p.drawText(glyph_rect, Qt.AlignCenter, "🦉")

    def _paint_nodes(self, p: QPainter, positions: List[QPointF]) -> None:
        for i, pos in enumerate(positions):
            name = self._agent_names[i] if i < len(self._agent_names) else f"agent{i}"
            phase_offset = i * 0.7
            pulse = 0.5 + 0.5 * math.sin(self._phase * 2.2 + phase_offset)
            r = 14 + 4 * pulse

            # Halo.
            grad = QRadialGradient(pos, r * 2.2)
            grad.setColorAt(0.0, _alpha(_NEON_CYAN, int(120 + 70 * pulse)))
            grad.setColorAt(1.0, _alpha(_NEON_CYAN, 0))
            p.setBrush(QBrush(grad))
            p.setPen(Qt.NoPen)
            p.drawEllipse(pos, r * 2.0, r * 2.0)

            # Core disc.
            p.setBrush(QBrush(_mix(_NEON_BLUE, _NEON_VIOLET, (i / max(1, len(positions))))))
            pen = QPen(_alpha(_TEXT_BRIGHT, 220), 1.8)
            p.setPen(pen)
            p.drawEllipse(pos, r, r)

            # Label below.
            p.setPen(_TEXT_BRIGHT)
            font = QFont()
            font.setPointSize(9)
            font.setBold(True)
            p.setFont(font)
            label_rect = QRectF(pos.x() - 80, pos.y() + r + 4, 160, 18)
            p.drawText(label_rect, Qt.AlignCenter, _display_label(name))

    def _paint_status_text(self, p: QPainter, rect: QRectF, y: float) -> None:
        # Main status — bigger, brighter.
        font_main = QFont()
        font_main.setPointSize(13)
        font_main.setBold(True)
        p.setFont(font_main)

        # Animated ellipsis on the status line.
        dots = "." * (1 + int((self._phase * 1.5) % 3))
        text = f"{self._status_text}{dots}"

        p.setPen(_TEXT_BRIGHT)
        main_rect = QRectF(0, y, rect.width(), 22)
        p.drawText(main_rect, Qt.AlignCenter, text)

        # Sub status — dimmer, smaller, often updated with the package being probed.
        font_sub = QFont()
        font_sub.setPointSize(10)
        p.setFont(font_sub)
        p.setPen(_TEXT_DIM)
        sub_rect = QRectF(0, y + 26, rect.width(), 20)
        p.drawText(sub_rect, Qt.AlignCenter, self._sub_text)

        # Heartbeat bar — a moving cyan sweep so the eye knows nothing's frozen
        # even when the status text doesn't change for a while.
        bar_w = min(280, rect.width() * 0.5)
        bar_x = (rect.width() - bar_w) / 2
        bar_y = y + 50
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(_alpha(_NEON_BLUE, 32)))
        p.drawRoundedRect(QRectF(bar_x, bar_y, bar_w, 4), 2, 2)
        sweep_t = (math.sin(self._phase * 1.3) + 1) / 2  # 0..1
        sweep_w = bar_w * 0.32
        sweep_x = bar_x + (bar_w - sweep_w) * sweep_t
        grad = QLinearGradient(sweep_x, 0, sweep_x + sweep_w, 0)
        grad.setColorAt(0.0, _alpha(_NEON_CYAN, 0))
        grad.setColorAt(0.5, _alpha(_NEON_CYAN, 230))
        grad.setColorAt(1.0, _alpha(_NEON_VIOLET, 0))
        p.setBrush(QBrush(grad))
        p.drawRoundedRect(QRectF(sweep_x, bar_y, sweep_w, 4), 2, 2)
