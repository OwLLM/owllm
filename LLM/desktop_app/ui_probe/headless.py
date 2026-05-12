"""Offscreen Qt platform configuration.

`configure_offscreen()` sets `QT_QPA_PLATFORM=offscreen` BEFORE any Qt
import so `QApplication` constructs a softpipe renderer that needs no
display server. It also pins font hinting + DPI to deterministic values
so screenshots are byte-stable across machines (the #1 source of flaky
visual regression on Qt is sub-pixel font rendering drifting between
Windows/Linux/macOS).

Idempotent. Safe to call from `conftest.py` at import time or from the
agent-tools entry point.
"""
from __future__ import annotations

import os

# Sentinel so the second call doesn't undo the first. We DO NOT clear
# the env on teardown — once a process is offscreen, every later
# QApplication in that process must be offscreen too or Qt asserts.
_CONFIGURED = False


def configure_offscreen() -> None:
    """Pin Qt to the offscreen platform with deterministic font / DPI.

    Must be called before `QApplication(sys.argv)` or any module that
    constructs widgets at import time. If a `QApplication` already
    exists when this runs, nothing breaks but the platform plugin is
    whatever was picked first.
    """
    global _CONFIGURED
    if _CONFIGURED:
        return

    # Platform plugin. "offscreen" renders into a QImage backbuffer
    # with no native window, which is exactly what we want for
    # screenshot capture.
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

    # Force deterministic DPI. Without this, capture on a 4K monitor
    # would produce a different pixel size than capture on a 1080p
    # CI runner, and baselines wouldn't transfer.
    os.environ.setdefault("QT_SCALE_FACTOR", "1")
    os.environ.setdefault("QT_AUTO_SCREEN_SCALE_FACTOR", "0")
    os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "0")

    # Pin font hinting / antialiasing. FreeType is shipped with Qt
    # on every platform; using it everywhere kills the Windows/Linux
    # font-rendering drift that breaks visual diffs.
    os.environ.setdefault("QT_QPA_FONTDIR", "")
    os.environ.setdefault("QT_HARFBUZZ", "old")

    _CONFIGURED = True


def is_offscreen() -> bool:
    """True if `configure_offscreen` has installed the offscreen env.

    Useful for tests that want to skip when run interactively (e.g.
    a developer running `pytest -k smoke` with a display attached
    might not want a baseline written from their machine).
    """
    return os.environ.get("QT_QPA_PLATFORM") == "offscreen"
