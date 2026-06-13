// worldState — XP / unlocks / quest log for the 2.5D HQ (P0-1 Slice 4).
// Module-level + localStorage (§0.8): OWLLM pages unmount on tab switch,
// so progression must survive outside component state.

export type Quest = { at: string; xp: number; note: string };
export type WorldProgress = {
  xp: number;
  scene: string;
  quests: Quest[];
};

const KEY = "owllm:world:progress";
const listeners = new Set<() => void>();
let cached: WorldProgress | null = null;

function load(): WorldProgress {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as WorldProgress;
      if (v && typeof v.xp === "number") {
        cached = { xp: v.xp, scene: v.scene || "hq_loft", quests: Array.isArray(v.quests) ? v.quests : [] };
        return cached;
      }
    }
  } catch { /* corrupted → fresh */ }
  cached = { xp: 0, scene: "hq_loft", quests: [] };
  return cached;
}

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(cached)); } catch { /* ignore */ }
  for (const l of listeners) l();
}

export function getProgress(): WorldProgress {
  return load();
}

export function subscribeProgress(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function addXp(n: number, note: string): void {
  const p = load();
  p.xp += n;
  p.quests = [{ at: new Date().toISOString(), xp: n, note }, ...p.quests].slice(0, 30);
  save();
}

export function setScene(key: string): void {
  load().scene = key;
  save();
}
