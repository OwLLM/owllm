"""Trivial widget used by `test_ui_tools.py` to exercise the agent path.

`GreetingCard` is what an OWLLM card looks like in miniature: a label
+ a button + a fixed minimum size. It accepts a `greeting` kwarg so
the tests can verify `ui_render_widget`'s `kwargs` plumbing.

Kept out of production `widgets/` so it isn't accidentally pulled
into the app bundle. The package path
`desktop_app.tests.fixtures.greeting_card:GreetingCard` is what tests
pass as the `target` arg, exactly as a real agent would.
"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QLabel, QPushButton, QVBoxLayout, QWidget


class GreetingCard(QWidget):
    """A label + button card sized 300x120 by default."""

    def __init__(self, greeting: str = "Hello", parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("greeting_card")
        layout = QVBoxLayout(self)
        self.label = QLabel(greeting)
        self.label.setObjectName("greeting_label")
        self.label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.button = QPushButton("&Save")
        self.button.setObjectName("save_btn")
        layout.addWidget(self.label)
        layout.addWidget(self.button)
        self.resize(300, 120)
