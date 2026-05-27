"""Subprocess runner for full-app screenshots.

Spawned by `core.agents.tools.ui_tools.ui_render_app_page` instead of
running in-process. Rationale: when the harness invoked MainWindow's
boot path directly under offscreen Qt, the background-detection
thread (`QTimer.singleShot(500, _start_background_detection)`)
mutated state that the `__exit__` teardown then accessed after
deletion, producing a `STATUS_STACK_BUFFER_OVERRUN` crash partway
through capture.

A subprocess avoids the issue entirely:

* Each call gets a fresh `QApplication` + fresh `MainWindow`.
* OS cleanup runs on process exit — no graceful Qt teardown needed.
* Concurrent agent calls can't poison each other's state.
* Cost is ~1 s of extra spawn overhead on top of the unavoidable
  ~6 s MainWindow boot, which is fine for the screenshot use case
  (this is never on a tight inner loop).

CLI: read JSON args from stdin, write the PNG to disk, exit 0 on
success or a non-zero code with a JSON error blob on stderr. The
JSON-in/JSON-out shape lets the parent surface clean error messages
to the agent without parsing log output.

Stdin payload schema:
    {
      "page":          "agents" | "studio" | "code" | "bridges" | "server" | "home" | "mcp",
      "out_path":      "absolute/path/to/output.png",
      "width":         1400,
      "height":        900,
      "wait_seconds":  5.0,
      "include_frame": true
    }
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path


def _die(msg: str, *, code: int = 1) -> None:
    """Emit a structured error and exit non-zero.

    The parent reads stderr looking for the JSON blob; anything else
    on stderr is incidental warning text it can ignore.
    """
    sys.stderr.write(json.dumps({"error": msg}) + "\n")
    sys.stderr.flush()
    sys.exit(code)


def _main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        _die(f"bad stdin JSON: {exc}")

    page = str(payload.get("page", "")).strip().lower()
    out_path = str(payload.get("out_path", "")).strip()
    if not page:
        _die("page is required")
    if not out_path:
        _die("out_path is required")

    width = int(payload.get("width", 1400))
    height = int(payload.get("height", 900))
    wait_seconds = float(payload.get("wait_seconds", 5.0))
    include_frame = bool(payload.get("include_frame", True))
    # Stability detection — capture twice, compare; if the two
    # captures match within `stable_pct`, the page has settled.
    # Defaults to ON because every full-app capture pre-v5 risked
    # capturing the loading state of `AgentsPage` (which kicks off
    # project-load + canvas-population via `QTimer.singleShot(150, ...)`
    # and isn't done settling at the initial 5 s mark).
    require_stable = bool(payload.get("require_stable", True))
    # 5 % accepts the idle "breathing" animation around the owl
    # emblem + agent canvas pulses (which never converge to 0 % on
    # a live AgentTeamCanvas) while still catching real loading
    # transitions where 20-100 % of pixels are mid-change.
    stable_pct = float(payload.get("stable_pct", 5.0))
    stable_max_attempts = int(payload.get("stable_max_attempts", 8))
    stable_recheck_seconds = float(payload.get("stable_recheck_seconds", 1.5))

    # Set offscreen BEFORE the first PySide6 import. Critical — the
    # platform plugin is locked in at QGuiApplication construct time
    # and can't be switched later.
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    os.environ.setdefault("QT_SCALE_FACTOR", "1")
    os.environ.setdefault("QT_AUTO_SCREEN_SCALE_FACTOR", "0")
    os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "0")

    # Make `import core.*` / `import desktop_app.*` work no matter
    # where the parent spawned us from.
    llm_root = Path(__file__).resolve().parents[2]
    if str(llm_root) not in sys.path:
        sys.path.insert(0, str(llm_root))

    try:
        from PySide6.QtCore import QBuffer, QByteArray, QIODevice
        from PySide6.QtGui import QColor, QFontDatabase, QImage, QPainter
        from PySide6.QtWidgets import QApplication
    except ImportError as exc:
        _die(f"PySide6 unavailable: {exc}")

    app = QApplication.instance() or QApplication(sys.argv[:1])

    # Load system fonts so the captured page has readable text.
    # Mirrors `desktop_app.ui_probe.harness._load_system_fonts_once`.
    if sys.platform.startswith("win"):
        font_root = r"C:\Windows\Fonts"
        if os.path.isdir(font_root):
            for dirpath, _dirs, files in os.walk(font_root):
                for name in files:
                    if name.lower().endswith((".ttf", ".ttc", ".otf")):
                        QFontDatabase.addApplicationFont(os.path.join(dirpath, name))

    # Map page name → MainWindow tab index attribute.
    page_attr = {
        "agents": "_agents_tab_index",
        "studio": "_studio_tab_index",
        "code": "_code_tab_index",
        "bridges": "_bridges_tab_index",
        "server": "_server_tab_index",
        "home": "_home_tab_index",
        "mcp": "_mcp_tab_index",
    }.get(page)

    try:
        from desktop_app.main import MainWindow
    except Exception as exc:  # noqa: BLE001
        _die(f"could not import MainWindow: {exc}\n{traceback.format_exc()}")

    try:
        win = MainWindow(splash=None)
    except Exception as exc:  # noqa: BLE001
        _die(f"MainWindow construction failed: {exc}\n{traceback.format_exc()}")

    win.resize(width, height)

    # Resolve the tab index by attribute first, then by tab text fallback.
    tab_idx = None
    if page_attr is not None:
        tab_idx = getattr(win, page_attr, None)
    if not isinstance(tab_idx, int) or tab_idx < 0:
        # Fallback: scan tab labels for the page name.
        if hasattr(win, "tabs"):
            for i in range(win.tabs.count()):
                label = win.tabs.tabText(i).lower()
                ascii_label = "".join(c for c in label if c.isascii())
                if page in ascii_label.split():
                    tab_idx = i
                    break
    if not isinstance(tab_idx, int) or tab_idx < 0:
        available = [win.tabs.tabText(i) for i in range(win.tabs.count())] if hasattr(win, "tabs") else []
        _die(f"unknown page {page!r}; available: {available}")

    # Production boot sequence — match `desktop_app.main.main()` so
    # the screenshot looks identical to what a user sees. Build the
    # frame BEFORE the first show so its geometry tracks the
    # window's initial size.
    frame = None
    if include_frame:
        try:
            from pathlib import Path as _Path
            llm_dir = _Path(__file__).resolve().parents[2]
            root_dir = llm_dir.parent
            if str(llm_dir) not in sys.path:
                sys.path.insert(0, str(llm_dir))
            from ui_frame.hybrid_frame import HybridFrameWindow, FrameAssets

            assets_dir = root_dir / "hybrid_frame_module" / "assets"

            def asset(name: str):
                for ext in ("webp", "png"):
                    p = assets_dir / f"{name}.{ext}"
                    if p.exists():
                        return str(p)
                return None

            cnew = root_dir / "icons" / "Page_icons" / "CornersNew"

            def corner(internal: str, new_name: str):
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
                fa, corner_size=18, border_thickness=18, safe_padding=2,
                resize_margin=8, parent_window=win,
            )
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

            colors = win._get_theme_colors()
            fc = QColor(colors["primary"]); fc.setAlpha(220)
            ac = QColor(colors["accent"]);  ac.setAlpha(200)
            bg = QColor(colors["primary"]).darker(300)
            frame.set_frame_colors(fc, ac, bg)
        except Exception as exc:  # noqa: BLE001
            # If the frame can't load, fall through to a frameless
            # capture rather than aborting. The agent gets a usable
            # PNG plus a warning on stderr.
            sys.stderr.write(f"frame init failed (continuing without): {exc}\n")
            frame = None

    win.show()
    if frame is not None:
        frame.show()

    # Switch tabs AFTER show so lazy widget construction (the
    # AgentsPage placeholder being swapped for the real page) runs
    # against a fully-shown parent.
    win.tabs.setCurrentIndex(tab_idx)

    # Pump the event loop. 50 ms granularity is small enough for
    # `QTimer.singleShot(100-300, ...)`-style deferred bootstrap.
    def _pump(seconds: float) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < deadline:
            app.processEvents()
            time.sleep(0.05)

    _pump(max(0.5, wait_seconds))

    # Grab + composite. Frame is a separate top-level widget under
    # offscreen — neither grabs the other automatically, so we draw
    # both into one QImage.
    def _capture_composite() -> bytes:
        win_pm = win.grab()
        if frame is None:
            ba = QByteArray(); buf = QBuffer(ba); buf.open(QIODevice.OpenModeFlag.WriteOnly)
            win_pm.save(buf, "PNG"); buf.close()
            return bytes(ba)
        frame_pm = frame.grab()
        wg = win.geometry()
        fg = frame.geometry()
        canvas = QImage(fg.width(), fg.height(), QImage.Format.Format_ARGB32_Premultiplied)
        canvas.fill(0)
        p = QPainter(canvas)
        p.drawPixmap(wg.x() - fg.x(), wg.y() - fg.y(), win_pm)
        p.drawPixmap(0, 0, frame_pm)
        p.end()
        ba = QByteArray(); buf = QBuffer(ba); buf.open(QIODevice.OpenModeFlag.WriteOnly)
        canvas.save(buf, "PNG"); buf.close()
        return bytes(ba)

    def _bytes_diff_pct(a: bytes, b: bytes) -> float:
        """Return % of pixels that differ between two PNG byte streams.

        Always decodes both — PNG deflate includes filter-row choices
        that aren't deterministic across grabs, so identical pixels
        can produce different byte streams (and different lengths).
        Comparing bytes directly would report 100% drift on a page
        that's actually fully settled.

        We decode via Pillow rather than `QImage.constBits().tobytes()`
        because the latter returned indexable objects whose elements
        weren't plain ints — `abs(x - y)` was being parsed as a
        two-arg call to abs(), exploding the runner.
        """
        from io import BytesIO
        from PIL import Image
        try:
            ia = Image.open(BytesIO(a)).convert("RGBA")
            ib = Image.open(BytesIO(b)).convert("RGBA")
        except Exception:  # noqa: BLE001
            return 100.0
        if ia.size != ib.size:
            return 100.0
        raw_a = ia.tobytes()
        raw_b = ib.tobytes()
        differing = 0
        total = ia.width * ia.height
        for i in range(0, len(raw_a), 4):
            dr = abs(raw_a[i] - raw_b[i])
            dg = abs(raw_a[i + 1] - raw_b[i + 1])
            db = abs(raw_a[i + 2] - raw_b[i + 2])
            if max(dr, dg, db) > 8:
                differing += 1
        return (100.0 * differing / total) if total else 0.0

    from PySide6.QtCore import QBuffer, QByteArray, QIODevice
    # Stability strategy: require N consecutive captures to all
    # match within tolerance. A single match isn't enough — if the
    # page changes in distinct phases (initial paint, project load,
    # canvas population at ~6 s), each phase can show a small
    # enough delta to pass a single-match tolerance even though the
    # page is mid-load.
    stable_consecutive_needed = int(payload.get("stable_consecutive_needed", 3))
    png = _capture_composite()
    # Write the FIRST capture immediately so a crash mid-loop still
    # leaves a usable PNG on disk for the parent to fall back to.
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_bytes(png)

    stable = True
    attempts = 0
    final_pct = 0.0
    drift_history: list = []
    if require_stable:
        stable = False
        consecutive_matches = 0
        while attempts < stable_max_attempts:
            attempts += 1
            _pump(stable_recheck_seconds)
            next_png = _capture_composite()
            pct = _bytes_diff_pct(png, next_png)
            final_pct = pct
            drift_history.append(round(pct, 2))
            png = next_png
            # Persist EACH new capture as we go. If MainWindow's
            # background-detection thread eventually crashes the
            # subprocess (~7-8 s of pumping total under offscreen
            # Qt), the parent at least gets the freshest pre-crash
            # frame instead of a stale early-load snapshot.
            Path(out_path).write_bytes(png)
            if pct <= stable_pct:
                consecutive_matches += 1
                sys.stderr.write(
                    f"[stability] attempt {attempts}: {pct:.2f}% differ "
                    f"(consecutive match {consecutive_matches}/{stable_consecutive_needed})\n"
                )
                if consecutive_matches >= stable_consecutive_needed:
                    stable = True
                    break
            else:
                consecutive_matches = 0
                sys.stderr.write(
                    f"[stability] attempt {attempts}: {pct:.2f}% differ, "
                    f"retrying (consecutive reset)\n"
                )

    # (File was already written on each iteration above.)

    # Print one machine-readable line for the parent to parse.
    print(json.dumps({
        "ok": True,
        "path": str(out_path),
        "width": (frame.width() if frame is not None else win.width()),
        "height": (frame.height() if frame is not None else win.height()),
        "page": page,
        "frame": frame is not None,
        "stable": stable,
        "stability_attempts": attempts,
        "final_drift_pct": round(final_pct, 3),
        "drift_history": drift_history,
    }), flush=True)

    # Do NOT close/deleteLater the widgets — the OS will clean them
    # up when this process exits. Graceful Qt teardown is what
    # crashed under offscreen; we sidestep it entirely by relying
    # on process termination.
    return 0


if __name__ == "__main__":
    sys.exit(_main())
