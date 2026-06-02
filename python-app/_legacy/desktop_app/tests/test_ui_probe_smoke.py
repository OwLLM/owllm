"""End-to-end smoke tests for `ui_probe`.

These exercise the whole stack — `WidgetHarness` → `capture_widget`
→ `diff_pngs` → `baseline` — against a trivial in-test widget that
has no OWLLM-specific dependencies. If these pass, the substrate is
healthy regardless of whether any specific OWLLM widget is broken.

A separate file (`test_ui_probe_real_widgets.py`) covers real
widgets and is allowed to be more fragile.
"""
from __future__ import annotations

import pytest

from PySide6.QtCore import QSize, Qt
from PySide6.QtWidgets import QLabel, QPushButton, QVBoxLayout, QWidget

from desktop_app.ui_probe import (
    WidgetHarness,
    capture_widget,
    diff_pngs,
    find_widget,
    list_widgets,
)
from desktop_app.ui_probe.baseline import save_baseline, load_baseline, BaselineMissing


# ---------------------------------------------------------------------------
# Test widgets — defined here so the smoke suite has zero coupling to OWLLM
# ---------------------------------------------------------------------------


class _GreetingCard(QWidget):
    """Minimal widget with a labelled button. Used to validate the
    capture/finder/diff round-trip without depending on OWLLM code."""

    def __init__(self, greeting: str = "Hello"):
        super().__init__()
        layout = QVBoxLayout(self)
        self.label = QLabel(greeting)
        self.label.setObjectName("greeting_label")
        self.label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.button = QPushButton("&Save")
        self.button.setObjectName("save_btn")
        layout.addWidget(self.label)
        layout.addWidget(self.button)
        self.resize(300, 120)


# ---------------------------------------------------------------------------
# Harness lifecycle
# ---------------------------------------------------------------------------


def test_harness_brings_up_widget_and_emits_show_event() -> None:
    saw_show = []

    class _Spy(QWidget):
        def showEvent(self, e):  # noqa: N802 — Qt naming
            saw_show.append(True)
            super().showEvent(e)

    with WidgetHarness() as h:
        h.show(_Spy())
        assert saw_show == [True]


def test_harness_replaces_hosted_widget_on_second_show() -> None:
    with WidgetHarness() as h:
        first = h.show(_GreetingCard("first"))
        # First widget's parent is the shell.
        assert first.parentWidget() is h.shell
        second = h.show(_GreetingCard("second"))
        assert second.parentWidget() is h.shell
        assert second is not first


# ---------------------------------------------------------------------------
# Capture
# ---------------------------------------------------------------------------


def test_capture_widget_returns_png_bytes() -> None:
    from io import BytesIO

    from PIL import Image

    with WidgetHarness() as h:
        card = h.show(_GreetingCard())
        png = capture_widget(card)
    # PNG magic bytes — non-negotiable.
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    # Verify actual pixel dimensions rather than file size — heavy PNG
    # compression on a mostly-blank card can produce tiny files even
    # when the capture is correct. The card's `__init__` does
    # `resize(300, 120)`; the harness honors that.
    img = Image.open(BytesIO(png))
    assert img.size == (300, 120), f"unexpected capture size: {img.size}"


def test_capture_is_deterministic_across_two_grabs() -> None:
    """The same widget captured twice in a row should be byte-identical.

    If this ever fails, sub-pixel font rendering or animation timers
    are leaking through and the diff tolerance needs widening — or
    the offscreen platform isn't actually engaged.
    """
    with WidgetHarness() as h:
        card = h.show(_GreetingCard())
        png1 = capture_widget(card)
        png2 = capture_widget(card)
    result = diff_pngs(png1, png2)
    assert result.same, result.describe()
    assert result.differing_pixels == 0


def test_capture_at_explicit_size() -> None:
    with WidgetHarness() as h:
        card = h.show(_GreetingCard())
        small = capture_widget(card, size=QSize(120, 60))
        large = capture_widget(card, size=QSize(600, 300))
    # Crude check: the larger render produces more bytes. Exact pixel
    # sizes are validated by `diff_pngs`'s `width`/`height` fields in
    # tests further down.
    assert len(large) > len(small)


# ---------------------------------------------------------------------------
# Finder
# ---------------------------------------------------------------------------


def test_finder_by_object_name() -> None:
    with WidgetHarness() as h:
        card = h.show(_GreetingCard())
        found = find_widget(card, object_name="save_btn")
    assert found is not None
    assert found.objectName() == "save_btn"


def test_finder_by_widget_type() -> None:
    with WidgetHarness() as h:
        card = h.show(_GreetingCard())
        found = find_widget(card, widget_type=QPushButton)
    assert isinstance(found, QPushButton)


def test_finder_by_text_strips_accelerator() -> None:
    """`&Save` should match `text='Save'` — the ampersand is a Qt
    accelerator hint, not visible character."""
    with WidgetHarness() as h:
        card = h.show(_GreetingCard())
        found = find_widget(card, text="Save")
    assert isinstance(found, QPushButton)


def test_finder_returns_none_when_no_match() -> None:
    with WidgetHarness() as h:
        card = h.show(_GreetingCard())
        assert find_widget(card, object_name="does_not_exist") is None


def test_list_widgets_describes_tree() -> None:
    with WidgetHarness() as h:
        card = h.show(_GreetingCard())
        listing = list_widgets(card)
    # The root + at least the label + the button. Layout managers
    # aren't QWidgets so they don't show up.
    names = {w["object_name"] for w in listing}
    assert "greeting_label" in names
    assert "save_btn" in names


# ---------------------------------------------------------------------------
# Diff
# ---------------------------------------------------------------------------


def test_diff_detects_text_change() -> None:
    """Changing the greeting label should produce a visible diff."""
    with WidgetHarness() as h:
        a = capture_widget(h.show(_GreetingCard("Hello")))
        b = capture_widget(h.show(_GreetingCard("Goodbye")))
    result = diff_pngs(a, b)
    assert not result.same, result.describe()
    assert result.differing_pixels > 0


def test_diff_tolerates_identical_images() -> None:
    with WidgetHarness() as h:
        png = capture_widget(h.show(_GreetingCard()))
    result = diff_pngs(png, png)
    assert result.same
    assert result.differing_pixels == 0
    assert result.max_channel_delta == 0


def test_diff_handles_size_mismatch_as_not_same() -> None:
    with WidgetHarness() as h:
        card = h.show(_GreetingCard())
        small = capture_widget(card, size=QSize(120, 60))
        large = capture_widget(card, size=QSize(400, 200))
    result = diff_pngs(small, large)
    assert not result.same
    assert result.width == 400
    assert result.height == 200


# ---------------------------------------------------------------------------
# Baseline round-trip
# ---------------------------------------------------------------------------


def test_baseline_save_and_load_round_trip(tmp_path, monkeypatch) -> None:
    """Saving a baseline and re-reading it returns identical bytes.

    We monkeypatch `_BASELINES_DIR` so the test doesn't pollute the
    real `tests/baselines/` directory.
    """
    monkeypatch.setattr(
        "desktop_app.ui_probe.baseline._BASELINES_DIR",
        tmp_path,
    )
    with WidgetHarness() as h:
        png = capture_widget(h.show(_GreetingCard()))
    saved = save_baseline("greeting_card_smoke", png)
    loaded = load_baseline("greeting_card_smoke")
    assert saved.png == loaded.png == png
    assert saved.path == loaded.path


def test_baseline_missing_raises_typed_error(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "desktop_app.ui_probe.baseline._BASELINES_DIR",
        tmp_path,
    )
    with pytest.raises(BaselineMissing):
        load_baseline("does_not_exist")


def test_baseline_name_sanitization(tmp_path, monkeypatch) -> None:
    """Names with slashes / spaces / parens become safe filenames."""
    monkeypatch.setattr(
        "desktop_app.ui_probe.baseline._BASELINES_DIR",
        tmp_path,
    )
    saved = save_baseline("Fleet/Page (top)", b"not really a png but it works")
    assert "/" not in saved.path.name
    assert "(" not in saved.path.name
    assert saved.path.name.endswith(".png")
