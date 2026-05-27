"""Manual demo for the supervisor 'Apply fix?' toast widget.

Spins up a tiny Qt window with three sample proposals (one per trust
tier) so devs can eyeball the layout, countdown, and button behavior
without booting the full OWLLM app.

Run:
    python LLM/tools/demo_supervisor_toast.py

This is a developer-only utility -- not shipped, not auto-run, not
part of the test suite.
"""
from __future__ import annotations

import sys
from pathlib import Path

llm_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(llm_dir))

from PySide6.QtWidgets import (  # noqa: E402
    QApplication, QLabel, QMainWindow, QPushButton, QVBoxLayout, QWidget,
)

from desktop_app.widgets.supervisor_toast import (  # noqa: E402
    TRUST_CONFIRM, TRUST_DANGER, TRUST_SAFE, propose,
)


SAMPLES = [
    {
        "trust": TRUST_SAFE,
        "action": "install_pkg",
        "args": {"name": "bitsandbytes", "version": "0.44.1"},
        "reason": "torch 2.5.1 ABI requires bnb >= 0.44.",
    },
    {
        "trust": TRUST_CONFIRM,
        "action": "swap_wheel",
        "args": {
            "name": "torch",
            "from_version": "2.5.1+cu121",
            "to_version": "2.4.1+cu118",
            "index": "https://download.pytorch.org/whl/cu118",
        },
        "reason": "user's CUDA runtime is 11.8 -- swap to a matching wheel.",
    },
    {
        "trust": TRUST_DANGER,
        "action": "run_shell",
        "args": {"cmd": "rmdir", "args": ["/s", "/q", "C:/some/cache"]},
        "reason": "wipe corrupted compilation cache.",
    },
]


class DemoWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Supervisor Toast -- demo")
        self.resize(700, 500)
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.addWidget(QLabel(
            "<h2>Supervisor toast demo</h2>"
            "<p>Click the buttons to spawn each trust tier. Use the "
            "buttons inside each toast or wait for the countdown to "
            "watch the auto-skip behavior.</p>"
        ))
        for sample in SAMPLES:
            btn = QPushButton(f"Spawn {sample['trust']} toast: {sample['action']}")
            btn.clicked.connect(lambda _=False, s=sample: self._spawn(s))
            layout.addWidget(btn)

        self._log = QLabel("decisions appear here")
        self._log.setStyleSheet("color: #888; padding: 6px;")
        self._log.setWordWrap(True)
        layout.addWidget(self._log)

        self._toast_anchor = QVBoxLayout()
        self._toast_anchor.setContentsMargins(0, 0, 0, 0)
        self._toast_anchor.setSpacing(8)
        anchor_widget = QWidget()
        anchor_widget.setLayout(self._toast_anchor)
        layout.addWidget(anchor_widget)
        layout.addStretch(1)

    def _spawn(self, sample: dict) -> None:
        toast = propose(self, sample, on_decision=self._record, timeout_s=10)
        self._toast_anchor.addWidget(toast)

    def _record(self, decision: str) -> None:
        existing = self._log.text()
        new = f"-> {decision}"
        self._log.setText(f"{existing}\n{new}" if "decisions appear" not in existing else new)


def main() -> int:
    app = QApplication(sys.argv)
    win = DemoWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
