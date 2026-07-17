// Persisted preference for the chat message text size. Users can enlarge the
// text inside chat message bodies (the shared ChatMarkdown / .md-body renderer
// every chat surface reuses) in whole-pixel steps. The smallest step is the
// app's existing 13px body size; it grows up to +4px in +1 increments.
// Pure module — storage is injectable so the verify harness can drive it
// without a browser (same pattern as framePreferences / themePreferences).
export const CHAT_FONT_STEP_KEY = "owllm:chat:font-step";

export const CHAT_FONT_BASE_PX = 13;
export const CHAT_FONT_MIN_STEP = 0;
export const CHAT_FONT_MAX_STEP = 4;

type ChatFontStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(storage?: ChatFontStorage): ChatFontStorage | null {
  if (storage) return storage;
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

// Clamp any value to a whole step within [MIN, MAX]; non-finite falls to MIN.
export function clampChatFontStep(value: number): number {
  if (!Number.isFinite(value)) return CHAT_FONT_MIN_STEP;
  return Math.min(CHAT_FONT_MAX_STEP, Math.max(CHAT_FONT_MIN_STEP, Math.round(value)));
}

// Resolve a step to the concrete chat body font size in pixels (13..17).
export function chatFontSizePx(step: number): number {
  return CHAT_FONT_BASE_PX + clampChatFontStep(step);
}

export function readChatFontStep(storage?: ChatFontStorage): number {
  try {
    const raw = browserStorage(storage)?.getItem(CHAT_FONT_STEP_KEY);
    if (raw == null) return CHAT_FONT_MIN_STEP;
    return clampChatFontStep(Number(raw));
  } catch { return CHAT_FONT_MIN_STEP; }
}

export function saveChatFontStep(value: number, storage?: ChatFontStorage) {
  try { browserStorage(storage)?.setItem(CHAT_FONT_STEP_KEY, String(clampChatFontStep(value))); }
  catch { /* storage unavailable */ }
}
