// Solar System explorer verification: drives the real focus/zoom logic through
// every planet (including repeated and mid-flight switching) and pins the
// WorldMapPage wiring — selector, fallbacks, keyboard access, bundled assets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const UI = path.resolve(HERE, "../..");
const read = (relative) => fs.readFileSync(path.join(UI, relative), "utf8").replace(/\r\n/g, "\n");
const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(`FAIL ${name}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-solar-system-"));
const source = read("pages/gamify/solarSystem.ts");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = path.join(temp, "solarSystem.mjs");
fs.writeFileSync(modulePath, compiled);
const solar = await import(pathToFileURL(modulePath).href);

const {
  PLANETS, PLANET_IDS, findPlanet, planetWorldPosition,
  focusDistanceFor, focusBoundsFor, focusEndState, createFocusTween, sampleFocusTween, nextPlanetIndex,
} = solar;

const distance = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const positionOf = (spec) => spec.id === "earth" ? { x: 0, y: 0, z: 0 } : planetWorldPosition(spec);

try {
  // ---- Catalog ------------------------------------------------------------
  check("Catalog holds all eight planets in solar order",
    PLANET_IDS.join(",") === "mercury,venus,earth,mars,jupiter,saturn,uranus,neptune");
  check("Planet ids are unique", new Set(PLANET_IDS).size === 8);
  check("Earth anchors the scene origin", findPlanet("earth").distance === 0 && findPlanet("earth").radius === 2.35);
  check("Size order stays truthful (gas giants down to Mercury)", (() => {
    const r = Object.fromEntries(PLANETS.map((p) => [p.id, p.radius]));
    return r.jupiter > r.saturn && r.saturn > r.uranus && r.uranus >= r.neptune
      && r.neptune > r.earth && r.earth > r.venus && r.venus > r.mars && r.mars > r.mercury;
  })());
  check("Every planet carries a procedural fallback recipe",
    PLANETS.every((p) => typeof p.fallback?.base === "string" && /^#[0-9a-f]{6}$/i.test(p.fallback.base)));
  check("Jupiter's fallback includes the Great Red Spot", Boolean(findPlanet("jupiter").fallback.spot));
  check("Mars' fallback includes polar caps and craters",
    Boolean(findPlanet("mars").fallback.caps) && findPlanet("mars").fallback.craters > 0);
  check("Saturn has a textured ring; Uranus a faint one",
    findPlanet("saturn").ring?.texture === "/world-map/saturn-ring.png" && Boolean(findPlanet("uranus").ring) && !findPlanet("uranus").ring.texture);
  check("Uranus rolls on its side; Venus is retrograde",
    findPlanet("uranus").tiltDeg > 90 && findPlanet("venus").spin < 0);

  // ---- Placement geometry -------------------------------------------------
  for (const spec of PLANETS) {
    if (spec.id === "earth") continue;
    const pos = planetWorldPosition(spec);
    check(`${spec.id} sits in reachable deep space`, finite(pos) && distance(pos, { x: 0, y: 0, z: 0 }) >= 18 && distance(pos, { x: 0, y: 0, z: 0 }) <= 90);
  }
  for (let i = 0; i < PLANETS.length; i++) {
    for (let j = i + 1; j < PLANETS.length; j++) {
      const a = PLANETS[i]; const b = PLANETS[j];
      const gap = distance(positionOf(a), positionOf(b));
      check(`${a.id} and ${b.id} never crowd each other's focused view`,
        gap > focusDistanceFor(a) * 0.9 + b.radius && gap > a.radius + b.radius + 8);
    }
  }

  // ---- Focus framing ------------------------------------------------------
  check("Earth focus reuses the calibrated world distance", focusDistanceFor(findPlanet("earth")) === 11.8 && focusDistanceFor(findPlanet("earth"), 13.2) === 13.2);
  check("Earth zoom clamps pass through unchanged", (() => {
    const bounds = focusBoundsFor(findPlanet("earth"), { min: 9.6, max: 17 });
    return bounds.min === 9.6 && bounds.max === 17;
  })());
  for (const spec of PLANETS) {
    if (spec.id === "earth") continue;
    const focus = focusDistanceFor(spec);
    const bounds = focusBoundsFor(spec);
    check(`${spec.id} framing keeps the camera outside the body with room to zoom`,
      focus > spec.radius * 2 && bounds.min > spec.radius && bounds.min < focus && bounds.max > focus);
    const ringOuter = spec.ring ? spec.radius * spec.ring.outer : spec.radius;
    check(`${spec.id} focus frames the full body and rings in the 42° view`,
      focus * Math.tan(21 * Math.PI / 180) >= ringOuter * 0.98);
  }

  // ---- Interaction: focusing every planet from the default Earth view -----
  const earthView = { target: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0.24, z: 11.8 } };
  for (const spec of PLANETS) {
    const planetPos = positionOf(spec);
    const end = focusEndState(earthView, planetPos, focusDistanceFor(spec));
    check(`${spec.id} focus centers the camera on the planet`,
      distance(end.target, planetPos) < 1e-9 && Math.abs(distance(end.position, planetPos) - focusDistanceFor(spec)) < 1e-6);
    const tween = createFocusTween(earthView, end);
    const start = sampleFocusTween(tween, 0);
    const mid = sampleFocusTween(tween, tween.duration / 2);
    const landed = sampleFocusTween(tween, tween.duration);
    check(`${spec.id} flight starts where the camera is and lands on the planet`,
      distance(start.position, earthView.position) < 1e-9 && !start.done
      && landed.done && distance(landed.target, planetPos) < 1e-9
      && finite(mid.target) && finite(mid.position));
    // Smoothstep is monotone: the midpoint must lie inside the travel bounds.
    for (const axis of ["x", "y", "z"]) {
      const low = Math.min(earthView.position[axis], end.position[axis]);
      const high = Math.max(earthView.position[axis], end.position[axis]);
      check(`${spec.id} flight stays inside its travel corridor on ${axis}`, mid.position[axis] >= low - 1e-9 && mid.position[axis] <= high + 1e-9);
    }
  }

  // ---- Interaction: repeated switching, exactly like the app drives it ----
  // Full solar tour out and back, then rapid Earth↔Mars hops, then mid-flight
  // retargeting at 40% of every leg: each switch starts from the CURRENT
  // interpolated camera state, mirroring focusPlanet() in WorldMapPage.
  let state = { target: { ...earthView.target }, position: { ...earthView.position } };
  const flyTo = (id, cutFraction = 1) => {
    const spec = findPlanet(id);
    const end = focusEndState(state, positionOf(spec), focusDistanceFor(spec));
    const tween = createFocusTween(state, end);
    const sampled = sampleFocusTween(tween, tween.duration * cutFraction);
    check(`flight toward ${id} stays numerically sound`, finite(sampled.target) && finite(sampled.position));
    state = { target: sampled.target, position: sampled.position };
    return sampled;
  };
  const tour = [...PLANET_IDS, ...[...PLANET_IDS].reverse(), "mars", "earth", "mars", "earth", "mars", "earth"];
  for (const id of tour) {
    const sampled = flyTo(id);
    check(`tour lands exactly on ${id}`, sampled.done && distance(state.target, positionOf(findPlanet(id))) < 1e-9);
  }
  check("Repeated switching returns home to Earth precisely",
    distance(state.target, { x: 0, y: 0, z: 0 }) < 1e-9 && Math.abs(distance(state.position, { x: 0, y: 0, z: 0 }) - 11.8) < 1e-6);
  // Interrupt every leg at 40% and immediately retarget the next planet.
  for (const id of PLANET_IDS) flyTo(id, 0.4);
  const finalLeg = flyTo("neptune");
  check("Mid-flight retargeting through all planets still converges",
    finalLeg.done && distance(state.target, planetWorldPosition(findPlanet("neptune"))) < 1e-9
    && Math.abs(distance(state.position, planetWorldPosition(findPlanet("neptune"))) - focusDistanceFor(findPlanet("neptune"))) < 1e-6);

  // ---- Keyboard navigation ------------------------------------------------
  check("Arrow navigation wraps in both directions",
    nextPlanetIndex(7, 1) === 0 && nextPlanetIndex(0, -1) === 7 && nextPlanetIndex(3, 1) === 4);
  let cursor = 0;
  const visited = new Set([PLANET_IDS[0]]);
  for (let step = 0; step < 7; step++) { cursor = nextPlanetIndex(cursor, 1); visited.add(PLANET_IDS[cursor]); }
  check("Arrow navigation reaches every planet", visited.size === 8);

  // ---- Bundled high-resolution assets -------------------------------------
  for (const spec of PLANETS) {
    if (!spec.texture) continue;
    const asset = path.join(UI, "../public/world-map", path.basename(spec.texture));
    check(`Bundled planet texture exists: ${path.basename(spec.texture)}`, fs.statSync(asset).size > 50_000);
  }
  check("Bundled Saturn ring strip exists", fs.statSync(path.join(UI, "../public/world-map/saturn-ring.png")).size > 5_000);
  check("Texture provenance documents the CC BY 4.0 planet set",
    read("../public/world-map/SOURCE.md").includes("solarsystemscope.com") && read("../public/world-map/SOURCE.md").includes("CC BY 4.0"));

  // ---- WorldMapPage wiring ------------------------------------------------
  const page = read("pages/gamify/WorldMapPage.tsx");
  check("Canvas hosts a readable planet selector in its top-left corner",
    page.includes('data-ui="WorldMap:planets"')
    && /data-ui="WorldMap:planets"[\s\S]{0,600}?position: "absolute", top: 13, left: 13/.test(page));
  check("Selector is a keyboard-accessible listbox",
    page.includes('role="listbox"') && page.includes("onKeyDown={onSelectorKeyDown}")
    && page.includes('aria-selected={focusedPlanet === planet.id}')
    && page.includes('event.key === "ArrowDown"') && page.includes('event.key === "Home"'));
  check("Selector renders every planet from the shared catalog", page.includes("PLANETS.map((planet, index)"));
  check("Planet clicks reuse the Earth focus/zoom machinery",
    page.includes("focusApiRef.current?.focus(id)")
    && page.includes("focusDistanceFor(spec, earthDistance)")
    && page.includes("focusBoundsFor(spec, { min: earthMin, max: 17 }, earthDistance)"));
  check("Focus flight animates target and camera each frame",
    page.includes("sampleFocusTween(focusTween, now - focusTweenStart)") && page.includes("if (!focusTween) controls.update();"));
  check("Scene still builds once per accent (selector cannot rebuild the renderer)",
    /}, \[accent\]\);/.test(page) && !/\[accent, focusedPlanet\]/.test(page));
  check("Planets ship loading + error fallbacks",
    page.includes("paintPlanetFallback(spec)")
    && page.includes('onTextureStatusRef.current?.(spec.id, "loading")')
    && page.includes('onTextureStatusRef.current?.(spec.id, "ready")')
    && page.includes('onTextureStatusRef.current?.(spec.id, "fallback")'));
  check("Selector surfaces the fallback state to the user",
    page.includes('textureStatus[planet.id] === "fallback"') && page.includes("Simplified view (texture failed to load)"));
  check("Saturn's ring samples its alpha strip radially", page.includes("remapRingUv(new THREE.RingGeometry("));
  check("Clicking a planet body in the canvas focuses it",
    page.includes("planetClickable") && page.includes("focusPlanet(hit.object.userData.planetId as string)"));
  check("Selecting a presence/fleet node flies the camera home to Earth",
    page.includes('if (focusedPlanet !== "earth") focusPlanet("earth")'));
  check("Mode reframing cancels an in-flight focus and returns to Earth",
    /focusTween = null;[\s\S]{0,220}?onPlanetFocusRef\.current\?\.\("earth"\)/.test(page));
  check("Star shell and far plane enclose the outer planets",
    page.includes("const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 520)") && page.includes("const radius = 120 + (i % 23) * 2.9"));

  const actions = read("localization/catalog.actions.ts");
  check("Planet names ship all eight locales",
    ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Solar System"]
      .every((name) => new RegExp(`\\["${name}",(?:[^\\]]*,){6}[^\\]]*\\]`).test(actions)));

  for (const row of checks) console.log(`  PASS ${row.name}`);
  console.log(`solar system verification: ${checks.length}/${checks.length} passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
