"""Widget-granularity UI probe for OWLLM.

Two consumers, one substrate:

* **Test suite** — pytest-qt drives `WidgetHarness` to bring up a single
  widget in isolation, captures a PNG via `capture_widget`, and compares
  against a golden under `desktop_app/tests/baselines/` via `diff`.
* **Agent framework** — the `ui_render_widget` / `ui_diff_baseline` /
  `ui_inspect` tools at `core/agents/tools/ui_tools.py` use the same
  harness so an LLM can iterate on a widget visually without a human
  in the verification loop.

Design rules that fall out of "widget granularity":

* Never boot the full `MainWindow`. The harness instantiates ONE
  widget per session, embeds it in a bare `QMainWindow` shell at a
  pinned size, and tears it down on exit. Tests stay <500 ms each.
* Default to the offscreen Qt platform so the harness runs on CI and
  headless dev boxes without a display server. `configure_offscreen()`
  is idempotent and must be called BEFORE the first QApplication.
* Pure-function image work (`diff`, `baseline`) lives in modules with
  no Qt import so agents can call them on PNG bytes without spinning
  up a Qt event loop.

The public surface is exported here. Submodules are implementation
detail; import from `desktop_app.ui_probe` rather than the submodule
paths so the layering can change without callers noticing.
"""
from __future__ import annotations

from desktop_app.ui_probe.app_harness import AppHarness
from desktop_app.ui_probe.baseline import (
    Baseline,
    BaselineMissing,
    baselines_dir,
    load_baseline,
    save_baseline,
)
from desktop_app.ui_probe.capture import capture_widget, capture_window
from desktop_app.ui_probe.diff import DiffResult, diff_pngs
from desktop_app.ui_probe.finder import find_widget, list_widgets
from desktop_app.ui_probe.harness import WidgetHarness
from desktop_app.ui_probe.headless import configure_offscreen, is_offscreen

__all__ = [
    "AppHarness",
    "Baseline",
    "BaselineMissing",
    "DiffResult",
    "WidgetHarness",
    "baselines_dir",
    "capture_widget",
    "capture_window",
    "configure_offscreen",
    "diff_pngs",
    "find_widget",
    "is_offscreen",
    "list_widgets",
    "load_baseline",
    "save_baseline",
]
