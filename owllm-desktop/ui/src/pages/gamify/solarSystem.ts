// Solar System catalog + pure focus/zoom math for the World Map explorer.
//
// The Sun stays at the scene origin. All eight planets use compressed display
// orbits: order and relative speed remain astronomically truthful while spacing
// is stylized so the complete system remains readable in one WebGL canvas.
//
// This module deliberately has no three.js or DOM dependency: the interaction
// verifier transpiles it and drives every planet switch in plain Node.

export type Vec3 = { x: number; y: number; z: number };
export type PlanetId = "mercury" | "venus" | "earth" | "mars" | "jupiter" | "saturn" | "uranus" | "neptune";
export type SolarScaleMode = "graphic" | "real";

type SolarScaleStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const SOLAR_SCALE_STORAGE_KEY = "owllm.world-map.solar-scale";

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
  id: PlanetId;
  name: string; // English label — localized with t() at render time
  texture: string | null; // null → Earth keeps its dedicated photographic layers
  radius: number; // display radius; Earth = 2.35 matches the live globe
  angle: number; // initial orbital phase around the Sun (degrees)
  distance: number; // compressed display orbit radius from the Sun
  y: number; // orbital inclination amplitude in display units
  orbitSpeed: number; // stylized angular speed (rad/s), inner planets are faster
  tiltDeg: number; // axial tilt (Venus retrograde, Uranus sideways)
  spin: number; // display self-rotation speed (rad/s, sign = direction)
  focusFactor?: number; // camera framing multiple of radius (rings need more room)
  fallback: PlanetFallback;
  ring?: PlanetRing;
};

export type AstronomicalPlanetData = {
  radiusKm: number;
  orbitKm: number;
  inclinationDeg: number;
};

// NASA mean radii and semi-major axes. Real mode uses one shared conversion
// factor for every radius and distance, so the resulting ratios are physical,
// not a second hand-tuned illustration. Neptune stays at the readable edge of
// the existing canvas; the consequence is intentionally dramatic: the Sun and
// planets become tiny and the inner system bunches close to the center.
export const ASTRONOMICAL_PLANETS: Record<PlanetId, AstronomicalPlanetData> = {
  mercury: { radiusKm: 2_439.7, orbitKm: 57_909_050, inclinationDeg: 7.005 },
  venus: { radiusKm: 6_051.8, orbitKm: 108_208_000, inclinationDeg: 3.395 },
  earth: { radiusKm: 6_371, orbitKm: 149_598_023, inclinationDeg: 0 },
  mars: { radiusKm: 3_389.5, orbitKm: 227_939_200, inclinationDeg: 1.85 },
  jupiter: { radiusKm: 69_911, orbitKm: 778_570_000, inclinationDeg: 1.303 },
  saturn: { radiusKm: 58_232, orbitKm: 1_433_529_000, inclinationDeg: 2.485 },
  uranus: { radiusKm: 25_362, orbitKm: 2_872_463_000, inclinationDeg: 0.773 },
  neptune: { radiusKm: 24_622, orbitKm: 4_495_060_000, inclinationDeg: 1.77 },
};

export const SUN_RADIUS_KM = 695_700;
export const GRAPHIC_SUN_RADIUS = 5.2;
export const REAL_SYSTEM_OUTER_DISTANCE = 125;
export const REAL_UNITS_PER_KM = REAL_SYSTEM_OUTER_DISTANCE / ASTRONOMICAL_PLANETS.neptune.orbitKm;

// Solar order. Radii are sqrt-compressed relative to Earth's 2.35 display units
// so the gas giants stay clearly giant without dwarfing the whole scene.
export const PLANETS: PlanetSpec[] = [
  {
    id: "mercury", name: "Mercury", texture: "/world-map/mercury.jpg",
    radius: 1.45, angle: -125, distance: 12, y: 0.3, orbitSpeed: 0.28, tiltDeg: 0.03, spin: 0.004,
    fallback: { base: "#8a8378", bands: ["#7c7568", "#948d80"], craters: 90 },
  },
  {
    id: "venus", name: "Venus", texture: "/world-map/venus.jpg",
    radius: 2.29, angle: -62, distance: 20, y: 0.5, orbitSpeed: 0.22, tiltDeg: 177.4, spin: -0.003,
    fallback: { base: "#d9b96e", bands: ["#e6cd8f", "#caa75c", "#e0c07a"] },
  },
  {
    id: "earth", name: "Earth", texture: null,
    radius: 2.35, angle: 0, distance: 29, y: 0, orbitSpeed: 0.18, tiltDeg: 23.4, spin: 0.018,
    fallback: { base: "#2a63c4", bands: ["#2f7d4f", "#35935e"], caps: "#e8f2fa" },
  },
  {
    id: "mars", name: "Mars", texture: "/world-map/mars.jpg",
    radius: 1.71, angle: 38, distance: 40, y: 0.8, orbitSpeed: 0.15, tiltDeg: 25.2, spin: 0.02,
    fallback: { base: "#b6552e", bands: ["#8f3f22", "#c46a3d"], caps: "#e8e2d9", craters: 40 },
  },
  {
    id: "jupiter", name: "Jupiter", texture: "/world-map/jupiter.jpg",
    radius: 7.78, angle: 96, distance: 58, y: 1.2, orbitSpeed: 0.11, tiltDeg: 3.1, spin: 0.09,
    fallback: {
      base: "#c8a97e",
      bands: ["#b98f63", "#e3cfa8", "#a97c52", "#d9bd92", "#8f6a48", "#e8d7b4"],
      spot: { color: "#c1553b", u: 0.31, v: 0.62, ru: 0.06, rv: 0.035 },
    },
  },
  {
    id: "saturn", name: "Saturn", texture: "/world-map/saturn.jpg",
    radius: 7.1, angle: 152, distance: 82, y: 1.5, orbitSpeed: 0.085, tiltDeg: 26.7, spin: 0.085, focusFactor: 6.4,
    fallback: { base: "#d8c290", bands: ["#cdb47e", "#e4d3a6", "#c2a670", "#e9dcb8"] },
    ring: { inner: 1.24, outer: 2.35, texture: "/world-map/saturn-ring.png", opacity: 0.96, tint: "#d9c8a3" },
  },
  {
    id: "uranus", name: "Uranus", texture: "/world-map/uranus.jpg",
    radius: 4.69, angle: -160, distance: 104, y: 2.2, orbitSpeed: 0.066, tiltDeg: 97.8, spin: -0.062, focusFactor: 5.4,
    fallback: { base: "#9fd7dd", bands: ["#a9dde2"] },
    ring: { inner: 1.6, outer: 1.95, opacity: 0.25, tint: "#cfe9ee" },
  },
  {
    id: "neptune", name: "Neptune", texture: "/world-map/neptune.jpg",
    radius: 4.62, angle: -20, distance: 125, y: 2.6, orbitSpeed: 0.054, tiltDeg: 28.3, spin: 0.058,
    fallback: { base: "#2f5bd6", bands: ["#2a4fbd", "#3f6ee0"], spot: { color: "#1f3a8f", u: 0.6, v: 0.42, ru: 0.05, rv: 0.03 } },
  },
];

export const PLANET_IDS = PLANETS.map((planet) => planet.id);

export function findPlanet(id: string): PlanetSpec | undefined {
  return PLANETS.find((planet) => planet.id === id);
}

function clampScaleProgress(progress: number): number {
  return Math.min(1, Math.max(0, progress));
}

// Geometric interpolation is visually smooth across the five orders of
// magnitude between the graphic bodies and their real-scale counterparts.
function interpolateMagnitude(graphic: number, real: number, progress: number): number {
  const t = clampScaleProgress(progress);
  if (t === 0) return graphic;
  if (t === 1) return real;
  return Math.exp(Math.log(graphic) + (Math.log(real) - Math.log(graphic)) * t);
}

export function planetOrbitDistance(spec: PlanetSpec, scaleProgress = 0): number {
  const real = ASTRONOMICAL_PLANETS[spec.id].orbitKm * REAL_UNITS_PER_KM;
  return interpolateMagnitude(spec.distance, real, scaleProgress);
}

export function planetRadiusAtScale(spec: PlanetSpec, scaleProgress = 0): number {
  const real = ASTRONOMICAL_PLANETS[spec.id].radiusKm * REAL_UNITS_PER_KM;
  return interpolateMagnitude(spec.radius, real, scaleProgress);
}

export function planetOrbitHeight(spec: PlanetSpec, scaleProgress = 0): number {
  const distance = planetOrbitDistance(spec, scaleProgress);
  const real = distance * Math.sin(ASTRONOMICAL_PLANETS[spec.id].inclinationDeg * Math.PI / 180);
  if (spec.y === 0 && real === 0) return 0;
  return interpolateMagnitude(Math.max(spec.y, 0.000_001), Math.max(real, 0.000_001), scaleProgress);
}

export function sunRadiusAtScale(scaleProgress = 0): number {
  return interpolateMagnitude(GRAPHIC_SUN_RADIUS, SUN_RADIUS_KM * REAL_UNITS_PER_KM, scaleProgress);
}

export function planetWorldPosition(spec: PlanetSpec, elapsedSeconds = 0, scaleProgress = 0): Vec3 {
  const bearing = spec.angle * Math.PI / 180 + elapsedSeconds * spec.orbitSpeed;
  const distance = planetOrbitDistance(spec, scaleProgress);
  const height = planetOrbitHeight(spec, scaleProgress);
  return {
    x: distance * Math.cos(bearing),
    y: height * Math.sin(bearing),
    z: distance * Math.sin(bearing),
  };
}

// Frame-rate-independent transition helper. Reduced-motion users get the final
// state immediately instead of an animated scale flight.
export function stepSolarScaleProgress(
  current: number,
  target: number,
  deltaSeconds: number,
  reducedMotion = false,
): number {
  const destination = clampScaleProgress(target);
  if (reducedMotion) return destination;
  const next = current + (destination - current) * (1 - Math.exp(-Math.max(0, deltaSeconds) / 0.34));
  return Math.abs(destination - next) < 0.000_5 ? destination : next;
}

export function readSolarScaleMode(storage?: SolarScaleStorage): SolarScaleMode {
  try {
    return storage?.getItem(SOLAR_SCALE_STORAGE_KEY) === "real" ? "real" : "graphic";
  } catch {
    return "graphic";
  }
}

export function saveSolarScaleMode(mode: SolarScaleMode, storage?: SolarScaleStorage): void {
  try {
    storage?.setItem(SOLAR_SCALE_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in privacy-restricted WebViews. The current
    // session still works; persistence simply falls back to the graphic mode.
  }
}

export type OrbitClock = { elapsedSeconds: number; lastTimeMs: number };

export function createOrbitClock(nowMs = 0): OrbitClock {
  return { elapsedSeconds: 0, lastTimeMs: nowMs };
}

// Deterministic pause/resume clock. Paused frames still advance lastTimeMs so
// resuming never catches up with a jump after a long stop.
export function advanceOrbitClock(clock: OrbitClock, nowMs: number, running: boolean): OrbitClock {
  const deltaSeconds = Math.max(0, Math.min(0.1, (nowMs - clock.lastTimeMs) / 1000));
  return {
    elapsedSeconds: clock.elapsedSeconds + (running ? deltaSeconds : 0),
    lastTimeMs: nowMs,
  };
}

// Camera distance that frames the planet (and its rings) inside the existing
// 42° field of view. Earth reuses the live globe's calibrated distance so
// focusing it restores the exact original view.
export function focusDistanceFor(spec: PlanetSpec, earthDistance = 11.8, scaleProgress = 0): number {
  const graphic = spec.id === "earth"
    ? earthDistance
    : Math.max(6.5, spec.radius * (spec.focusFactor ?? 4.3));
  const real = planetRadiusAtScale(spec, 1) * (spec.focusFactor ?? 4.3);
  return interpolateMagnitude(graphic, real, scaleProgress);
}

// Wheel-zoom clamps around the focused planet, mirroring how the Earth view
// clamps between its minimum distance and 17.
export function focusBoundsFor(
  spec: PlanetSpec,
  earthBounds: { min: number; max: number } = { min: 9.6, max: 17 },
  earthDistance = 11.8,
  scaleProgress = 0,
): { min: number; max: number } {
  const graphicFocus = focusDistanceFor(spec, earthDistance, 0);
  const graphic = spec.id === "earth"
    ? earthBounds
    : { min: spec.radius * 2.1, max: graphicFocus * 2.2 };
  const realRadius = planetRadiusAtScale(spec, 1);
  const realFocus = focusDistanceFor(spec, earthDistance, 1);
  const real = {
    min: realRadius * Math.max(2.1, (spec.ring?.outer ?? 1) + 0.35),
    max: realFocus * 2.2,
  };
  return {
    min: interpolateMagnitude(graphic.min, real.min, scaleProgress),
    max: interpolateMagnitude(graphic.max, real.max, scaleProgress),
  };
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
