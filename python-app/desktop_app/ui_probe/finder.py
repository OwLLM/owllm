"""Find widgets in a Qt tree by name, type, or text.

The agent layer needs to say "click the button labelled 'Save'" without
knowing the widget's variable name in the host module. These functions
walk the QObject tree (parent/children) starting from a root widget
and return matches.

Matching predicates are deliberately permissive: an agent that asks
for `text='Save'` should also match `'&Save'` (the ampersand is Qt's
accelerator hint, not part of the visible text) and `' Save '` (the
user-visible text after trim).
"""
from __future__ import annotations

from typing import Iterable, Optional, Type, TypeVar

from PySide6.QtWidgets import QWidget

T = TypeVar("T", bound=QWidget)


def find_widget(
    root: QWidget,
    *,
    object_name: Optional[str] = None,
    widget_type: Optional[Type[QWidget]] = None,
    text: Optional[str] = None,
) -> Optional[QWidget]:
    """Return the first widget matching the given predicates, or None.

    Predicates AND together. Pass only the ones you care about:

        find_widget(root, object_name="suGear")
        find_widget(root, widget_type=QPushButton, text="Save")

    Order of traversal is depth-first, parent-before-children, which
    matches how QtCreator's object inspector enumerates a hierarchy.
    """
    for w in _walk(root):
        if object_name is not None and w.objectName() != object_name:
            continue
        if widget_type is not None and not isinstance(w, widget_type):
            continue
        if text is not None and _widget_text(w) != _normalize_text(text):
            continue
        return w
    return None


def list_widgets(
    root: QWidget,
    *,
    widget_type: Optional[Type[QWidget]] = None,
    limit: int = 200,
) -> list[dict]:
    """Enumerate the tree for an agent's "what's on this page?" call.

    Returns a list of dicts with `{object_name, type, text, visible,
    geometry}` — small enough for an LLM to skim, structured enough
    to drive a follow-up click. `limit` caps the result at 200 by
    default to keep agent contexts bounded; pages with more widgets
    than that usually want a narrower `widget_type` filter first.
    """
    out: list[dict] = []
    for w in _walk(root):
        if widget_type is not None and not isinstance(w, widget_type):
            continue
        g = w.geometry()
        out.append({
            "object_name": w.objectName() or "",
            "type": type(w).__name__,
            "text": _widget_text(w),
            "visible": bool(w.isVisible()),
            "geometry": [g.x(), g.y(), g.width(), g.height()],
        })
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _walk(root: QWidget) -> Iterable[QWidget]:
    """Depth-first parent-then-children traversal of the QWidget tree."""
    yield root
    # findChildren with no type and Qt.FindChildrenRecursively (the
    # default) returns every descendant — much faster than a manual
    # recursion and skips QObjects that aren't QWidgets.
    for child in root.findChildren(QWidget):
        yield child


def _widget_text(w: QWidget) -> str:
    """Best-effort visible text for a widget.

    Tries the common accessors (`text`, `title`, `placeholderText`)
    and normalizes the result. Widgets without any text return "".
    """
    for attr in ("text", "title", "placeholderText", "currentText"):
        getter = getattr(w, attr, None)
        if callable(getter):
            try:
                value = getter()
            except Exception:  # noqa: BLE001 — Qt getters can raise on uninit
                continue
            if value:
                return _normalize_text(str(value))
    return ""


def _normalize_text(text: str) -> str:
    """Strip accelerator ampersands + outer whitespace.

    `&Save` and `S&ave` both render as `Save`/`Save` with an underline
    on the next character; agents asking for "Save" should match both.
    A literal ampersand is escaped as `&&`, so we preserve that.
    """
    out = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == "&":
            if i + 1 < len(text) and text[i + 1] == "&":
                out.append("&")
                i += 2
                continue
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out).strip()
