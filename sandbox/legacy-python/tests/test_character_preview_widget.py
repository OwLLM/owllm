import sys
from pathlib import Path

import pytest
from PySide6.QtCore import QObject, Signal
from PySide6.QtWidgets import QApplication, QWidget

from desktop_app.widgets import character_preview_widget as cpw


@pytest.fixture(scope="session")
def qapp():
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    yield app


class _FakePage(QObject):
    def __init__(self):
        super().__init__()
        self.calls = []

    def runJavaScript(self, script: str):  # noqa: N802
        self.calls.append(script)


class _FakeWebView(QWidget):
    loadFinished = Signal(bool)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._page = _FakePage()
        self.last_url = None

    def setUrl(self, url):  # noqa: N802
        self.last_url = url
        self.loadFinished.emit(True)

    def page(self):
        return self._page


def test_character_preview_widget_emits_selection(qapp, monkeypatch, tmp_path: Path):
    assets_dir = tmp_path / "desktop_app" / "assets" / "3d"
    assets_dir.mkdir(parents=True, exist_ok=True)
    (assets_dir / "character_preview.html").write_text("<html></html>", encoding="utf-8")

    monkeypatch.setattr(cpw, "QWebEngineView", _FakeWebView)
    widget = cpw.CharacterPreviewWidget(model_name="A", root_path=tmp_path)

    captured = []
    widget.characterSelected.connect(lambda model, key: captured.append((model, key)))

    widget._on_next()

    assert captured, "characterSelected should emit after navigation"
    assert captured[-1][0] == "A"
    assert captured[-1][1] in cpw.CharacterPreviewWidget.CHARACTER_KEYS
