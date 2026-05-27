"""Self-contained HTML report generator for the UI agent.

Produces ONE .html file with everything embedded as base64 — the user
can open it without internet access or any other files. Contents:

  * Headline: overall pixel diff, mean SSIM, mean ΔE, # matched regions
  * 2-pane full screenshot comparison (source ↔ target)
  * Sortable, filterable region table with all per-element metrics
  * Tile grid embedded inline (one card per matched region)
  * Lists of unmatched ids on each side

The page works fully offline and renders cleanly in any modern browser.
"""
from __future__ import annotations

import base64
import html
import json
from pathlib import Path
from typing import Dict, List, Optional, Any

from PIL import Image

from core.twinforge.diff import RegionDiff
from core.twinforge.schema import CaptureResult


def _img_to_b64(path: str, max_w: Optional[int] = None) -> str:
    img = Image.open(path).convert("RGB")
    if max_w and img.width > max_w:
        ratio = max_w / img.width
        img = img.resize((max_w, int(img.height * ratio)), Image.LANCZOS)
    from io import BytesIO
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _crop_b64(img: Image.Image, b, max_w: int = 240) -> str:
    """Crop with clamp and return base64 PNG."""
    W, H = img.size
    x0 = max(0, b.x); y0 = max(0, b.y)
    x1 = min(W, b.x + b.w); y1 = min(H, b.y + b.h)
    if x1 <= x0 or y1 <= y0:
        crop = Image.new("RGB", (4, 4), (40, 40, 40))
    else:
        crop = img.crop((x0, y0, x1, y1)).convert("RGB")
    if crop.width > max_w:
        r = max_w / crop.width
        new_h = max(1, int(crop.height * r))
        crop = crop.resize((max_w, new_h), Image.LANCZOS)
    from io import BytesIO
    buf = BytesIO()
    crop.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def render_html_report(
    src: CaptureResult, tgt: CaptureResult,
    regions: List[RegionDiff], overall_pct: float,
    unmatched_src: List[str], unmatched_tgt: List[str],
    *, title: str = "TwinForge — Diff Report",
    out_path: str,
    vlm_differences = None,  # noqa: ANN001 — optional list of VLMDifference
    code_fixes = None,       # noqa: ANN001 — optional list of CodeFix
    vlm_provider_configured: str = "anthropic · claude-opus-4-7",
    vlm_provider_status: str = "unknown",
    coder_provider_configured: str = "anthropic · claude-opus-4-7",
    coder_provider_status: str = "unknown",
) -> str:
    """Write a self-contained HTML report. Returns the absolute path."""
    src_img = Image.open(src.png_path).convert("RGB")
    tgt_img = Image.open(tgt.png_path).convert("RGB")

    mean_ssim = (
        sum(r.ssim for r in regions) / len(regions) if regions else 1.0
    )
    mean_quality = (
        sum(r.quality_score for r in regions) / len(regions) if regions else 100.0
    )
    mean_lab = (
        sum(r.mean_lab_distance for r in regions) / len(regions) if regions else 0.0
    )

    rows_json = json.dumps([
        {
            "id": r.id, "kind": r.kind,
            "quality": round(r.quality_score, 1),
            "pixel": round(r.diff_pct, 1),
            "ssim": round(r.ssim, 3),
            "lab": round(r.mean_lab_distance, 1),
            "src_bounds": [r.src_bounds.x, r.src_bounds.y,
                           r.src_bounds.w, r.src_bounds.h],
            "tgt_bounds": [r.tgt_bounds.x, r.tgt_bounds.y,
                           r.tgt_bounds.w, r.tgt_bounds.h],
            "src_text": r.src_text, "tgt_text": r.tgt_text,
            "notes": r.notes,
            "src_crop": _crop_b64(src_img, r.src_bounds, max_w=240),
            "tgt_crop": _crop_b64(tgt_img, r.tgt_bounds, max_w=240),
        }
        for r in regions
    ])

    src_full = _img_to_b64(src.png_path, max_w=900)
    tgt_full = _img_to_b64(tgt.png_path, max_w=900)

    # Available providers — same catalogue for perception and generation
    # because TwinForge defaults both to one Anthropic model. Each entry
    # is (label, wired_today, tooltip-text).
    PROVIDERS = [
        ("claude-code · claude-opus-4-7",  True,
         "Claude Code subscription (Opus 4.7) — uses your logged-in "
         "claude.ai session via the `claude` CLI. No API key needed. "
         "Recommended default for both perception and generation."),
        ("claude-code · claude-sonnet-4-6", True,
         "Claude Code subscription (Sonnet 4.6) — faster + cheaper "
         "than Opus, still vision-capable. Same subscription auth."),
        ("claude-code · claude-haiku-4-5",  True,
         "Claude Code subscription (Haiku 4.5) — fastest + cheapest "
         "tier, vision-capable. Use for tight iteration loops."),
        ("anthropic · claude-opus-4-7",  True,
         "Anthropic API (Opus 4.7) — same model as Claude Code but "
         "billed per-token. Set ANTHROPIC_API_KEY. Use in CI / "
         "headless where no subscription auth exists."),
        ("anthropic · claude-sonnet-4-6", True,
         "Anthropic API (Sonnet 4.6) — per-token billing."),
        ("anthropic · claude-haiku-4-5",  True,
         "Anthropic API (Haiku 4.5) — per-token billing."),
        ("openai · gpt-4o",               False,
         "OpenAI GPT-4o — strong vision + code. Needs OpenAI adapter (not shipped yet)."),
        ("openai · gpt-5",                False,
         "OpenAI GPT-5 — strongest pure coder; vision OK. Pair as the "
         "generation half with a more visual perception model."),
        ("google · gemini-2.5-pro",       False,
         "Google Gemini 2.5 Pro — vision-strong, long context. Good for "
         "diffing very long pages."),
        ("local · qwen2.5-vl-72b",        False,
         "Local Qwen2.5-VL 72B — vision-capable, single A100/4090. "
         "When pixels can't leave on-prem."),
        ("local · qwen2.5-coder-32b",     False,
         "Local Qwen2.5-Coder 32B — best local coder. Pair with a "
         "local VLM for full on-prem loop."),
        ("disabled",                      True,
         "No provider — skip this step entirely."),
    ]

    def _provider_options(active: str) -> str:
        out = []
        for label, _wired, _tooltip in PROVIDERS:
            sel = " selected" if label == active else ""
            out.append(f'<option value="{html.escape(label)}"{sel}>'
                       f'{html.escape(label)}</option>')
        return "".join(out)

    def _provider_legend() -> str:
        rows = []
        for label, wired, tooltip in PROVIDERS:
            badge = "✓ available" if wired else "needs adapter"
            cls = "good" if wired else "mid"
            rows.append(
                f'<tr><td><code>{html.escape(label)}</code></td>'
                f'<td><span class="badge {cls}">{badge}</span></td>'
                f'<td>{html.escape(tooltip)}</td></tr>'
            )
        return "".join(rows)

    def _status_class(s: str) -> str:
        sl = s.lower()
        if "ran via" in sl: return "good"
        if "disabled" in sl or "fallback" in sl or "skipped" in sl: return "mid"
        if "crashed" in sl: return "bad"
        return "mid"

    provider_card_html = (
        '<div class="provider-card">'
        '<h3>Providers used for this run · hover ⓘ for details</h3>'
        '<div class="provider-grid">'

        # ---- Perception ----
        '<label title="The PERCEPTION API. Looks at the two screenshots '
        'and lists what differs — untagged decorations, missing elements, '
        'wrong sizes a human would call out. Best models: vision-strong '
        'ones (Claude Opus 4.7, GPT-4o, Gemini 2.5 Pro, Qwen-VL).">'
        '<div class="label-row">'
        '<span class="kind">Perception (VLM)</span>'
        '<span class="info" title="The agent\'s eyes. Sends both screenshots '
        'to a vision model and asks for a structured list of differences '
        'with severity + fix suggestions. Disable with enable_vlm=False.">ⓘ</span>'
        '</div>'
        f'<select disabled name="vlm">{_provider_options(vlm_provider_configured)}</select>'
        f'<div class="status-line">status: '
        f'<span class="badge {_status_class(vlm_provider_status)}">'
        f'{html.escape(vlm_provider_status)}</span></div>'
        '</label>'

        # ---- Generation ----
        '<label title="The GENERATION API. Takes the diff report + VLM '
        'findings + the current target file and emits code patches. Best '
        'models: strong coders (Claude Opus 4.7, GPT-5, Qwen2.5-Coder).">'
        '<div class="label-row">'
        '<span class="kind">Generation (Coder)</span>'
        '<span class="info" title="The agent\'s hands. Sends the diff + '
        'perception output + current target file to a coder model and '
        'gets back ready-to-apply patches. Off by default; enable with '
        'enable_coder=True + target_file=path.">ⓘ</span>'
        '</div>'
        f'<select disabled name="coder">{_provider_options(coder_provider_configured)}</select>'
        f'<div class="status-line">status: '
        f'<span class="badge {_status_class(coder_provider_status)}">'
        f'{html.escape(coder_provider_status)}</span></div>'
        '</label>'

        '</div>'
        '<details class="provider-legend">'
        '<summary>Available providers (click for the full catalogue)</summary>'
        '<table>'
        '<thead><tr><th>provider</th><th>status</th><th>when to pick it</th></tr></thead>'
        f'<tbody>{_provider_legend()}</tbody>'
        '</table>'
        '</details>'
        '</div>'
    )

    # VLM differences as a separate top-level section. List comes pre-sorted
    # by severity from the provider; we just render it.
    vlm_html = ""
    if vlm_differences:
        sev_class = {"high": "bad", "med": "mid", "low": "good"}
        rows = []
        for i, d in enumerate(vlm_differences, 1):
            sev = (d.severity or "med").lower()
            badge_cls = sev_class.get(sev, "mid")
            rows.append(
                f'<tr>'
                f'<td>{i}</td>'
                f'<td><span class="badge {badge_cls}">{html.escape(sev.upper())}</span></td>'
                f'<td>{html.escape(d.description)}</td>'
                f'<td>{html.escape(d.location)}</td>'
                f'<td>{html.escape(d.suggestion)}</td>'
                f'</tr>'
            )
        vlm_html = f"""
        <h2>Perceived visual differences (VLM)</h2>
        <div class="panel">
          <p class="note">Generated by sending both screenshots to a vision model and asking what differs. Catches untagged decorations, paint-only widgets, and missing rows that the widget-tree-based diff cannot see.</p>
          <table>
            <thead><tr><th>#</th><th>severity</th><th>description</th><th>location</th><th>fix</th></tr></thead>
            <tbody>{''.join(rows)}</tbody>
          </table>
        </div>
        """

    css = """
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px; background: #0c0f1a; color: #e6e8eb;
      font: 14px/1.5 'Inter', 'Segoe UI', system-ui, sans-serif;
    }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { font-size: 16px; margin: 24px 0 8px; color: #cbd2e0; }
    .subtitle { color: #7888a8; margin-bottom: 18px; }
    .kpi-row { display: flex; gap: 12px; margin-bottom: 18px; }
    .kpi {
      flex: 1; padding: 12px 16px; border-radius: 10px;
      background: #181c29; border: 1px solid #2a3142;
    }
    .kpi .label { color: #7888a8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; }
    .kpi .value { font-size: 26px; font-weight: 700; margin-top: 4px; }
    .kpi .value.good { color: #3cf26b; }
    .kpi .value.mid  { color: #ffd080; }
    .kpi .value.bad  { color: #ff7878; }
    .panel {
      background: #14172a; border: 1px solid #2a3142;
      border-radius: 12px; padding: 16px; margin-bottom: 18px;
    }
    .compare { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .compare > div { background: #0a0d14; padding: 8px; border-radius: 8px; }
    .compare img { width: 100%; display: block; }
    .compare h3 { margin: 0 0 6px; font-size: 12px; color: #88c0ff; text-transform: uppercase; letter-spacing: 0.6px; }
    .filters { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
    .filters input, .filters select {
      padding: 6px 10px; background: #0a0d14; color: #e6e8eb;
      border: 1px solid #2a3142; border-radius: 6px; font: inherit;
    }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #1f2638; }
    th { background: #181c29; cursor: pointer; user-select: none; }
    th:hover { background: #1f2638; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.id { font-weight: 600; color: #fff; }
    .badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
    .badge.good { background: rgba(60, 220, 120, 0.18); color: #69e6a1; }
    .badge.mid  { background: rgba(255, 200, 100, 0.18); color: #ffd080; }
    .badge.bad  { background: rgba(255, 120, 120, 0.18); color: #ff7878; }
    .tile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .tile {
      background: #14172a; border: 1px solid #2a3142;
      border-radius: 10px; padding: 10px; font-size: 11px;
    }
    .tile .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .tile .row { display: flex; gap: 4px; }
    .tile .row > div { flex: 1; }
    .tile img { width: 100%; display: block; background: #0a0d14; border-radius: 4px; }
    .tile .caption { font-size: 9px; color: #7888a8; text-transform: uppercase; text-align: center; margin: 4px 0 2px; }
    .tile .notes { margin-top: 6px; font-size: 10px; color: #cbd2e0; max-height: 60px; overflow: auto; }
    .unmatched { display: flex; flex-wrap: wrap; gap: 4px; font-family: 'Consolas', monospace; font-size: 11px; }
    .unmatched span { padding: 2px 6px; background: #181c29; border-radius: 4px; }
    .provider-card {
      background: linear-gradient(180deg, #1a213a, #0f1424);
      border: 1px solid #2a3142; border-radius: 12px;
      padding: 18px; margin: 14px 0;
    }
    .provider-card h3 { margin: 0 0 12px; font-size: 13px; color: #88c0ff; text-transform: uppercase; letter-spacing: 0.6px; }
    .provider-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .provider-grid label { display: flex; flex-direction: column; gap: 4px; cursor: help; }
    .label-row { display: flex; align-items: center; gap: 6px; }
    .label-row .kind { font-weight: 700; color: #fff; }
    .info {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border-radius: 50%;
      background: rgba(120, 220, 255, 0.18); color: #7fdfff;
      font-size: 11px; cursor: help; user-select: none;
    }
    .provider-grid select {
      background: #0a0d14; color: #e6e8eb;
      border: 1px solid #2a3142; border-radius: 6px;
      padding: 6px 8px; font: inherit;
    }
    .provider-legend { margin-top: 12px; }
    .provider-legend summary { cursor: pointer; color: #7888a8; font-size: 12px; padding: 4px 0; }
    .provider-legend summary:hover { color: #cbd2e0; }
    .provider-legend table { margin-top: 8px; font-size: 11px; }
    .status-line { font-size: 11px; color: #7888a8; margin-top: 6px; }
    .status-line .badge { margin-left: 2px; }
    """

    body = f"""
    <h1>{html.escape(title)}</h1>
    <div class="subtitle">UI agent diff between Qt source and Web target.</div>

    <div class="kpi-row">
      <div class="kpi">
        <div class="label">Overall pixel diff</div>
        <div class="value {'good' if overall_pct < 20 else 'mid' if overall_pct < 50 else 'bad'}">{overall_pct:.1f}%</div>
      </div>
      <div class="kpi">
        <div class="label">Mean quality score</div>
        <div class="value {'good' if mean_quality > 70 else 'mid' if mean_quality > 40 else 'bad'}">{mean_quality:.0f}/100</div>
      </div>
      <div class="kpi">
        <div class="label">Mean SSIM</div>
        <div class="value {'good' if mean_ssim > 0.85 else 'mid' if mean_ssim > 0.5 else 'bad'}">{mean_ssim:.2f}</div>
      </div>
      <div class="kpi">
        <div class="label">Mean ΔE</div>
        <div class="value {'good' if mean_lab < 5 else 'mid' if mean_lab < 15 else 'bad'}">{mean_lab:.1f}</div>
      </div>
      <div class="kpi">
        <div class="label">Matched regions</div>
        <div class="value">{len(regions)}</div>
      </div>
    </div>

    {provider_card_html}

    <h2>Full-page comparison</h2>
    <div class="panel compare">
      <div><h3>Source — Qt app</h3><img src="{src_full}" /></div>
      <div><h3>Target — Web replica</h3><img src="{tgt_full}" /></div>
    </div>

    {vlm_html}

    <h2>Per-region report</h2>
    <div class="panel">
      <div class="filters">
        <input id="search" placeholder="Filter by id, kind, note…" style="flex:1" />
        <select id="kind">
          <option value="">all kinds</option>
        </select>
        <select id="sort">
          <option value="quality_asc">worst quality first</option>
          <option value="quality_desc">best quality first</option>
          <option value="pixel_desc">worst pixel diff first</option>
          <option value="ssim_asc">lowest SSIM first</option>
          <option value="lab_desc">highest ΔE first</option>
        </select>
      </div>
      <table id="tbl">
        <thead>
          <tr>
            <th>#</th><th>id</th><th>kind</th>
            <th class="num">quality</th>
            <th class="num">pixel %</th>
            <th class="num">SSIM</th>
            <th class="num">ΔE</th>
            <th>notes</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <h2>Tile grid</h2>
    <div class="panel">
      <div id="tiles" class="tile-grid"></div>
    </div>

    <h2>Unmatched in source ({len(unmatched_src)})</h2>
    <div class="panel"><div class="unmatched">
      {''.join(f'<span>{html.escape(u)}</span>' for u in unmatched_src)}
    </div></div>

    <h2>Unmatched in target ({len(unmatched_tgt)})</h2>
    <div class="panel"><div class="unmatched">
      {''.join(f'<span>{html.escape(u)}</span>' for u in unmatched_tgt)}
    </div></div>
    """

    js = """
    const rows = __ROWS__;
    const tbl = document.querySelector('#tbl tbody');
    const tiles = document.querySelector('#tiles');
    const search = document.getElementById('search');
    const kindSel = document.getElementById('kind');
    const sortSel = document.getElementById('sort');

    const allKinds = [...new Set(rows.map(r => r.kind))].sort();
    allKinds.forEach(k => {
      const o = document.createElement('option'); o.value = k; o.textContent = k;
      kindSel.appendChild(o);
    });

    function severity(q) { return q > 70 ? 'good' : q > 40 ? 'mid' : 'bad'; }

    function escape(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function render() {
      const q = search.value.toLowerCase();
      const kf = kindSel.value;
      const sf = sortSel.value;
      let view = rows.filter(r => {
        if (kf && r.kind !== kf) return false;
        if (!q) return true;
        const hay = [r.id, r.kind, (r.notes||[]).join(' '), r.src_text||'', r.tgt_text||''].join(' ').toLowerCase();
        return hay.includes(q);
      });
      view.sort((a, b) => {
        switch (sf) {
          case 'quality_asc':  return a.quality - b.quality;
          case 'quality_desc': return b.quality - a.quality;
          case 'pixel_desc':   return b.pixel - a.pixel;
          case 'ssim_asc':     return a.ssim - b.ssim;
          case 'lab_desc':     return b.lab - a.lab;
        }
      });

      tbl.innerHTML = view.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td class="id">${escape(r.id)}</td>
          <td>${escape(r.kind)}</td>
          <td class="num"><span class="badge ${severity(r.quality)}">${r.quality}</span></td>
          <td class="num">${r.pixel.toFixed(1)}%</td>
          <td class="num">${r.ssim.toFixed(2)}</td>
          <td class="num">${r.lab.toFixed(1)}</td>
          <td>${escape((r.notes||[]).join(' · '))}</td>
        </tr>
      `).join('');

      tiles.innerHTML = view.slice(0, 24).map(r => `
        <div class="tile">
          <div class="top">
            <strong>${escape(r.id)}</strong>
            <span class="badge ${severity(r.quality)}">${r.quality}/100</span>
          </div>
          <div class="row">
            <div>
              <div class="caption">source · ${r.src_bounds[2]}×${r.src_bounds[3]}</div>
              <img src="${r.src_crop}"/>
            </div>
            <div>
              <div class="caption">target · ${r.tgt_bounds[2]}×${r.tgt_bounds[3]}</div>
              <img src="${r.tgt_crop}"/>
            </div>
          </div>
          <div class="notes">${escape((r.notes||[]).join('\\n'))}</div>
        </div>
      `).join('');
    }
    search.oninput = render;
    kindSel.onchange = render;
    sortSel.onchange = render;
    render();
    """.replace("__ROWS__", rows_json)

    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>{html.escape(title)}</title>
<style>{css}</style>
</head>
<body>
{body}
<script>
{js}
</script>
</body>
</html>
"""
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(page, encoding="utf-8")
    return str(Path(out_path).resolve())
