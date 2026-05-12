"""Capture rendered widget output as PNG bytes.

Two entry points:

* `capture_widget(widget)` — grab the widget's own paint surface,
  including children, using `QWidget.grab()`. Bypasses the window
  manager entirely so it works under the offscreen platform.
* `capture_window(widget)` — grab the top-level window the widget
  lives in. Useful when a click pops a child dialog and you want
  the whole thing.

Both return PNG bytes. We deliberately do NOT take a `Path` argument
— callers persist bytes via `baseline.save_baseline` so all writes
funnel through one place that can grow features (atomic write, file
locking, sidecar metadata) later.
"""
from __future__ import annotations

from io import BytesIO

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QSize
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import QWidget


def capture_widget(widget: QWidget, *, size: QSize | None = None) -> bytes:
    """Render `widget` (and its children) to PNG bytes.

    The widget must be `show()`-n at least once for layout to settle —
    `WidgetHarness.show(widget)` does this. Capturing a never-shown
    widget returns a 1x1 transparent PNG, which is a useful failure
    mode (visual diff catches it).

    `size` overrides the widget's reported size for the capture only.
    Without it we use `widget.size()` after a `processEvents()` flush.
    """
    if size is not None and size.isValid():
        widget.resize(size)
    elif widget.size().isEmpty():
        # Widget has never been resized and has no laid-out geometry —
        # fall back to its sizeHint so we don't return a 0x0 PNG.
        # We deliberately don't call `adjustSize()` when the widget
        # ALREADY has a size: that overrides any explicit `resize()`
        # the test or harness set, which breaks layouts that depend
        # on a parent-defined width.
        widget.adjustSize()

    # Flush any pending paint events queued by a parent's `show()` or
    # the resize above. `grab()` paints synchronously into the returned
    # pixmap, so we don't need a second pass after this.
    if (app := widget.window()) is not None:
        app.update()
    pixmap: QPixmap = widget.grab()
    return _pixmap_to_png(pixmap)


def capture_window(widget: QWidget, *, size: QSize | None = None) -> bytes:
    """Render the top-level window containing `widget`.

    Falls back to `capture_widget(widget)` when the widget has no
    parent (i.e. it IS the top level). This is the common shape for
    dialogs that pop child popovers — the test grabs the whole stack.
    """
    top = widget.window() if widget.parent() is not None else widget
    return capture_widget(top, size=size)


def _pixmap_to_png(pixmap: QPixmap) -> bytes:
    """Serialize a `QPixmap` to PNG bytes via Qt's own encoder.

    Going through `QBuffer` avoids a temp file. Quality is lossless
    for PNG; the second arg of `save()` is the format string.
    """
    ba = QByteArray()
    buf = QBuffer(ba)
    buf.open(QIODevice.OpenModeFlag.WriteOnly)
    try:
        ok = pixmap.save(buf, "PNG")
        if not ok:
            # Should be impossible under normal use — Qt's PNG encoder
            # can serialize any QPixmap. If it ever happens, fall
            # through to a clearly-zero-sized PNG so callers see a
            # visual diff rather than a silent corruption.
            return _empty_png()
        return bytes(ba)
    finally:
        buf.close()


def _empty_png() -> bytes:
    """1x1 fully-transparent PNG — sentinel for capture failure.

    Hard-coded so a missing Pillow doesn't break the test scaffold.
    """
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xfc\xff"
        b"\xff?\x03\x00\x05\xfe\x02\xfe\xa3>\xf3\xd1\x00\x00\x00\x00IEND\xaeB`\x82"
    )


# Re-export for the BytesIO callers (diff.py reads PNG bytes).
__all__ = ["capture_widget", "capture_window", "BytesIO"]
