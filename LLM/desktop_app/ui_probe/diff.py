"""Pixel-level diff between two PNG byte streams.

Pure functions over bytes — no Qt dependency. The agent path calls
`diff_pngs` on captured-vs-baseline bytes; the test path does the
same. We keep both paths byte-identical so an agent's "is this off?"
matches what `pytest --update-baselines` will lock in.

Tolerance: we accept up to ~0.1% of pixels differing by up to 4 RGB
units. Empirically that's enough to absorb sub-pixel font hinting
drift while still catching real layout / colour bugs.

Pillow is the only third-party dep. We import it lazily so users
without Pillow installed get a clean ToolError ("install Pillow")
instead of an `ImportError` at module load.
"""
from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from PIL.Image import Image  # only for type hints


# Default tolerances. Tweakable per-test via `diff_pngs(..., max_pct=...)`.
_DEFAULT_MAX_PCT = 0.1     # 0.1% of pixels may differ
_DEFAULT_MAX_DELTA = 4     # per-channel tolerance (0-255)


@dataclass(frozen=True)
class DiffResult:
    """Outcome of comparing two PNG renders.

    `same` is the agent-friendly bool. `differing_pixels` and
    `total_pixels` let a pytest fixture print a useful failure
    message ("3.7% of pixels differ"). `max_channel_delta` is the
    worst single-channel deviation seen — useful when a diff
    fails by a hair and you're deciding whether to bump tolerance.
    """
    same: bool
    differing_pixels: int
    total_pixels: int
    max_channel_delta: int
    width: int
    height: int

    @property
    def percent_differing(self) -> float:
        if self.total_pixels == 0:
            return 0.0
        return 100.0 * self.differing_pixels / self.total_pixels

    def describe(self) -> str:
        return (
            f"{self.differing_pixels}/{self.total_pixels} pixels differ "
            f"({self.percent_differing:.3f}%), max channel delta "
            f"{self.max_channel_delta}, size {self.width}x{self.height}"
        )


def diff_pngs(
    a: bytes,
    b: bytes,
    *,
    max_pct: float = _DEFAULT_MAX_PCT,
    max_delta: int = _DEFAULT_MAX_DELTA,
) -> DiffResult:
    """Compare two PNG byte streams pixel by pixel.

    Returns a `DiffResult` whose `.same` is True if at most `max_pct`
    of pixels differ by more than `max_delta` per channel. Differing
    image dimensions always count as not-same (the test should regen
    the baseline rather than try to align).
    """
    try:
        from PIL import Image  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "Pillow is required for ui_probe.diff — pip install Pillow"
        ) from exc

    img_a = Image.open(BytesIO(a)).convert("RGBA")
    img_b = Image.open(BytesIO(b)).convert("RGBA")
    if img_a.size != img_b.size:
        # Treat as fully-differing at the larger of the two sizes so
        # callers can render a meaningful failure message.
        w = max(img_a.width, img_b.width)
        h = max(img_a.height, img_b.height)
        total = w * h
        return DiffResult(
            same=False,
            differing_pixels=total,
            total_pixels=total,
            max_channel_delta=255,
            width=w,
            height=h,
        )

    return _diff_same_size(img_a, img_b, max_pct=max_pct, max_delta=max_delta)


def _diff_same_size(
    img_a: "Image",
    img_b: "Image",
    *,
    max_pct: float,
    max_delta: int,
) -> DiffResult:
    """Pixel walk for two same-size RGBA images.

    Hot path. We materialize both to `bytes` once and step through
    in 4-byte chunks rather than calling `getpixel` per pixel —
    that's ~50x faster on a 800x600 capture.
    """
    raw_a = img_a.tobytes()
    raw_b = img_b.tobytes()
    width, height = img_a.size
    total = width * height
    differing = 0
    worst = 0
    # Each pixel is RGBA = 4 bytes. Walk in steps of 4.
    for i in range(0, len(raw_a), 4):
        dr = abs(raw_a[i] - raw_b[i])
        dg = abs(raw_a[i + 1] - raw_b[i + 1])
        db = abs(raw_a[i + 2] - raw_b[i + 2])
        da = abs(raw_a[i + 3] - raw_b[i + 3])
        local_worst = max(dr, dg, db, da)
        if local_worst > worst:
            worst = local_worst
        if local_worst > max_delta:
            differing += 1

    pct = 100.0 * differing / total if total else 0.0
    return DiffResult(
        same=(pct <= max_pct),
        differing_pixels=differing,
        total_pixels=total,
        max_channel_delta=worst,
        width=width,
        height=height,
    )
