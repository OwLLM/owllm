"""Pytest fixtures for desktop_app tests.

Sets the Qt offscreen platform BEFORE any test imports a Qt module.
`pytest-qt`'s `qtbot` fixture is available to tests that import this
package, but most `ui_probe` tests use `WidgetHarness` directly.
"""
from __future__ import annotations

# Order matters: configure_offscreen must run before any PySide6 import
# triggers a QApplication. Importing this conftest is enough — pytest
# loads it before collecting tests in this directory.
from desktop_app.ui_probe.headless import configure_offscreen

configure_offscreen()
