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
    # Owl startup icon — 450 px, top-centered over the splash, shifted
    # 150 px upward so it visibly extends above the splash window.
    _ICON_SIZE = 450
    _ICON_Y_SHIFT = -150  # negative = up; positions the icon's TOP
                          # this many px above the splash's top edge.

    def __init__(self):
        # Create a custom pixmap with gradient background
        pixmap = QPixmap(self._SPLASH_W, self._SPLASH_H)
        pixmap.fill(Qt.transparent)

        super().__init__(pixmap, Qt.WindowStaysOnTopHint | Qt.WindowStaysOnTopHint)

        # Enable mouse events for scrolling
        self.setMouseTracking(True)

        # Create overlay widget for content
        self.content_widget = QWidget(self)
        self.content_widget.setGeometry(0, 0, self._SPLASH_W, self._SPLASH_H)

        layout = QVBoxLayout(self.content_widget)
        layout.setContentsMargins(20, 15, 20, 15)
        layout.setSpacing(8)

        # Title — text only here; the visual icon is the floating
        # owl_startup overlay positioned in _position_owl_overlay below.
        self.title = QLabel("OWLLM")
        self.title.setAlignment(Qt.AlignCenter)
        self.title.setStyleSheet("""
            QLabel {
                color: white;
                font-size: 18pt;
                font-weight: bold;
                background: transparent;
                padding: 5px;
            }
        """)
        layout.addWidget(self.title)

        # ---- floating owl crest -----------------------------------
        # Independent top-level frameless window with a transparent
        # background so the PNG can render OUTSIDE the splash bounds —
        # exactly like the corner frame overlays in the main app. A
        # child QLabel of the splash would be clipped to the splash
        # rectangle, which is what was cropping the icon before.
        self._owl_overlay = QWidget(
            None,
            Qt.FramelessWindowHint
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
        
        # Progress bar (compact)
        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setTextVisible(True)
        self.progress.setFormat("%p% - Detecting system...")
        self.progress.setStyleSheet("""
            QProgressBar {
                border: 2px solid rgba(255, 255, 255, 0.3);
                border-radius: 6px;
                background: rgba(0, 0, 0, 0.3);
                color: white;
                font-size: 9pt;
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
        layout.addWidget(self.progress)
        
        # Scrollable details (TextEdit instead of Label)
        self.details = QTextEdit()
        self.details.setReadOnly(True)
        self.details.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.details.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.details.setStyleSheet("""
            QTextEdit {
                color: rgba(255, 255, 255, 0.95);
                font-size: 9pt;
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(255, 255, 255, 0.25);
                border-radius: 6px;
                padding: 10px;
                font-family: 'Consolas', 'Courier New', monospace;
            }
            QScrollBar:vertical {
                background: rgba(0, 0, 0, 0.2);
                width: 10px;
                border-radius: 5px;
            }
            QScrollBar::handle:vertical {
                background: rgba(255, 255, 255, 0.3);
                border-radius: 5px;
                min-height: 20px;
            }
            QScrollBar::handle:vertical:hover {
                background: rgba(255, 255, 255, 0.5);
            }
        """)
        layout.addWidget(self.details, 1)  # Give it stretch factor
        
        # Version/footer (compact)
        self.footer = QLabel("v2.0 - Hardware-Adaptive")
        self.footer.setAlignment(Qt.AlignCenter)
        self.footer.setStyleSheet("""
            QLabel {
                color: rgba(255, 255, 255, 0.5);
                font-size: 8pt;
                background: transparent;
                padding: 2px;
            }
        """)
        layout.addWidget(self.footer)
        
        self.setStyleSheet("""
            QWidget {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
                    stop:0 #1a1a2e, stop:0.5 #16213e, stop:1 #0f3460);
            }
        """)

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

