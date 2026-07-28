# OwLLM Desktop — startup flash fix (overlay-frame webview)

## TL;DR

The cyan flash users used to see at every startup came from the
**overlay-frame** webview — a second Tauri window that draws the cyan
HybridFrame chrome (corners + border bars). It had hardcoded cyan
CSS variables that didn't follow the accent picker AND it showed in
parallel with the main webview painting, so the picked accent on the
main window never matched the cyan overlay during the first few
hundred ms.

Two structural changes fixed it. **Don't undo either of them** without
re-reading the failure modes below.

## The two windows

The Tauri app ships TWO webviews on every launch, defined in
`src-tauri/src/lib.rs` + `src-tauri/src/overlay_frame.rs`:

| Window label | Source HTML | What it draws | Visible on first paint? |
|---|---|---|---|
| `main` | `ui/index.html` → `ui/src/main.tsx` (React) | All app content (header, pages, panels) | `visible: false` until `on_page_load Finished` |
| `overlay-frame` | `ui/public/overlay-frame.html` (plain HTML/JS) | Cyan corner PNGs + 4 cyan border bars | `visible: false` until `prepare_and_show_for_main()` |

The overlay frame is a **separate webview**, so the React app's runtime
`applyAccent()` (which sets CSS variables on the main window's `<html>`)
does NOT propagate to it. Each webview has its own document. **This is
the root cause of every "frame stays cyan when I picked amber" bug.**

## How the cold-boot flash worked

Before the fix:

1. Tauri creates both windows with `visible: false`.
2. `on_page_load Finished` fires on the main webview.
3. Main calls `dispatch_window.show()` and the overlay calls
   `prepare_and_show_for_main()`.
4. Both windows become visible at roughly the same time.
5. The overlay-frame.html had hardcoded `--frame-line: rgba(200,240,255,0.86)`
   etc. (cyan), so it painted bright cyan corners against the dark page.
6. The user perceived this as a strong cyan flash because:
   - WebView2 rendering timing was non-deterministic — sometimes the
     overlay painted first, sometimes the main, sometimes both at once.
   - Even when they painted simultaneously, the cyan was a different
     colour family from whatever accent the user had picked, so it read
     as "wrong colour for a beat, then re-paints correctly" — except it
     never re-painted because the overlay had hardcoded values.

## The fix (don't break either of these)

### Fix #1 — Overlay reads localStorage on its own load

`ui/public/overlay-frame.html` now has an inline script that:

```js
const ACCENTS = { indigo: "#667eea", amber: "#fbbf24", ... };
applyOverlayAccent(localStorage.getItem("owllm:theme:accent") || "indigo");
```

It runs **at HTML parse time**, before the main React app even mounts.
This means the very first frame the overlay paints is already in the
right accent — no cyan-to-amber re-paint, no flash.

The `ACCENTS` table is duplicated from `ui/src/theme.ts` on purpose:
the overlay can't import TypeScript modules (it's plain HTML loaded as
a separate webview), and keeping the table inline avoids a network
fetch on the critical-path startup.

**If you add a new accent square** in `theme.ts`, **also add it to the
overlay's `ACCENTS` table**, or that accent will fall back to indigo
in the overlay.

### Fix #2 — Live picker clicks broadcast via Tauri event

`ui/src/theme.ts`'s accent effect now does:

```ts
useEffect(() => {
  applyAccent(accent.color);
  localStorage.setItem(LS_ACCENT, accentKey);
  // Push to the overlay-frame webview so its cyan corners flip
  // immediately on a picker click.
  window.__TAURI__?.event?.emit("owllm:accent-changed", accentKey);
}, [accentKey, accent.color]);
```

The overlay listens for that event:

```js
window.__TAURI__.event.listen("owllm:accent-changed", (ev) => {
  if (typeof ev.payload === "string") applyOverlayAccent(ev.payload);
});
```

Without this, clicking a colour square in the header would paint the
React side instantly but leave the cyan corners stale until the next
launch (when the overlay would re-read localStorage).

## How to verify after future changes

Use the existing TwinForge probe:

```bash
# 1. Start vite dev (the overlay loads from /overlay-frame.html under
#    the same vite origin, so the localStorage seed reaches it).
cd apps/owllm-desktop && npm run dev

# 2. Capture all six accents at once
/c/1_Git/LocaLLM/LLM/python_runtime/python3.11/python.exe \
  /c/1_Git/LocaLLM/LLM/tools/twinforge_theme_snap.py
```

PNGs land in `twinforge_loop_out/theme-check/<page>/<accent>-<mode>.png`.
The cyan frame corners in each should match the accent of that snap.
If `amber-dark.png` shows cyan corners, the overlay fix has regressed.

## What NOT to do

- **Don't move overlay-frame styling into `styles.css`.** styles.css is
  loaded by the React bundle which the overlay doesn't import. The
  CSS vars must live in the overlay's own HTML.

- **Don't make the overlay `visible: true` by default.** That would
  ship a brief cyan flash again because the overlay can paint before
  its inline `applyOverlayAccent()` runs (the timing is HTML-parse-
  order dependent).

- **Don't rely solely on the Tauri event for the initial paint.** The
  event is for live picker clicks; cold-boot must use the localStorage
  read, otherwise there's a race between event subscription and the
  first paint.

- **Don't drop the `prepare_and_show_for_main()` gating in lib.rs.**
  It guarantees the overlay shows AFTER the main webview has
  geometry, which prevents the overlay from painting at (0,0) full-
  screen for one frame.

## Related files

- `apps/owllm-desktop/ui/public/overlay-frame.html` — overlay HTML
  + accent-reading script
- `apps/owllm-desktop/ui/src/theme.ts` — `applyAccent()` +
  `owllm:accent-changed` event emit
- `apps/owllm-desktop/src-tauri/src/overlay_frame.rs` — Tauri-side
  window creation, geometry sync, visibility gating
- `apps/owllm-desktop/src-tauri/src/lib.rs` — `on_page_load Finished`
  handler that triggers main show + overlay show
- `LLM/tools/twinforge_theme_snap.py` — Playwright probe used to
  validate accent propagation
