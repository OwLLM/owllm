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
  createOrbitClock, advanceOrbitClock,
  ASTRONOMICAL_PLANETS, REAL_SYSTEM_OUTER_DISTANCE, REAL_UNITS_PER_KM, SUN_RADIUS_KM,
  planetOrbitDistance, planetRadiusAtScale, sunRadiusAtScale, stepSolarScaleProgress,
  SOLAR_SCALE_STORAGE_KEY, readSolarScaleMode, saveSolarScaleMode,
} = solar;

const distance = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const positionOf = (spec, elapsedSeconds = 0) => planetWorldPosition(spec, elapsedSeconds);

try {
  // ---- Catalog ------------------------------------------------------------
  check("Catalog holds all eight planets in solar order",
    PLANET_IDS.join(",") === "mercury,venus,earth,mars,jupiter,saturn,uranus,neptune");
  check("Planet ids are unique", new Set(PLANET_IDS).size === 8);
  check("Sun anchors the system while Earth keeps its calibrated display radius",
    findPlanet("earth").distance > 0 && findPlanet("earth").radius === 2.35);
  check("All eight orbit radii increase in astronomical order",
    PLANETS.every((planet, index) => index === 0 || planet.distance > PLANETS[index - 1].distance));
  check("Stylized orbital speeds decrease from Mercury through Neptune",
    PLANETS.every((planet, index) => index === 0 || planet.orbitSpeed < PLANETS[index - 1].orbitSpeed));
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

  // ---- True astronomical scale -------------------------------------------
  check("Real-scale Neptune remains at the canvas outer radius",
    Math.abs(planetOrbitDistance(findPlanet("neptune"), 1) - REAL_SYSTEM_OUTER_DISTANCE) < 1e-9);
  check("Real-scale orbital ratios use one physical kilometers-to-units factor", (() => {
    const mercury = planetOrbitDistance(findPlanet("mercury"), 1);
    const earth = planetOrbitDistance(findPlanet("earth"), 1);
    return Math.abs(earth / mercury - ASTRONOMICAL_PLANETS.earth.orbitKm / ASTRONOMICAL_PLANETS.mercury.orbitKm) < 1e-12
      && Math.abs(REAL_UNITS_PER_KM * ASTRONOMICAL_PLANETS.earth.orbitKm - earth) < 1e-12;
  })());
  check("Real-scale planet radii preserve physical size ratios", (() => {
    const jupiter = planetRadiusAtScale(findPlanet("jupiter"), 1);
    const earth = planetRadiusAtScale(findPlanet("earth"), 1);
    return Math.abs(jupiter / earth - ASTRONOMICAL_PLANETS.jupiter.radiusKm / ASTRONOMICAL_PLANETS.earth.radiusKm) < 1e-12;
  })());
  check("Sun and planets share the same true-scale conversion", (() => {
    const earth = planetRadiusAtScale(findPlanet("earth"), 1);
    return Math.abs(sunRadiusAtScale(1) / earth - SUN_RADIUS_KM / ASTRONOMICAL_PLANETS.earth.radiusKm) < 1e-12;
  })());
  check("Real scale honestly makes Earth tiny against its orbit",
    planetRadiusAtScale(findPlanet("earth"), 1) / planetOrbitDistance(findPlanet("earth"), 1) < 0.000_05);

  let scaleProgress = 0;
  for (let frame = 0; frame < 240; frame++) {
    scaleProgress = stepSolarScaleProgress(scaleProgress, 1, 1 / 60);
  }
  check("Real-size toggle animates smoothly to the physical representation",
    scaleProgress === 1 || scaleProgress > 0.999);
  for (let frame = 0; frame < 240; frame++) {
    scaleProgress = stepSolarScaleProgress(scaleProgress, 0, 1 / 60);
  }
  check("Turning real size off smoothly returns to the graphic representation",
    scaleProgress === 0 || scaleProgress < 0.001);
  check("Reduced-motion scale switching is immediate",
    stepSolarScaleProgress(0, 1, 1 / 60, true) === 1
    && stepSolarScaleProgress(1, 0, 1 / 60, true) === 0);

  const persisted = new Map();
  const storage = {
    getItem: (key) => persisted.get(key) ?? null,
    setItem: (key, value) => persisted.set(key, value),
  };
  check("Scale mode defaults safely to graphic", readSolarScaleMode(storage) === "graphic");
  saveSolarScaleMode("real", storage);
  check("Real-size preference persists and reloads",
    persisted.get(SOLAR_SCALE_STORAGE_KEY) === "real" && readSolarScaleMode(storage) === "real");
  saveSolarScaleMode("graphic", storage);
  check("Graphic preference persists after toggling real size off",
    readSolarScaleMode(storage) === "graphic");

  // ---- Placement geometry -------------------------------------------------
  for (const spec of PLANETS) {
    const pos = planetWorldPosition(spec);
    check(`${spec.id} sits on a visible compressed orbit`,
      finite(pos) && distance(pos, { x: 0, y: 0, z: 0 }) >= 10 && distance(pos, { x: 0, y: 0, z: 0 }) <= 130);
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

    // A click during orbital animation freezes at the CURRENT moving position,
    // then the same focus math must center and frame that body.
    const movingPosition = positionOf(spec, 17.5);
    const movingEnd = focusEndState(earthView, movingPosition, focusDistanceFor(spec));
    check(`${spec.id} click still centers its animated orbital position`,
      distance(movingEnd.target, movingPosition) < 1e-9
      && Math.abs(distance(movingEnd.position, movingPosition) - focusDistanceFor(spec)) < 1e-6);
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
    distance(state.target, positionOf(findPlanet("earth"))) < 1e-9
    && Math.abs(distance(state.position, positionOf(findPlanet("earth"))) - 11.8) < 1e-6);
  // Interrupt every leg at 40% and immediately retarget the next planet.
  for (const id of PLANET_IDS) flyTo(id, 0.4);
  const finalLeg = flyTo("neptune");
  check("Mid-flight retargeting through all planets still converges",
    finalLeg.done && distance(state.target, planetWorldPosition(findPlanet("neptune"))) < 1e-9
    && Math.abs(distance(state.position, planetWorldPosition(findPlanet("neptune"))) - focusDistanceFor(findPlanet("neptune"))) < 1e-6);

  // ---- Orbital clock: movement, pause, and resume -------------------------
  let orbitClock = createOrbitClock(1_000);
  orbitClock = advanceOrbitClock(orbitClock, 2_000, true);
  const runningElapsed = orbitClock.elapsedSeconds;
  const mercuryStart = positionOf(findPlanet("mercury"), 0);
  const mercuryMoved = positionOf(findPlanet("mercury"), runningElapsed);
  check("Running orbital mode advances planet positions", runningElapsed > 0 && distance(mercuryStart, mercuryMoved) > 0.1);
  orbitClock = advanceOrbitClock(orbitClock, 7_000, false);
  check("Paused orbital mode freezes elapsed orbital time", orbitClock.elapsedSeconds === runningElapsed);
  orbitClock = advanceOrbitClock(orbitClock, 7_050, true);
  check("Resuming advances smoothly without catching up the paused duration",
    orbitClock.elapsedSeconds > runningElapsed && orbitClock.elapsedSeconds - runningElapsed <= 0.051);

  for (const modeProgress of [0, 1]) {
    const modeLabel = modeProgress === 1 ? "real" : "graphic";
    for (const spec of PLANETS) {
      const atStart = planetWorldPosition(spec, 0, modeProgress);
      const whileOrbiting = planetWorldPosition(spec, 3.5, modeProgress);
      const focus = focusDistanceFor(spec, 11.8, modeProgress);
      const end = focusEndState(earthView, whileOrbiting, focus);
      check(`${spec.id} keeps orbiting in ${modeLabel} scale`,
        finite(whileOrbiting) && distance(atStart, whileOrbiting) > 0);
      check(`${spec.id} selection centers and zooms correctly in ${modeLabel} scale`,
        distance(end.target, whileOrbiting) < 1e-9
        && Math.abs(distance(end.position, whileOrbiting) - focus) < 1e-8);
    }
  }

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
  check("Canvas hosts the selector and real-size toggle together in its top-left corner",
    page.includes('data-ui="WorldMap:solar-controls"')
    && /data-ui="WorldMap:solar-controls"[\s\S]{0,460}?position: "absolute", zIndex: 2, top: 13,[\s\S]{0,60}?left: 13/.test(page)
    && page.includes('data-ui="WorldMap:planets"')
    && page.includes('data-ui="WorldMap:real-scale"'));
  check("Selector is a keyboard-accessible listbox",
    page.includes('role="listbox"') && page.includes("onKeyDown={onSelectorKeyDown}")
    && page.includes('aria-selected={focusedPlanet === planet.id}')
    && page.includes('event.key === "ArrowDown"') && page.includes('event.key === "Home"'));
  check("Selector renders every planet from the shared catalog", page.includes("PLANETS.map((planet, index)"));
  check("Planet clicks reuse the Earth focus/zoom machinery",
    page.includes("focusApiRef.current?.focus(id)")
    && page.includes("focusDistanceFor(spec, earthDistance, requestedScale)")
    && page.includes("focusBoundsFor(spec, { min: earthMin, max: 17 }, earthDistance, requestedScale)"));
  // Pins the GUARANTEE (a lit Sun at the centre), not one lighting implementation.
  // The previous form required `new THREE.PointLight(0xfff2d0` — that exact light
  // was removed when the scene moved to an Ambient + Directional lighting model
  // with named intensity constants, which left this cell red on a Sun that still
  // renders perfectly (MeshBasicMaterial is self-lit, plus glow shells). Assert
  // the sun body, a self-lit material, and scene lighting instead.
  check("Canvas renders a visible Sun at the system center",
    page.includes('sun.userData.solarBody = "sun"')
    && /new THREE\.Mesh\(\s*new THREE\.SphereGeometry\([\s\S]{0,80}new THREE\.MeshBasicMaterial/.test(page)
    && /new THREE\.(AmbientLight|PointLight|DirectionalLight)\(/.test(page)
    && page.includes("const solarOrbitLines: { spec: PlanetSpec; line: THREE.LineLoop }[] = []"));
  check("Every planet anchor advances from the shared orbital clock",
    page.includes("orbitClock = advanceOrbitClock(orbitClock, now, orbitRunningRef.current)")
    && page.includes("planetWorldPosition(spec, orbitClock.elapsedSeconds, scaleProgress)")
    && page.includes("anchor.position.set(position.x, position.y, position.z)")
    && page.includes("anchor.scale.setScalar(planetRadiusAtScale(spec, scaleProgress) / spec.radius)"));
  check("Earth carries its world and fleet markers around the Sun",
    page.includes("const earthAnchor = new THREE.Group()")
    && page.includes("earthAnchor.add(earthGroup)")
    && page.includes("earthAnchor.add(mesh)")
    && page.includes("earthAnchor.add(ring)"));
  check("Planet focus pauses orbital motion before reusing focus/zoom",
    /const focusPlanet = \(id: string, requestedScale = scaleTarget\) => \{[\s\S]{0,320}?orbitRunningRef\.current = false;[\s\S]{0,650}?planetWorldPosition\(spec, orbitClock\.elapsedSeconds, requestedScale\)/.test(page));
  check("Orbit control exposes pause/resume and a Sun-centered overview",
    page.includes("aria-pressed={orbitRunning}")
    && page.includes("onClick={toggleOrbits}")
    && page.includes("focusApiRef.current?.overview()")
    && page.includes("SYSTEM_OVERVIEW_DISTANCE"));
  check("Reduced-motion preference starts and keeps orbital animation stopped",
    page.includes('window.matchMedia("(prefers-reduced-motion: reduce)")')
    && page.includes("if (media.matches) setOrbitRunning(false)")
    && page.includes("controls.autoRotate = orbitRunningRef.current"));
  check("Real-size toggle is labeled, keyboard-accessible, and announces the tiny-body consequence",
    page.includes('aria-label={t("Real size")}')
    && page.includes('aria-pressed={scaleMode === "real"}')
    && page.includes("onClick={toggleScaleMode}")
    && page.includes("True scale: planets are tiny and far apart. Use the selector to focus."));
  check("Scale preference loads and persists through the shared storage helpers",
    page.includes("readSolarScaleMode(typeof window")
    && page.includes("saveSolarScaleMode(scaleMode, window.localStorage)"));
  check("Scale morph updates bodies, orbits, Sun, and focused camera without rebuilding the scene",
    page.includes("stepSolarScaleProgress(")
    && page.includes("line.scale.set(distance, planetOrbitHeight(spec, scaleProgress), distance)")
    && page.includes("sunRadiusAtScale(scaleProgress)")
    && page.includes("focusApiRef.current?.setScaleMode(scaleMode)"));
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
    /focusTween = null;[\s\S]{0,500}?onPlanetFocusRef\.current\?\.\("earth"\)/.test(page));
  check("Star shell and far plane enclose the outer planets",
    page.includes("const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 900)") && page.includes("const radius = 180 + (i % 23) * 3.9"));

  const actions = read("localization/catalog.actions.ts");
  check("Planet names ship all eight locales",
    ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Solar System"]
      .every((name) => new RegExp(`\\["${name}",(?:[^\\]]*,){6}[^\\]]*\\]`).test(actions)));

  for (const row of checks) console.log(`  PASS ${row.name}`);
  console.log(`solar system verification: ${checks.length}/${checks.length} passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
