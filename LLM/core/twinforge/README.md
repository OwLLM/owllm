# UI Agent — generic UI replication & testing

A cross-platform agent for replicating and visually testing UIs. Same
agent can compare a Qt desktop app against a React replica, or two web
versions of the same page, or a Win32 app against a Flutter port. Adding
a new platform is a single adapter file; the core never changes.

## Why

Pixel-only diffs are not enough to drive replica work. A single number
(`44 % different`) doesn't tell you which widget is wrong, by how much,
or in what way. This agent produces a ranked per-element report keyed on
stable identifiers (Qt `objectName`, web `data-ui`, etc.), with
size/position/text/style notes and a 0–100 perceptual quality score per
element.

## Architecture

```
adapters/          per-platform glue (~200 lines each)
  qt_adapter.py        boots a Qt app, walks QWidget tree
  web_adapter.py       Playwright DOM walk + getComputedStyle
  uia_adapter.py       (future) Windows UIAutomation
  flutter_adapter.py   (future) flutter_driver
schema.py          normalized UIElement contract
diff.py            region-aware diff: pixel + SSIM + ΔE per element
html_report.py     self-contained interactive HTML report
agent.py           orchestration: capture → diff → report
__main__.py        CLI entry
```

Adapters know about their platform. Everything else only sees the
normalized `UIElement` shape and the saved PNGs — it never needs to
know whether it's looking at Qt, HTML, native code, etc.

## The normalized contract

Each adapter produces a tree of `UIElement` instances:

```python
@dataclass
class UIElement:
    id: str              # stable cross-platform name
    kind: str            # container | text | button | input | image |
                         # canvas | list | other
    bounds: Bounds       # {x, y, w, h} in screenshot pixels
    text: Optional[str]  # visible text content if any
    class_name: str      # native class name for debugging
    children: List[UIElement]
    raw: Dict            # adapter-specific extras, e.g. raw.style
```

Two ids align iff they're string-equal. The Qt adapter sources ids from
`QWidget.objectName()`. The web adapter sources them from
`data-ui="..."` attributes. Both adapters happily walk and report on
*unnamed* elements too — they just don't participate in alignment.

## Metrics per matched element

The diff core computes for each `(src_element, tgt_element)` pair:

| Metric | What it catches |
|---|---|
| `diff_pct` | % of pixels where any channel differs > 20 |
| `ssim` | Structural similarity (handles anti-aliasing gracefully) |
| `mean_lab_distance` | CIE Lab ΔE — perceptual color distance |
| `quality_score` | Weighted blend, 0–100 |

Plus notes:

* Size mismatch (`size src=86×32 tgt=85×23`)
* Position drift (`pos off by (+6, -2)`)
* Text content (`text src='Run' tgt='▶ Run'`)
* Font size/weight/family
* Foreground/background color (ΔE > 40 in RGB)
* Padding/margin (per side > 4 px)
* Opacity, text-align, text-transform

## Running it

```bash
# OWLLM Qt agents page vs the local React replica:
python -m core.twinforge compare \
    --source-adapter qt  --source-target agents \
    --source-width 1600 --source-height 960 \
    --target-adapter web --target-target ./web_replica/agents_page_v11.html \
    --target-width 1700 --target-height 1100 \
    --out-dir ./twinforge_out
```

Outputs:
* `twinforge_out/source.png` — Qt screenshot
* `twinforge_out/target.png` — web screenshot
* `twinforge_out/source_tree.json` — Qt widget tree (normalized)
* `twinforge_out/target_tree.json` — DOM tree (normalized)
* `twinforge_out/report.txt` — text report
* `twinforge_out/report.html` — **self-contained interactive HTML**
* `twinforge_out/tile_grid.png` — per-region [src | tgt | delta] grid
* `twinforge_out/overlay.png` — 2-pane full-page comparison with boxes

## Adding a new adapter

1. New file in `adapters/`. Subclass `AdapterBase`.
2. Implement `capture(target, out_png, out_tree, width, height, **kw)`.
3. Take a screenshot, walk the native tree, normalize, write both.
4. Wire it into `__main__.py:_ADAPTERS`.

That's all — the diff core, report generator, CLI, and HTML output
work unchanged.

### Roadmap

* `uia_adapter.py` — Windows UIAutomation for any native Win32 / WPF app
* `flutter_adapter.py` — flutter_driver
* `dom_text_extraction` — OCR for canvas/image elements that have no
  DOM text
* `baseline_db` — persist per-element scores across runs, surface
  regressions

## Why the funky offscreen Qt subprocess?

`adapters/_qt_subprocess_runner.py` runs in a fresh process per capture
because the OWLLM `MainWindow`'s background-detection thread destroys
widgets unpredictably after ~10 s under `QT_QPA_PLATFORM=offscreen`. In-
process captures gave a `STATUS_STACK_BUFFER_OVERRUN` during teardown.
Each subprocess captures the PNG, walks the tree, writes both, exits —
OS cleanup handles teardown. Cost: ~6 s of MainWindow boot per call.
