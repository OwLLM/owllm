// How two copies of one notebook's step list are reconciled.
//
// This lives on its own because BOTH layers need the identical rule and a
// second implementation would drift:
//   • vaultSync (mergeNotebookLease) reconciles this device's copy with a
//     peer PC's copy on pull.
//   • RunNotebook (saveNotebook) reconciles an in-memory copy that lost the
//     optimistic-concurrency check with whatever landed in localStorage
//     underneath it — which is the same problem with a shorter distance.
//
// Extracted from vaultSync; the rules below are unchanged, only relocated.

/// How far a step has progressed. This is only the tie-breaker when two copies
/// have the same lifecycle timestamp; a newer explicit Reopen must be allowed
/// to move a step from archived back to pending.
export function stepProgress(s: any): number {
  if (!s || typeof s !== "object") return 0;
  if (s.status === "done") return 4;
  if (s.status === "sent" && s.finishedAt != null) return 3;
  if (s.status === "failed") return 2;
  if (s.status === "sent") return 1;
  return 0; // pending
}

export function stepLifecycleAt(s: any): number {
  if (!s || typeof s !== "object") return 0;
  for (const value of [s.stepUpdatedAt, s.archivedAt, s.finishedAt, s.startedAt, s.ts]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

/// Union two step lists by id, newest-lifecycle-wins, with deleted ids buried.
/// Order follows the newer side, then any ids only the older side still has,
/// so a reordering on the newer device survives without dropping the other's
/// additions.
export function mergeSteps(newer: any[], older: any[], buried: Set<string>): any[] {
  const byId = new Map<string, any>();
  for (const s of older) if (s?.id && !buried.has(s.id)) byId.set(s.id, s);
  for (const s of newer) {
    if (!s?.id || buried.has(s.id)) continue;
    const prev = byId.get(s.id);
    const currentAt = stepLifecycleAt(s);
    const previousAt = stepLifecycleAt(prev);
    const winner = !prev
      || currentAt > previousAt
      || (currentAt === previousAt && stepProgress(s) >= stepProgress(prev))
      ? s
      : prev;
    byId.set(s.id, winner);
  }
  const out: any[] = [];
  const emitted = new Set<string>();
  for (const src of [newer, older]) {
    for (const s of src) {
      if (!s?.id || emitted.has(s.id) || !byId.has(s.id)) continue;
      emitted.add(s.id);
      out.push(byId.get(s.id));
    }
  }
  return out;
}

/// Tombstones are a union: a delete on EITHER copy is authoritative, or a
/// union of the step lists would resurrect everything the user removed.
export function unionTombstones(...lists: any[]): Array<{ id: string; ts: number }> {
  const tombstones = new Map<string, { id: string; ts: number }>();
  for (const src of lists) {
    if (!Array.isArray(src)) continue;
    for (const d of src) {
      if (d && typeof d.id === "string" && typeof d.ts === "number") tombstones.set(d.id, d);
    }
  }
  return [...tombstones.values()];
}
