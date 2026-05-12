"""Region-aware diff core — entirely platform-agnostic.

Inputs:
  * Two `CaptureResult`s (source = "what should look like", target = "what
    actually looks like" — but the math is symmetric so the roles are
    just labels).
  * Both PNG paths are read with Pillow. Both element trees are aligned by
    matching non-empty `id`s.

Output:
  * `RegionDiff` per matched (id, kind) pair, with the per-region pixel
    diff %, the region's source and target bounds, and a small visual
    crop of each side for inspection.
  * An overall ranked list, sorted descending by diff %.

There is NO platform-specific logic in this module. To add a new platform,
write a new adapter — diff.py is untouched.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import re

import numpy as np
from PIL import Image

from core.ui_agent.schema import Bounds, CaptureResult, UIElement


# ----------------------------------------------------------------------
# Style comparison helpers — adapters normalize where they can, but Qt
# emits "#rrggbb" and CSS emits "rgb(r, g, b)" / "rgba(r, g, b, a)".
# Parsing both into (r, g, b) lets the diff core stay format-agnostic.
# ----------------------------------------------------------------------
_HEX_RE = re.compile(r"^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$")
_RGB_RE = re.compile(r"rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)")


def _parse_color(s):
    """Return (r, g, b) ints, or None if not parseable."""
    if not s:
        return None
    s = str(s).strip()
    m = _HEX_RE.match(s)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    m = _RGB_RE.match(s)
    if m:
        return (int(float(m.group(1))), int(float(m.group(2))),
                int(float(m.group(3))))
    return None


def _color_distance(a, b) -> float:
    if a is None or b is None:
        return 0.0
    return float(((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2) ** 0.5)


def _style_notes(src_style: dict, tgt_style: dict) -> list:
    """Generate human-readable notes when style fields disagree."""
    notes = []
    if not src_style or not tgt_style:
        return notes
    sfs = src_style.get("font_size_px")
    tfs = tgt_style.get("font_size_px")
    if sfs and tfs and abs(sfs - tfs) > 2:
        notes.append(f"font_size_px {sfs} vs {tfs}")
    sfw = src_style.get("font_weight")
    tfw = tgt_style.get("font_weight")
    if sfw and tfw and sfw != tfw:
        notes.append(f"font_weight {sfw}/{tfw}")
    src_c = _parse_color(src_style.get("color_fg"))
    tgt_c = _parse_color(tgt_style.get("color_fg"))
    if src_c and tgt_c and _color_distance(src_c, tgt_c) > 40:
        notes.append(f"color_fg {src_style.get('color_fg')} vs {tgt_style.get('color_fg')}")
    src_b = _parse_color(src_style.get("color_bg"))
    tgt_b = _parse_color(tgt_style.get("color_bg"))
    if src_b and tgt_b and _color_distance(src_b, tgt_b) > 40:
        notes.append(f"color_bg {src_style.get('color_bg')} vs {tgt_style.get('color_bg')}")
    return notes


@dataclass
class RegionDiff:
    id: str
    kind: str
    src_bounds: Bounds
    tgt_bounds: Bounds
    diff_pct: float
    pixels_total: int
    pixels_diff: int
    src_text: Optional[str] = None
    tgt_text: Optional[str] = None
    notes: List[str] = field(default_factory=list)


def _flatten_with_ids(root: UIElement) -> Dict[str, UIElement]:
    out: Dict[str, UIElement] = {}
    for e in root.flatten():
        if e.id and not e.id.startswith(("Q", "q")) and "@" not in e.id:
            # Only consider stable, user-given ids (objectName / data-ui).
            # Reject anonymous "<class>@<x,y>" fall-backs and Qt's internal
            # auto-named widgets that start with capital Q (like QScrollBar).
            out[e.id] = e
    return out


def _crop_to_array(img: Image.Image, b: Bounds) -> np.ndarray:
    """Crop with clamping; returns RGBA uint8 array of size (h, w, 4).

    Out-of-bounds rectangles get clipped to the image; if the result is
    empty we return a tiny black tile so downstream math still works.
    """
    W, H = img.size
    x0 = max(0, b.x); y0 = max(0, b.y)
    x1 = min(W, b.x + b.w); y1 = min(H, b.y + b.h)
    if x1 <= x0 or y1 <= y0:
        return np.zeros((1, 1, 4), dtype=np.uint8)
    return np.asarray(img.crop((x0, y0, x1, y1)).convert("RGBA"))


def region_diff(src: CaptureResult, tgt: CaptureResult,
                pixel_tolerance: int = 20) -> List[RegionDiff]:
    """Pair elements by id; pixel-diff each pair's bounds; return per-id."""
    src_img = Image.open(src.png_path).convert("RGBA")
    tgt_img = Image.open(tgt.png_path).convert("RGBA")

    src_idx = _flatten_with_ids(src.root)
    tgt_idx = _flatten_with_ids(tgt.root)
    common_ids = sorted(set(src_idx.keys()) & set(tgt_idx.keys()))

    results: List[RegionDiff] = []
    for ident in common_ids:
        s = src_idx[ident]; t = tgt_idx[ident]
        a = _crop_to_array(src_img, s.bounds)
        b = _crop_to_array(tgt_img, t.bounds)
        # Resize the larger to the smaller so they're directly comparable.
        # We compare on equal area — the diff % becomes "how much of the
        # source/replica region's pixels disagree", not "how much area
        # the two cover differently". Mismatched sizes get a note.
        h = min(a.shape[0], b.shape[0]); w = min(a.shape[1], b.shape[1])
        if h < 1 or w < 1:
            continue
        size_mismatch = (a.shape[:2] != b.shape[:2])
        # Crude resize for the diff math: take the top-left h*w slice of
        # each. This privileges alignment with the upper-left corner,
        # which is right for our use case (frames and headers anchor
        # from the top).
        ac = a[:h, :w, :3].astype(np.int16)
        bc = b[:h, :w, :3].astype(np.int16)
        delta = np.max(np.abs(ac - bc), axis=2)
        mask = delta > pixel_tolerance
        diff_count = int(mask.sum())
        total = int(mask.size)
        pct = (100.0 * diff_count / total) if total else 0.0

        notes = []
        if size_mismatch:
            notes.append(f"size src={s.bounds.w}x{s.bounds.h} "
                         f"tgt={t.bounds.w}x{t.bounds.h}")
        # Bounds-position drift — flag when the same id sits at very
        # different screen coords. Useful diagnostic separate from
        # size mismatch: tells you "the element exists but is in the
        # wrong place" vs "the element exists at the right place but
        # is the wrong size".
        dx = t.bounds.x - s.bounds.x
        dy = t.bounds.y - s.bounds.y
        if abs(dx) > 5 or abs(dy) > 5:
            notes.append(f"pos off by ({dx:+d}, {dy:+d})")
        if (s.text or "") and (t.text or "") and s.text.strip() != t.text.strip():
            notes.append(f"text src={s.text!r} tgt={t.text!r}")
        if (s.text or "") and not (t.text or ""):
            notes.append("text missing in target")
        if (t.text or "") and not (s.text or ""):
            notes.append("text in target only")
        notes.extend(_style_notes(s.raw.get("style") or {},
                                  t.raw.get("style") or {}))

        results.append(RegionDiff(
            id=ident, kind=s.kind,
            src_bounds=s.bounds, tgt_bounds=t.bounds,
            diff_pct=pct, pixels_total=total, pixels_diff=diff_count,
            src_text=s.text, tgt_text=t.text, notes=notes,
        ))

    # Sort: worst-fit first.
    results.sort(key=lambda r: r.diff_pct, reverse=True)
    return results


def overall_diff(src: CaptureResult, tgt: CaptureResult,
                 pixel_tolerance: int = 20) -> float:
    """The old single-number diff, kept for back-compatibility comparison."""
    a = np.asarray(Image.open(src.png_path).convert("RGB")).astype(np.int16)
    b = np.asarray(Image.open(tgt.png_path).convert("RGB"))
    if b.shape != a.shape:
        b = np.asarray(
            Image.open(tgt.png_path).convert("RGB")
                 .resize((a.shape[1], a.shape[0]), Image.LANCZOS)
        )
    b = b.astype(np.int16)
    delta = np.max(np.abs(a - b), axis=2)
    return float((delta > pixel_tolerance).sum()) * 100.0 / float(delta.size)


def format_report(results: List[RegionDiff],
                  overall_pct: float, *,
                  unmatched_src: Optional[List[str]] = None,
                  unmatched_tgt: Optional[List[str]] = None) -> str:
    """Pretty-print a ranked diff report for the terminal."""
    lines = []
    lines.append(f"OVERALL pixel diff: {overall_pct:.2f}%")
    lines.append(f"Per-element regions matched: {len(results)}")
    lines.append("")
    lines.append(f"{'#':>2}  {'id':<28} {'kind':<10} {'diff':>7}  notes")
    lines.append("-" * 90)
    for i, r in enumerate(results, 1):
        note_str = ("; ".join(r.notes))[:40]
        lines.append(f"{i:>2}  {r.id[:28]:<28} {r.kind:<10} "
                     f"{r.diff_pct:>6.2f}%  {note_str}")
    if unmatched_src:
        lines.append("")
        lines.append(f"Unmatched in source ({len(unmatched_src)}): "
                     f"{', '.join(unmatched_src[:10])}"
                     f"{' …' if len(unmatched_src) > 10 else ''}")
    if unmatched_tgt:
        lines.append(f"Unmatched in target ({len(unmatched_tgt)}): "
                     f"{', '.join(unmatched_tgt[:10])}"
                     f"{' …' if len(unmatched_tgt) > 10 else ''}")
    return "\n".join(lines)


def unmatched_ids(src: CaptureResult, tgt: CaptureResult
                  ) -> Tuple[List[str], List[str]]:
    """Ids in source but not target (and vice versa). Useful for telling
    the user "your replica is missing these named elements." """
    src_idx = _flatten_with_ids(src.root)
    tgt_idx = _flatten_with_ids(tgt.root)
    s = set(src_idx.keys()); t = set(tgt_idx.keys())
    return sorted(s - t), sorted(t - s)
