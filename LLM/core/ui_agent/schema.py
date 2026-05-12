"""Normalized UI element schema — the contract every adapter speaks.

An adapter (Qt / web / UIA / Flutter / ...) walks its native widget tree and
emits a list of `UIElement` instances. The diff core consumes only this
normalized shape, so adding a new platform is purely "implement adapter".

Bounds are in PIXELS in the SCREENSHOT coordinate system the adapter uses
for its associated PNG. Aligning two trees from different platforms means
matching elements by `id` (a stable, cross-platform name the user picks),
not by tree position — different platforms structure widgets differently
and we want resilience to that.

The `id` convention:
    Qt side       — set objectName("AgentTeamCanvas") on the QWidget
    Web side      — add data-ui="AgentTeamCanvas" on the matching element
    UIA side      — set AutomationId="AgentTeamCanvas"
The diff aligns by string equality on `id`. Elements without an id are
captured but ignored by the aligner — they're useful for the raw tree
dump only.

`kind` is a coarse categorization for the diff engine to decide how
strict to be (text content can demand exact match; images use SSIM, etc.).
Adapters should map their native class hierarchy onto this small set.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional


VALID_KINDS = {
    "container",   # generic frame / panel / div
    "text",        # label, paragraph, span
    "button",      # any clickable
    "input",       # text input, textarea
    "image",       # pixmap, img, icon
    "canvas",      # custom-painted region (Qt paintEvent, <canvas>, SVG root)
    "list",        # list / combo / repeater
    "other",
}


@dataclass
class Bounds:
    """Axis-aligned rectangle in screenshot pixels (top-left origin)."""
    x: int
    y: int
    w: int
    h: int

    def to_tuple(self) -> tuple:
        return (self.x, self.y, self.w, self.h)


@dataclass
class UIElement:
    id: str                       # cross-platform identifier ("AgentTeamCanvas")
    kind: str                     # one of VALID_KINDS
    bounds: Bounds                # in adapter's screenshot coordinate system
    text: Optional[str] = None    # visible text content if any
    class_name: str = ""          # native class (QPushButton, DIV, ...)
    children: List["UIElement"] = field(default_factory=list)
    raw: Dict = field(default_factory=dict)   # adapter-specific extras

    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "bounds": asdict(self.bounds),
            "text": self.text,
            "class_name": self.class_name,
            "children": [c.to_dict() for c in self.children],
            "raw": self.raw,
        }

    @classmethod
    def from_dict(cls, d: Dict) -> "UIElement":
        b = d.get("bounds") or {}
        return cls(
            id=d.get("id", ""),
            kind=d.get("kind", "other"),
            bounds=Bounds(x=int(b.get("x", 0)), y=int(b.get("y", 0)),
                          w=int(b.get("w", 0)), h=int(b.get("h", 0))),
            text=d.get("text"),
            class_name=d.get("class_name", ""),
            children=[cls.from_dict(c) for c in (d.get("children") or [])],
            raw=d.get("raw") or {},
        )

    def flatten(self) -> List["UIElement"]:
        """Depth-first list of self + every descendant."""
        out = [self]
        for c in self.children:
            out.extend(c.flatten())
        return out

    def by_id(self, target_id: str) -> Optional["UIElement"]:
        if self.id == target_id:
            return self
        for c in self.children:
            hit = c.by_id(target_id)
            if hit is not None:
                return hit
        return None


@dataclass
class CaptureResult:
    """What an adapter returns: a PNG path + a normalized element tree.

    The PNG and the tree share a coordinate system: every UIElement.bounds
    rectangle, when used to crop the PNG, yields that element's visual
    appearance.
    """
    png_path: str
    root: UIElement
    width: int
    height: int
    raw: Dict = field(default_factory=dict)
