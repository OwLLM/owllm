// Persisted preference for the decorative window frame (HybridFrame and
// its Windows overlay twin): whether the frame stays visible instead of
// fading after idle. Pure module — storage is injectable so the verify
// harness can drive it without a browser (same pattern as themePreferences).
export const KEEP_FRAME_VISIBLE_KEY = "owllm:window-frame:keep-visible";

type FrameStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(storage?: FrameStorage): FrameStorage | null {
  if (storage) return storage;
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

export function readKeepFrameVisible(storage?: FrameStorage): boolean {
  try { return browserStorage(storage)?.getItem(KEEP_FRAME_VISIBLE_KEY) === "1"; }
  catch { return false; }
}

export function saveKeepFrameVisible(value: boolean, storage?: FrameStorage) {
  try { browserStorage(storage)?.setItem(KEEP_FRAME_VISIBLE_KEY, value ? "1" : "0"); }
  catch { /* storage unavailable */ }
}
