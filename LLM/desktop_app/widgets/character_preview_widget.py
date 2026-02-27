from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, QTimer, QUrl, Signal
from PySide6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget, QSlider
from PySide6.QtWebEngineWidgets import QWebEngineView


class CharacterPreviewWidget(QWidget):
    """Arena character selector with local 3D preview."""

    characterSelected = Signal(str, str)  # model_name, character_key
    scaleChanged = Signal(str, float)     # model_name, scale_multiplier

    CHARACTER_KEYS = [
        "fantasy_knight",
        "fantasy_mage",
        "fantasy_rogue",
        "fantasy_guardian",
        "anime_blade",
        "anime_guardian",
        "anime_urban",
        "anime_tokyo",
        "anime_android",
        "anime_scout",
        "classic_soldier",
        "classic_xbot",
        "classic_cesium",
        "classic_robot",
        "wild_fox",
        "wild_horse",
        "wild_flamingo",
        "wild_parrot",
        "wild_stork",
        "d_rex",
        "mystic_brainstem",
    ]

    DEFAULTS = {
        "A": "fantasy_knight",
        "B": "anime_android",
        "C": "fantasy_mage",
    }

    def __init__(self, model_name: str, root_path: Path, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.model_name = model_name
        self.root_path = root_path
        self._index = 0

        self._name_label = QLabel("Loading...")
        self._name_label.setAlignment(Qt.AlignCenter)
        self._name_label.setStyleSheet("font-size: 14pt; font-weight: bold; text-transform: capitalize;")

        self._btn_prev = QPushButton("◀")
        self._btn_prev.setFixedSize(40, 40)
        self._btn_next = QPushButton("▶")
        self._btn_next.setFixedSize(40, 40)

        nav_layout = QHBoxLayout()
        nav_layout.addWidget(self._btn_prev)
        nav_layout.addWidget(self._name_label, 1)
        nav_layout.addWidget(self._btn_next)

        self._scale_label = QLabel("Scale: 1.00x")
        self._scale_label.setAlignment(Qt.AlignCenter)
        self._scale_slider = QSlider(Qt.Horizontal)
        self._scale_slider.setMinimum(1)
        self._scale_slider.setMaximum(200)
        self._scale_slider.setValue(100)
        self._scale_slider.valueChanged.connect(self._on_scale_changed)

        scale_layout = QHBoxLayout()
        scale_layout.addWidget(self._scale_label)
        scale_layout.addWidget(self._scale_slider)

        self._preview_view = QWebEngineView()
        self._preview_view.setMinimumHeight(280)
        self._preview_view.setMaximumHeight(350)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addLayout(nav_layout)
        layout.addLayout(scale_layout)
        layout.addWidget(self._preview_view)

        self._btn_prev.clicked.connect(self._on_prev)
        self._btn_next.clicked.connect(self._on_next)
        self._preview_view.loadFinished.connect(self._on_load_finished)

        self._set_initial_index()
        self._load_preview_page()

    def _set_initial_index(self) -> None:
        initial = self.DEFAULTS.get(self.model_name, self.CHARACTER_KEYS[0])
        if initial in self.CHARACTER_KEYS:
            self._index = self.CHARACTER_KEYS.index(initial)

    def _load_preview_page(self) -> None:
        preview_path = self.root_path / "desktop_app" / "assets" / "3d" / "character_preview.html"
        if preview_path.exists():
            self._preview_view.setUrl(QUrl.fromLocalFile(str(preview_path)))

    def _on_load_finished(self, ok: bool) -> None:
        if ok:
            self._update_selection()

    def _on_prev(self) -> None:
        self._index = (self._index - 1) % len(self.CHARACTER_KEYS)
        self._update_selection()

    def _on_next(self) -> None:
        self._index = (self._index + 1) % len(self.CHARACTER_KEYS)
        self._update_selection()

    def _on_scale_changed(self, value: int) -> None:
        mult = value / 100.0
        self._scale_label.setText(f"Scale: {mult:.2f}x")
        self._preview_view.page().runJavaScript(f"window.setPreviewScale({mult});")
        self.scaleChanged.emit(self.model_name, mult)

    def _update_selection(self) -> None:
        key = self.CHARACTER_KEYS[self._index]
        self._name_label.setText(key.replace("_", " ").title())
        
        # Reset slider
        self._scale_slider.blockSignals(True)
        self._scale_slider.setValue(100)
        self._scale_label.setText("Scale: 1.00x")
        self._scale_slider.blockSignals(False)

        QTimer.singleShot(20, lambda: self._preview_view.page().runJavaScript(f"window.setPreviewModel('{key}');"))
        self.characterSelected.emit(self.model_name, key)
