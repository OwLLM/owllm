"""Per-platform adapters. Each module exposes a `capture()` function that
returns a `schema.CaptureResult`. New platforms slot in by adding a new file
here — the diff core does not need to change.

To implement a new adapter, satisfy the `AdapterBase` interface below:

    from core.ui_agent.adapters import AdapterBase
    from core.ui_agent.schema import CaptureResult, UIElement, Bounds

    class UiaAdapter(AdapterBase):
        @classmethod
        def capture(cls, *,
                    target: str,        # window title, URL, process id, etc.
                    out_png: str,
                    out_tree: str,
                    width: int = 1600,
                    height: int = 960,
                    **kwargs,
                    ) -> CaptureResult:
            ...
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from core.ui_agent.schema import CaptureResult


class AdapterBase(ABC):
    """Contract every platform adapter must satisfy.

    The diff core only talks to `CaptureResult`s, not to adapters directly.
    Adapters are responsible for:

      1. Producing a screenshot PNG of the target.
      2. Walking the target's native widget/element tree.
      3. Normalising that tree into the `UIElement` shape, with bounds in
         the SAME coordinate system as the PNG (top-left origin, pixels).
      4. Returning a `CaptureResult` pointing at both artefacts.

    Implementations should NOT do any cross-platform comparison logic —
    that belongs in `diff.py`. Implementations SHOULD:

      * Be resilient to flaky native APIs (wrap each call in try/except,
        skip elements that throw, never let one bad widget bring down
        the whole capture).
      * Tag each element with a stable identifier sourced from the
        platform's idiomatic place (objectName / aria-label / data-ui /
        AutomationId / accessibilityIdentifier / etc.).
      * Capture per-element style data into ``raw.style`` when possible —
        the diff core uses font_size_px, color_fg, color_bg, padding,
        margin, etc. for style-mismatch notes.
    """

    @classmethod
    @abstractmethod
    def capture(cls, *,
                target: str,
                out_png: str,
                out_tree: str,
                width: int = 1600,
                height: int = 960,
                **kwargs: Any,
                ) -> CaptureResult:
        raise NotImplementedError

