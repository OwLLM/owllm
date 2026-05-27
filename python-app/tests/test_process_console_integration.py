from __future__ import annotations

from pathlib import Path


def _llm_root() -> Path:
    return Path(__file__).resolve().parents[1]


def test_main_window_defines_terminal_dock_and_toggle() -> None:
    main_py = (_llm_root() / "desktop_app" / "main.py").read_text(
        encoding="utf-8",
        errors="replace",
    )
    assert "ProcessConsoleWidget" in main_py
    assert "QDockWidget(\"Terminal\"" in main_py
    assert "Qt.BottomDockWidgetArea" in main_py
    assert "self.terminal_btn.clicked.connect(self._toggle_process_console)" in main_py


def test_key_process_outputs_are_mirrored_to_terminal() -> None:
    main_py = (_llm_root() / "desktop_app" / "main.py").read_text(
        encoding="utf-8",
        errors="replace",
    )
    for source in ("install", "pip", "cuda", "onboarding", "models", "train", "model-a", "model-b", "model-c"):
        assert f'source="{source}"' in main_py

