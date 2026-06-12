// Synced "model library" — the set of model repos the user has downloaded on
// ANY device. We never sync model weights (GBs); we sync this small list of
// names. It rides the vault automatically (the `owllm:` localStorage prefix is
// synced). On a device that doesn't have a model's weights locally, the Models
// page shows it as a GHOSTED card with a Download button — your library
// follows you even though the bytes don't.

const KEY = "owllm:model-library";

/// On-disk model names (`<author>__<repo>` form, matching DownloadedItem.name).
export function getModelLibrary(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/// Merge locally-present model names into the synced library (idempotent).
export function recordDownloadedModels(names: string[]): void {
  if (!names.length) return;
  try {
    const set = new Set(getModelLibrary());
    let changed = false;
    for (const n of names) {
      if (n && !set.has(n)) { set.add(n); changed = true; }
    }
    if (changed) localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch { /* private mode / quota */ }
}

/// Names in the synced library whose weights are NOT present locally — these
/// render as ghosted "Download" cards.
export function ghostedModels(localNames: string[]): string[] {
  const have = new Set(localNames.map((n) => n.toLowerCase()));
  return getModelLibrary().filter((n) => !have.has(n.toLowerCase()));
}
