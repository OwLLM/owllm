"""Normalize the owl-brown across the home tile art to one reference.

The three home tiles (Fine Tuning / Agentic Team / Gamify) were each
generated separately, so the owls' brown tone drifts from pic to pic.
This script detects ONLY the warm brown/tan/orange owl pixels (hue in
the orange band, with real saturation) and retargets their hue /
saturation / value to a reference image's brown — leaving the blue
neon, white frames and dark backgrounds untouched.

Method: per-channel mean(+gain) match restricted to the brown mask, so
feather texture/variation is preserved; only the *centre* of the brown
distribution moves to the reference.

Usage:
    python owl_brown_match.py <reference.png> <target1.png> [target2.png ...] --out <dir>

Outputs <dir>/<name>.png (graded) for every target, plus a
<dir>/_mask_<name>.png debug image showing which pixels were touched.
"""
import sys
import os
import numpy as np
from PIL import Image

# Brown/tan/orange owl band in HSV (PIL: all channels 0-255).
# Orange ~20-40deg, tan/brown up to ~50deg -> 0-255: ~6..40.
H_LO, H_HI = 6, 42
S_MIN = 45          # ignore near-grey/white (frames, highlights)
V_LO, V_HI = 25, 245  # ignore near-black shadows and blown highlights


def brown_mask(hsv):
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return (h >= H_LO) & (h <= H_HI) & (s >= S_MIN) & (v >= V_LO) & (v <= V_HI)


def brown_stats(path):
    img = Image.open(path).convert("RGB")
    hsv = np.asarray(img.convert("HSV"), dtype=np.float32)
    m = brown_mask(hsv)
    if m.sum() == 0:
        raise SystemExit(f"no brown pixels found in reference {path}")
    return (
        float(hsv[..., 0][m].mean()),
        float(hsv[..., 1][m].mean()),
        float(hsv[..., 2][m].mean()),
        int(m.sum()),
    )


def grade(path, ref, out_dir):
    img = Image.open(path)
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    alpha = img.convert("RGBA").split()[3] if has_alpha else None
    rgb = img.convert("RGB")
    hsv = np.asarray(rgb.convert("HSV"), dtype=np.float32)
    m = brown_mask(hsv)
    name = os.path.splitext(os.path.basename(path))[0]
    if m.sum() == 0:
        print(f"  {name}: no brown pixels — copied unchanged")
        rgb.save(os.path.join(out_dir, f"{name}.png"))
        return

    Hr, Sr, Vr = ref[0], ref[1], ref[2]
    Hs = float(hsv[..., 0][m].mean())
    Ss = float(hsv[..., 1][m].mean())
    Vs = float(hsv[..., 2][m].mean())

    h, s, v = hsv[..., 0].copy(), hsv[..., 1].copy(), hsv[..., 2].copy()
    # Hue: shift centre by the mean difference (narrow band -> linear ok).
    h[m] = np.clip(h[m] + (Hr - Hs), 0, 255)
    # Saturation / value: multiplicative gain toward the reference mean.
    s_gain = Sr / max(Ss, 1.0)
    v_gain = Vr / max(Vs, 1.0)
    s[m] = np.clip(s[m] * s_gain, 0, 255)
    v[m] = np.clip(v[m] * v_gain, 0, 255)

    out_hsv = np.stack([h, s, v], axis=-1).astype(np.uint8)
    out_rgb = Image.fromarray(out_hsv, mode="HSV").convert("RGB")
    if alpha is not None:
        out_rgb = out_rgb.convert("RGBA")
        out_rgb.putalpha(alpha)
    out_rgb.save(os.path.join(out_dir, f"{name}.png"))
    print(f"  {name}: HSV brown {Hs:.0f},{Ss:.0f},{Vs:.0f} -> "
          f"{Hr:.0f},{Sr:.0f},{Vr:.0f} (gain S*{s_gain:.2f} V*{v_gain:.2f}, "
          f"{int(m.sum())} px)")

    # Debug mask preview.
    dbg = np.zeros_like(out_hsv)
    dbg[m] = [255, 255, 255]
    Image.fromarray(dbg, mode="RGB").save(os.path.join(out_dir, f"_mask_{name}.png"))


def main():
    args = sys.argv[1:]
    if "--out" not in args:
        raise SystemExit(__doc__)
    oi = args.index("--out")
    out_dir = args[oi + 1]
    paths = args[:oi]
    ref_path, targets = paths[0], paths[1:]
    os.makedirs(out_dir, exist_ok=True)

    ref = brown_stats(ref_path)
    print(f"reference {os.path.basename(ref_path)}: brown HSV "
          f"{ref[0]:.0f},{ref[1]:.0f},{ref[2]:.0f} ({ref[3]} px)")
    for t in targets:
        grade(t, ref, out_dir)
    print(f"done -> {out_dir}")


if __name__ == "__main__":
    main()
