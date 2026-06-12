// The Watcher — local-only activity statistics (P0-8 Slice 4).
//
// Rolling counters of PRODUCT events: pages visited, model loads, env
// installs, bridge starts, tool-call failures, errors. Strictly telemetry
// about the app, never content: no prompts, no file contents, no keys, no
// paths, no message text. Stored in localStorage only — the user can view
// and clear it from The Watcher; nothing is ever sent anywhere.

const KEY = "owllm:watcher:activity";
const MAX_KEYS = 200; // hard cap so a pathological key space can't grow unbounded

export type ActivityStats = {
  /// ISO date the window started (set on first event / after clear).
  since: string;
  /// counter name → count. Names are product-event ids, never content.
  counts: Record<string, number>;
};

function load(): ActivityStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as ActivityStats;
      if (v && typeof v.counts === "object") return v;
    }
  } catch { /* corrupted → start fresh */ }
  return { since: new Date().toISOString(), counts: {} };
}

function save(s: ActivityStats): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* full/blocked → drop */ }
}

/// Increment a product-event counter. `name` must be a STATIC event id
/// (optionally with a short enum-ish suffix like a page key or tool name)
/// — never user content.
export function bumpActivity(name: string): void {
  const s = load();
  if (!(name in s.counts) && Object.keys(s.counts).length >= MAX_KEYS) return;
  s.counts[name] = (s.counts[name] ?? 0) + 1;
  save(s);
}

export function getActivity(): ActivityStats {
  return load();
}

export function clearActivity(): void {
  save({ since: new Date().toISOString(), counts: {} });
}

/// Render the stats as display lines, grouped and sorted by count.
export function activityLines(s: ActivityStats): string[] {
  const entries = Object.entries(s.counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return ["(no activity recorded yet)"];
  return entries.map(([k, v]) => `${v}× ${k}`);
}
