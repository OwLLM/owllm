"""Qt-side subprocess runner — boots MainWindow under offscreen Qt, captures
the composite frame+window PNG, walks the QWidget tree, emits BOTH artifacts
to disk in one MainWindow boot.

Same crash-avoidance strategy as `desktop_app/ui_probe/_app_capture_runner.py`
(fresh process per call so OS teardown cleans up). The tree dump is added
on top of the existing screenshot+stability logic.

Stdin payload (JSON):
    {
      "page":          "agents",
      "out_png":       "abs/path/to/png",
      "out_tree":      "abs/path/to/tree.json",
      "width":  1600,
      "height": 960,
      "wait_seconds": 5.0,
      "include_frame": true,
      "stable_pct": 5.0,
      "stable_consecutive_needed": 3,
      "stable_max_attempts": 8,
      "stable_recheck_seconds": 1.5
    }
Stdout: one JSON line summarising the result.
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path


def _die(msg: str, code: int = 1) -> None:
    sys.stderr.write(json.dumps({"error": msg}) + "\n")
    sys.stderr.flush()
    sys.exit(code)


# ----------------------------------------------------------------------
# Qt class → schema.kind classifier. Used by the tree walker below.
# We only care about a coarse bucket — the diff engine uses it to pick a
# comparison policy.
# ----------------------------------------------------------------------
def _classify(qclass: str) -> str:
    name = qclass.lower()
    if "button" in name:
        return "button"
    if "lineedit" in name or "textedit" in name or "plaintext" in name:
        return "input"
    if name.endswith("label") or "label" in name:
        # QLabel is also used for icons — caller can override via raw.
        return "text"
    if "combobox" in name or "listview" in name or "listwidget" in name or "treeview" in name:
        return "list"
    if "canvas" in name or "graphicsview" in name:
        return "canvas"
    if "pixmap" in name or "image" in name:
        return "image"
    if name in {"qframe", "qwidget", "qstackedwidget", "qsplitter", "qtabwidget"}:
        return "container"
    return "other"


def _safe_text(w) -> str:
    """Pull human-visible text off a widget without raising."""
    for attr in ("text", "toPlainText", "placeholderText"):
        if hasattr(w, attr) and callable(getattr(w, attr)):
            try:
                v = getattr(w, attr)()
                if v:
                    return str(v)[:200]
            except Exception:  # noqa: BLE001
                pass
    return ""


def _safe_style(w) -> dict:
    """Best-effort style snapshot from a QWidget.

    Stylesheet strings override the palette, so palette() values can lie
    when the widget is themed via setStyleSheet. We capture both: the
    palette colors (always available) AND the raw stylesheet string (so
    the diff core can string-match common patterns like "font-size:13px"
    when palette is uninformative). Cheap to compute, valuable for
    catching color/size mismatches the pixel diff misses on uniform
    areas.
    """
    out: dict = {}
    try:
        f = w.font()
        ps = f.pixelSize()
        if ps <= 0:
            pt = f.pointSize()
            if pt > 0:
                ps = int(pt * 4 / 3)
        out["font_size_px"] = int(ps) if ps > 0 else None
        out["font_weight"] = "bold" if f.bold() else "normal"
        out["font_family"] = str(f.family() or "")
    except Exception:  # noqa: BLE001
        pass
    try:
        pal = w.palette()
        out["color_fg"] = pal.windowText().color().name()
        out["color_bg"] = pal.window().color().name()
    except Exception:  # noqa: BLE001
        pass
    try:
        sheet = w.styleSheet() or ""
        if sheet:
            out["stylesheet"] = sheet[:300]
    except Exception:  # noqa: BLE001
        pass
    return out


def _main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        _die(f"bad stdin JSON: {exc}")

    page = str(payload.get("page", "")).strip().lower()
    out_png = str(payload.get("out_png", "")).strip()
    out_tree = str(payload.get("out_tree", "")).strip()
    if not (page and out_png and out_tree):
        _die("page, out_png, out_tree are required")

    width = int(payload.get("width", 1600))
    height = int(payload.get("height", 960))
    wait_seconds = float(payload.get("wait_seconds", 5.0))
    include_frame = bool(payload.get("include_frame", True))
    stable_pct = float(payload.get("stable_pct", 5.0))
    stable_consec = int(payload.get("stable_consecutive_needed", 3))
    stable_max = int(payload.get("stable_max_attempts", 8))
    stable_recheck = float(payload.get("stable_recheck_seconds", 1.5))

    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    os.environ.setdefault("QT_SCALE_FACTOR", "1")
    os.environ.setdefault("QT_AUTO_SCREEN_SCALE_FACTOR", "0")
    os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "0")
    # Skip the AgentsPage 4 s loader minimum so the workspace_stack
    # flips to the real splitter within ~500 ms of show(). Critical
    # for the tree walk: at 5 s pump the splitter must already be
    # visible, otherwise its children (Flow*, AgentTeamCanvas,
    # Orchestrator*) are filtered out by the isVisible() check.
    os.environ["OWLLM_UI_AGENT_FAST_LOAD"] = "1"

    llm_root = Path(__file__).resolve().parents[3]
    if str(llm_root) not in sys.path:
        sys.path.insert(0, str(llm_root))

    try:
        from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QPoint, Qt
        from PySide6.QtGui import QColor, QFontDatabase, QImage, QPainter
        from PySide6.QtWidgets import QApplication, QWidget
    except ImportError as exc:
        _die(f"PySide6 unavailable: {exc}")

    app = QApplication.instance() or QApplication(sys.argv[:1])

    # Load system fonts so captured text isn't a row of squares.
    if sys.platform.startswith("win"):
        font_root = r"C:\Windows\Fonts"
        if os.path.isdir(font_root):
            for dirpath, _dirs, files in os.walk(font_root):
                for name in files:
                    if name.lower().endswith((".ttf", ".ttc", ".otf")):
                        QFontDatabase.addApplicationFont(os.path.join(dirpath, name))

    try:
        from desktop_app.main import MainWindow
    except Exception as exc:  # noqa: BLE001
        _die(f"MainWindow import failed: {exc}\n{traceback.format_exc()}")

    try:
        win = MainWindow(splash=None)
    except Exception as exc:  # noqa: BLE001
        _die(f"MainWindow construction failed: {exc}\n{traceback.format_exc()}")

    win.resize(width, height)

    page_attr = {
        "agents": "_agents_tab_index", "studio": "_studio_tab_index",
        "code": "_code_tab_index", "bridges": "_bridges_tab_index",
        "server": "_server_tab_index", "home": "_home_tab_index",
        "mcp": "_mcp_tab_index",
    }.get(page)
    tab_idx = getattr(win, page_attr, None) if page_attr else None
    if not isinstance(tab_idx, int) or tab_idx < 0:
        if hasattr(win, "tabs"):
            for i in range(win.tabs.count()):
                label = win.tabs.tabText(i).lower()
                ascii_label = "".join(c for c in label if c.isascii())
                if page in ascii_label.split():
                    tab_idx = i
                    break
    if not isinstance(tab_idx, int) or tab_idx < 0:
        avail = [win.tabs.tabText(i) for i in range(win.tabs.count())] if hasattr(win, "tabs") else []
        _die(f"unknown page {page!r}; available: {avail}")

    # Frame setup (matches the production runner so coords line up).
    frame = None
    if include_frame:
        try:
            from ui_frame.hybrid_frame import HybridFrameWindow, FrameAssets
            root_dir = llm_root.parent
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
            sys.stderr.write(f"frame init failed: {exc}\n")
            frame = None

    win.show()
    if frame is not None:
        frame.show()
    win.tabs.setCurrentIndex(tab_idx)

    def _pump(seconds: float) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < deadline:
            app.processEvents()
            time.sleep(0.05)

    _pump(max(0.5, wait_seconds))

    def _capture_composite() -> bytes:
        win_pm = win.grab()
        if frame is None:
            ba = QByteArray(); buf = QBuffer(ba); buf.open(QIODevice.OpenModeFlag.WriteOnly)
            win_pm.save(buf, "PNG"); buf.close()
            return bytes(ba)
        frame_pm = frame.grab()
        wg = win.geometry(); fg = frame.geometry()
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
        # numpy keeps this fast and side-steps a bytes-indexing crash we
        # hit on this Python install with the manual Python loop.
        from io import BytesIO
        import numpy as _np
        from PIL import Image
        try:
            ia = _np.asarray(Image.open(BytesIO(a)).convert("RGB"))
            ib = _np.asarray(Image.open(BytesIO(b)).convert("RGB"))
        except Exception:  # noqa: BLE001
            return 100.0
        if ia.shape != ib.shape:
            return 100.0
        delta = _np.max(_np.abs(ia.astype(_np.int16) - ib.astype(_np.int16)), axis=2)
        diff = int((delta > 8).sum())
        total = int(delta.size)
        return (100.0 * diff / total) if total else 0.0

    png = _capture_composite()
    Path(out_png).parent.mkdir(parents=True, exist_ok=True)
    Path(out_png).write_bytes(png)

    # --------------------------------------------------------------
    # Walk widget tree EARLY — before the long stability loop. The
    # MainWindow's background-detection thread starts destroying
    # widgets at ~7-10 s under offscreen Qt, and recursive method
    # calls on a dead QWidget skip Python's try/except entirely
    # (STATUS_ACCESS_VIOLATION at the C++ level). 5 s in is the
    # sweet spot: long enough for the project-store-driven cards
    # (SuperUserCard, AgentCard *) to be mounted, short enough to
    # be before the destruction window. The PNG can still be
    # refined by the stability loop afterwards — we'll re-write the
    # tree if we end up surviving the loop, but the early tree is
    # the load-bearing one.
    # Coordinate system: screenshot pixels, where (0,0) is the
    # frame's top-left (== top-left of the saved PNG).
    # --------------------------------------------------------------
    wg = win.geometry()
    fg = frame.geometry() if frame is not None else wg
    win_x_in_shot = wg.x() - fg.x()
    win_y_in_shot = wg.y() - fg.y()

    def _node(w, depth=0) -> dict:
        """Build the schema dict for one widget and its visible children.

        Every Qt call is wrapped because the MainWindow's background
        threads invalidate widgets unpredictably under offscreen — a
        single bad mapTo() call yields STATUS_ACCESS_VIOLATION and
        kills the whole runner. We'd rather drop a node than die.
        """
        if depth > 50:
            return None
        try:
            if not w.isVisible():
                return None
        except Exception:
            return None
        try:
            pt = w.mapTo(win, QPoint(0, 0))
            sx = pt.x() + win_x_in_shot
            sy = pt.y() + win_y_in_shot
            ww, wh = int(w.width()), int(w.height())
        except Exception:
            return None
        try:
            cls = type(w).__name__
        except Exception:
            cls = "?"
        try:
            oname = w.objectName() or ""
        except Exception:
            oname = ""
        try:
            text = _safe_text(w)
        except Exception:
            text = ""
        try:
            style = _safe_style(w)
        except Exception:
            style = {}
        # id := objectName if set, else "<class>@<sx,sy>" so the node is
        # still uniquely addressable for raw-tree consumers; the diff
        # core only aligns on non-empty ids anyway.
        ident = oname if oname else f"{cls}@{sx},{sy}"
        node = {
            "id": ident,
            "kind": _classify(cls),
            "bounds": {"x": int(sx), "y": int(sy), "w": ww, "h": wh},
            "text": text or None,
            "class_name": cls,
            "children": [],
            "raw": {"objectName": oname, "style": style},
        }
        try:
            kids = list(w.children())
        except Exception:
            kids = []
        for child in kids:
            try:
                is_widget = isinstance(child, QWidget)
            except Exception:
                is_widget = False
            if not is_widget:
                continue
            try:
                c = _node(child, depth + 1)
            except Exception:
                c = None
            if c is not None:
                node["children"].append(c)
        return node

    # Walk only the main window (skip the frame — it's decorative and
    # its children aren't elements we want to align against the replica).
    # Even walking `win` is risky under offscreen Qt because background
    # threads may have invalidated descendants, so we wrap the top call
    # too. If we crash here, the PNG is already on disk and we can fall
    # back to a single root-only tree node.
    try:
        sys.stderr.write("[tree] walking win…\n")
        root_node = _node(win)
        sys.stderr.write(f"[tree] walked: {len(root_node.get('children', []))} top-level kids\n")
    except Exception as _exc:  # noqa: BLE001
        sys.stderr.write(f"[tree] walk failed: {_exc!r}\n")
        root_node = {
            "id": "MainWindow",
            "kind": "container",
            "bounds": {"x": int(win_x_in_shot), "y": int(win_y_in_shot),
                       "w": int(win.width()), "h": int(win.height())},
            "text": None, "class_name": "MainWindow",
            "children": [], "raw": {"objectName": "MainWindow"},
        }

    # If we got a frame, wrap the win node inside a frame-sized root so
    # the tree's coordinate origin lines up with the PNG's top-left.
    if frame is not None and root_node is not None:
        root_node = {
            "id": "Frame",
            "kind": "container",
            "bounds": {"x": 0, "y": 0,
                       "w": int(fg.width()), "h": int(fg.height())},
            "text": None, "class_name": "HybridFrameWindow",
            "children": [root_node],
            "raw": {"objectName": "Frame"},
        }

    Path(out_tree).write_text(json.dumps(root_node, indent=2), encoding="utf-8")

    # Tree is on disk. Now refine the PNG with the stability loop so we
    # have the loaded-state screenshot to diff against (the tree's
    # bounds remain valid even if the loop crashes — they were captured
    # while widgets were alive).
    drift_history = []
    stable = False
    attempts = 0
    consec = 0
    try:
        while attempts < stable_max:
            attempts += 1
            _pump(stable_recheck)
            next_png = _capture_composite()
            pct = _bytes_diff_pct(png, next_png)
            drift_history.append(round(pct, 2))
            png = next_png
            Path(out_png).write_bytes(png)
            if pct <= stable_pct:
                consec += 1
                sys.stderr.write(
                    f"[stable] attempt {attempts}: {pct:.2f}% "
                    f"({consec}/{stable_consec})\n")
                if consec >= stable_consec:
                    stable = True
                    break
            else:
                consec = 0
                sys.stderr.write(
                    f"[stable] attempt {attempts}: {pct:.2f}% reset\n")
    except Exception as _exc:  # noqa: BLE001
        sys.stderr.write(f"[stable] loop bailed: {_exc!r}\n")

    print(json.dumps({
        "ok": True,
        "png": str(out_png), "tree": str(out_tree),
        "stable": stable, "attempts": attempts,
        "drift_history": drift_history,
        "width": fg.width() if frame is not None else win.width(),
        "height": fg.height() if frame is not None else win.height(),
    }), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(_main())
