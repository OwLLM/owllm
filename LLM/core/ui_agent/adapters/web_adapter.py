"""Web adapter — Playwright opens a URL or local HTML, screenshots it,
and walks the DOM looking for `data-ui="..."` annotations. Elements with a
data-ui attribute become the addressable identifiers; elements without one
are still walked into `raw` for debugging but aren't aligned by the diff
core (matches the Qt adapter's behaviour: only named objectNames align).

This adapter is generic — it works against ANY HTML page that follows the
data-ui annotation convention. The replica being an OWLLM clone is
irrelevant to the adapter.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from core.ui_agent.schema import Bounds, CaptureResult, UIElement


# JS snippet evaluated inside the page to extract the DOM tree. We do it
# in one round-trip rather than walking from Python via CDP — the latter
# is far slower and the synchronous JS visitor is straightforward.
_DOM_WALK_JS = r"""
() => {
  function classify(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    if (tag === 'button' || role === 'button') return 'button';
    if (tag === 'input' || tag === 'textarea') return 'input';
    if (tag === 'img' || tag === 'svg' || tag === 'canvas') {
      return tag === 'canvas' ? 'canvas' : 'image';
    }
    if (tag === 'span' || tag === 'p' || tag === 'label' || /^h[1-6]$/.test(tag)) return 'text';
    if (tag === 'select' || tag === 'ul' || tag === 'ol') return 'list';
    return 'container';
  }
  function visibleText(el) {
    if (el.children.length === 0) {
      const t = (el.textContent || '').trim();
      return t.slice(0, 200) || null;
    }
    return null;
  }
  function styleOf(el) {
    // Computed style → properties that matter for replica fidelity.
    // We use computed style (not inline `style` attribute) so inherited
    // values are accurate, the way they render in the browser.
    const cs = window.getComputedStyle(el);
    const px = (v) => {
      const m = String(v || '').match(/(-?[\d.]+)px/);
      return m ? parseFloat(m[1]) : null;
    };
    return {
      font_size_px: px(cs.fontSize),
      font_weight: cs.fontWeight === '700' || cs.fontWeight === 'bold' ? 'bold' : 'normal',
      font_family: cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
      italic: cs.fontStyle === 'italic',
      color_fg: cs.color,
      color_bg: cs.backgroundColor,
      border_radius_px: px(cs.borderTopLeftRadius),
      border_width_px: px(cs.borderTopWidth),
      border_color: cs.borderTopColor,
      padding: [px(cs.paddingLeft), px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom)],
      margin:  [px(cs.marginLeft),  px(cs.marginTop),  px(cs.marginRight),  px(cs.marginBottom)],
      text_align: cs.textAlign,
      text_transform: cs.textTransform,
      letter_spacing: cs.letterSpacing,
      opacity: parseFloat(cs.opacity || '1'),
      display: cs.display,
      stylesheet: el.getAttribute('style') || ''
    };
  }
  function walk(el) {
    const r = el.getBoundingClientRect();
    const id = el.getAttribute('data-ui') || '';
    const kind = classify(el);
    const node = {
      id: id,
      kind: kind,
      bounds: { x: Math.round(r.left), y: Math.round(r.top),
                w: Math.round(r.width), h: Math.round(r.height) },
      text: visibleText(el),
      class_name: el.tagName.toLowerCase(),
      children: [],
      raw: { className: el.className || '', style: styleOf(el) }
    };
    for (const c of el.children) {
      const child = walk(c);
      if (child) node.children.push(child);
    }
    return node;
  }
  return walk(document.body);
}
"""


def capture(
    url_or_path: str,
    out_png: str,
    out_tree: str,
    *,
    width: int = 1700,
    height: int = 1100,
    wait_ms: int = 2500,
    timeout_ms: int = 30000,
) -> CaptureResult:
    """Screenshot `url_or_path` at the given viewport and dump its DOM tree.

    `url_or_path` accepts a full URL or an absolute filesystem path. The
    adapter converts local paths to `file://` URIs automatically.
    """
    from playwright.sync_api import sync_playwright

    p = Path(url_or_path)
    if p.exists():
        url = p.resolve().as_uri()
    else:
        url = url_or_path

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": width, "height": height})
        page.goto(url, timeout=timeout_ms)
        page.wait_for_timeout(wait_ms)
        Path(out_png).parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=out_png, full_page=False)
        tree_dict = page.evaluate(_DOM_WALK_JS)
        browser.close()

    Path(out_tree).write_text(json.dumps(tree_dict, indent=2), encoding="utf-8")
    root = UIElement.from_dict(tree_dict)
    return CaptureResult(
        png_path=str(out_png),
        root=root,
        width=width, height=height,
    )
