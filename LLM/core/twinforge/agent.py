"""Orchestration entrypoint — generic.

Pulls a source capture + a target capture from any pair of adapters,
runs the diff core, and writes a ranked report. The agent code below
knows nothing about Qt, HTML, or OWLLM — it talks to the adapter
interface and the diff module.

Usage example (programmatic):

    from core.twinforge.adapters import qt_adapter, web_adapter
    from core.twinforge import agent

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

from core.twinforge.diff import (
    RegionDiff, format_report, overall_diff, region_diff, unmatched_ids,
)
from core.twinforge.schema import CaptureResult
from core.twinforge.vlm_diff import (
    VLMDifference, default_provider as default_vlm_provider, VLMProvider,
)
from core.twinforge.coder import (
    CodeFix, default_provider as default_coder_provider, CoderProvider,
)
from core.twinforge.verifier import (
    VerifiedFinding, ClaudeCodeVerifier,
    group_by_surface, default_provider as default_verifier_provider,
)
from core.twinforge.parallel_coder import dispatch_parallel
from core.twinforge.source_context import SourceContext


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
            title: str = "TwinForge — Diff Report",
            vlm: Optional[VLMProvider] = None,
            coder: Optional[CoderProvider] = None,
            target_file: Optional[str] = None,
            enable_vlm: bool = True,
            enable_coder: bool = False,
            source_context: Optional[str] = None,
            source_context_bundle: Optional["SourceContext"] = None,
            enable_parallel_coder: bool = False,
            cwd: Optional[str] = None) -> Dict:
    """Run the full diff + report pipeline."""
    regions = region_diff(src, tgt)
    overall = overall_diff(src, tgt)
    unm_src, unm_tgt = unmatched_ids(src, tgt)

    # VLM perception pass — the 'eyes' of TwinForge.
    # We always record TWO labels:
    #   * configured — what would run if everything were available
    #   * status     — what actually ran this time (or why it didn't)
    vlm_differences: List[VLMDifference] = []
    # `configured` = whatever the default chain would pick FIRST today.
    # Today that's ClaudeCodeVLM (subscription via `claude` CLI) — but
    # we don't hard-code the name; we ask `default_vlm_provider()` to
    # tell us, so the label tracks any future re-ordering of the chain.
    if vlm is not None:
        _vlm_intent_provider = vlm
    else:
        _vlm_intent_provider = default_vlm_provider()
    vlm_configured = (
        f"{getattr(_vlm_intent_provider, 'name', '?')} · "
        f"{getattr(_vlm_intent_provider, 'model', '?')}"
    )
    vlm_status = "disabled (enable_vlm=False)"
    if enable_vlm:
        provider = vlm if vlm is not None else default_vlm_provider()
        # If the picked provider can introspect availability, do so:
        avail = getattr(provider, "available", lambda: True)()
        if not avail:
            vlm_status = (
                f"FALLBACK to null — {provider.name} unavailable "
                f"(set ANTHROPIC_API_KEY to enable)"
            )
        else:
            vlm_status = f"ran via {provider.name} · {getattr(provider, 'model', '?')}"
        try:
            vlm_differences = provider.compare(
                src.png_path, tgt.png_path, title=title,
            )
        except Exception as exc:  # noqa: BLE001
            vlm_differences = [VLMDifference(
                description=f"VLM provider crashed: {exc}",
                severity="low",
            )]
            vlm_status = f"crashed: {exc!s}"

    # Build the structural diff text NOW so we can pass it to the Coder
    # (used to be a placeholder string — actual bug fix on 2026-05-13).
    text = format_report(regions, overall,
                         unmatched_src=unm_src, unmatched_tgt=unm_tgt)

    # Verifier — second-opinion subagent. Same Claude model as the
    # VLM, but with code access. Rejects hallucinated findings and
    # routes the survivors to the replica file that owns them. Skipped
    # when parallel coder is off (legacy single-Coder doesn't use
    # surface routing).
    verified_findings: List[VerifiedFinding] = []
    verifier_status = "disabled (enable_parallel_coder=False)"
    verifier_configured = "—"
    if enable_parallel_coder and enable_vlm and vlm_differences and source_context_bundle is not None:
        verifier = ClaudeCodeVerifier()
        verifier_configured = f"{verifier.name} · {verifier.model}"
        if not verifier.available():
            verifier_status = "FALLBACK — claude CLI not on PATH"
        else:
            verifier_status = f"ran via {verifier.name} · {verifier.model}"
            try:
                verified_findings = verifier.verify(
                    findings=vlm_differences,
                    replica_files=list(source_context_bundle.replica_files),
                    source_widget_files=list(source_context_bundle.widget_files),
                    src_png=src.png_path,
                    tgt_png=tgt.png_path,
                    cwd=cwd,
                )
            except Exception as exc:  # noqa: BLE001
                verifier_status = f"crashed: {exc!s}"

    code_fixes: List[CodeFix] = []
    if coder is not None:
        _coder_intent_provider = coder
    else:
        _coder_intent_provider = default_coder_provider()
    coder_configured = (
        f"{getattr(_coder_intent_provider, 'name', '?')} · "
        f"{getattr(_coder_intent_provider, 'model', '?')}"
    )
    coder_status = "disabled (enable_coder=False)"

    # Parallel multi-surface coder path — dispatches one Claude CLI
    # per replica file in parallel. Activated when both
    # `enable_parallel_coder` and a `source_context_bundle` are given.
    # Falls back to single-Coder path below otherwise.
    if (enable_coder and enable_parallel_coder
            and source_context_bundle is not None
            and verified_findings):
        groups = group_by_surface(verified_findings)
        surface_files = {
            p.name: p for p in source_context_bundle.replica_files
        }
        source_excerpts = {
            name: source_context_bundle.widget_excerpt_for_surface(name)
            for name in surface_files
        }
        asset_blk = source_context_bundle.asset_block(
            replica_path=source_context_bundle.replica_files[0]
            if source_context_bundle.replica_files else None
        )
        dispatch_cwd = cwd or str(source_context_bundle.repo_root)
        code_fixes = dispatch_parallel(
            grouped_findings=groups,
            surface_files=surface_files,
            source_excerpts=source_excerpts,
            asset_block=asset_blk,
            src_png=src.png_path,
            tgt_png=tgt.png_path,
            cwd=dispatch_cwd,
        )
        coder_status = (
            f"parallel via claude-code · {len(code_fixes)} surfaces "
            f"({', '.join(sorted(groups))})"
        )
    elif enable_coder and target_file:
        provider_c = coder if coder is not None else default_coder_provider()
        avail = getattr(provider_c, "available", lambda: True)()
        if not avail:
            coder_status = (
                f"FALLBACK to null — {provider_c.name} unavailable "
                f"(set ANTHROPIC_API_KEY to enable)"
            )
        else:
            coder_status = f"ran via {provider_c.name} · {getattr(provider_c, 'model', '?')}"
        try:
            code_fixes = provider_c.patch(
                diff_text=text,                  # ← real report, not a placeholder
                vlm_findings=vlm_differences,
                target_file=target_file,
                src_png=src.png_path,            # ← let the coder SEE the source too
                tgt_png=tgt.png_path,
                source_context=source_context,   # ← code-aware: asset list + widget src
            )
        except TypeError:
            # Older provider signature without src_png / tgt_png / source_context.
            try:
                code_fixes = provider_c.patch(
                    diff_text=text,
                    vlm_findings=vlm_differences,
                    target_file=target_file,
                    src_png=src.png_path,
                    tgt_png=tgt.png_path,
                )
            except TypeError:
                code_fixes = provider_c.patch(
                    diff_text=text,
                    vlm_findings=vlm_differences,
                    target_file=target_file,
                )
        except Exception as exc:  # noqa: BLE001
            code_fixes = [CodeFix(
                description=f"Coder provider crashed: {exc}",
                file_path="(none)", patch="",
                is_full_file=False, confidence="low",
            )]
            coder_status = f"crashed: {exc!s}"
    elif enable_coder and not target_file:
        coder_status = "skipped — enable_coder=True but no target_file given"
    text += (
        f"\n\nPROVIDERS\n"
        f"  perception · configured: {vlm_configured}\n"
        f"  perception · status:     {vlm_status}\n"
        f"  verifier   · configured: {verifier_configured}\n"
        f"  verifier   · status:     {verifier_status}\n"
        f"  generation · configured: {coder_configured}\n"
        f"  generation · status:     {coder_status}\n"
    )
    if vlm_differences:
        text += "\nPERCEIVED VISUAL DIFFERENCES (VLM)\n"
        text += "-" * 70 + "\n"
        for i, d in enumerate(vlm_differences, 1):
            text += (
                f"{i:>2}. [{d.severity}] {d.description}\n"
                f"    location: {d.location}\n"
                f"    fix:      {d.suggestion}\n"
            )
    if verified_findings:
        verified_block: List[str] = []
        rejected_block: List[str] = []
        for v in verified_findings:
            line = (
                f"  [{v.severity}] [{v.surface or '?'}] {v.description}\n"
                f"      source: {v.source_evidence}\n"
                f"      target: {v.target_evidence}\n"
                f"      fix:    {v.suggestion}"
            )
            if v.status == "verified":
                verified_block.append(line)
            elif v.status == "rejected":
                rejected_block.append(
                    f"  [REJECTED] {v.description}\n"
                    f"      reason: {v.rejection_reason}"
                )
        if verified_block:
            text += "\nVERIFIED FINDINGS (routed to coders)\n"
            text += "-" * 70 + "\n"
            text += "\n".join(verified_block) + "\n"
        if rejected_block:
            text += "\nREJECTED FINDINGS (VLM hallucinations)\n"
            text += "-" * 70 + "\n"
            text += "\n".join(rejected_block) + "\n"
    if code_fixes:
        text += "\nGENERATED CODE FIXES (Coder)\n"
        text += "-" * 70 + "\n"
        for i, f in enumerate(code_fixes, 1):
            text += (
                f"{i:>2}. [{f.confidence}] {f.description}\n"
                f"    file: {f.file_path}  ({len(f.patch)} chars)\n"
            )
    Path(report_path).parent.mkdir(parents=True, exist_ok=True)
    Path(report_path).write_text(text, encoding="utf-8")
    _draw_region_overlay(src, tgt, regions, overlay_path)
    if tile_grid_path:
        _draw_tile_grid(src, tgt, regions, tile_grid_path)
    if html_report_path:
        from core.twinforge.html_report import render_html_report
        render_html_report(
            src, tgt, regions, overall,
            unm_src, unm_tgt,
            vlm_differences=vlm_differences,
            code_fixes=code_fixes,
            vlm_provider_configured=vlm_configured,
            vlm_provider_status=vlm_status,
            coder_provider_configured=coder_configured,
            coder_provider_status=coder_status,
            title=title, out_path=html_report_path,
        )
    return {
        "text": text, "regions": regions,
        "overall_pct": overall, "overlay_path": overlay_path,
        "tile_grid_path": tile_grid_path,
        "html_report_path": html_report_path,
        "unmatched_src": unm_src, "unmatched_tgt": unm_tgt,
        "vlm_differences": vlm_differences,
        "verified_findings": verified_findings,
        "verifier_configured": verifier_configured,
        "verifier_status": verifier_status,
        "code_fixes": code_fixes,
        "vlm_configured": vlm_configured,
        "vlm_status": vlm_status,
        "coder_configured": coder_configured,
        "coder_status": coder_status,
    }
