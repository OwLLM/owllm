"""Bring up one widget in isolation and feed it to the rest of `ui_probe`.

Most OWLLM widgets (`SuperUserCard`, `AgentCanvas`, `FleetAgentCard`,
the various `widgets/*.py` cards) are designed to be embeddable. They
take a parent + optional config and don't depend on the running
`MainWindow`'s subsystems. That's the property the harness exploits:

    with WidgetHarness() as h:
        card = h.show(SuperUserCard())
        png = capture_widget(card)

The harness owns the `QApplication`. It refuses to recreate one if a
test runs after another test in the same process (Qt asserts on that
anyway). It tears the widget down at exit but leaves the QApplication
alive — Qt does not allow a clean restart, and pytest-qt's `qtbot`
fixture relies on a long-lived app.

The shell is a plain top-level `QWidget`, not a `QMainWindow`. Using
`QMainWindow.setCentralWidget` stretches the embedded widget to fill
the window, which silently overrides any `resize()` the widget did
in its `__init__`. A plain `QWidget` shell lets us keep the widget at
its natural / requested size and resize the shell around it — exactly
what production embedders (cards in scroll areas, popovers, dialogs)
do. The widget under test sees a real top-level window via
`self.window()` either way.

Full-`MainWindow` mode is intentionally out of scope. When we need it
(rare — only for end-to-end "does the tab stack work" tests) we'll
add a sibling `AppHarness`. The 80% case is widget-level and stays
fast because of it.
"""
from __future__ import annotations

import sys
from typing import Optional

from PySide6.QtCore import QSize, Qt
from PySide6.QtGui import QFontDatabase
from PySide6.QtWidgets import QApplication, QWidget

from desktop_app.ui_probe.headless import configure_offscreen


# Sentinel — fonts only need to be loaded once per QApplication
# lifetime. Loading C:\Windows\Fonts twice would double-register
# every face and waste a few hundred ms per harness construction.
_SYSTEM_FONTS_LOADED = False


def _load_system_fonts_once() -> None:
    """Register OS system fonts with QFontDatabase.

    The offscreen Qt platform plugin on Windows ships with an empty
    font database — `QFontDatabase.families()` returns `[]` and every
    label renders as `▢▢▢` missing-glyph boxes. Production Qt picks
    up fonts via the platform-native integration (Windows GDI / DWrite,
    macOS Core Text, fontconfig on Linux); the offscreen plugin skips
    that integration entirely.

    Fix: enumerate the OS font directory ourselves and call
    `QFontDatabase.addApplicationFont` on each face. Cheap (~300 ms
    on a typical Windows box) and one-shot per process.

    No-ops on platforms where the font dir doesn't exist.
    """
    global _SYSTEM_FONTS_LOADED
    if _SYSTEM_FONTS_LOADED:
        return
    _SYSTEM_FONTS_LOADED = True

    candidates: list[str] = []
    if sys.platform.startswith("win"):
        candidates.append(r"C:\Windows\Fonts")
    elif sys.platform == "darwin":
        candidates.extend([
            "/System/Library/Fonts",
            "/Library/Fonts",
        ])
    else:  # linux / *bsd
        candidates.extend([
            "/usr/share/fonts",
            "/usr/local/share/fonts",
        ])

    import os
    for root in candidates:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                lower = name.lower()
                if lower.endswith((".ttf", ".ttc", ".otf")):
                    QFontDatabase.addApplicationFont(os.path.join(dirpath, name))


class WidgetHarness:
    """Context manager that owns the QApplication + a shell QWidget.

    Usage:

        with WidgetHarness() as h:
            w = h.show(MyWidget())
            png = capture_widget(w)

    The shell is a bare top-level `QWidget`. The widget under test
    becomes its child and keeps its own size (whatever its
    `__init__` did via `resize()` or `setMinimumSize()`). The shell
    resizes to wrap.

    Multiple `show()` calls in one harness session replace the
    hosted widget, so one harness can step through several widget
    variants without paying the QApplication-startup cost each time.
    """

    def __init__(self) -> None:
        configure_offscreen()
        self._app: Optional[QApplication] = None
        self._shell: Optional[QWidget] = None
        self._current: Optional[QWidget] = None

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    def __enter__(self) -> "WidgetHarness":
        # QApplication is a singleton per-process. Re-using whatever
        # already exists is mandatory — Qt asserts on a second construct.
        self._app = QApplication.instance() or QApplication(sys.argv[:1])
        # System fonts must be loaded AFTER the QApplication exists
        # (QFontDatabase requires it) but BEFORE the widget under test
        # is constructed — otherwise the widget's first paint happens
        # with the empty font db and labels get measured against
        # nothing, producing wrong layout.
        _load_system_fonts_once()
        self._shell = QWidget()
        self._shell.setWindowTitle("ui_probe harness")
        # `WA_DontShowOnScreen` keeps the shell off the compositor
        # even when the running QApplication uses the native platform
        # plugin (e.g. when an agent calls into ui_probe from a
        # live OWLLM session). Under the offscreen platform this is
        # already implicit; setting it explicitly makes the harness
        # safe under both.
        self._shell.setAttribute(Qt.WidgetAttribute.WA_DontShowOnScreen, True)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        # Close the shell so the hosted widget gets a hideEvent — most
        # OWLLM cards stop timers there, which is exactly what we want
        # tested. We do NOT call `quit()` on the QApplication; pytest-qt
        # reuses it across tests in the same process.
        if self._shell is not None:
            self._shell.close()
            self._shell.deleteLater()
            self._shell = None
        if self._app is not None:
            self._app.processEvents()
        self._current = None

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------

    def show(self, widget: QWidget, *, size: QSize | None = None) -> QWidget:
        """Embed `widget` in the shell and return it ready for capture.

        Calling this a second time replaces the previous widget (which
        is deleted via `deleteLater`). The returned widget is the one
        you passed in — keep a reference if you need to interact with
        it later.

        If `size` is given, the widget is resized to it before show.
        Otherwise the widget keeps whatever size its `__init__` set
        (via `resize()` or `setMinimumSize()`); if both are empty, we
        fall back to its `sizeHint()` so the capture isn't 0x0.
        """
        if self._shell is None:
            raise RuntimeError("WidgetHarness.show() called outside context")

        # Tear down the previous hosted widget.
        if self._current is not None:
            self._current.setParent(None)  # type: ignore[arg-type]
            self._current.deleteLater()

        widget.setParent(self._shell)
        widget.move(0, 0)

        # Honour the most specific size signal available.
        target = size
        if target is None or not target.isValid():
            target = widget.size()
        if target.isEmpty():
            target = widget.sizeHint()
        if target.isValid() and not target.isEmpty():
            widget.resize(target)

        # The shell wraps tightly around the widget so any later
        # full-window grab still matches the widget's bounds.
        self._shell.resize(widget.size())
        self._shell.show()
        self._current = widget
        self.processed()
        return widget

    def processed(self) -> None:
        """Flush pending Qt events so the next capture sees final layout.

        Called automatically by `show()`. Exposed for tests that mutate
        state between `show()` and `capture_widget()` and want to
        force a paint pass first.
        """
        if self._app is not None:
            # processEvents() with the default flags handles both posted
            # events and the deferred-delete queue from any prior
            # `deleteLater()` call.
            self._app.processEvents()

    @property
    def shell(self) -> QWidget:
        """The embedding shell `QWidget`. Mostly useful for tests that
        want to assert window-level state (title, geometry)."""
        if self._shell is None:
            raise RuntimeError("WidgetHarness.shell accessed outside context")
        return self._shell


__all__ = ["WidgetHarness"]
