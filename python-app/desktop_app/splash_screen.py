"""
Professional splash screen for LLM Fine-tuning Studio
Shows system detection progress with app's signature gradient style
"""
from pathlib import Path

from PySide6.QtWidgets import (
    QSplashScreen, QVBoxLayout, QHBoxLayout, QLabel, QWidget, QProgressBar,
    QTextEdit, QScrollArea,
)
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QPixmap, QPainter, QColor, QLinearGradient, QFont, QTextCursor


class SplashScreen(QSplashScreen):
    # Splash dimensions. Back to the historical 550×350 — the owl crest
    # is now drawn in a SEPARATE top-level window that floats above the
    # splash and bleeds out past its top edge, just like the corner
    # frame overlays in the main app.
    _SPLASH_W = 550
    _SPLASH_H = 350
    # Owl startup icon — 200 px, top-centered over the splash. Sits
    # 50 px below the splash top, so it's mostly inside the splash and
    # close to the title / progress bar (the user moved the previous
    # -150 placement down by 200 px to close the gap).
    _ICON_SIZE = 200
    _ICON_Y_SHIFT = 50    # positive = below splash top; negative = up
    # Absolute placement (inside the 550×350 splash) of the OWLLM
    # title text and the progress bar. The 200 px owl PNG covers
    # y=50..250 of the splash, so the title sits in the strip ABOVE
    # the owl and the progress bar in the strip BELOW it. Tunable
    # — bump these constants to nudge either widget without touching
    # the rest of the file.
    _TITLE_Y = 5
    _TITLE_H = 40
    _PROGRESS_Y = 270
    _PROGRESS_H = 22

    def __init__(self):
        # Fully transparent backdrop — no gradient, no panel, no shadow.
        # Only the floating owl PNG, the OWLLM title, and the progress
        # bar should be visible on screen.
        pixmap = QPixmap(self._SPLASH_W, self._SPLASH_H)
        pixmap.fill(Qt.transparent)

        super().__init__(
            pixmap,
            Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint,
        )
        # The QSplashScreen draws the pixmap as its background. To make
        # the splash window itself transparent (so the gradient panel
        # disappears completely and only the labelled controls show),
        # opt into a translucent backing surface.
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_NoSystemBackground, True)

        # Enable mouse events for scrolling
        self.setMouseTracking(True)

        # Create overlay widget for content
        self.content_widget = QWidget(self)
        self.content_widget.setGeometry(0, 0, self._SPLASH_W, self._SPLASH_H)
        self.content_widget.setAttribute(Qt.WA_TranslucentBackground, True)
        self.content_widget.setStyleSheet("background: transparent;")

        # No QVBoxLayout — every visible widget (title + progress) is
        # absolutely positioned inside content_widget so it can be
        # placed clear of the floating owl-PNG overlay (which covers
        # y=_ICON_Y_SHIFT .. _ICON_Y_SHIFT+_ICON_SIZE = 50..250 by
        # default). Mixing a layout with absolute children was hiding
        # both labels behind the overlay.

        # Title — sits above the owl PNG.
        self.title = QLabel("OWLLM", self.content_widget)
        self.title.setAlignment(Qt.AlignCenter)
        self.title.setStyleSheet("""
            QLabel {
                color: white;
                font-size: 18pt;
                font-weight: bold;
                background: transparent;
                padding: 0px;
            }
        """)
        self.title.setGeometry(
            0, self._TITLE_Y, self._SPLASH_W, self._TITLE_H,
        )

        # ---- floating owl crest -----------------------------------
        # Top-level frameless tool window parented to the splash so it
        # stacks ABOVE it on Windows (Qt.Tool with a parent inherits
        # the parent's stacking context). Without the parent, two
        # independent WindowStaysOnTopHint windows could end up in
        # arbitrary z-order — which is what made the owl appear
        # *behind* the splash in the previous attempt.
        self._owl_overlay = QWidget(
            self,
            Qt.Window
            | Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
            | Qt.WindowTransparentForInput,
        )
        self._owl_overlay.setAttribute(Qt.WA_TranslucentBackground, True)
        self._owl_overlay.setAttribute(Qt.WA_NoSystemBackground, True)
        self._owl_overlay.setAttribute(Qt.WA_ShowWithoutActivating, True)
        self._owl_overlay.setFixedSize(self._ICON_SIZE, self._ICON_SIZE)

        owl_label = QLabel(self._owl_overlay)
        owl_label.setGeometry(0, 0, self._ICON_SIZE, self._ICON_SIZE)
        owl_label.setAlignment(Qt.AlignCenter)
        owl_label.setStyleSheet("background: transparent;")
        try:
            icon_path = (
                Path(__file__).resolve().parents[2]
                / "icons" / "Page_icons" / "owl_startup.png"
            )
            if icon_path.exists():
                pm = QPixmap(str(icon_path))
                if not pm.isNull():
                    owl_label.setPixmap(
                        pm.scaled(
                            self._ICON_SIZE, self._ICON_SIZE,
                            Qt.KeepAspectRatio,
                            Qt.SmoothTransformation,
                        )
                    )
        except Exception:
            pass
        # Stash for the move/show plumbing.
        self.title_icon = owl_label
        
        # Progress bar — sits below the owl PNG.
        self.progress = QProgressBar(self.content_widget)
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setTextVisible(True)
        self.progress.setFormat("%p% - Detecting system...")
        self.progress.setStyleSheet("""
            QProgressBar {
                border: 2px solid rgba(255, 255, 255, 0.55);
                border-radius: 6px;
                background: transparent;
                color: white;
                font-size: 9pt;
                font-weight: 600;
                text-align: center;
                min-height: 22px;
                max-height: 22px;
            }
            QProgressBar::chunk {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #667eea, stop:1 #764ba2);
                border-radius: 4px;
            }
        """)
        self.progress.setGeometry(
            20,
            self._PROGRESS_Y,
            self._SPLASH_W - 40,
            self._PROGRESS_H,
        )
        self.progress.raise_()
        self.title.raise_()
        
        # Scrollable details — kept as a hidden in-memory log so the
        # update_progress / set_checking / set_result API still works
        # without painting a visible panel. The user wants only the
        # PNG, the OWLLM title, and the progress bar on screen.
        self.details = QTextEdit()
        self.details.setReadOnly(True)
        self.details.setVisible(False)

        # No root stylesheet — keeps the splash background fully
        # transparent so only the OWLLM title and progress bar paint.

    # ---- floating overlay plumbing ------------------------------------

    def _position_owl_overlay(self) -> None:
        """Park the floating owl-crest overlay over the splash, with its
        top edge ``-_ICON_Y_SHIFT`` px above the splash. The overlay is a
        separate top-level window — it intentionally extends past the
        splash bounds, so global screen coordinates are required.
        """
        if not getattr(self, "_owl_overlay", None):
            return
        sx = self.x() + (self.width() - self._ICON_SIZE) // 2
        sy = self.y() + self._ICON_Y_SHIFT
        self._owl_overlay.move(sx, sy)
        self._owl_overlay.raise_()

    def showEvent(self, event):
        super().showEvent(event)
        self._position_owl_overlay()
        if getattr(self, "_owl_overlay", None):
            self._owl_overlay.show()
            self._owl_overlay.raise_()
            # QSplashScreen aggressively re-asserts top-of-stack the
            # first time it paints, so a single raise_() can lose to
            # it. Re-raise on the next tick once both windows are
            # known to the WM.
            QTimer.singleShot(0, self._owl_overlay.raise_)
            QTimer.singleShot(50, self._owl_overlay.raise_)

    def moveEvent(self, event):
        super().moveEvent(event)
        self._position_owl_overlay()

    def hideEvent(self, event):
        super().hideEvent(event)
        if getattr(self, "_owl_overlay", None):
            self._owl_overlay.hide()

    def closeEvent(self, event):
        if getattr(self, "_owl_overlay", None):
            self._owl_overlay.close()
            self._owl_overlay = None
        super().closeEvent(event)

    def finish(self, mainWindow):  # noqa: N802, N803
        # QSplashScreen.finish closes the splash; tear down the floating
        # overlay at the same time so it doesn't linger on screen.
        if getattr(self, "_owl_overlay", None):
            self._owl_overlay.close()
            self._owl_overlay = None
        super().finish(mainWindow)

    def update_progress(self, value: int, status: str, details: str = ""):
        """Update splash screen with detection progress.

        ``self.repaint()`` is synchronous: it repaints the splash immediately
        without yielding to Qt's event loop, so other widgets do NOT get a
        chance to render. ``QApplication.processEvents()`` was previously
        called here as well, but during ``MainWindow.__init__`` that flushed
        every queued show/HWND/paint event for transient widgets being built
        in the same call stack — appearing as dozens of brief flashes
        precisely at progress-bar phase changes (50%, 90%, 100%).
        """
        self.progress.setValue(value)
        self.progress.setFormat(f"{value}% - {status}")

        if details:
            self.details.append(details)
            cursor = self.details.textCursor()
            cursor.movePosition(QTextCursor.End)
            self.details.setTextCursor(cursor)

        self.repaint()

    def set_checking(self, component: str):
        """Mark a component as being checked."""
        self.details.append(f"⏳ Checking {component}...")
        cursor = self.details.textCursor()
        cursor.movePosition(QTextCursor.End)
        self.details.setTextCursor(cursor)
        self.repaint()

    def set_result(self, component: str, result: str, is_ok: bool = True):
        """Update the last line with result."""
        cursor = self.details.textCursor()
        cursor.movePosition(QTextCursor.End)
        cursor.select(QTextCursor.LineUnderCursor)
        cursor.removeSelectedText()
        cursor.deletePreviousChar()

        icon = '✅' if is_ok else '⚠️'
        self.details.append(f"{icon} {component}: {result}")

        cursor = self.details.textCursor()
        cursor.movePosition(QTextCursor.End)
        self.details.setTextCursor(cursor)
        self.repaint()

