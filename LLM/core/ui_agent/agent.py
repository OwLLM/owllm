"""Orchestration entrypoint — generic.

Pulls a source capture + a target capture from any pair of adapters,
runs the diff core, and writes a ranked report. The agent code below
knows nothing about Qt, HTML, or OWLLM — it talks to the adapter
interface and the diff module.

Usage example (programmatic):

    from core.ui_agent.adapters import qt_adapter, web_adapter
    from core.ui_agent import agent

    src = qt_adapter.capture("agents", "out/src.png", "out/src.json")
    tgt = web_adapter.capture("path/to/replica.html",
                              "out/tgt.png", "out/tgt.json")
    report = agent.compare(src, tgt, "out/report.txt", "out/overlay.png")
    print(report["text"])
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
from PIL import Image, ImageDraw

from core.ui_agent.diff import (
    RegionDiff, format_report, overall_diff, region_diff, unmatched_ids,
)
from core.ui_agent.schema import CaptureResult
from core.ui_agent.vlm_diff import VLMDifference, default_provider, VLMProvider


def _crop_clip(img: Image.Image, b) -> Image.Image:
    """Crop with clamping; never raises and never returns 0x0."""
    W, H = img.size
    x0 = max(0, b.x); y0 = max(0, b.y)
    x1 = min(W, b.x + b.w); y1 = min(H, b.y + b.h)
    if x1 <= x0 or y1 <= y0:
        return Image.new("RGB", (4, 4), (40, 40, 40))
    return img.crop((x0, y0, x1, y1)).convert("RGB")


def _draw_tile_grid(src: CaptureResult, tgt: CaptureResult,
                    regions: List[RegionDiff], out_path: str,
                    max_rows: int = 12) -> None:
    """Per-region tile grid: rows of [src crop | tgt crop | delta] for the
    worst N regions. Far more diagnostic than the 2-pane full-page overlay
    when you need to see WHAT differs inside each element.

    Each tile is scaled so the row height fits, preserving aspect.
    """
    src_img = Image.open(src.png_path).convert("RGB")
    tgt_img = Image.open(tgt.png_path).convert("RGB")
    row_h = 90
    cell_w = 280
    label_w = 220
    pad = 6
    rows = regions[:max_rows]
    if not rows:
        rows = []
    total_h = 50 + len(rows) * (row_h + pad) + 30
    total_w = label_w + 3 * (cell_w + pad) + 20
    canvas = Image.new("RGB", (total_w, total_h), (12, 12, 16))
    d = ImageDraw.Draw(canvas)
    d.text((10, 12), f"Per-region tile grid — worst {len(rows)} regions",
           fill=(220, 220, 240))
    d.text((label_w + 10, 32), "SOURCE (Qt)", fill=(160, 200, 255))
    d.text((label_w + 10 + cell_w + pad, 32), "TARGET (Web)",
           fill=(160, 200, 255))
    d.text((label_w + 10 + 2*(cell_w + pad), 32), "DELTA",
           fill=(160, 200, 255))

    def _fit(im: Image.Image, w: int, h: int) -> Image.Image:
        iw, ih = im.size
        s = min(w / max(1, iw), h / max(1, ih))
        nw = max(1, int(iw * s)); nh = max(1, int(ih * s))
        return im.resize((nw, nh), Image.LANCZOS)

    for i, r in enumerate(rows):
        y = 50 + i * (row_h + pad)
        # Color the row's left label band by diff severity.
        if r.diff_pct < 10: c = (40, 90, 50)
        elif r.diff_pct < 50: c = (110, 90, 30)
        else: c = (120, 40, 40)
        d.rectangle([0, y, label_w - 4, y + row_h], fill=c)
        d.text((6, y + 4), f"{r.id}", fill=(255, 255, 255))
        d.text((6, y + 22), f"{r.kind} · {r.diff_pct:.1f}%",
               fill=(220, 220, 220))
        note_lines = []
        # Wrap notes onto up to 3 lines.
        line = ""
        for n in r.notes:
            cand = (line + " · " + n) if line else n
            if len(cand) > 30 and line:
                note_lines.append(line); line = n
            else:
                line = cand
        if line: note_lines.append(line)
        for j, ln in enumerate(note_lines[:3]):
            d.text((6, y + 40 + j * 12), ln[:30], fill=(220, 220, 220))

        src_crop = _crop_clip(src_img, r.src_bounds)
        tgt_crop = _crop_clip(tgt_img, r.tgt_bounds)
        src_fit = _fit(src_crop, cell_w, row_h)
        tgt_fit = _fit(tgt_crop, cell_w, row_h)
        canvas.paste(src_fit, (label_w + (cell_w - src_fit.size[0])//2, y))
        canvas.paste(tgt_fit,
                     (label_w + cell_w + pad + (cell_w - tgt_fit.size[0])//2, y))
        # Delta panel: align to same size as src, mark red/blue.
        sa = np.asarray(src_fit.convert("RGB")).astype(np.int16)
        # Resize tgt_fit to src_fit shape for the delta map.
        tgt_for_delta = tgt_fit.resize(src_fit.size, Image.LANCZOS)
        ta = np.asarray(tgt_for_delta.convert("RGB")).astype(np.int16)
        delta = np.max(np.abs(sa - ta), axis=2)
        mask = delta > 20
        overlay = np.full_like(sa, 30, dtype=np.uint8)
        sl = sa.mean(axis=2); tl = ta.mean(axis=2)
        rmask = mask & (tl > sl)
        bmask = mask & (tl <= sl)
        gray = (sa.mean(axis=2) / 2).astype(np.uint8)
        overlay[..., 0] = gray; overlay[..., 1] = gray; overlay[..., 2] = gray
        overlay[rmask] = [220, 60, 60]
        overlay[bmask] = [60, 60, 220]
        delta_img = Image.fromarray(overlay)
        canvas.paste(delta_img,
                     (label_w + 2*(cell_w + pad) + (cell_w - delta_img.size[0])//2, y))

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)


def _draw_region_overlay(src: CaptureResult, tgt: CaptureResult,
                         regions: List[RegionDiff], out_path: str) -> None:
    """Render a 2-pane image showing both screenshots with matched regions
    boxed and labeled with their diff %. Colored green when <10%, amber
    20-50%, red >50%."""
    src_img = Image.open(src.png_path).convert("RGB")
    tgt_img = Image.open(tgt.png_path).convert("RGB")
    # Scale both to the same height.
    H = 540
    sr = H / src_img.height
    tr = H / tgt_img.height
    src_s = src_img.resize((int(src_img.width * sr), H), Image.LANCZOS)
    tgt_s = tgt_img.resize((int(tgt_img.width * tr), H), Image.LANCZOS)
    canvas = Image.new("RGB",
                       (src_s.width + tgt_s.width + 20, H + 40),
                       (12, 12, 16))
    canvas.paste(src_s, (0, 40))
    canvas.paste(tgt_s, (src_s.width + 20, 40))
    d = ImageDraw.Draw(canvas)
    d.text((6, 10), "SOURCE (Qt app)", fill=(180, 220, 255))
    d.text((src_s.width + 26, 10), "TARGET (React replica)", fill=(180, 220, 255))

    def _color(pct: float):
        if pct < 10: return (60, 220, 120)
        if pct < 50: return (240, 200, 60)
        return (240, 80, 80)

    for r in regions:
        c = _color(r.diff_pct)
        # source side
        x0 = int(r.src_bounds.x * sr); y0 = int(r.src_bounds.y * sr) + 40
        x1 = int((r.src_bounds.x + r.src_bounds.w) * sr)
        y1 = int((r.src_bounds.y + r.src_bounds.h) * sr) + 40
        d.rectangle([x0, y0, x1, y1], outline=c, width=2)
        d.text((x0 + 2, y0 + 2), f"{r.id} {r.diff_pct:.0f}%", fill=c)
        # target side
        ox = src_s.width + 20
        x0 = ox + int(r.tgt_bounds.x * tr); y0 = int(r.tgt_bounds.y * tr) + 40
        x1 = ox + int((r.tgt_bounds.x + r.tgt_bounds.w) * tr)
        y1 = int((r.tgt_bounds.y + r.tgt_bounds.h) * tr) + 40
        d.rectangle([x0, y0, x1, y1], outline=c, width=2)
        d.text((x0 + 2, y0 + 2), f"{r.id} {r.diff_pct:.0f}%", fill=c)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)


def compare(src: CaptureResult, tgt: CaptureResult,
            report_path: str, overlay_path: str,
            tile_grid_path: Optional[str] = None,
            html_report_path: Optional[str] = None,
            title: str = "UI Agent — Diff Report",
            vlm: Optional[VLMProvider] = None,
            enable_vlm: bool = True) -> Dict:
    """Run the full diff + report pipeline.

    Returns a dict with:
      text          — formatted text report (also written to report_path)
      regions       — list of RegionDiff
      overall_pct   — single-number diff (for back-compat comparison)
      overlay_path  — where the 2-pane visual overlay was saved
      unmatched_src — ids in source not found in target
      unmatched_tgt — ids in target not found in source
    """
    regions = region_diff(src, tgt)
    overall = overall_diff(src, tgt)
    unm_src, unm_tgt = unmatched_ids(src, tgt)

    # VLM perception pass — the 'eyes' of the agent. Catches untagged
    # decorative elements, paint-only widgets, and state coverage gaps
    # that the widget-tree-based aligner cannot see.
    vlm_differences: List[VLMDifference] = []
    if enable_vlm:
        provider = vlm if vlm is not None else default_provider()
        try:
            vlm_differences = provider.compare(
                src.png_path, tgt.png_path, title=title,
            )
        except Exception as exc:  # noqa: BLE001
            vlm_differences = [VLMDifference(
                description=f"VLM provider crashed: {exc}",
                severity="low",
            )]

    text = format_report(regions, overall,
                         unmatched_src=unm_src, unmatched_tgt=unm_tgt)
    if vlm_differences:
        text += "\n\nPERCEIVED VISUAL DIFFERENCES (VLM)\n"
        text += "-" * 70 + "\n"
        for i, d in enumerate(vlm_differences, 1):
            text += (
                f"{i:>2}. [{d.severity}] {d.description}\n"
                f"    location: {d.location}\n"
                f"    fix:      {d.suggestion}\n"
            )
    Path(report_path).parent.mkdir(parents=True, exist_ok=True)
    Path(report_path).write_text(text, encoding="utf-8")
    _draw_region_overlay(src, tgt, regions, overlay_path)
    if tile_grid_path:
        _draw_tile_grid(src, tgt, regions, tile_grid_path)
    if html_report_path:
        from core.ui_agent.html_report import render_html_report
        render_html_report(
            src, tgt, regions, overall,
            unm_src, unm_tgt,
            vlm_differences=vlm_differences,
            title=title, out_path=html_report_path,
        )
    return {
        "text": text, "regions": regions,
        "overall_pct": overall, "overlay_path": overlay_path,
        "tile_grid_path": tile_grid_path,
        "html_report_path": html_report_path,
        "unmatched_src": unm_src, "unmatched_tgt": unm_tgt,
        "vlm_differences": vlm_differences,
    }
