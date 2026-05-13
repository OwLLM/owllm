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

from core.twinforge.schema import Bounds, CaptureResult, UIElement


# ----------------------------------------------------------------------
# Perceptual metrics — pixel diff alone is misleading for replica work:
# a 1-pixel anti-aliasing shift can score 30 % "different" even though
# the result looks identical. SSIM (Structural Similarity) compares
# local luminance/contrast/structure; Lab distance measures color
# distance in a perceptually uniform space (ΔE > 2.3 is "noticeable",
# > 5 is "very visible"). Both are imported lazily so the rest of the
# module still loads if scikit-image is missing.
# ----------------------------------------------------------------------
def _ssim(a: np.ndarray, b: np.ndarray) -> float:
    """Return SSIM in [0, 1] (1 = identical). Returns 1.0 on shape mismatch."""
    if a.shape != b.shape or a.shape[0] < 7 or a.shape[1] < 7:
        return 1.0
    try:
        from skimage.metrics import structural_similarity as _ssim_lib
        return float(_ssim_lib(
            a.astype(np.float32), b.astype(np.float32),
            channel_axis=-1, data_range=255.0,
        ))
    except Exception:  # noqa: BLE001
        return 1.0


_SRGB_TO_XYZ_M = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
], dtype=np.float32)

_XYZ_REF_WHITE = np.array([0.95047, 1.0, 1.08883], dtype=np.float32)


def _srgb_to_lab(img: np.ndarray) -> np.ndarray:
    """Convert sRGB uint8 array to CIE L*a*b*. Vectorized."""
    rgb = img.astype(np.float32) / 255.0
    mask = rgb > 0.04045
    rgb_lin = np.where(
        mask,
        ((rgb + 0.055) / 1.055) ** 2.4,
        rgb / 12.92,
    )
    xyz = rgb_lin @ _SRGB_TO_XYZ_M.T
    xyz /= _XYZ_REF_WHITE
    eps = (6 / 29) ** 3
    mask2 = xyz > eps
    f = np.where(
        mask2,
        np.cbrt(xyz),
        (xyz / (3 * (6 / 29) ** 2)) + 4 / 29,
    )
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def _lab_distance(a_img: np.ndarray, b_img: np.ndarray) -> float:
    """Mean ΔE76 distance between two same-shape RGB arrays."""
    if a_img.shape != b_img.shape or a_img.size == 0:
        return 0.0
    la = _srgb_to_lab(a_img)
    lb = _srgb_to_lab(b_img)
    delta = la - lb
    return float(np.sqrt(np.sum(delta * delta, axis=-1)).mean())


def _quality_score(pixel_pct: float, ssim: float, lab_dist: float) -> float:
    """Blend the three metrics into a 0..100 score, 100 = perfect.

    Weighting:
      * SSIM gets the largest weight (50 %) — it's the most perceptually
        meaningful of the three.
      * Pixel pct is 30 %; it dominates on big silhouette mismatches but
        is unfair on AA.
      * Lab distance is 20 %; bridges color shifts the other two miss.
    Each metric is converted to a 0..100 score first, then weighted.
    """
    s_pixel = max(0.0, 100.0 - pixel_pct)
    s_ssim = max(0.0, min(100.0, ssim * 100.0))
    # ΔE 0 → 100; ΔE 30+ → 0. Linear fall-off in between.
    s_lab = max(0.0, 100.0 - (lab_dist * 100.0 / 30.0))
    return 0.30 * s_pixel + 0.50 * s_ssim + 0.20 * s_lab


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
    """Generate human-readable notes when style fields disagree.

    The Qt side can have `stylesheet_parsed` with overrides that don't
    show up in palette/font; we merge those in before comparing.
    """
    notes = []
    if not src_style or not tgt_style:
        return notes
    # Merge Qt's parsed-stylesheet props on top of palette/font values
    # so the comparison sees what the user actually sees.
    def _flatten(s):
        out = dict(s)
        parsed = s.get("stylesheet_parsed") or {}
        if "font_size" in parsed:
            m = re.search(r"(\d+)", parsed["font_size"])
            if m:
                v = int(m.group(1))
                # `font-size: 13pt` → ~17 px. Qt mostly uses `px` and `pt`.
                if "pt" in parsed["font_size"]:
                    v = int(v * 4 / 3)
                out["font_size_px"] = v
        if "color" in parsed:
            out["color_fg"] = parsed["color"]
        if "background" in parsed and "color_bg" not in parsed:
            out["color_bg"] = parsed["background"]
        if "background_color" in parsed:
            out["color_bg"] = parsed["background_color"]
        return out
    src_style = _flatten(src_style)
    tgt_style = _flatten(tgt_style)

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
    # Padding / margin — flag if any side differs by > 4 px.
    for k in ("padding", "margin"):
        sa = src_style.get(k); ta = tgt_style.get(k)
        if isinstance(sa, list) and isinstance(ta, list) and len(sa) == len(ta):
            diffs = [
                f"{i}:{a}/{b}"
                for i, (a, b) in enumerate(zip(sa, ta))
                if a is not None and b is not None and abs(a - b) > 4
            ]
            if diffs:
                notes.append(f"{k} {' '.join(diffs)}")
    # text_transform & text_align — coarse equality.
    for k in ("text_align", "text_transform"):
        sv, tv = src_style.get(k), tgt_style.get(k)
        if sv and tv and sv != tv and sv != "auto" and tv != "auto":
            notes.append(f"{k} {sv}/{tv}")
    # Opacity — flag deltas > 0.15.
    so = src_style.get("opacity"); to = tgt_style.get("opacity")
    if so is not None and to is not None and abs(so - to) > 0.15:
        notes.append(f"opacity {so:.2f}/{to:.2f}")
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
    # New in v2: perceptual metrics. Pixel diff over-counts on anti-aliased
    # text and gradient backgrounds; SSIM and Lab distance catch "looks the
    # same to a human" vs "byte-equal" much better.
    ssim: float = 1.0          # 1.0 = perfectly similar; 0 = totally different
    mean_lab_distance: float = 0.0  # CIE Lab Euclidean distance, ~25 = noticeable
    quality_score: float = 100.0    # blended 0..100; 100 = perfect match


_QT_INTERNAL_PREFIXES = (
    "qt_", "QScrollBar", "QSizeGrip", "qt_scrollarea", "QFrame_",
)


def _is_anonymous_id(ident: str) -> bool:
    """An id is anonymous if the adapter synthesised it from class+coords
    rather than reading a real objectName / data-ui attribute."""
    return not ident or "@" in ident or ident.startswith(_QT_INTERNAL_PREFIXES)


def _flatten_with_ids(root: UIElement) -> Dict[str, UIElement]:
    """Index every named element by id. If duplicate ids appear (e.g.
    Qt's `AgentCard` is set on N widgets), the FIRST one wins — the
    diff loses information here, but at least it's deterministic. A
    smarter approach (suffix-by-occurrence) is a TODO."""
    out: Dict[str, UIElement] = {}
    for e in root.flatten():
        if _is_anonymous_id(e.id):
            continue
        out.setdefault(e.id, e)
    return out


def _flatten_anonymous(root: UIElement) -> List[UIElement]:
    """Every element WITHOUT a stable id but with a meaningful kind.
    Used by the fuzzy aligner to pair them up via class + bounds."""
    out: List[UIElement] = []
    for e in root.flatten():
        if _is_anonymous_id(e.id) and e.kind not in ("other",):
            out.append(e)
    return out


def _fuzzy_pair(src_anon: List[UIElement], tgt_anon: List[UIElement]
                ) -> List[tuple]:
    """Pair anonymous source elements with their nearest target by
    (kind, bounds.x, bounds.y, bounds.w, bounds.h) Euclidean distance.

    Matches are 1:1 — each pair is removed from both pools after a match.
    Targets too far away (> 200 px center distance) are skipped: an
    anonymous source button at (10, 20) shouldn't pair with an anonymous
    target list at (900, 700) just because no closer match exists.
    """
    pairs: List[tuple] = []
    used_tgt = set()
    for s in src_anon:
        if s.kind not in {"button", "text", "input", "image", "list"}:
            continue
        sc_x = s.bounds.x + s.bounds.w / 2
        sc_y = s.bounds.y + s.bounds.h / 2
        best_idx = None
        best_d = 200.0
        for j, t in enumerate(tgt_anon):
            if j in used_tgt or t.kind != s.kind:
                continue
            tc_x = t.bounds.x + t.bounds.w / 2
            tc_y = t.bounds.y + t.bounds.h / 2
            d = ((sc_x - tc_x) ** 2 + (sc_y - tc_y) ** 2) ** 0.5
            if d < best_d:
                best_d = d; best_idx = j
        if best_idx is not None:
            used_tgt.add(best_idx)
            pairs.append((s, tgt_anon[best_idx]))
    return pairs


def _clip_bounds(b: Bounds, parent: Optional[Bounds]) -> Bounds:
    """Return a Bounds clipped to its parent's rect, if any. Saves the
    diff from comparing regions that extend beyond the visible window."""
    if parent is None:
        return b
    x0 = max(b.x, parent.x); y0 = max(b.y, parent.y)
    x1 = min(b.x + b.w, parent.x + parent.w)
    y1 = min(b.y + b.h, parent.y + parent.h)
    if x1 <= x0 or y1 <= y0:
        return Bounds(x=b.x, y=b.y, w=1, h=1)
    return Bounds(x=x0, y=y0, w=x1 - x0, h=y1 - y0)


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
    """Pair elements by id; pixel-diff each pair's bounds; return per-id.

    Bounds are clipped to the screenshot's actual visible rect before
    cropping — many Qt widgets (especially QScrollArea viewports and
    splitter handles) report bounds that overflow the parent. Without
    clipping the diff was comparing slivers of black background and
    over-reporting "this element is completely wrong".
    """
    src_img = Image.open(src.png_path).convert("RGBA")
    tgt_img = Image.open(tgt.png_path).convert("RGBA")
    src_clip = Bounds(x=0, y=0, w=src_img.width, h=src_img.height)
    tgt_clip = Bounds(x=0, y=0, w=tgt_img.width, h=tgt_img.height)

    src_idx = _flatten_with_ids(src.root)
    tgt_idx = _flatten_with_ids(tgt.root)
    common_ids = sorted(set(src_idx.keys()) & set(tgt_idx.keys()))

    results: List[RegionDiff] = []
    for ident in common_ids:
        s = src_idx[ident]; t = tgt_idx[ident]
        s_bounds = _clip_bounds(s.bounds, src_clip)
        t_bounds = _clip_bounds(t.bounds, tgt_clip)
        a = _crop_to_array(src_img, s_bounds)
        b = _crop_to_array(tgt_img, t_bounds)
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
        # Perceptual metrics — same input crops, different math.
        ssim_score = _ssim(a[:h, :w, :3], b[:h, :w, :3])
        lab_dist = _lab_distance(a[:h, :w, :3], b[:h, :w, :3])
        qscore = _quality_score(pct, ssim_score, lab_dist)

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
            ssim=ssim_score, mean_lab_distance=lab_dist,
            quality_score=qscore,
        ))

    # Sort: worst-quality first (lower quality_score == worse).
    results.sort(key=lambda r: r.quality_score)
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
    lines.append(f"{'#':>2}  {'id':<28} {'kind':<10} "
                 f"{'qual':>5}  {'pix':>6}  {'SSIM':>5}  {'ΔE':>4}  notes")
    lines.append("-" * 110)
    for i, r in enumerate(results, 1):
        note_str = ("; ".join(r.notes))[:40]
        lines.append(
            f"{i:>2}  {r.id[:28]:<28} {r.kind:<10} "
            f"{r.quality_score:>4.1f}  "
            f"{r.diff_pct:>5.1f}%  "
            f"{r.ssim:>4.2f}  "
            f"{r.mean_lab_distance:>4.1f}  "
            f"{note_str}"
        )
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
