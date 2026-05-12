"""Full-app harness — boots `MainWindow` + `HybridFrameWindow` and
captures the running app at any tab.

`WidgetHarness` (sibling module) is for widget-granularity work — one
card in isolation, fast, no subsystems. This module is for the
opposite end of the spectrum: when an agent or test needs to see
"the app showing page X" — chrome, tab bar, project picker,
decorative frame corners, the works.

The boot mirrors `desktop_app.main.main()`:

1. Construct `QApplication` if absent (offscreen platform).
2. Load system fonts (otherwise labels render as missing-glyph boxes).
3. Construct `MainWindow(splash=None)` — skips the slow splash path.
4. Construct `HybridFrameWindow` from the same `FrameAssets` the real
   app uses (CornersNew/, Page_icons/owl_studio_square.png).
5. Position the frame around `MainWindow`'s geometry.
6. Show both; switch to the requested tab.
7. Pump the event loop for `wait_seconds` so deferred bootstrap
   (project load, agent canvas population, font scans) settles.
8. Composite-grab: window contents + frame overlay into one PNG.

Cost: ~6-8 s for the first construction (MainWindow boots a lot of
subsystems on import). Subsequent calls in the same process re-use
the QApplication and font cache. NOT something you'd run inside a
fast pytest loop — gate with `@pytest.mark.slow` or an env flag.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtWidgets import QApplication

from desktop_app.ui_probe.harness import _load_system_fonts_once
from desktop_app.ui_probe.headless import configure_offscreen


# Mapping from agent-friendly page names to the attribute on
# `MainWindow` that holds that tab's index. The real `MainWindow`
# adds tabs lazily as their dependencies resolve, so the name -> index
# map is built at runtime from MainWindow's own attributes.
_PAGE_ATTR = {
    "agents": "_agents_tab_index",
    "studio": "_studio_tab_index",
    "code": "_code_tab_index",
    "bridges": "_bridges_tab_index",
    "server": "_server_tab_index",
    "home": "_home_tab_index",
    "mcp": "_mcp_tab_index",
}


def _resolve_tab_index(win, page: str) -> Optional[int]:
    """Find the QTabWidget index for `page`, or None if unavailable.

    Tries `_PAGE_ATTR` first, then falls back to scanning the tab
    bar's display text. The text scan tolerates emoji prefixes
    (`🏠 Home`, `🌐 Bridges`) and case differences.
    """
    attr = _PAGE_ATTR.get(page.lower())
    if attr is not None:
        idx = getattr(win, attr, None)
        if isinstance(idx, int) and idx >= 0:
            return idx

    # Fallback: text scan.
    tabs = getattr(win, "tabs", None)
    if tabs is None:
        return None
    needle = page.lower().strip()
    for i in range(tabs.count()):
        label = tabs.tabText(i).lower()
        # Strip emoji + whitespace by keeping ASCII letters only.
        stripped = "".join(c for c in label if c.isascii() and (c.isalnum() or c.isspace())).strip()
        if needle == stripped or needle in stripped.split():
            return i
    return None


def _build_frame(win, root_dir: Path):
    """Construct the `HybridFrameWindow` overlay using the same asset
    resolution rules as `desktop_app.main.main()`. Returns the frame.

    Mirrors the production boot byte-for-byte where it can — same
    corner_size, border_thickness, theme color derivation, geometry
    inflation. Drifting from production here would mean the captured
    screenshot doesn't match what a user actually sees.
    """
    from ui_frame.hybrid_frame import HybridFrameWindow, FrameAssets

    assets_dir = root_dir / "hybrid_frame_module" / "assets"

    def asset(name: str) -> Optional[str]:
        for ext in ("webp", "png"):
            p = assets_dir / f"{name}.{ext}"
            if p.exists():
                return str(p)
        return None

    cnew = root_dir / "icons" / "Page_icons" / "CornersNew"

    def corner(internal: str, new_name: str) -> Optional[str]:
        c = cnew / new_name
        return str(c) if c.exists() else asset(internal)

    top_center = root_dir / "icons" / "Page_icons" / "owl_studio_square.png"

    fa = FrameAssets(
        corner_tl=corner("corner_tl", "corner_ul.png"),
        corner_tr=corner("corner_tr", "corner_ur.png"),
        corner_bl=corner("corner_bl", "corner_bl.png"),
        corner_br=str(cnew / "corner_br.png") if (cnew / "corner_br.png").exists() else None,
        top_center=str(top_center) if top_center.exists() else asset("top_center_owl"),
    )

    frame = HybridFrameWindow(
        fa,
        corner_size=18,
        border_thickness=18,
        safe_padding=2,
        resize_margin=8,
        parent_window=win,
    )

    # Geometry inflation mirrors main.py — half-border outset on all
    # sides, plus extra room for the top crest (badge_h/2) and the
    # right corner_tr extension (75 px).
    badge_h = int(90 * 0.65)
    extra_top = badge_h // 2
    extra_right = 75
    shift_out = 9
    fg = win.geometry()
    fg.setX(fg.x() - shift_out)
    fg.setY(fg.y() - extra_top - shift_out)
    fg.setHeight(fg.height() + extra_top + 2 * shift_out)
    fg.setWidth(fg.width() + extra_right + 2 * shift_out)
    frame.setGeometry(fg)

    # Theme-derived colors, exactly as production sets them.
    colors = win._get_theme_colors()
    fc = QColor(colors["primary"]); fc.setAlpha(220)
    ac = QColor(colors["accent"]);  ac.setAlpha(200)
    bg = QColor(colors["primary"]).darker(300)
    frame.set_frame_colors(fc, ac, bg)

    return frame


class AppHarness:
    """Boot the full OWLLM app offscreen and capture any tab.

    Usage:

        with AppHarness() as h:
            h.navigate("agents")
            png = h.capture(width=1400, height=900, wait_seconds=5)

    The context manager owns the QApplication + MainWindow + frame.
    Tearing down via `__exit__` deletes the windows and flushes the
    event loop. The QApplication itself outlives the harness — Qt
    forbids second construction in a process, so subsequent harness
    instances reuse it.
    """

    def __init__(self, *, include_frame: bool = True) -> None:
        configure_offscreen()
        self._include_frame = include_frame
        self._app: Optional[QApplication] = None
        self._win = None
        self._frame = None

    # Known issue: invoking the harness end-to-end through the agent
    # tool wrapper crashes with STATUS_STACK_BUFFER_OVERRUN (0xC0000409)
    # somewhere between `capture()` and process exit, even after
    # switching `__exit__` from delete-now to hide-only. The same
    # boot sequence run inline (without the context manager wrapping)
    # succeeds — see commit history for the proof-of-concept output
    # at c:/tmp/owllm_full.png. Suspect: MainWindow's background
    # detection thread (QTimer.singleShot(500, _start_background_detection))
    # touches state from the offscreen QApplication that gets
    # invalidated mid-pump. Not blocking the React work; will be
    # iterated on once the rebuild surfaces other requirements.

    def __enter__(self) -> "AppHarness":
        self._app = QApplication.instance() or QApplication(sys.argv[:1])
        _load_system_fonts_once()
        # Import MainWindow lazily — pulls in dozens of subsystems
        # so callers that only want the WidgetHarness shouldn't pay
        # the import cost transitively.
        from desktop_app.main import MainWindow

        self._win = MainWindow(splash=None)
        # Match production: window gets its working size BEFORE the
        # frame is sized around it, so the frame's geometry inflation
        # is based on the right window rect from the start.
        self._win.resize(1400, 900)
        if self._include_frame:
            llm_dir = Path(__file__).resolve().parents[2]
            root_dir = llm_dir.parent
            if str(llm_dir) not in sys.path:
                sys.path.insert(0, str(llm_dir))
            self._frame = _build_frame(self._win, root_dir)
        # Show order from main.py: win first (underneath), then frame
        # overlay. Doing this in __enter__ rather than capture() means
        # navigate() operates on a fully-shown window — lazy tab
        # construction (the Agents placeholder being swapped for the
        # real AgentsPage) needs that to access screen geometry
        # without crashing under offscreen.
        self._win.show()
        if self._frame is not None:
            self._frame.show()
        # Let the initial show settle before anyone navigates.
        self._pump(0.3)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        # MainWindow holds long-lived subsystems (bus, project store,
        # MCP server manager, voice service, background detection
        # threads) that aren't designed to tear down cleanly mid-life.
        # Calling close()/deleteLater() under offscreen triggers a
        # stack-buffer overrun on shutdown — the underlying issue is
        # production assumes a normal app-exit lifecycle, not a
        # mid-process teardown.
        #
        # Workaround: hide rather than delete. The QApplication and
        # the windows stay alive until process exit, where the OS
        # cleans them up. Cost is ~120 MB of resident memory per
        # un-torn-down harness, which is fine for the agent
        # screenshot use case (one capture per agent turn, process
        # exits after the agent loop ends).
        try:
            if self._frame is not None:
                self._frame.hide()
            if self._win is not None:
                self._win.hide()
            if self._app is not None:
                self._app.processEvents()
        except Exception:
            # Don't let teardown errors propagate — capture already
            # succeeded by the time we're here.
            pass

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------

    def navigate(self, page: str) -> int:
        """Switch to `page` (e.g. 'agents'). Returns the tab index.

        Raises `ValueError` if the page can't be resolved. The error
        message lists what IS available so callers can self-correct.
        """
        if self._win is None:
            raise RuntimeError("AppHarness.navigate called outside context")
        idx = _resolve_tab_index(self._win, page)
        if idx is None:
            available = [
                self._win.tabs.tabText(i)
                for i in range(self._win.tabs.count())
            ]
            raise ValueError(
                f"unknown page {page!r}; available: {available}"
            )
        self._win.tabs.setCurrentIndex(idx)
        self._pump(0.5)
        return idx

    def capture(
        self,
        *,
        width: int = 1400,
        height: int = 900,
        wait_seconds: float = 5.0,
    ) -> bytes:
        """Resize if needed, settle, composite-grab. Returns PNG bytes.

        `wait_seconds` is how long to pump the event loop — needed
        for deferred bootstrap (Agents page kicks off project load +
        canvas population via `QTimer.singleShot(150, ...)`). 5 s is
        empirically enough for the heaviest pages.
        """
        if self._win is None:
            raise RuntimeError("AppHarness.capture called outside context")

        # Only resize + re-inflate frame if the caller asked for a
        # different size than what __enter__ set. Resize-on-shown
        # window is what triggered the access violation: the
        # HybridFrame attaches event filters to the parent's resize
        # events and a recompute under offscreen + animation state
        # blew up.
        if (width, height) != (self._win.width(), self._win.height()):
            self._win.resize(int(width), int(height))
            if self._frame is not None:
                self._reinflate_frame()

        self._pump(float(wait_seconds))

        win_pm = self._win.grab()
        if self._frame is None:
            from desktop_app.ui_probe.capture import _pixmap_to_png
            return _pixmap_to_png(win_pm)

        # Composite onto a canvas sized to the frame (frame is
        # slightly larger than the window — outset by half-border
        # and extra top room for the crest).
        frame_pm = self._frame.grab()
        wg = self._win.geometry()
        fg = self._frame.geometry()
        canvas = QImage(fg.width(), fg.height(), QImage.Format.Format_ARGB32_Premultiplied)
        canvas.fill(0)
        p = QPainter(canvas)
        p.drawPixmap(wg.x() - fg.x(), wg.y() - fg.y(), win_pm)
        p.drawPixmap(0, 0, frame_pm)
        p.end()
        return _qimage_to_png(canvas)

    def _reinflate_frame(self) -> None:
        """Recompute the frame's geometry from the current window rect.

        Same inflation rules as `_build_frame`. Factored out so resize
        in `capture()` and the original placement in `_build_frame`
        agree byte-for-byte.
        """
        if self._frame is None or self._win is None:
            return
        badge_h = int(90 * 0.65)
        extra_top = badge_h // 2
        extra_right = 75
        shift_out = 9
        fg = self._win.geometry()
        fg.setX(fg.x() - shift_out)
        fg.setY(fg.y() - extra_top - shift_out)
        fg.setHeight(fg.height() + extra_top + 2 * shift_out)
        fg.setWidth(fg.width() + extra_right + 2 * shift_out)
        self._frame.setGeometry(fg)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _pump(self, seconds: float) -> None:
        """Spin the event loop for `seconds`, processing posted events.

        50 ms granularity — small enough that QTimer-driven bootstrap
        (which often defers in 100-300 ms hops) gets multiple turns.
        """
        if self._app is None or seconds <= 0:
            return
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self._app.processEvents()
            time.sleep(0.05)


def _qimage_to_png(img: QImage) -> bytes:
    """Serialize a QImage to PNG bytes."""
    from PySide6.QtCore import QBuffer, QByteArray, QIODevice
    ba = QByteArray()
    buf = QBuffer(ba)
    buf.open(QIODevice.OpenModeFlag.WriteOnly)
    try:
        img.save(buf, "PNG")
        return bytes(ba)
    finally:
        buf.close()


__all__ = ["AppHarness"]
