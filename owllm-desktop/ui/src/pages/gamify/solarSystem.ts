// Solar System catalog + pure focus/zoom math for the World Map explorer.
//
// Earth stays at the scene origin because every presence marker, fleet orbit,
// and satellite label is positioned relative to it. The other seven planets are
// visitable bodies placed on a wide display arc around that origin (not an
// astronomical ephemeris — distances/radii are compressed so all eight bodies
// are reachable inside one WebGL scene while size order stays truthful).
//
// This module deliberately has no three.js or DOM dependency: the interaction
// verifier transpiles it and drives every planet switch in plain Node.

export type Vec3 = { x: number; y: number; z: number };

export type PlanetFallback = {
  // Procedural texture recipe: guarantees each planet renders its distinguishing
  // features immediately (loading) and permanently (texture load error).
  base: string;
  bands?: string[];
  spot?: { color: string; u: number; v: number; ru: number; rv: number };
  caps?: string;
  craters?: number;
};

export type PlanetRing = {
  inner: number; // multiples of the planet radius
  outer: number;
  texture?: string; // bundled alpha strip; procedural fallback when it fails
  opacity: number;
  tint: string; // WebGL material tint (not a CSS text colour)
};

export type PlanetSpec = {
  id: "mercury" | "venus" | "earth" | "mars" | "jupiter" | "saturn" | "uranus" | "neptune";
  name: string; // English label — localized with t() at render time
  texture: string | null; // null → Earth keeps its dedicated photographic layers
  radius: number; // display radius; Earth = 2.35 matches the live globe
  angle: number; // bearing around Earth on the XZ plane (degrees)
  distance: number; // display distance from the scene origin (Earth)
  y: number; // slight vertical offset so the arc reads with depth
  tiltDeg: number; // axial tilt (Venus retrograde, Uranus sideways)
  spin: number; // display self-rotation speed (rad/s, sign = direction)
  focusFactor?: number; // camera framing multiple of radius (rings need more room)
  fallback: PlanetFallback;
  ring?: PlanetRing;
};

// Solar order. Radii are sqrt-compressed relative to Earth's 2.35 display units
// so the gas giants stay clearly giant without dwarfing the whole scene.
export const PLANETS: PlanetSpec[] = [
  {
    id: "mercury", name: "Mercury", texture: "/world-map/mercury.jpg",
    radius: 1.45, angle: -125, distance: 26, y: -2, tiltDeg: 0.03, spin: 0.004,
    fallback: { base: "#8a8378", bands: ["#7c7568", "#948d80"], craters: 90 },
  },
  {
    id: "venus", name: "Venus", texture: "/world-map/venus.jpg",
    radius: 2.29, angle: -62, distance: 21, y: 1.5, tiltDeg: 177.4, spin: -0.003,
    fallback: { base: "#d9b96e", bands: ["#e6cd8f", "#caa75c", "#e0c07a"] },
  },
  {
    id: "earth", name: "Earth", texture: null,
    radius: 2.35, angle: 0, distance: 0, y: 0, tiltDeg: 23.4, spin: 0.018,
    fallback: { base: "#2a63c4", bands: ["#2f7d4f", "#35935e"], caps: "#e8f2fa" },
  },
  {
    id: "mars", name: "Mars", texture: "/world-map/mars.jpg",
    radius: 1.71, angle: 38, distance: 20, y: -1, tiltDeg: 25.2, spin: 0.02,
    fallback: { base: "#b6552e", bands: ["#8f3f22", "#c46a3d"], caps: "#e8e2d9", craters: 40 },
  },
  {
    id: "jupiter", name: "Jupiter", texture: "/world-map/jupiter.jpg",
    radius: 7.78, angle: 96, distance: 46, y: 3, tiltDeg: 3.1, spin: 0.09,
    fallback: {
      base: "#c8a97e",
      bands: ["#b98f63", "#e3cfa8", "#a97c52", "#d9bd92", "#8f6a48", "#e8d7b4"],
      spot: { color: "#c1553b", u: 0.31, v: 0.62, ru: 0.06, rv: 0.035 },
    },
  },
  {
    id: "saturn", name: "Saturn", texture: "/world-map/saturn.jpg",
    radius: 7.1, angle: 152, distance: 62, y: -2.5, tiltDeg: 26.7, spin: 0.085, focusFactor: 6.4,
    fallback: { base: "#d8c290", bands: ["#cdb47e", "#e4d3a6", "#c2a670", "#e9dcb8"] },
    ring: { inner: 1.24, outer: 2.35, texture: "/world-map/saturn-ring.png", opacity: 0.96, tint: "#d9c8a3" },
  },
  {
    id: "uranus", name: "Uranus", texture: "/world-map/uranus.jpg",
    radius: 4.69, angle: -160, distance: 74, y: 4, tiltDeg: 97.8, spin: -0.062, focusFactor: 5.4,
    fallback: { base: "#9fd7dd", bands: ["#a9dde2"] },
    ring: { inner: 1.6, outer: 1.95, opacity: 0.25, tint: "#cfe9ee" },
  },
  {
    id: "neptune", name: "Neptune", texture: "/world-map/neptune.jpg",
    radius: 4.62, angle: -20, distance: 86, y: -3.5, tiltDeg: 28.3, spin: 0.058,
    fallback: { base: "#2f5bd6", bands: ["#2a4fbd", "#3f6ee0"], spot: { color: "#1f3a8f", u: 0.6, v: 0.42, ru: 0.05, rv: 0.03 } },
  },
];

export const PLANET_IDS = PLANETS.map((planet) => planet.id);

export function findPlanet(id: string): PlanetSpec | undefined {
  return PLANETS.find((planet) => planet.id === id);
}

export function planetWorldPosition(spec: PlanetSpec): Vec3 {
  const bearing = spec.angle * Math.PI / 180;
  return { x: spec.distance * Math.cos(bearing), y: spec.y, z: spec.distance * Math.sin(bearing) };
}

// Camera distance that frames the planet (and its rings) inside the existing
// 42° field of view. Earth reuses the live globe's calibrated distance so
// focusing it restores the exact original view.
export function focusDistanceFor(spec: PlanetSpec, earthDistance = 11.8): number {
  if (spec.id === "earth") return earthDistance;
  return Math.max(6.5, spec.radius * (spec.focusFactor ?? 4.3));
}

// Wheel-zoom clamps around the focused planet, mirroring how the Earth view
// clamps between its minimum distance and 17.
export function focusBoundsFor(
  spec: PlanetSpec,
  earthBounds: { min: number; max: number } = { min: 9.6, max: 17 },
  earthDistance = 11.8,
): { min: number; max: number } {
  if (spec.id === "earth") return earthBounds;
  const focus = focusDistanceFor(spec, earthDistance);
  return { min: spec.radius * 2.1, max: focus * 2.2 };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export type FocusState = { target: Vec3; position: Vec3 };
export type FocusTween = { from: FocusState; to: FocusState; duration: number };

// End state for a focus request: the camera keeps its current viewing side
// (direction from the new target to the camera's present position) and settles
// at the planet's framing distance, so every switch is a smooth dolly rather
// than a teleport to a canned angle.
export function focusEndState(current: FocusState, planetPosition: Vec3, focusDistance: number): FocusState {
  const offset = subtract(current.position, planetPosition);
  const away = length(offset);
  const direction = away > 1e-6
    ? { x: offset.x / away, y: offset.y / away, z: offset.z / away }
    : { x: 0, y: 0.02, z: 1 };
  return {
    target: { ...planetPosition },
    position: {
      x: planetPosition.x + direction.x * focusDistance,
      y: planetPosition.y + direction.y * focusDistance,
      z: planetPosition.z + direction.z * focusDistance,
    },
  };
}

// Duration scales with travel so hopping Mars→Earth feels tight while
// Mercury→Neptune gets time to read as a journey. Deterministic: the caller
// owns the clock (the animation loop in the app, plain numbers in tests).
export function createFocusTween(from: FocusState, to: FocusState): FocusTween {
  const travel = length(subtract(to.position, from.position));
  const duration = Math.min(2400, Math.max(900, 700 + travel * 14));
  return { from: { target: { ...from.target }, position: { ...from.position } }, to, duration };
}

export function sampleFocusTween(tween: FocusTween, elapsedMs: number): FocusState & { done: boolean } {
  const t = Math.min(1, Math.max(0, elapsedMs / tween.duration));
  const eased = t * t * (3 - 2 * t);
  return {
    target: lerpVec3(tween.from.target, tween.to.target, eased),
    position: lerpVec3(tween.from.position, tween.to.position, eased),
    done: t >= 1,
  };
}

// Roving keyboard selection for the planet selector: arrows wrap in both
// directions so the listbox never dead-ends.
export function nextPlanetIndex(index: number, delta: number, count = PLANETS.length): number {
  return ((index + delta) % count + count) % count;
}
