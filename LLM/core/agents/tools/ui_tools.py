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
# Aggregator — register all five in one call
# ---------------------------------------------------------------------------


UI_TOOLS = (
    ui_render_widget,
    ui_inspect_widget,
    ui_diff_baseline,
    ui_list_baselines,
    ui_update_baseline,
)
