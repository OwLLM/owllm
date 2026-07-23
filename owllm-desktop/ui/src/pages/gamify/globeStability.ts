// Pure helpers that keep the World Map globe rendering stable. Extracted from
// WorldMapPage so the flicker-prevention rules can be unit-tested without a
// WebGL context (same convention as worldPresence.ts).
//
// Two motion regressions live here:
//  1. The node layer must be rebuilt only when the node SET actually changes.
//     The 30s fleet poll and every world-presence snapshot hand back a brand
//     new array with identical content; rebuilding the marker/orbit meshes on
//     each new reference tore the node layer down and back up on a timer, which
//     read as the globe flickering "after completing a turn".
//  2. A pointer gesture that travelled (an orbit drag) must NOT be treated as a
//     click, so dragging to rotate the globe never fires a selection state
//     update "while the user moves the mouse over it".

/** Fields of a globe node that determine the built marker/orbit meshes. */
export type GlobeNodeShape = {
  id: string;
  kind: "world" | "fleet";
  online: boolean;
  label: string;
  latitude?: number;
  longitude?: number;
};

/**
 * Stable signature of a node set. Two arrays with the same nodes (in the same
 * order) produce the same string regardless of array/object identity, so the
 * node layer is rebuilt only on a real change. Fleet orbits are a deterministic
 * function of `id`, so `id` already covers them.
 */
export function nodeSignature(nodes: readonly GlobeNodeShape[]): string {
  return JSON.stringify(
    nodes.map((n) => [n.id, n.kind, n.online, n.label, n.latitude ?? null, n.longitude ?? null]),
  );
}

/** Max pointer travel (px) between press and release still counted as a click. */
export const GLOBE_CLICK_MAX_TRAVEL_PX = 6;

/**
 * True when a press→release pair is a click (near-stationary), false when the
 * pointer travelled far enough to be an orbit drag.
 */
export function isClickGesture(dx: number, dy: number, maxTravel = GLOBE_CLICK_MAX_TRAVEL_PX): boolean {
  return Math.hypot(dx, dy) <= maxTravel;
}
