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
    # Splash dimensions. Enlarged from the historical 550×350 so a 450
    # px owl crest can sit above the progress + log area without
    # cropping the bottom controls.
    _SPLASH_W = 700
    _SPLASH_H = 600
    # Owl startup icon — 450 px, top-centered, shifted 150 px upward
    # so it bleeds off the top edge and visually dominates the splash.
    _ICON_SIZE = 450
    _ICON_Y_SHIFT = -150  # negative = up

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

        # Owl crest — absolute positioned so it can be top-centered AND
        # shifted upward independently of the QVBoxLayout below. A
        # layout-managed icon with a negative top margin would just be
        # clipped to (0, 0).
        self.title_icon = QLabel(self.content_widget)
        self.title_icon.setAlignment(Qt.AlignCenter)
        self.title_icon.setStyleSheet("background: transparent;")
        icon_x = (self._SPLASH_W - self._ICON_SIZE) // 2
        self.title_icon.setGeometry(
            icon_x, self._ICON_Y_SHIFT, self._ICON_SIZE, self._ICON_SIZE
        )
        try:
            # splash_screen.py is in LLM/desktop_app/ — repo root is parents[2].
            icon_path = (
                Path(__file__).resolve().parents[2]
                / "icons" / "Page_icons" / "owl_startup.png"
            )
            if icon_path.exists():
                pm = QPixmap(str(icon_path))
                if not pm.isNull():
                    self.title_icon.setPixmap(
                        pm.scaled(
                            self._ICON_SIZE, self._ICON_SIZE,
                            Qt.KeepAspectRatio,
                            Qt.SmoothTransformation,
                        )
                    )
        except Exception:
            pass
        self.title_icon.raise_()

        # Reserve room for the visible portion of the icon so the rest
        # of the splash content (title text + progress + log) starts
        # below it. Visible pixels = ICON_SIZE + ICON_Y_SHIFT.
        visible_icon_h = self._ICON_SIZE + self._ICON_Y_SHIFT  # 300

        layout = QVBoxLayout(self.content_widget)
        layout.setContentsMargins(20, visible_icon_h + 12, 20, 15)
        layout.setSpacing(8)

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

