// edgeRouter — obstacle-avoiding, bundling edge paths for the agent graph
// (P0-2b). Pure geometry, no React: probe-able in node and cheap enough to
// run per render (cards are user-draggable; every drag frame re-routes).
//
// Approach: cubic Beziers anchored perpendicular to the card edge (same
// look as before), then SAMPLED against the card rectangles. A path that
// cuts through a card gets its control points pushed laterally (away from
// the worst-offending card), retrying with growing offsets on both sides
// and keeping the best attempt. Parallel edges between the same pair of
// cards fan out with per-member lateral offsets so they never overlap.

export type Rect = { x: number; y: number; w: number; h: number };
export type PortSide = "left" | "right" | "top" | "bottom";
export type Port = { x: number; y: number; side: PortSide };

export type RoutedEdge = {
  /// SVG path `d` string (cubic Bezier).
  d: string;
  /// True when no obstacle-free route was found (best effort returned).
  clipped: boolean;
};

const SAMPLES = 28;
/// Keep this much clearance around card bodies.
const MARGIN = 6;

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function inflate(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/// Perpendicular exit/entry control point (the established look).
function baseCtl(p: Port, other: Port, k: number): { x: number; y: number } {
  if (p.side === "right") return { x: p.x + Math.max(40, Math.abs(other.x - p.x) * k), y: p.y };
  if (p.side === "left") return { x: p.x - Math.max(40, Math.abs(other.x - p.x) * k), y: p.y };
  if (p.side === "bottom") return { x: p.x, y: p.y + Math.max(40, Math.abs(other.y - p.y) * k), };
  return { x: p.x, y: p.y - Math.max(40, Math.abs(other.y - p.y) * k) };
}

/// How badly a candidate path penetrates the obstacles (0 = clear).
function penetration(
  s: Port, t: Port,
  c1: { x: number; y: number }, c2: { x: number; y: number },
  obstacles: Rect[],
): number {
  let hits = 0;
  for (let i = 1; i < SAMPLES; i++) {
    const tt = i / SAMPLES;
    const x = cubicAt(s.x, c1.x, c2.x, t.x, tt);
    const y = cubicAt(s.y, c1.y, c2.y, t.y, tt);
    for (const r of obstacles) {
      if (pointInRect(x, y, r)) hits++;
    }
  }
  return hits;
}

/// Route one edge around the obstacle rects (which must EXCLUDE the source
/// and target cards). `bundleShift` fans parallel edges apart.
export function routeEdge(
  s: Port,
  t: Port,
  obstacles: Rect[],
  bundleShift = 0,
): RoutedEdge {
  const obs = obstacles.map(r => inflate(r, MARGIN));
  // Lateral direction = perpendicular to the straight s→t line.
  const dx = t.x - s.x, dy = t.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;

  const build = (shift: number) => {
    const c1 = baseCtl(s, t, 0.55);
    const c2 = baseCtl(t, s, 0.55);
    c1.x += nx * (shift + bundleShift); c1.y += ny * (shift + bundleShift);
    c2.x += nx * (shift + bundleShift); c2.y += ny * (shift + bundleShift);
    return { c1, c2 };
  };

  // Data-driven detour candidates: for every obstacle near the corridor,
  // how far (laterally, signed) would the path need to swing to clear its
  // far edge? A Bezier's midpoint only moves ~3/4 of the control shift,
  // so scale up. This is what lets a single edge clear a WALL of cards —
  // fixed-size nudges can't.
  const dataShifts: number[] = [];
  for (const r of obs) {
    const corners = [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
      { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h },
    ];
    let lo = Infinity, hi = -Infinity;
    for (const c of corners) {
      // Signed lateral distance of the corner from the s→t line.
      const d = (c.x - s.x) * nx + (c.y - s.y) * ny;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    // Only relevant when the corridor actually brushes this obstacle.
    if (lo < 60 && hi > -60) {
      dataShifts.push((hi + 24) * 1.6, (lo - 24) * 1.6);
    }
  }
  // Try straight-ish first, small static nudges, then the data-driven
  // swings (sorted small→large so we keep curves as gentle as possible).
  const shifts = [
    0, 60, -60, 110, -110, 170, -170, 240, -240,
    ...dataShifts.sort((a, b) => Math.abs(a) - Math.abs(b)),
    340, -340, 460, -460,
  ];
  let best: { d: string; pen: number } | null = null;
  for (const shift of shifts) {
    const { c1, c2 } = build(shift);
    const pen = penetration(s, t, c1, c2, obs);
    const d = `M ${s.x} ${s.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${t.x} ${t.y}`;
    if (pen === 0) return { d, clipped: false };
    if (!best || pen < best.pen) best = { d, pen };
  }

  // Manhattan fallback: a single-swing Bezier physically can't clear a
  // tight cluster hugging the ports (lateral displacement tapers to zero
  // at the endpoints). Route a LANE fully outside the obstacles' lateral
  // extent instead: stub out of each port, jog to the lane, run along it,
  // jog back in. Tried at increasing clearances on both sides.
  const lat = (px: number, py: number) => (px - s.x) * nx + (py - s.y) * ny;
  let lo = 0, hi = 0;
  for (const r of obs) {
    for (const c of [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
      { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h },
    ]) {
      const d = lat(c.x, c.y);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
  }
  const stub = (p: Port, len: number) =>
    p.side === "bottom" ? { x: p.x, y: p.y + len }
    : p.side === "top" ? { x: p.x, y: p.y - len }
    : p.side === "right" ? { x: p.x + len, y: p.y }
    : { x: p.x - len, y: p.y };
  const polyPen = (pts: Array<{ x: number; y: number }>): number => {
    let hits = 0;
    for (let seg = 0; seg < pts.length - 1; seg++) {
      for (let i = 0; i <= 10; i++) {
        const tt = i / 10;
        const x = pts[seg].x + (pts[seg + 1].x - pts[seg].x) * tt;
        const y = pts[seg].y + (pts[seg + 1].y - pts[seg].y) * tt;
        for (const r of obs) if (pointInRect(x, y, r)) hits++;
      }
    }
    return hits;
  };
  for (const clearance of [36, 80, 140]) {
    for (const lane of [hi + clearance, lo - clearance]) {
      const p1 = stub(s, 24);
      const p2 = stub(t, 24);
      const q1 = { x: p1.x + nx * (lane - lat(p1.x, p1.y)), y: p1.y + ny * (lane - lat(p1.x, p1.y)) };
      const q2 = { x: p2.x + nx * (lane - lat(p2.x, p2.y)), y: p2.y + ny * (lane - lat(p2.x, p2.y)) };
      const pts = [{ x: s.x, y: s.y }, p1, q1, q2, p2, { x: t.x, y: t.y }];
      if (polyPen(pts) === 0) {
        return { d: "M " + pts.map(p => `${p.x} ${p.y}`).join(" L "), clipped: false };
      }
    }
  }
  return { d: best!.d, clipped: true };
}

/// Per-edge lateral offsets so parallel edges between the same card pair
/// fan out instead of overlapping. Order-independent pair key.
export function bundleOffsets(
  edges: Array<{ source: string; target: string }>,
): number[] {
  const groups = new Map<string, number[]>();
  edges.forEach((e, i) => {
    const key = [e.source, e.target].sort().join("→");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  });
  const out = new Array(edges.length).fill(0);
  for (const idxs of groups.values()) {
    const n = idxs.length;
    idxs.forEach((edgeIdx, k) => {
      out[edgeIdx] = (k - (n - 1) / 2) * 16;
    });
  }
  return out;
}

/// Sample a routed path (cubic OR Manhattan polyline) and report whether
/// it intersects a rect — the probe uses this; callers can use it for
/// debug overlays.
export function pathIntersectsRect(d: string, r: Rect, margin = 0): boolean {
  const rr = inflate(r, margin);
  const cubic = d.match(/M ([-\d.]+) ([-\d.]+) C ([-\d.]+) ([-\d.]+), ([-\d.]+) ([-\d.]+), ([-\d.]+) ([-\d.]+)/);
  if (cubic) {
    const [sx, sy, c1x, c1y, c2x, c2y, tx, ty] = cubic.slice(1).map(Number);
    for (let i = 1; i < SAMPLES; i++) {
      const tt = i / SAMPLES;
      const x = cubicAt(sx, c1x, c2x, tx, tt);
      const y = cubicAt(sy, c1y, c2y, ty, tt);
      if (pointInRect(x, y, rr)) return true;
    }
    return false;
  }
  // Polyline: "M x y L x y L x y …"
  const nums = (d.match(/[-\d.]+/g) ?? []).map(Number);
  for (let seg = 0; seg + 3 < nums.length; seg += 2) {
    const [ax, ay, bx, by] = [nums[seg], nums[seg + 1], nums[seg + 2], nums[seg + 3]];
    for (let i = 0; i <= 12; i++) {
      const tt = i / 12;
      const x = ax + (bx - ax) * tt;
      const y = ay + (by - ay) * tt;
      if (pointInRect(x, y, rr)) return true;
    }
  }
  return false;
}
