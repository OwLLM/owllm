"""UI inspection + rendering tools for agents.

These wrap `desktop_app.ui_probe` so an LLM agent can drive the visual
iteration loop autonomously:

* ``ui_render_widget`` — import a widget class, render it offscreen,
  return the PNG path. The agent's vision model reads the file and
  feeds back ("the title is misaligned to the right").
* ``ui_inspect_widget`` — return a structured list of every widget
  in the tree (object name, type, text, geometry). Lets an agent
  navigate without screenshots when text-shaped questions suffice.
* ``ui_diff_baseline`` — render the widget AND compare against a
  named baseline PNG. The agent uses this to verify "did my last
  edit change the look in any way other than intended?"
* ``ui_list_baselines`` — enumerate available baselines so the agent
  knows what's covered before adding more.
* ``ui_update_baseline`` — overwrite a baseline with the current
  render. Approval-gated: changing a golden file is a deliberate
  act that should always pass through the user.

All five tools share one render path so what the agent sees is
byte-identical to what the pytest suite would produce — no drift
between "agent says it looks right" and "CI says it's regressed".

Why widget granularity (no full-app mode here)? Same reason the test
harness only does widgets: bringing up MainWindow is slow, flaky,
and pulls in subsystems (model registry, fleet broker) the agent
doesn't actually need to see in order to iterate on a card. When we
do need a full-app screenshot, that's a separate tool with its own
trade-offs.
"""
from __future__ import annotations

import importlib
import json
from pathlib import Path
from typing import Any, Mapping

from core.agents.tools.base import ArgSpec, Tool, ToolError


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _parse_target(target: str) -> tuple[str, str]:
    """Split a 'module.path:ClassName' target into (module, class).

    Accepts both ':' (canonical) and '.' (forgiving) as the separator
    in case an LLM emits `widgets.super_user_card.SuperUserCard`.
    """
    target = target.strip()
    if not target:
        raise ToolError("target is required (format: 'module.path:ClassName')")
    if ":" in target:
        module_path, _, class_name = target.partition(":")
    else:
        module_path, _, class_name = target.rpartition(".")
    if not module_path or not class_name:
        raise ToolError(
            f"invalid target {target!r}; use 'module.path:ClassName' "
            f"(e.g. 'desktop_app.widgets.super_user_card:SuperUserCard')"
        )
    return module_path, class_name


def _parse_optional_int(raw: Any, name: str) -> int | None:
    """Parse a numeric arg that may be absent, empty, or a string.

    LLMs often emit "1400" rather than 1400 because the tool-call
    schema serializes numbers as strings in some backends.
    """
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ToolError(f"{name} must be an integer, got {raw!r}")


def _parse_kwargs(raw: Any) -> dict:
    """Normalize the `kwargs` arg to a dict.

    Accepts a dict (passed through), a JSON string (parsed), or
    None/empty (returns `{}`). LLMs often emit JSON strings because
    their tool-call schema serializes nested objects as text.
    """
    if raw is None or raw == "":
        return {}
    if isinstance(raw, Mapping):
        return dict(raw)
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ToolError(f"kwargs must be JSON object; parse error: {exc}")
        if not isinstance(parsed, dict):
            raise ToolError(f"kwargs must decode to an object, got {type(parsed).__name__}")
        return parsed
    raise ToolError(f"kwargs must be a JSON object or dict, got {type(raw).__name__}")


def _construct_widget(target: str, kwargs: dict):
    """Import the module, look up the class, instantiate it.

    All three failure modes (import error, missing attribute, ctor
    raising) get translated to `ToolError` with the original cause
    chained so the agent sees enough to fix.
    """
    module_path, class_name = _parse_target(target)
    try:
        module = importlib.import_module(module_path)
    except ImportError as exc:
        raise ToolError(f"could not import {module_path!r}: {exc}")
    cls = getattr(module, class_name, None)
    if cls is None:
        raise ToolError(f"{module_path!r} has no attribute {class_name!r}")
    if not isinstance(cls, type):
        raise ToolError(f"{module_path}:{class_name} is not a class")
    try:
        return cls(**kwargs)
    except TypeError as exc:
        # Most common failure: wrong kwargs. Surface the class's
        # actual signature hint so the agent can self-correct.
        raise ToolError(
            f"could not construct {class_name} with kwargs={kwargs}: {exc}"
        )
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"{class_name}.__init__ raised {type(exc).__name__}: {exc}")


def _render(
    target: str,
    kwargs: dict,
    *,
    width: int | None = None,
    height: int | None = None,
) -> bytes:
    """Render the widget to PNG bytes via the harness.

    Imports `ui_probe` lazily so importing this module from a
    non-Qt context (e.g. a CLI tool listing agent tools) doesn't
    pull in PySide6.

    Order matters: the `WidgetHarness` context is entered BEFORE
    `_construct_widget` runs, because creating a `QWidget` without
    a live `QApplication` hangs on Windows. The harness's
    `__enter__` is what guarantees the QApplication exists.

    `width`/`height` override the widget's natural `sizeHint`.
    Required for full-page widgets like `AgentsPage` whose default
    sizeHint is the layout's minimum, far smaller than the real
    app window.
    """
    try:
        from desktop_app.ui_probe import WidgetHarness, capture_widget
        from PySide6.QtCore import QSize
    except ImportError as exc:
        raise ToolError(f"ui_probe unavailable (PySide6 missing?): {exc}")

    size = None
    if width is not None and height is not None:
        size = QSize(int(width), int(height))

    with WidgetHarness() as h:
        widget = _construct_widget(target, kwargs)
        h.show(widget, size=size)
        # Let any deferred `QTimer.singleShot(...)` from the widget's
        # __init__ run before we capture — pages often defer their
        # heavy bootstrap (project load, font scan) to the next
        # event-loop turn so the first paint is cheap.
        h.processed()
        return capture_widget(widget)


# ---------------------------------------------------------------------------
# ui_render_widget — capture + save
# ---------------------------------------------------------------------------


def _ui_render_widget(args: Mapping[str, Any]) -> str:
    target = str(args.get("target", "")).strip()
    out_path = str(args.get("out_path", "")).strip()
    kwargs = _parse_kwargs(args.get("kwargs"))
    width = _parse_optional_int(args.get("width"), "width")
    height = _parse_optional_int(args.get("height"), "height")

    if not out_path:
        raise ToolError("out_path is required (where to write the PNG)")
    if (width is None) != (height is None):
        raise ToolError("width and height must be set together (or both omitted)")

    png = _render(target, kwargs, width=width, height=height)
    path = Path(out_path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)

    # Echo back the resolved path + image size so the agent has a
    # concrete handle to feed its vision model.
    from io import BytesIO
    try:
        from PIL import Image
        w, h = Image.open(BytesIO(png)).size
        size_note = f"{w}x{h}"
    except Exception:  # noqa: BLE001
        size_note = "unknown"
    return f"wrote {path} ({size_note}, {len(png)} bytes)"


ui_render_widget = Tool(
    name="ui_render_widget",
    description=(
        "Render an OWLLM widget class to a PNG on disk. The widget is "
        "constructed in an offscreen Qt harness — no visible window appears. "
        "Use this to visually verify a widget you just edited. After the "
        "render, read the PNG with your vision tools to see what it looks "
        "like. Target format: 'module.path:ClassName' "
        "(e.g. 'desktop_app.widgets.super_user_card:SuperUserCard'). "
        "Pass constructor kwargs as a JSON object. Pass width+height "
        "together to override the widget's natural sizeHint — required "
        "for full-page widgets that should render at app size "
        "(e.g. width=1400, height=900 for the Agents page)."
    ),
    args=[
        ArgSpec("target", "string", "module.path:ClassName of the widget."),
        ArgSpec("out_path", "string", "Where to write the PNG (absolute path)."),
        ArgSpec("kwargs", "string", "JSON object of constructor kwargs.", required=False),
        ArgSpec("width", "integer", "Render width in pixels (paired with height).", required=False),
        ArgSpec("height", "integer", "Render height in pixels (paired with width).", required=False),
    ],
    func=_ui_render_widget,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# ui_inspect_widget — structured tree dump
# ---------------------------------------------------------------------------


def _ui_inspect_widget(args: Mapping[str, Any]) -> str:
    try:
        from desktop_app.ui_probe import WidgetHarness, list_widgets
    except ImportError as exc:
        raise ToolError(f"ui_probe unavailable (PySide6 missing?): {exc}")

    target = str(args.get("target", "")).strip()
    kwargs = _parse_kwargs(args.get("kwargs"))
    try:
        limit = int(args.get("limit", 100))
    except (TypeError, ValueError):
        raise ToolError("limit must be an integer")
    limit = max(1, min(limit, 500))

    with WidgetHarness() as h:
        widget = _construct_widget(target, kwargs)
        h.show(widget)
        listing = list_widgets(widget, limit=limit)

    # JSON one item per line so an LLM can skim. We deliberately do
    # NOT pretty-print — agents waste tokens on indentation.
    out = [f"{len(listing)} widget(s) in {target}:"]
    for w in listing:
        out.append(json.dumps(w, ensure_ascii=False))
    return "\n".join(out)


ui_inspect_widget = Tool(
    name="ui_inspect_widget",
    description=(
        "Enumerate every widget inside a target OWLLM widget. Returns "
        "object_name, type, text, visible, and geometry for each child. "
        "Use this BEFORE clicking or asserting — it tells you what's on "
        "the page without needing a screenshot. Target format: "
        "'module.path:ClassName'."
    ),
    args=[
        ArgSpec("target", "string", "module.path:ClassName of the widget."),
        ArgSpec("kwargs", "string", "JSON object of constructor kwargs.", required=False),
        ArgSpec("limit", "integer", "Max widgets to report (default 100, max 500).", required=False),
    ],
    func=_ui_inspect_widget,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# ui_diff_baseline — visual regression check
# ---------------------------------------------------------------------------


def _ui_diff_baseline(args: Mapping[str, Any]) -> str:
    try:
        from desktop_app.ui_probe import diff_pngs, load_baseline
        from desktop_app.ui_probe.baseline import BaselineMissing, save_actual
    except ImportError as exc:
        raise ToolError(f"ui_probe unavailable: {exc}")

    target = str(args.get("target", "")).strip()
    baseline_name = str(args.get("baseline_name", "")).strip()
    kwargs = _parse_kwargs(args.get("kwargs"))
    if not baseline_name:
        raise ToolError("baseline_name is required")

    actual_png = _render(target, kwargs)
    try:
        baseline = load_baseline(baseline_name)
    except BaselineMissing:
        # First-run case. Save the captured PNG as the .actual.png
        # next to where the baseline WOULD live so the agent can
        # inspect it and optionally call ui_update_baseline.
        actual_path = save_actual(baseline_name, actual_png)
        return (
            f"no baseline {baseline_name!r} on disk yet. "
            f"Current render saved at {actual_path}. "
            f"Use ui_update_baseline to create the golden if it looks right."
        )

    result = diff_pngs(actual_png, baseline.png)
    if result.same:
        return f"OK — {baseline_name} matches baseline. {result.describe()}"

    # Failure path: write the actual so a human (or the agent) can
    # eyeball the diff. Distinct filename so it doesn't overwrite
    # the baseline accidentally.
    actual_path = save_actual(baseline_name, actual_png)
    return (
        f"DIFF — {baseline_name} does NOT match baseline. {result.describe()}. "
        f"Captured render at {actual_path}; baseline at {baseline.path}."
    )


ui_diff_baseline = Tool(
    name="ui_diff_baseline",
    description=(
        "Render a widget and compare against a named baseline PNG. "
        "Returns 'OK' if pixel diff is within tolerance, 'DIFF' otherwise "
        "with a pointer to the captured .actual.png so you can read it. "
        "If no baseline exists yet, the captured PNG is saved and you're "
        "told — call ui_update_baseline if the render is correct."
    ),
    args=[
        ArgSpec("target", "string", "module.path:ClassName of the widget."),
        ArgSpec("baseline_name", "string", "Identifier for the golden file."),
        ArgSpec("kwargs", "string", "JSON object of constructor kwargs.", required=False),
    ],
    func=_ui_diff_baseline,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# ui_list_baselines — what's on disk
# ---------------------------------------------------------------------------


def _ui_list_baselines(args: Mapping[str, Any]) -> str:
    try:
        from desktop_app.ui_probe import baselines_dir
    except ImportError as exc:
        raise ToolError(f"ui_probe unavailable: {exc}")

    bdir = baselines_dir()
    pngs = sorted(p for p in bdir.glob("*.png") if not p.name.endswith(".actual.png"))
    if not pngs:
        return f"(no baselines under {bdir})"
    lines = [f"{len(pngs)} baseline(s) in {bdir}:"]
    for p in pngs:
        size = p.stat().st_size
        lines.append(f"  {p.stem}  ({size} bytes)")
    return "\n".join(lines)


ui_list_baselines = Tool(
    name="ui_list_baselines",
    description=(
        "List all visual regression baselines on disk. Use this to find "
        "out what widgets are already pinned before you add new coverage."
    ),
    args=[],
    func=_ui_list_baselines,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# ui_update_baseline — approval-gated overwrite
# ---------------------------------------------------------------------------


def _ui_update_baseline(args: Mapping[str, Any]) -> str:
    try:
        from desktop_app.ui_probe import save_baseline
    except ImportError as exc:
        raise ToolError(f"ui_probe unavailable: {exc}")

    target = str(args.get("target", "")).strip()
    baseline_name = str(args.get("baseline_name", "")).strip()
    kwargs = _parse_kwargs(args.get("kwargs"))
    if not baseline_name:
        raise ToolError("baseline_name is required")

    png = _render(target, kwargs)
    baseline = save_baseline(baseline_name, png)
    return f"wrote baseline {baseline_name!r} -> {baseline.path} ({len(png)} bytes)"


ui_update_baseline = Tool(
    name="ui_update_baseline",
    description=(
        "Render a widget and overwrite its named baseline PNG with the "
        "current output. Approval-gated: changing a golden file is a "
        "deliberate decision (intentional redesign) that always routes "
        "through the user."
    ),
    args=[
        ArgSpec("target", "string", "module.path:ClassName of the widget."),
        ArgSpec("baseline_name", "string", "Identifier for the golden file."),
        ArgSpec("kwargs", "string", "JSON object of constructor kwargs.", required=False),
    ],
    func=_ui_update_baseline,
    requires_approval=True,
)


# ---------------------------------------------------------------------------
# ui_render_app_page — full-app screenshot, with frame + tab navigation
# ---------------------------------------------------------------------------


def _ui_render_app_page(args: Mapping[str, Any]) -> str:
    page = str(args.get("page", "")).strip().lower()
    out_path = str(args.get("out_path", "")).strip()
    if not page:
        raise ToolError(
            "page is required (e.g. 'agents', 'studio', 'code', "
            "'bridges', 'server', 'home')"
        )
    if not out_path:
        raise ToolError("out_path is required (where to write the PNG)")

    width = _parse_optional_int(args.get("width"), "width") or 1400
    height = _parse_optional_int(args.get("height"), "height") or 900
    wait_seconds = args.get("wait_seconds", 5)
    try:
        wait_seconds = float(wait_seconds)
    except (TypeError, ValueError):
        raise ToolError("wait_seconds must be a number")
    wait_seconds = max(0.0, min(wait_seconds, 30.0))
    include_frame = bool(args.get("include_frame", True))

    path = Path(out_path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)

    # Run the capture in a SUBPROCESS rather than in-process. Two
    # reasons that fall out of MainWindow being a heavyweight singleton:
    #
    # 1. Reliability: in-process invocation of MainWindow's full boot
    #    + offscreen Qt teardown produced a STATUS_STACK_BUFFER_OVERRUN
    #    in the background-detection thread. A fresh subprocess lets
    #    the OS clean up — no graceful Qt teardown needed.
    # 2. Isolation: agents running concurrent tool calls don't end
    #    up sharing one MainWindow's state.
    #
    # Cost: ~1 s extra spawn overhead on top of the ~6 s MainWindow
    # boot. Fine for screenshot work; never call this on a tight loop.
    import json
    import subprocess
    import sys as _sys

    # __file__ = LLM/core/agents/tools/ui_tools.py
    #   parents[3] = LLM/
    runner = (
        Path(__file__).resolve().parents[3]
        / "desktop_app" / "ui_probe" / "_app_capture_runner.py"
    )
    if not runner.exists():
        raise ToolError(f"runner script missing: {runner}")

    # Stability params — passed through to the runner. Defaults to ON
    # because the AgentsPage in particular kicks off async bootstrap
    # (project load, canvas population) that isn't done at the initial
    # wait deadline. Without stability checking, the capture is of an
    # arbitrary moment during the load and every diff is invalid.
    require_stable = bool(args.get("require_stable", True))
    payload = json.dumps({
        "page": page,
        "out_path": str(path),
        "width": width,
        "height": height,
        "wait_seconds": wait_seconds,
        "include_frame": include_frame,
        "require_stable": require_stable,
    })

    try:
        proc = subprocess.run(
            [_sys.executable, str(runner)],
            input=payload,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise ToolError("ui_render_app_page subprocess timed out after 120s")
    except OSError as exc:
        raise ToolError(f"subprocess invocation failed: {exc}")

    if proc.returncode != 0:
        # Runner emits a JSON error blob on stderr; surface it directly.
        err = proc.stderr.strip().splitlines()[-1] if proc.stderr else ""
        try:
            parsed = json.loads(err)
            raise ToolError(f"runner failed: {parsed.get('error', err)}")
        except (json.JSONDecodeError, AttributeError):
            raise ToolError(
                f"runner exited {proc.returncode}; "
                f"stderr tail: {(proc.stderr or '')[-500:]}"
            )

    # Parse the runner's success line for echo-back info.
    try:
        result = json.loads(proc.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError, AttributeError):
        result = {"width": width, "height": height, "frame": include_frame}

    size = path.stat().st_size if path.exists() else 0
    stability = ""
    if "stable" in result:
        if result["stable"]:
            stability = (
                f", stable after {result['stability_attempts']} check"
                f"{'s' if result['stability_attempts'] != 1 else ''} "
                f"(final drift {result['final_drift_pct']:.2f}%)"
            )
        else:
            # ASCII-only marker so cp1252 stdout (default on Windows
            # consoles) doesn't crash when the agent prints this.
            stability = (
                f" -- WARNING: NOT STABLE after {result['stability_attempts']} attempts "
                f"(last drift {result['final_drift_pct']:.2f}%); page may still "
                f"be loading and diff results are unreliable"
            )
    return (
        f"wrote {path} (page={page}, "
        f"{result.get('width', width)}x{result.get('height', height)}, "
        f"{size} bytes, frame={'on' if result.get('frame', include_frame) else 'off'}{stability})"
    )


ui_render_app_page = Tool(
    name="ui_render_app_page",
    description=(
        "Render a full OWLLM app page to PNG — `MainWindow` + decorative "
        "`HybridFrame` overlay + the requested tab, with chrome, toolbar, "
        "project picker, status panel, everything. Use this when "
        "`ui_render_widget` (which only captures a single widget in "
        "isolation) isn't enough — i.e. when you need to see what the "
        "user sees. Pages: 'agents' (the team graph), 'studio', 'code', "
        "'bridges', 'server', 'home', 'mcp'. The harness boots MainWindow "
        "offscreen, switches to the page, waits `wait_seconds` for "
        "deferred bootstrap (project load, agent canvas population), then "
        "composite-grabs window+frame. Cost: ~6-8 s per call — not for "
        "tight inner loops. Set `include_frame=false` to skip the "
        "decorative overlay if you only need the central widget chrome."
    ),
    args=[
        ArgSpec("page", "string", "Page name — 'agents', 'studio', 'code', 'bridges', 'server', 'home', 'mcp'."),
        ArgSpec("out_path", "string", "Where to write the PNG (absolute path)."),
        ArgSpec("width", "integer", "Window width (default 1400).", required=False),
        ArgSpec("height", "integer", "Window height (default 900).", required=False),
        ArgSpec("wait_seconds", "number", "Pump time for async load (default 5, max 30).", required=False),
        ArgSpec("include_frame", "boolean", "Composite the HybridFrame overlay (default true).", required=False),
        ArgSpec("require_stable", "boolean",
                "Auto-detect loading state by capturing twice and comparing; "
                "retries until two consecutive captures match. Default true. "
                "Set false only if you specifically want a snapshot mid-load.",
                required=False),
    ],
    func=_ui_render_app_page,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# ui_measure_widget — geometry + colors + fonts the agent can copy directly
# ---------------------------------------------------------------------------


def _ui_measure_widget(args: Mapping[str, Any]) -> str:
    """Return detailed measurements for every named widget in a tree.

    `ui_inspect_widget` returns a thin summary; this returns the
    full set of data an agent needs to write a pixel-accurate
    replica: geometry, palette colors, font family/size/weight,
    and the QSS stylesheet (truncated).
    """
    try:
        from desktop_app.ui_probe import WidgetHarness
    except ImportError as exc:
        raise ToolError(f"ui_probe unavailable: {exc}")

    from PySide6.QtWidgets import QWidget
    from PySide6.QtGui import QPalette

    target = str(args.get("target", "")).strip()
    kwargs = _parse_kwargs(args.get("kwargs"))
    only_named = bool(args.get("only_named", True))
    try:
        limit = int(args.get("limit", 200))
    except (TypeError, ValueError):
        raise ToolError("limit must be an integer")
    limit = max(1, min(limit, 1000))

    measurements: list[dict] = []
    with WidgetHarness() as h:
        widget = _construct_widget(target, kwargs)
        h.show(widget)

        for w in [widget] + list(widget.findChildren(QWidget)):
            name = w.objectName() or ""
            if only_named and not name:
                continue
            g = w.geometry()

            def _hex(role, palette=w.palette()):
                c = palette.color(role)
                return f"#{c.red():02x}{c.green():02x}{c.blue():02x}"

            font = w.font()
            ss = (w.styleSheet() or "").strip()
            if len(ss) > 600:
                ss = ss[:600] + "…"
            measurements.append({
                "object_name": name,
                "type": type(w).__name__,
                "geometry": {"x": g.x(), "y": g.y(), "width": g.width(), "height": g.height()},
                "visible": bool(w.isVisible()),
                "palette": {
                    "window":     _hex(QPalette.ColorRole.Window),
                    "windowText": _hex(QPalette.ColorRole.WindowText),
                    "base":       _hex(QPalette.ColorRole.Base),
                    "text":       _hex(QPalette.ColorRole.Text),
                    "button":     _hex(QPalette.ColorRole.Button),
                    "buttonText": _hex(QPalette.ColorRole.ButtonText),
                    "highlight":  _hex(QPalette.ColorRole.Highlight),
                },
                "font": {
                    "family":    font.family(),
                    "pointSize": font.pointSize(),
                    "pixelSize": font.pixelSize(),
                    "weight":    int(font.weight()),
                    "italic":    bool(font.italic()),
                    "bold":      bool(font.bold()),
                },
                "stylesheet": ss,
            })
            if len(measurements) >= limit:
                break

    out_lines = [f"{len(measurements)} widget(s) measured in {target}:"]
    for m in measurements:
        out_lines.append(json.dumps(m, ensure_ascii=False))
    return "\n".join(out_lines)


ui_measure_widget = Tool(
    name="ui_measure_widget",
    description=(
        "Return precise measurements for every named widget in a target — "
        "geometry (x, y, w, h), palette colors (window, base, text, "
        "button, highlight), font (family, size, weight), and the "
        "stylesheet. Use this BEFORE writing a replica: instead of "
        "eyeballing the screenshot, you get the exact numbers Qt is "
        "rendering with. Defaults to named widgets only; set "
        "only_named=false to include everything."
    ),
    args=[
        ArgSpec("target", "string", "module.path:ClassName of the widget."),
        ArgSpec("kwargs", "string", "JSON object of constructor kwargs.", required=False),
        ArgSpec("only_named", "boolean", "Skip widgets with empty objectName (default true).", required=False),
        ArgSpec("limit", "integer", "Max widgets to report (default 200, max 1000).", required=False),
    ],
    func=_ui_measure_widget,
    requires_approval=False,
)


# ---------------------------------------------------------------------------
# ui_compare_screenshots — 3-pane side-by-side diff PNG
# ---------------------------------------------------------------------------


def _ui_compare_screenshots(args: Mapping[str, Any]) -> str:
    """Build a 3-pane PNG (reference | replica | diff overlay).

    Diff overlay tints pixels: red where replica is brighter than
    reference, blue where reference is brighter than replica. Same-
    size requirement is enforced by resizing the replica to match.
    """
    try:
        from PIL import Image, ImageChops, ImageDraw, ImageFont
    except ImportError as exc:
        raise ToolError(f"Pillow is required: pip install Pillow ({exc})")

    ref_path = Path(str(args.get("reference_path", ""))).expanduser()
    rep_path = Path(str(args.get("replica_path", ""))).expanduser()
    out_path = Path(str(args.get("out_path", ""))).expanduser()
    if not ref_path.exists():
        raise ToolError(f"reference_path does not exist: {ref_path}")
    if not rep_path.exists():
        raise ToolError(f"replica_path does not exist: {rep_path}")
    if not str(out_path):
        raise ToolError("out_path is required")

    ref = Image.open(ref_path).convert("RGBA")
    rep = Image.open(rep_path).convert("RGBA")
    if ref.size != rep.size:
        rep = rep.resize(ref.size, Image.LANCZOS)

    w, h = ref.size
    gap = 20
    header = 36
    canvas_w = 3 * w + 2 * gap
    canvas_h = h + header
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (12, 16, 30, 255))

    # Pixel-wise diff with brighter-side coloring. Step through raw
    # bytes rather than `load()[x,y]` because some Pillow versions
    # return a packed int for palette/CMYK source images even after
    # `convert("RGBA")` — building the overlay byte-by-byte is both
    # faster and side-steps that ambiguity.
    threshold = 12
    differing = 0
    total = w * h
    raw_a = ref.tobytes()  # RGBA, 4 bytes per pixel
    raw_b = rep.tobytes()
    overlay = bytearray(total * 4)  # initialized to all zeros = transparent
    for i in range(0, len(raw_a), 4):
        dr = abs(raw_a[i]     - raw_b[i])
        dg = abs(raw_a[i + 1] - raw_b[i + 1])
        db = abs(raw_a[i + 2] - raw_b[i + 2])
        if max(dr, dg, db) > threshold:
            differing += 1
            sum_a = raw_a[i] + raw_a[i + 1] + raw_a[i + 2]
            sum_b = raw_b[i] + raw_b[i + 1] + raw_b[i + 2]
            if sum_b > sum_a:
                overlay[i]     = 255
                overlay[i + 1] = 64
                overlay[i + 2] = 64
                overlay[i + 3] = 180
            else:
                overlay[i]     = 64
                overlay[i + 1] = 128
                overlay[i + 2] = 255
                overlay[i + 3] = 180
    diff_overlay = Image.frombytes("RGBA", (w, h), bytes(overlay))

    base = rep.copy()
    base.putalpha(128)
    diff_pane = Image.alpha_composite(Image.new("RGBA", (w, h), (24, 28, 48, 255)), base)
    diff_pane = Image.alpha_composite(diff_pane, diff_overlay)

    canvas.paste(ref,       (0,             header), ref)
    canvas.paste(rep,       (w + gap,       header), rep)
    canvas.paste(diff_pane, (2 * (w + gap), header), diff_pane)

    draw = ImageDraw.Draw(canvas)
    font = None
    for candidate in ("seguisb.ttf", "arial.ttf"):
        try:
            font = ImageFont.truetype(candidate, 18)
            break
        except Exception:  # noqa: BLE001
            continue
    if font is None:
        font = ImageFont.load_default()
    pct = (100.0 * differing / total) if total else 0.0
    draw.text((10, 8),                  "REFERENCE", fill=(220, 230, 255, 255), font=font)
    draw.text((w + gap + 10, 8),        "REPLICA",   fill=(220, 230, 255, 255), font=font)
    draw.text((2 * (w + gap) + 10, 8),
              f"DIFF — {differing:,}/{total:,} px ({pct:.2f}%) — red=replica extra, blue=reference extra",
              fill=(255, 200, 80, 255), font=font)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, "PNG")
    return (
        f"wrote {out_path} ({canvas.width}x{canvas.height}, "
        f"{differing:,}/{total:,} pixels differ = {pct:.2f}%)"
    )


ui_compare_screenshots = Tool(
    name="ui_compare_screenshots",
    description=(
        "Build a 3-pane side-by-side comparison PNG (reference | replica | "
        "diff overlay). Diff pane tints: red = replica has color the "
        "reference doesn't, blue = reference has color the replica "
        "doesn't. Read the result with your vision tools to see exactly "
        "which region is off. Different sizes get auto-resized to match."
    ),
    args=[
        ArgSpec("reference_path", "string", "Path to the reference PNG."),
        ArgSpec("replica_path",   "string", "Path to the replica PNG."),
        ArgSpec("out_path",       "string", "Where to write the comparison PNG."),
    ],
    func=_ui_compare_screenshots,
    requires_approval=False,
)


UI_TOOLS = (
    ui_render_widget,
    ui_inspect_widget,
    ui_diff_baseline,
    ui_list_baselines,
    ui_update_baseline,
    ui_render_app_page,
    ui_measure_widget,
    ui_compare_screenshots,
)
