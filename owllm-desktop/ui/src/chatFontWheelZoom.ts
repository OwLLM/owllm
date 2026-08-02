// Ctrl+mouse-wheel text zoom for the app's editable text surfaces (notebook,
// brainstorm, code chat, agent input). This reuses the shared chat font step
// (chatFontPreferences) — the same clamp/persist/restore the Settings +/-
// buttons drive — so a wheel notch and a button click are equivalent and there
// is one persisted preference, not a parallel one.
//
// Pure module: the DOM element is treated as a minimal shape so the verify
// harness can drive focus-targeting without a browser (same pattern as
// framePreferences / themePreferences / chatFontPreferences).
import { clampChatFontStep } from "./chatFontPreferences";

// A container/input can opt a region into wheel zoom explicitly with this
// attribute. Detection ALSO recognizes any element whose inline font-size is
// driven by --chat-font-size, so every surface that already scales with the
// Settings control is zoomable with no extra markup.
export const CHAT_ZOOM_ATTR = "data-chat-zoom";
const CHAT_FONT_VAR = "--chat-font-size";
// A wheel event lands on the innermost element under the pointer (often a text
// node's span). Walk a bounded number of ancestors so it still resolves to the
// zoomable box, without scanning the whole tree.
const MAX_ANCESTOR_WALK = 8;

type ZoomEl = {
  getAttribute?: (name: string) => string | null;
  style?: { fontSize?: string } | null;
  parentElement?: ZoomEl | null;
} | null;

// True when `el` (or a nearby ancestor) is a chat-zoomable text surface: either
// explicitly tagged with data-chat-zoom, or rendering text sized by the shared
// --chat-font-size variable. Used to target the currently clicked/focused box so
// Ctrl+wheel elsewhere (nav, model lists, settings) never hijacks the gesture.
export function isChatZoomTarget(el: ZoomEl): boolean {
  let node: ZoomEl = el;
  for (let i = 0; node && i < MAX_ANCESTOR_WALK; i += 1) {
    try {
      if (node.getAttribute && node.getAttribute(CHAT_ZOOM_ATTR) != null) return true;
      const fs = node.style?.fontSize;
      if (typeof fs === "string" && fs.includes(CHAT_FONT_VAR)) return true;
    } catch {
      /* detached / cross-origin node — treat as not zoomable */
    }
    node = node.parentElement ?? null;
  }
  return false;
}

// Wheel direction → step change. Scrolling up (deltaY < 0) grows the text (zoom
// in); scrolling down shrinks it. A zero or non-finite delta is a no-op.
export function wheelZoomDelta(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  return deltaY < 0 ? 1 : -1;
}

// Apply one wheel notch to the current step, clamped to the readable range
// ([-3, +9] via chatFontPreferences). Keeping the clamp here means the wheel can
// never push the text past the same bounds the buttons enforce, so layouts that
// already tolerate the +9 ceiling never overflow.
export function nextChatFontStep(current: number, deltaY: number): number {
  return clampChatFontStep(current + wheelZoomDelta(deltaY));
}
