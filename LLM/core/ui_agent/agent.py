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
from typing import Dict, List

import numpy as np
from PIL import Image, ImageDraw

from core.ui_agent.diff import (
    RegionDiff, format_report, overall_diff, region_diff, unmatched_ids,
)
from core.ui_agent.schema import CaptureResult


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
            report_path: str, overlay_path: str) -> Dict:
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
    text = format_report(regions, overall,
                         unmatched_src=unm_src, unmatched_tgt=unm_tgt)
    Path(report_path).parent.mkdir(parents=True, exist_ok=True)
    Path(report_path).write_text(text, encoding="utf-8")
    _draw_region_overlay(src, tgt, regions, overlay_path)
    return {
        "text": text, "regions": regions,
        "overall_pct": overall, "overlay_path": overlay_path,
        "unmatched_src": unm_src, "unmatched_tgt": unm_tgt,
    }
