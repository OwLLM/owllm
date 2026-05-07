
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, QPoint, QRect, QSize, QEvent, QTimer
from PySide6.QtGui import QPainter, QPixmap, QPen, QColor
from PySide6.QtWidgets import QApplication, QWidget, QVBoxLayout


@dataclass
class FrameAssets:
    corner_tl: Optional[str] = None
    corner_tr: Optional[str] = None
    corner_bl: Optional[str] = None
    corner_br: Optional[str] = None  # Background layer (CornersNew/corner_br.png) — drawn under the per-tab owl image
    top_center: Optional[str] = None


# Top-center badge geometry. The overlay window has to extend
# ``BADGE_H // 2`` px above the parent's top edge so the badge can
# render above the title bar without being clipped — keep these in
# sync with the badge_w used in paintEvent's top-center block.
BADGE_W = 300
BADGE_H = int(BADGE_W * 0.65)

# Extra room the overlay reserves on every side beyond ``shift_out``
# so the corner crests can be drawn shifted outward without being
# clipped by the overlay rectangle. Must match the ``corner_outset``
# value in paintEvent below.
#
# Modest 10 px — enough that the corner crests visibly overlap the
# parent-window edge again, but small enough that the overlay's
# left/top edge stays on-screen even when the parent window is
# pushed against the desktop top-left (which is what made 22 px
# clip TL/BL last time).
CORNER_OUTSET = 10


class HybridFrameWindow(QWidget):
    """
    Pure decorative overlay window that:
      - renders a decorative frame (hybrid: code + images) 
      - provides resize behavior for parent window
      - is transparent in the center (click-through to parent)
      - syncs position/size with parent MainWindow
    """

    def __init__(
        self,
        assets: FrameAssets | None = None,
        *,
        corner_size: int = 96,
        border_thickness: int = 12,
        resize_margin: int = 8,
        safe_padding: int = 8,
        min_size: QSize = QSize(520, 360),
        frame_color: QColor = QColor(200, 240, 255, 220),
        frame_accent: QColor = QColor(120, 220, 255, 200),
        parent_window: QWidget | None = None,
    ) -> None:
        super().__init__()

        # Store reference to parent window
        self.parent_window = parent_window
        
        self.setWindowFlags(
            Qt.Tool  # Tool window stays on top of parent but not all windows
            | Qt.FramelessWindowHint
        )
        # Need transparency to show main window through center
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, False)  # We'll handle mouse events selectively
        self.setMouseTracking(True)
        self.setMinimumSize(min_size)

        self.corner_size = int(corner_size)
        self.border_thickness = int(border_thickness)
        self.resize_margin = int(resize_margin)
        self.safe_padding = int(safe_padding)

        # Visual tuning (can be overridden)
        self.frame_color = frame_color
        self.frame_accent = frame_accent
        self.frame_bg_color = QColor("#0e1117")  # Default dark background

        # --- assets ---
        self._assets = assets or FrameAssets()
        self.corner_tl = self._load_pixmap(self._assets.corner_tl)
        self.corner_tr = self._load_pixmap(self._assets.corner_tr)
        self.corner_bl = self._load_pixmap(self._assets.corner_bl)
        # corner_br_bg = static background crest from CornersNew/corner_br.png.
        # corner_br = per-tab owl image, set dynamically via set_corner_br().
        self.corner_br_bg = self._load_pixmap(self._assets.corner_br)
        self.corner_br = None
        self.top_center = self._load_pixmap(self._assets.top_center)

        # --- resize state ---
        self._resizing = False
        self._resize_dir = 0  # bitmask: L=1 R=2 T=4 B=8
        self._press_global = QPoint(0, 0)
        self._press_geom = QRect()

        # --- corner-image click-to-snap rects (populated by paintEvent) ---
        # The decorative images at the top-left, top-center and top-right
        # double as window-snap shortcuts:
        #   TL → left half of screen (full height)
        #   TC → half-size, centered
        #   TR → right half of screen (full height)
        self._tl_click_rect = QRect()
        self._tc_click_rect = QRect()
        self._tr_click_rect = QRect()

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

        # Connect to parent window events to sync position/size
        if self.parent_window:
            self.parent_window.installEventFilter(self)
            # Timer to periodically check if parent is active and raise frame
            self._raise_timer = QTimer()
            self._raise_timer.timeout.connect(self._check_and_raise)
            self._raise_timer.start(100)  # Check every 100ms

    # ----------------------------
    # Public API
    # ----------------------------
    def set_assets(self, assets: FrameAssets) -> None:
        self._assets = assets
        self.corner_tl = self._load_pixmap(self._assets.corner_tl)
        self.corner_tr = self._load_pixmap(self._assets.corner_tr)
        self.corner_bl = self._load_pixmap(self._assets.corner_bl)
        # Reload the static background from the new assets bundle.
        self.corner_br_bg = self._load_pixmap(self._assets.corner_br)
        # corner_br is the per-tab owl image — keep whatever the caller
        # already pushed via set_corner_br(), don't overwrite.
        if not hasattr(self, 'corner_br') or self.corner_br is None:
            self.corner_br = None
        self.top_center = self._load_pixmap(self._assets.top_center)
        self.update()
    
    def set_corner_br(self, path: str | None) -> None:
        """Update only the corner_br image."""
        self.corner_br = self._load_pixmap(path)
        if self._assets:
            self._assets.corner_br = path
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
        self.update()
    
    def set_frame_colors(self, frame_color: QColor, frame_accent: QColor, bg_color: QColor = None) -> None:
        """Update frame colors and repaint."""
        self.frame_color = frame_color
        self.frame_accent = frame_accent
        if bg_color is not None:
            self.frame_bg_color = bg_color
        self.update()

    # ----------------------------
    # Position syncing
    # ----------------------------
    def eventFilter(self, obj, event) -> bool:
        """Event filter to sync position/size with parent window."""
        # Sync with parent window events
        if obj is self.parent_window:
            if event.type() == QEvent.Move:
                # Parent moved - move overlay to match, offset upward for top image and left/up by shift_out
                badge_h = BADGE_H if self.top_center and not self.top_center.isNull() else 0
                extra_top = badge_h // 2
                shift_out = self.border_thickness // 2  # Shift outside by half thickness
                new_pos = self.parent_window.pos()
                new_pos.setY(new_pos.y() - extra_top - shift_out - CORNER_OUTSET)
                new_pos.setX(new_pos.x() - shift_out - CORNER_OUTSET)
                self.move(new_pos)
                return False
            elif event.type() == QEvent.Resize:
                # Parent resized - resize overlay to match, add extra height for top image and width for right corner
                # Also add shift_out on all sides for frame extension
                badge_h = BADGE_H if self.top_center and not self.top_center.isNull() else 0
                extra_top = badge_h // 2
                # Extend width to the right for corner_tr (120px wide, centered at edge = 60px extension)
                extra_right = 60
                shift_out = self.border_thickness // 2  # Shift outside by half thickness
                new_size = self.parent_window.size()
                new_size.setHeight(new_size.height() + extra_top + 2 * shift_out + 2 * CORNER_OUTSET)
                new_size.setWidth(new_size.width() + extra_right + 2 * shift_out + 2 * CORNER_OUTSET)
                self.resize(new_size)
                return False
            elif event.type() == QEvent.Close:
                # Parent closing - close overlay too
                self.close()
                return False
            elif event.type() == QEvent.FocusIn:
                # Parent window focused - raise frame to stay on top
                self.raise_()
                return False
            elif event.type() in (QEvent.WindowActivate, QEvent.Show):
                # Same recovery as the periodic _check_and_raise but
                # fires immediately when the parent regains activation
                # after a resize-driven focus blip — avoids the 100 ms
                # window where the overlay was hidden by the OS but
                # the timer hadn't fired yet.
                if not self.isVisible():
                    self.show()
                self.raise_()
                return False

        return super().eventFilter(obj, event)
    
    def _check_and_raise(self) -> None:
        """Keep the overlay visible and on top of the active parent.

        Qt.Tool windows on Windows can be auto-hidden by the OS when
        the owner briefly loses/regains active state — which happens
        during a fast edge-drag sequence because the resize loop
        passes focus around. Without this guard the overlay vanishes
        after a couple of resizes while the main window stays open.
        Re-show the overlay (not just ``raise_``) when the parent is
        active but the overlay is no longer visible.
        """
        if not self.parent_window:
            return
        if not self.parent_window.isActiveWindow():
            return
        if not self.isVisible():
            self.show()
        self.raise_()

    # ----------------------------
    # Painting
    # ----------------------------
    def paintEvent(self, event) -> None:
        w, h = self.width(), self.height()
        cs = self.corner_size
        t = self.border_thickness

        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        
        # Calculate offset for top image (widget is extended above)
        badge_h = BADGE_H if self.top_center and not self.top_center.isNull() else 0
        extra_top = badge_h // 2  # Half the image extends above
        extra_right = 75  # Extended width for corner_tr (150px wide, centered at edge = 75px extension)
        shift_out = t // 2  # Shift frame outside by half the border thickness

        # Parent window position within frame window coordinate system —
        # account for the CORNER_OUTSET pad we added in eventFilter so
        # the painted frame still maps onto the actual parent rect.
        parent_x = shift_out + CORNER_OUTSET
        parent_y = extra_top + shift_out + CORNER_OUTSET
        parent_w = w - extra_right - 2 * shift_out - 2 * CORNER_OUTSET
        parent_h = h - extra_top - 2 * shift_out - 2 * CORNER_OUTSET

        # Frame rectangles: outer extends beyond parent by shift_out on each side
        # Top extends up, right extends right, bottom extends down, left extends left
        outer = QRect(
            parent_x - shift_out,  # Left extends left (0)
            parent_y - shift_out,  # Top extends up (extra_top)
            parent_w + 2 * shift_out + t//2,  # Width includes both left and right extensions
            parent_h + 2 * shift_out   # Height includes both top and bottom extensions
        )
        # Outer right edge: parent_x - shift_out + (parent_w + 2*shift_out) = parent_x + parent_w + shift_out = w - extra_right
        # Outer bottom edge: parent_y - shift_out + (parent_h + 2*shift_out) = parent_y + parent_h + shift_out = h
        inner = QRect(
            parent_x - shift_out + t,  # Inner left edge
            parent_y - shift_out + t,  # Inner top edge
            parent_w + 2 * shift_out - 2 * t + t//2,  # Inner width
            parent_h + 2 * shift_out - 2 * t   # Inner height
        )

        # Fill only the border areas with solid background (frame borders only, not center)
        # The frame extends shift_out (9px) beyond the parent window on each side
        # The border thickness is t (18px), but the visible border area is only shift_out (9px) beyond parent
        
        # Top border - extends upward from parent top edge by shift_out (9px), thickness t (18px)
        p.fillRect(parent_x - shift_out, parent_y - shift_out, parent_w + 2 * shift_out, t, self.frame_bg_color)
        
        # Bottom border - extends downward from parent bottom edge by t (18px), same as top
        p.fillRect(parent_x - shift_out, parent_y + parent_h -t//2, parent_w + 2 * shift_out, t, self.frame_bg_color)
        
        # Left border - extends leftward from parent left edge by t (18px)
        p.fillRect(parent_x - shift_out, parent_y - shift_out, t, parent_h + 2 * shift_out, self.frame_bg_color)
        
        # Right border - extends rightward from parent right edge by t (18px), same as left
        right_border_x = parent_x + parent_w # = w - extra_right - shift_out
        p.fillRect(right_border_x, parent_y - shift_out, t, parent_h + 2 * shift_out, self.frame_bg_color)

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

        # Corner images. ``corner_width`` is the visible draw size for
        # each corner. ``corner_outset`` shifts every corner image
        # outward (negative x/y for TL, positive for BR, etc.) so the
        # visible owl artwork overlaps the parent-window edge again
        # the way the legacy WebP corners did. The CornersNew/ PNGs
        # have more transparent padding inside their canvas, so
        # without this outset the owl appears recessed.
        corner_width = 160
        corner_outset = CORNER_OUTSET
        
        # Helper function to calculate corner height from aspect ratio
        def get_corner_height(pixmap):
            if pixmap and not pixmap.isNull():
                aspect_ratio = pixmap.height() / pixmap.width() if pixmap.width() > 0 else 1.0
                return int(corner_width * aspect_ratio)
            return corner_width
        
        # Corner BR background (CornersNew/corner_br.png) — drawn first
        # so the per-tab owl crest renders on top of it.
        if self.corner_br_bg and not self.corner_br_bg.isNull():
            corner_br_bg_height = get_corner_height(self.corner_br_bg)
            self._draw_corner_pix(p, self.corner_br_bg, QRect(
                outer.right() - corner_width + 1 + corner_outset,
                outer.bottom() - corner_br_bg_height + 1 + corner_outset,
                corner_width,
                corner_br_bg_height
            ))

        # Corner BR — per-tab owl image, painted on top of the static
        # background above.
        if self.corner_br and not self.corner_br.isNull():
            corner_br_height = get_corner_height(self.corner_br)
            self._draw_corner_pix(p, self.corner_br, QRect(
                outer.right() - corner_width + 1 + corner_outset,
                outer.bottom() - corner_br_height + 1 + corner_outset,
                corner_width,
                corner_br_height
            ))

        # Other corner images (TL, TR, BL) - draw LAST so they appear on top
        # Corner TL - at top-left corner of outer frame, contained within frame
        corner_tl_height = get_corner_height(self.corner_tl)
        corner_tl_rect = QRect(
            outer.left() - corner_outset,
            outer.top() - corner_outset,
            corner_width,
            corner_tl_height
        )
        self._draw_corner_pix(p, self.corner_tl, corner_tl_rect)
        # Cache click target — shrink by resize_margin on the OUTER edges
        # (left/top here) so the diagonal-resize handle at the very corner
        # pixel stays draggable; the body of the owl stays clickable.
        rm = self.resize_margin
        self._tl_click_rect = corner_tl_rect.adjusted(rm, rm, 0, 0)

        # Corner TR - at top-right corner of outer frame, contained within frame
        corner_tr_height = get_corner_height(self.corner_tr)
        corner_tr_rect = QRect(
            outer.right() - corner_width + 1 + corner_outset,
            outer.top() - corner_outset,
            corner_width,
            corner_tr_height
        )
        self._draw_corner_pix(p, self.corner_tr, corner_tr_rect)
        # Outer edges are top/right for TR — preserve resize there.
        self._tr_click_rect = corner_tr_rect.adjusted(0, rm, -rm, 0)
        
        # Corner BL - at bottom-left corner of outer frame, contained within frame
        corner_bl_height = get_corner_height(self.corner_bl)
        self._draw_corner_pix(p, self.corner_bl, QRect(
            outer.left() - corner_outset,
            outer.bottom() - corner_bl_height + 1 + corner_outset,
            corner_width,
            corner_bl_height
        ))

        # Top-center badge image - now has space to extend above frame
        if self.top_center and not self.top_center.isNull():
            badge_w = BADGE_W  # Logical px
            badge_h = BADGE_H  # 0.65 × badge_w, kept in step with the
            # overlay-height calculation in eventFilter() above so the
            # crest never spills past the overlay's top edge.
            # Center horizontally relative to parent window
            x = parent_x + (parent_w - badge_w) // 2
            # Position so center of image is at parent window's top edge
            y = parent_y - badge_h // 2
            target = QRect(x, y, badge_w, badge_h)
            # Draw directly without background - the image itself is transparent
            self._draw_scaled(p, self.top_center, target)
            # Cache click target. The badge sits horizontally far from the
            # left/right resize edges, so no inset needed; the small badge
            # rect is the click target as-is.
            self._tc_click_rect = QRect(target)
        else:
            self._tc_click_rect = QRect()

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
        """Handle resize from edges and snap-clicks on corner images."""
        if event is None:
            return

        try:
            if event.button() != Qt.LeftButton:
                event.ignore()
                return

            pos = event.pos()
            global_pos = event.globalPosition().toPoint()

            # Resize edge takes priority — the very corner pixel stays
            # a diagonal-resize handle even though the corner image rect
            # overlaps it. The image's click rect is shrunk by
            # resize_margin in paintEvent specifically for this.
            d = self._hit_test_resize(pos)
            if d != 0 and self.parent_window:
                self._resizing = True
                self._resize_dir = d
                self._press_global = global_pos
                self._press_geom = self.parent_window.geometry()
                event.accept()
                return

            # Not on an edge — check the snap-shortcut click rects.
            which = self._hit_test_corner_click(pos)
            if which is not None and self.parent_window is not None:
                self._apply_corner_snap(which)
                event.accept()
                return

            # Not on edge or snap target - ignore event (pass through to parent)
            event.ignore()
        except Exception as e:
            print(f"Error in HybridFrameWindow.mousePressEvent: {e}")
            event.ignore()

    def mouseMoveEvent(self, event) -> None:
        """Handle resize cursor and resize operation."""
        if event is None:
            return

        try:
            # If resizing, apply resize to parent window
            if self._resizing and self.parent_window:
                global_pos = event.globalPosition().toPoint()
                self._apply_resize(global_pos)
                event.accept()
                return

            # Not resizing — pick the cursor by precedence:
            #   resize edge   → directional resize cursor
            #   snap target   → pointing-hand cursor
            #   neither       → arrow
            pos = event.pos()
            d = self._hit_test_resize(pos)
            if d != 0:
                self.setCursor(self._cursor_by_dir.get(d, Qt.ArrowCursor))
            elif self._hit_test_corner_click(pos) is not None:
                self.setCursor(Qt.PointingHandCursor)
            else:
                self.setCursor(Qt.ArrowCursor)

            event.ignore()  # Pass through
        except Exception as e:
            print(f"Error in HybridFrameWindow.mouseMoveEvent: {e}")
            event.ignore()

    def mouseReleaseEvent(self, event) -> None:
        """Handle mouse release - end resize."""
        if event is None:
            return
        
        try:
            if event.button() == Qt.LeftButton:
                if self._resizing:
                    self._resizing = False
                    self._resize_dir = 0
                    self.setCursor(Qt.ArrowCursor)
                    event.accept()
                else:
                    event.ignore()
            else:
                event.ignore()
        except Exception as e:
            print(f"Error in HybridFrameWindow.mouseReleaseEvent: {e}")
            self._resizing = False
            self._resize_dir = 0
            event.ignore()

    def _hit_test_resize(self, pos) -> int:
        # Anchor the hit zones to the *parent window's* visible edges,
        # not the overlay's outer rect. The overlay extends well past
        # the parent (≈19 px on the left/bottom, ≈79 px on the right
        # for the corner_tr extension, ≈BADGE_H/2 px above for the
        # top-centre badge), so testing against the overlay rect put
        # the right- and top-edge resize zones far outside the visible
        # window and the user couldn't grab them.
        m = self.resize_margin
        badge_h = BADGE_H if self.top_center and not self.top_center.isNull() else 0
        extra_top = badge_h // 2
        extra_right = 60
        shift_out = self.border_thickness // 2

        parent_left = shift_out + CORNER_OUTSET
        parent_top = extra_top + shift_out + CORNER_OUTSET
        parent_right = self.width() - extra_right - shift_out - CORNER_OUTSET
        parent_bottom = self.height() - shift_out - CORNER_OUTSET

        # ``m`` px on either side of each visible edge so the user can
        # grab from the decorative outer band or from a hair inside the
        # parent — whichever feels natural.
        left = abs(pos.x() - parent_left) <= m
        right = abs(pos.x() - parent_right) <= m
        top = abs(pos.y() - parent_top) <= m
        bottom = abs(pos.y() - parent_bottom) <= m

        # Only count edges where the cursor is actually within the
        # parent's vertical/horizontal span (plus the same ``m`` slack)
        # — without this, e.g. a click at (parent_left, 9999) would
        # register as "left" because it's m px from the parent_left
        # vertical line but it's nowhere near the window.
        in_v_span = (parent_top - m) <= pos.y() <= (parent_bottom + m)
        in_h_span = (parent_left - m) <= pos.x() <= (parent_right + m)

        d = 0
        if left and in_v_span:
            d |= 1
        if right and in_v_span:
            d |= 2
        if top and in_h_span:
            d |= 4
        if bottom and in_h_span:
            d |= 8
        return d

    def _hit_test_corner_click(self, pos) -> str | None:
        """Return 'tl' / 'tc' / 'tr' if pos is over a snap target, else None.

        The rects are populated by paintEvent. Test in priority order:
        the top-center badge is small and sits between the corners, so
        it's checked first; otherwise tie-breaking by position is fine.
        """
        if self._tc_click_rect.isValid() and self._tc_click_rect.contains(pos):
            return "tc"
        if self._tl_click_rect.isValid() and self._tl_click_rect.contains(pos):
            return "tl"
        if self._tr_click_rect.isValid() and self._tr_click_rect.contains(pos):
            return "tr"
        return None

    def _apply_corner_snap(self, which: str) -> None:
        """Resize+move the parent window to a screen-half snap rect.

        The frame syncs to the parent automatically via the parent's
        Move/Resize events (see eventFilter), so we only set the parent's
        geometry — the overlay follows.
        """
        if self.parent_window is None:
            return

        # availableGeometry excludes the taskbar / docked panels, so the
        # snapped window doesn't slide under them.
        screen = QApplication.primaryScreen()
        if screen is None:
            return
        avail = screen.availableGeometry()

        # All three snaps are 60%-screen width × full screen height —
        # only the horizontal position differs (left edge / centred /
        # right edge). 60% (vs 50%) is wider than a clean half-split,
        # which the user prefers for editor-style layouts.
        snap_w = int(avail.width() * 0.6)
        if which == "tl":
            target = QRect(avail.x(), avail.y(), snap_w, avail.height())
        elif which == "tc":
            target = QRect(avail.x() + (avail.width() - snap_w) // 2,
                           avail.y(), snap_w, avail.height())
        elif which == "tr":
            target = QRect(avail.x() + avail.width() - snap_w, avail.y(),
                           snap_w, avail.height())
        else:
            return

        # Honour the parent's minimum size so we don't crush smaller
        # windows below their content's hard floor.
        min_w = max(self.parent_window.minimumWidth(), 100)
        min_h = max(self.parent_window.minimumHeight(), 100)
        if target.width() < min_w:
            target.setWidth(min_w)
        if target.height() < min_h:
            target.setHeight(min_h)

        self.parent_window.setGeometry(target)

    def _apply_resize(self, global_pos: QPoint) -> None:
        """Apply resize to parent window and sync overlay."""
        try:
            if not self.parent_window or not self._press_geom.isValid():
                return
            
            if global_pos.isNull():
                return
            
            dx = global_pos.x() - self._press_global.x()
            dy = global_pos.y() - self._press_global.y()

            g = QRect(self._press_geom)
            minw = self.parent_window.minimumWidth()
            minh = self.parent_window.minimumHeight()
            
            if minw <= 0 or minh <= 0:
                minw = 100
                minh = 100

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

            if g.isValid() and g.width() >= minw and g.height() >= minh:
                # Resize parent window - overlay will sync automatically via eventFilter
                self.parent_window.setGeometry(g)
        except Exception as e:
            print(f"Error in HybridFrameWindow._apply_resize: {e}")
            self._resizing = False
            self._resize_dir = 0

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

