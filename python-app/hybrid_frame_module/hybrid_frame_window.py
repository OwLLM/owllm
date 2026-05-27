
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, QPoint, QRect, QSize, QEvent
from PySide6.QtGui import QPainter, QPixmap, QPen, QColor
from PySide6.QtWidgets import QWidget, QVBoxLayout


@dataclass
class FrameAssets:
    corner_tl: Optional[str] = None
    corner_tr: Optional[str] = None
    corner_bl: Optional[str] = None
    corner_br: Optional[str] = None
    top_center: Optional[str] = None


class HybridFrameWindow(QWidget):
    """
    Outer frameless window that:
      - renders a decorative frame (hybrid: code + images)
      - provides drag + resize behavior
      - hosts your existing UI inside `content_container`
    """

    def __init__(
        self,
        assets: FrameAssets | None = None,
        *,
        corner_size: int = 96,
        border_thickness: int = 12,
        resize_margin: int = 14,
        safe_padding: int = 8,
        min_size: QSize = QSize(520, 360),
        frame_color: QColor = QColor(200, 240, 255, 220),
        frame_accent: QColor = QColor(120, 220, 255, 200),
    ) -> None:
        super().__init__()

        self.setWindowFlags(
            Qt.Window
            | Qt.FramelessWindowHint
            | Qt.WindowMinimizeButtonHint
            | Qt.WindowSystemMenuHint
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setMouseTracking(True)
        self.setMinimumSize(min_size)

        self.corner_size = int(corner_size)
        self.border_thickness = int(border_thickness)
        self.resize_margin = int(resize_margin)
        self.safe_padding = int(safe_padding)

        # Visual tuning (can be overridden)
        self.frame_color = frame_color
        self.frame_accent = frame_accent

        # --- assets ---
        self._assets = assets or FrameAssets()
        self.corner_tl = self._load_pixmap(self._assets.corner_tl)
        self.corner_tr = self._load_pixmap(self._assets.corner_tr)
        self.corner_bl = self._load_pixmap(self._assets.corner_bl)
        self.corner_br = self._load_pixmap(self._assets.corner_br)
        self.top_center = self._load_pixmap(self._assets.top_center)

        # --- content container ---
        # This is where you mount your existing app UI.
        self.content_container = QWidget(self)
        self.content_container.setObjectName("HybridFrameContent")
        self.content_container.setAttribute(Qt.WA_StyledBackground, True)

        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(0, 0, 0, 0)
        self._layout.addWidget(self.content_container)

        # Default content margins so the UI never overlaps corners/frame.
        self._apply_content_margins()

        # --- drag/resize state ---
        self._dragging = False
        self._drag_offset = QPoint(0, 0)

        self._resizing = False
        self._resize_dir = 0  # bitmask: L=1 R=2 T=4 B=8
        self._press_global = QPoint(0, 0)
        self._press_geom = QRect()

        self._cursor_by_dir = {
            1 | 4: Qt.SizeFDiagCursor,  # L+T
            2 | 8: Qt.SizeFDiagCursor,  # R+B
            2 | 4: Qt.SizeBDiagCursor,  # R+T
            1 | 8: Qt.SizeBDiagCursor,  # L+B
            1: Qt.SizeHorCursor,
            2: Qt.SizeHorCursor,
            4: Qt.SizeVerCursor,
            8: Qt.SizeVerCursor,
            0: Qt.ArrowCursor,
        }

        # Keep margins correct if device pixel ratio / style changes
        self.installEventFilter(self)

    # ----------------------------
    # Public API
    # ----------------------------
    def set_content_widget(self, widget: QWidget) -> None:
        """
        Mount an existing widget (your current main UI) inside the frame.
        Example:
            frame = HybridFrameWindow(...)
            frame.set_content_widget(existing_main_widget)
        """
        widget.setParent(self.content_container)
        layout = self.content_container.layout()
        if layout is None:
            layout = QVBoxLayout(self.content_container)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(0)
        # Clear existing
        while layout.count():
            item = layout.takeAt(0)
            w = item.widget()
            if w is not None:
                w.setParent(None)
        layout.addWidget(widget)

    def set_assets(self, assets: FrameAssets) -> None:
        self._assets = assets
        self.corner_tl = self._load_pixmap(self._assets.corner_tl)
        self.corner_tr = self._load_pixmap(self._assets.corner_tr)
        self.corner_bl = self._load_pixmap(self._assets.corner_bl)
        self.corner_br = self._load_pixmap(self._assets.corner_br)
        self.top_center = self._load_pixmap(self._assets.top_center)
        self.update()

    def set_frame_geometry_params(
        self,
        *,
        corner_size: int | None = None,
        border_thickness: int | None = None,
        resize_margin: int | None = None,
        safe_padding: int | None = None,
    ) -> None:
        if corner_size is not None:
            self.corner_size = int(corner_size)
        if border_thickness is not None:
            self.border_thickness = int(border_thickness)
        if resize_margin is not None:
            self.resize_margin = int(resize_margin)
        if safe_padding is not None:
            self.safe_padding = int(safe_padding)
        self._apply_content_margins()
        self.update()

    # ----------------------------
    # Layout helpers
    # ----------------------------
    def _apply_content_margins(self) -> None:
        """
        Creates a safe region for the real UI so it doesn't overlap:
          - the decorative border
          - the corner images
        """
        # The corner images are fixed-size squares; keep UI outside them.
        m = max(self.corner_size, self.border_thickness) + self.safe_padding
        self.content_container.setGeometry(
            QRect(m, m, max(0, self.width() - 2 * m), max(0, self.height() - 2 * m))
        )

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._apply_content_margins()

    def eventFilter(self, obj, event) -> bool:
        if obj is self and event.type() in (QEvent.Polish, QEvent.StyleChange):
            self._apply_content_margins()
        return super().eventFilter(obj, event)

    # ----------------------------
    # Painting
    # ----------------------------
    def paintEvent(self, event) -> None:
        w, h = self.width(), self.height()
        cs = self.corner_size
        t = self.border_thickness

        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)

        outer = QRect(0, 0, w, h)
        inner = QRect(t, t, w - 2 * t, h - 2 * t)

        # Base outline
        p.setPen(QPen(self.frame_color, 1))
        p.drawRoundedRect(outer.adjusted(1, 1, -2, -2), 14, 14)

        # Inner outline (accent)
        p.setPen(QPen(self.frame_accent, 1))
        p.drawRoundedRect(inner, 10, 10)

        # Futuristic brackets and ticks
        p.setPen(QPen(self.frame_accent, 1))
        self._draw_corner_brackets(p, outer, length=36, inset=14)
        self._draw_edge_ticks(p, outer, tick_len=18, inset=10)

        # Corner images
        self._draw_corner_pix(p, self.corner_tl, QRect(0, 0, cs, cs))
        self._draw_corner_pix(p, self.corner_tr, QRect(w - cs, 0, cs, cs))
        self._draw_corner_pix(p, self.corner_bl, QRect(0, h - cs, cs, cs))
        self._draw_corner_pix(p, self.corner_br, QRect(w - cs, h - cs, cs, cs))

        # Top-center badge image
        if self.top_center and not self.top_center.isNull():
            # Requirement: top-center badge is 300 px wide (logical
            # px). Vertical placement unchanged — height grows with
            # the corner-size baseline so the new wider badge keeps
            # the same proportions as before.
            badge_w = 300
            badge_h = int(cs * 1.30)
            x = (w - badge_w) // 2
            y = max(0, t // 2)
            target = QRect(x, y, badge_w, badge_h)

            # HiDPI-safe scaling: scale in device pixels, then center in target rect.
            dpr = float(self.devicePixelRatioF()) if hasattr(self, "devicePixelRatioF") else 1.0
            scaled = self.top_center.scaledToWidth(int(badge_w * dpr), Qt.SmoothTransformation)
            scaled.setDevicePixelRatio(dpr)
            size = scaled.deviceIndependentSize()
            px = target.x() + (target.width() - int(size.width())) // 2
            py = target.y() + (target.height() - int(size.height())) // 2
            p.drawPixmap(px, py, scaled)

    def _draw_corner_brackets(self, p: QPainter, r: QRect, *, length: int, inset: int) -> None:
        x1, y1, x2, y2 = r.left(), r.top(), r.right(), r.bottom()
        i = inset
        L = length

        # TL
        p.drawLine(x1 + i, y1 + i, x1 + i + L, y1 + i)
        p.drawLine(x1 + i, y1 + i, x1 + i, y1 + i + L)
        # TR
        p.drawLine(x2 - i, y1 + i, x2 - i - L, y1 + i)
        p.drawLine(x2 - i, y1 + i, x2 - i, y1 + i + L)
        # BL
        p.drawLine(x1 + i, y2 - i, x1 + i + L, y2 - i)
        p.drawLine(x1 + i, y2 - i, x1 + i, y2 - i - L)
        # BR
        p.drawLine(x2 - i, y2 - i, x2 - i - L, y2 - i)
        p.drawLine(x2 - i, y2 - i, x2 - i, y2 - i - L)

    def _draw_edge_ticks(self, p: QPainter, r: QRect, *, tick_len: int, inset: int) -> None:
        midx = (r.left() + r.right()) // 2
        midy = (r.top() + r.bottom()) // 2
        i = inset
        L = tick_len

        p.drawLine(midx - L // 2, r.top() + i, midx + L // 2, r.top() + i)
        p.drawLine(midx - L // 2, r.bottom() - i, midx + L // 2, r.bottom() - i)
        p.drawLine(r.left() + i, midy - L // 2, r.left() + i, midy + L // 2)
        p.drawLine(r.right() - i, midy - L // 2, r.right() - i, midy + L // 2)

    def _draw_corner_pix(self, p: QPainter, pix: Optional[QPixmap], target: QRect) -> None:
        if pix is None or pix.isNull():
            return
        self._draw_scaled(p, pix, target)

    def _draw_scaled(self, p: QPainter, pix: QPixmap, target: QRect) -> None:
        scaled = pix.scaled(target.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation)
        x = target.x() + (target.width() - scaled.width()) // 2
        y = target.y() + (target.height() - scaled.height()) // 2
        p.drawPixmap(x, y, scaled)

    # ----------------------------
    # Drag + Resize
    # ----------------------------
    def mousePressEvent(self, event) -> None:
        if event.button() != Qt.LeftButton:
            return

        d = self._hit_test_resize(event.pos())
        if d != 0:
            self._resizing = True
            self._resize_dir = d
            self._press_global = event.globalPosition().toPoint()
            self._press_geom = self.geometry()
            event.accept()
            return

        # Drag only if not clicking inside content (so widgets still work)
        if self._is_in_content(event.pos()):
            return

        self._dragging = True
        self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
        event.accept()

    def mouseMoveEvent(self, event) -> None:
        if self._resizing:
            self._apply_resize(event.globalPosition().toPoint())
            event.accept()
            return

        if self._dragging:
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            event.accept()
            return

        d = self._hit_test_resize(event.pos())
        self.setCursor(self._cursor_by_dir.get(d, Qt.ArrowCursor))

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self._dragging = False
            self._resizing = False
            self._resize_dir = 0
            self.setCursor(Qt.ArrowCursor)

    def _is_in_content(self, pos) -> bool:
        return self.content_container.geometry().contains(pos)

    def _hit_test_resize(self, pos) -> int:
        m = self.resize_margin
        r = self.rect()

        left = pos.x() <= m
        right = pos.x() >= r.width() - m
        top = pos.y() <= m
        bottom = pos.y() >= r.height() - m

        d = 0
        if left:
            d |= 1
        if right:
            d |= 2
        if top:
            d |= 4
        if bottom:
            d |= 8
        return d

    def _apply_resize(self, global_pos: QPoint) -> None:
        dx = global_pos.x() - self._press_global.x()
        dy = global_pos.y() - self._press_global.y()

        g = QRect(self._press_geom)
        minw = self.minimumWidth()
        minh = self.minimumHeight()

        if self._resize_dir & 1:  # Left
            new_left = g.left() + dx
            max_left = g.right() - minw
            g.setLeft(min(new_left, max_left))
        if self._resize_dir & 2:  # Right
            new_right = g.right() + dx
            min_right = g.left() + minw
            g.setRight(max(new_right, min_right))
        if self._resize_dir & 4:  # Top
            new_top = g.top() + dy
            max_top = g.bottom() - minh
            g.setTop(min(new_top, max_top))
        if self._resize_dir & 8:  # Bottom
            new_bottom = g.bottom() + dy
            min_bottom = g.top() + minh
            g.setBottom(max(new_bottom, min_bottom))

        self.setGeometry(g)

    # ----------------------------
    # Utils
    # ----------------------------
    def _load_pixmap(self, path: Optional[str]) -> Optional[QPixmap]:
        if not path:
            return None
        p = Path(path)
        if not p.exists():
            return None
        pm = QPixmap(str(p))
        return pm
