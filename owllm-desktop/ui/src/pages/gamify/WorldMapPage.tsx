import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject } from "react";
// three is bundled with OwLLM; the repository intentionally does not carry
// the optional @types package (same convention as TeamMemoryGraph).
// @ts-ignore: bundled dependency has no local declaration package
import * as THREE from "three";
// @ts-ignore: bundled Three.js example module
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useLocalization } from "../../localization";
import { isDeviceOnline } from "../advanced/deviceLiveness";
import { getIdentity, listDevices, type DeviceIdentity, type DeviceRecord } from "../advanced/remoteDevices";
import { isClickGesture, nodeSignature } from "./globeStability";
import {
  PLANETS,
  findPlanet,
  planetWorldPosition,
  focusDistanceFor,
  focusBoundsFor,
  focusEndState,
  createFocusTween,
  sampleFocusTween,
  nextPlanetIndex,
  createOrbitClock,
  advanceOrbitClock,
  planetOrbitDistance,
  planetOrbitHeight,
  planetRadiusAtScale,
  sunRadiusAtScale,
  stepSolarScaleProgress,
  readSolarScaleMode,
  saveSolarScaleMode,
  type FocusTween,
  type PlanetSpec,
  type SolarScaleMode,
} from "./solarSystem";
import {
  groupOnlinePresenceByCountry,
  includeSelfDevice,
  readWorldMapMode,
  saveWorldMapMode,
  subscribeWorldPresence,
  type PresenceOs,
  type PublicPresenceNode,
  type WorldMapMode,
} from "./worldPresence";

type OrbitParams = {
  radius: number;
  inclination: number;
  ascendingNode: number;
  phase: number;
  speed: number;
};

type GlobeNode = {
  id: string;
  label: string;
  detail: string;
  online: boolean;
  kind: "world" | "fleet";
  // World mode: surface coordinates from the presence service.
  latitude?: number;
  longitude?: number;
  // Fleet mode: each paired device is a private satellite in a stable orbit.
  orbit?: OrbitParams;
};

const EARTH_TEXTURES = {
  day: "/world-map/earth-day.jpg",
  normal: "/world-map/earth-normal.jpg",
  specular: "/world-map/earth-specular.jpg",
  clouds: "/world-map/earth-clouds.png",
} as const;

// Keep enough space around the globe that it reads as a world in space instead
// of filling/cropping against the panel edges. OrbitControls clamps accidental
// wheel zooms to these bounds, while fleet mode leaves extra room for satellites.
const WORLD_CAMERA_DISTANCE = 11.8;
const FLEET_CAMERA_DISTANCE = 13.2;
const SYSTEM_OVERVIEW_DISTANCE = 245;
const WORLD_MIN_DISTANCE = 9.6;
const FLEET_MIN_DISTANCE = 10.8;
const OS_DISPLAY_ORDER: PresenceOs[] = ["Windows", "macOS", "Linux", "Other"];

// Direction of the subsolar point (where the sun is directly overhead right now)
// in the globe mesh's LOCAL texture frame, so the day/night terminator tracks the
// real UTC clock. The equirectangular Earth map places longitude 0 at +X and the
// north pole at +Y (standard Three.js SphereGeometry UVs), giving:
//   dir = (cosφ·cosλ, sinφ, -cosφ·sinλ)   where φ = solar declination, λ = subsolar longitude.
function subsolarLocalDir(now: Date, target: THREE.Vector3): THREE.Vector3 {
  const dayMs = 86_400_000;
  const yearStart = Date.UTC(now.getUTCFullYear(), 0, 0);
  const dayOfYear = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - yearStart) / dayMs;
  // Seasonal declination (±23.44°), simple axial-tilt approximation.
  const decl = -23.44 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  // Subsolar longitude (east positive): sun over 0° at 12:00 UTC, +15°/hour westward.
  const subsolarLon = -(utcHours - 12) * 15;
  const phi = decl * Math.PI / 180;
  const lam = subsolarLon * Math.PI / 180;
  return target.set(
    Math.cos(phi) * Math.cos(lam),
    Math.sin(phi),
    -Math.cos(phi) * Math.sin(lam),
  );
}

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// Presence regions arrive as "US · CA" (ISO country code + coarse region).
// Render the country as its flag; the flag glyphs come from the bundled
// Twemoji Country Flags font because Windows has no native flag emoji.
function countryCodeToFlag(code: string): string {
  return String.fromCodePoint(...[...code.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

function regionWithFlag(region: string): string {
  const match = /^([A-Za-z]{2})(?:\s*·\s*(.+))?$/.exec(region.trim());
  if (!match) return region;
  const flag = countryCodeToFlag(match[1]);
  return match[2] ? `${flag} · ${match[2]}` : flag;
}

function fleetOrbit(id: string): OrbitParams {
  const h = hashNumber(id);
  const h2 = hashNumber(`${id}:orbit`);
  return {
    radius: 2.95 + ((h % 1000) / 1000) * 1.55,
    inclination: ((h % 160) - 80) * Math.PI / 180,
    ascendingNode: (h2 % 360) * Math.PI / 180,
    phase: ((h2 >>> 10) % 360) * Math.PI / 180,
    speed: (0.12 + ((h % 500) / 500) * 0.42) * (h % 2 === 0 ? 1 : -1),
  };
}

function latLonVector(latitude: number, longitude: number, radius: number) {
  const phi = (90 - latitude) * Math.PI / 180;
  const theta = (longitude + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function orbitPosition(orbit: OrbitParams, elapsed: number) {
  const theta = orbit.phase + orbit.speed * elapsed;
  const cosI = Math.cos(orbit.inclination);
  const sinI = Math.sin(orbit.inclination);
  const cosO = Math.cos(orbit.ascendingNode);
  const sinO = Math.sin(orbit.ascendingNode);
  const xp = orbit.radius * Math.cos(theta);
  const yp = orbit.radius * Math.sin(theta);
  const xpp = xp;
  const ypp = yp * cosI;
  const zpp = yp * sinI;
  return new THREE.Vector3(
    xpp * cosO + zpp * sinO,
    ypp,
    -xpp * sinO + zpp * cosO,
  );
}

function fleetWithSelf(identity: DeviceIdentity, devices: DeviceRecord[]): DeviceRecord[] {
  if (devices.some((device) => device.device_id === identity.device_id)) return devices;
  const self: DeviceRecord = {
    device_id: identity.device_id,
    name: identity.name,
    ed25519_pub: identity.ed25519_pub,
    x25519_pub: identity.x25519_pub,
    os: identity.os,
    arch: identity.arch,
    app_version: identity.app_version,
    github_login: identity.github_login,
    capabilities: identity.capabilities,
    endpoint: identity.endpoint,
    endpoints: identity.endpoints,
    p2p_node_id: identity.p2p_node_id,
    last_seen: new Date().toISOString(),
    is_self: true,
  };
  return includeSelfDevice(self, devices);
}

function satelliteLabel(text: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 112;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "700 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,.95)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "rgba(2,8,20,.84)";
  ctx.beginPath();
  ctx.roundRect(10, 10, 492, 92, 32);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.shadowBlur = 5;
  ctx.fillStyle = "#f4f8ff";
  ctx.fillText(text.slice(0, 24), 256, 57);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.18, 0.26, 1);
  return sprite;
}

// Deterministic pseudo-random stream so procedural planet fallbacks render the
// same craters/bands every launch (seeded from the planet id).
function seededRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

// Procedural equirectangular fallback for a planet: base tone, latitude bands,
// storm spot, polar caps, and craters per the catalog recipe. This is both the
// loading placeholder and the permanent error fallback, so every planet always
// shows its distinguishing features even fully offline.
function paintPlanetFallback(spec: PlanetSpec): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const random = seededRandom(hashNumber(spec.id));
  ctx.fillStyle = spec.fallback.base;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const bands = spec.fallback.bands ?? [];
  bands.forEach((color, index) => {
    const center = ((index + 0.5) / bands.length) * canvas.height;
    const thickness = canvas.height / bands.length * (0.55 + random() * 0.5);
    const gradient = ctx.createLinearGradient(0, center - thickness, 0, center + thickness);
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(0.5, color);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(0, center - thickness, canvas.width, thickness * 2);
    ctx.globalAlpha = 1;
  });
  if (spec.fallback.craters) {
    for (let i = 0; i < spec.fallback.craters; i++) {
      const radius = 1.5 + random() * 6;
      const x = random() * canvas.width;
      const y = random() * canvas.height;
      ctx.fillStyle = random() > 0.5 ? "rgba(0,0,0,.16)" : "rgba(255,255,255,.10)";
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (spec.fallback.spot) {
    const spot = spec.fallback.spot;
    ctx.fillStyle = spot.color;
    ctx.beginPath();
    ctx.ellipse(spot.u * canvas.width, spot.v * canvas.height, spot.ru * canvas.width, spot.rv * canvas.height, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (spec.fallback.caps) {
    ctx.fillStyle = spec.fallback.caps;
    ctx.beginPath();
    ctx.ellipse(canvas.width / 2, 4, canvas.width * 0.62, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(canvas.width / 2, canvas.height - 4, canvas.width * 0.62, 14, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Procedural ring strip (used for Uranus and as the Saturn error fallback).
function paintRingFallback(color: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 8;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.18, color);
  gradient.addColorStop(0.46, "rgba(0,0,0,.06)");
  gradient.addColorStop(0.62, color);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// RingGeometry UVs run around the annulus; remap them radially so the bundled
// Saturn ring alpha strip (radius → banding) samples correctly.
function remapRingUv(geometry: THREE.RingGeometry, inner: number, outer: number) {
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    const radius = Math.sqrt(position.getX(i) ** 2 + position.getY(i) ** 2);
    uv.setXY(i, (radius - inner) / (outer - inner), 0.5);
  }
  uv.needsUpdate = true;
  return geometry;
}

function atmosphereMaterial(accent: string) {
  return new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      color: { value: new THREE.Color(accent) },
    },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 color;
      varying vec3 vNormal;
      void main() {
        float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.6);
        gl_FragColor = vec4(color, fresnel * 0.55);
      }
    `,
  });
}

function useThemeColors() {
  const read = () => {
    const style = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue("--accent").trim() || "#72d9ff",
      accentInk: style.getPropertyValue("--accent-ink").trim() || "#72d9ff",
    };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
    return () => observer.disconnect();
  }, []);
  return colors;
}

function Globe({ nodes, accent, selectedId, onSelect, focusApiRef, onPlanetFocus, onTextureStatus, orbitRunning, onOrbitPause, scaleMode, reducedMotion }: {
  nodes: GlobeNode[];
  accent: string;
  selectedId: string | null;
  onSelect: (node: GlobeNode) => void;
  // Imperative bridge for the planet selector overlay: the scene effect installs
  // a focus function here (same ref pattern as rebuildNodesRef) so selecting a
  // planet never re-runs the scene-building effect.
  focusApiRef: MutableRefObject<{ focus: (id: string) => void; overview: () => void; setScaleMode: (mode: SolarScaleMode) => void } | null>;
  onPlanetFocus: (id: string) => void;
  onTextureStatus: (id: string, status: "loading" | "ready" | "fallback") => void;
  orbitRunning: boolean;
  onOrbitPause: () => void;
  scaleMode: SolarScaleMode;
  reducedMotion: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Live inputs flow into the animation loop / rebuild through refs so that
  // selecting a node, refreshing the fleet, or switching mode never re-runs
  // the scene-building effect below. Rebuilding the WebGL renderer + Earth
  // textures on every button click is what made the whole globe flash and
  // restart — the GUI was hostage to the right-column buttons.
  const nodesRef = useRef(nodes);
  const selectedIdRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  const rebuildNodesRef = useRef<(() => void) | null>(null);
  // Signature of the node set currently drawn on the globe. Guards the
  // node-only rebuild so a new-but-identical `nodes` array (every 30s poll /
  // presence snapshot) does not tear down and recreate the marker meshes.
  const lastNodeSigRef = useRef<string>("");
  const onPlanetFocusRef = useRef(onPlanetFocus);
  const onTextureStatusRef = useRef(onTextureStatus);
  const orbitRunningRef = useRef(orbitRunning);
  const onOrbitPauseRef = useRef(onOrbitPause);
  const scaleModeRef = useRef(scaleMode);
  const reducedMotionRef = useRef(reducedMotion);
  nodesRef.current = nodes;
  selectedIdRef.current = selectedId;
  onSelectRef.current = onSelect;
  onPlanetFocusRef.current = onPlanetFocus;
  onTextureStatusRef.current = onTextureStatus;
  orbitRunningRef.current = orbitRunning;
  onOrbitPauseRef.current = onOrbitPause;
  scaleModeRef.current = scaleMode;
  reducedMotionRef.current = reducedMotion;

  // Scene is built ONCE per theme accent. Node data / selection / pointer
  // callbacks are read from refs, never from this effect's dependency array.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new THREE.Scene();
    // Far plane covers the outer planets and the expanded star shell.
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 900);
    camera.position.set(0, 82, SYSTEM_OVERVIEW_DISTANCE);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    // Retina displays use a 2x drawing buffer. Keep the canvas' CSS box tied to
    // the panel instead of letting its intrinsic (2x) pixel dimensions become
    // its layout dimensions; otherwise macOS renders a double-sized canvas and
    // the globe appears cropped into the lower-right corner.
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.setAttribute("aria-label", "Interactive 3D OWLLM world map");
    renderer.domElement.setAttribute("role", "img");
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 105;
    controls.maxDistance = 360;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.32;

    const textureLoader = new THREE.TextureLoader();
    const earthMap = textureLoader.load(EARTH_TEXTURES.day);
    const earthNormal = textureLoader.load(EARTH_TEXTURES.normal);
    const earthSpecular = textureLoader.load(EARTH_TEXTURES.specular);
    const cloudMap = textureLoader.load(EARTH_TEXTURES.clouds);
    earthMap.colorSpace = THREE.SRGBColorSpace;
    cloudMap.colorSpace = THREE.SRGBColorSpace;
    const maxAnisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    earthMap.anisotropy = maxAnisotropy;
    earthNormal.anisotropy = maxAnisotropy;
    earthSpecular.anisotropy = maxAnisotropy;
    cloudMap.anisotropy = maxAnisotropy;

    // Earth and every world/fleet marker share one anchor so the complete Earth
    // system travels together when orbital mode advances its solar orbit.
    const earthAnchor = new THREE.Group();
    scene.add(earthAnchor);
    const earthGroup = new THREE.Group();
    earthGroup.rotation.z = -0.14;
    earthAnchor.add(earthGroup);
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(2.35, 128, 64),
      new THREE.MeshPhongMaterial({
        map: earthMap,
        normalMap: earthNormal,
        normalScale: new THREE.Vector2(0.48, 0.48),
        specularMap: earthSpecular,
        specular: new THREE.Color(0x557799),
        shininess: 18,
        // Faint self-illumination of the land/ocean so the night hemisphere reads
        // as a dim twilit Earth rather than pure black. The day map modulates it,
        // so continents glow softly; on the sunlit side it is negligible.
        emissive: new THREE.Color(0x58759d),
        emissiveMap: earthMap,
        emissiveIntensity: 0.72,
      }),
    );
    earthGroup.add(globe);

    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(2.382, 128, 64),
      new THREE.MeshPhongMaterial({
        map: cloudMap,
        transparent: true,
        opacity: 0.68,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    earthGroup.add(clouds);

    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(2.47, 96, 64), atmosphereMaterial(accent));
    earthAnchor.add(atmosphere);
    const outerGlow = new THREE.Mesh(
      new THREE.SphereGeometry(2.56, 80, 48),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.035, side: THREE.BackSide, depthWrite: false }),
    );
    earthAnchor.add(outerGlow);

    // Starfield.
    const starsGeometry = new THREE.BufferGeometry();
    const starCount = 2500;
    const starPositions = new Float32Array(starCount * 3);
    const starSizes = new Float32Array(starCount);
    for (let i = 0; i < starCount; i++) {
      // Star shell encloses the whole solar-system arc, not just the Earth view,
      // so Neptune and Saturn keep a deep-space backdrop when focused.
      const radius = 180 + (i % 23) * 3.9;
      const theta = (i * 2.399963) % (Math.PI * 2);
      const z = 1 - 2 * ((i * 37 % 997) / 997);
      const planar = Math.sqrt(1 - z * z);
      starPositions[i * 3] = radius * planar * Math.cos(theta);
      starPositions[i * 3 + 1] = radius * z;
      starPositions[i * 3 + 2] = radius * planar * Math.sin(theta);
      starSizes[i] = 0.13 + (i % 7) * 0.034;
    }
    starsGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    starsGeometry.setAttribute("size", new THREE.BufferAttribute(starSizes, 1));
    scene.add(new THREE.Points(starsGeometry, new THREE.PointsMaterial({
      color: 0xc9ddff,
      size: 0.22,
      transparent: true,
      opacity: 0.75,
      sizeAttenuation: true,
    })));

    // Ground color lifted from near-black so the shadowed hemisphere keeps a dim
    // blue twilight fill instead of collapsing to black.
    scene.add(new THREE.HemisphereLight(0xb5d3ff, 0x385476, 1.55));
    scene.add(new THREE.AmbientLight(0xa8c7ef, 0.9));
    // Sun tracks the real subsolar point each frame (see animate loop); this is
    // just the initial placement so the first rendered frame is already correct.
    // Keep the day side dimensional without bleaching its texture. The former
    // 3.9 intensity stacked with the solar point light and clipped most surface
    // detail on the hemisphere facing the Sun.
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.15);
    const sunLocal = new THREE.Vector3();
    const sunQuat = new THREE.Quaternion();
    sunLight.position.copy(subsolarLocalDir(new Date(), sunLocal)).multiplyScalar(10);
    scene.add(sunLight);
    const rimLight = new THREE.PointLight(new THREE.Color(accent), 1.6, 20);
    rimLight.position.set(-6, -1.5, -5);
    scene.add(rimLight);

    // ---- Solar System bodies ----------------------------------------------
    // The Sun is the visual and orbital center. Its emissive surface and two
    // cheap glow shells avoid post-processing while remaining smooth on
    // integrated GPUs.
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(5.2, 64, 40),
      new THREE.MeshBasicMaterial({ color: 0xffc85c }),
    );
    sun.userData.solarBody = "sun";
    scene.add(sun);
    const sunGlow = new THREE.Mesh(
      new THREE.SphereGeometry(6.2, 48, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffa42c,
        transparent: true,
        opacity: 0.18,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    scene.add(sunGlow);
    const solarLight = new THREE.PointLight(0xfff2d0, 150, 0, 0.55);
    scene.add(solarLight);

    // Unit orbit paths are scaled every frame with the same layout math as the
    // planets. This lets the graphic and true astronomical representations
    // morph smoothly without rebuilding any WebGL geometry.
    const solarOrbitLines: { spec: PlanetSpec; line: THREE.LineLoop }[] = [];
    for (const spec of PLANETS) {
      const points = Array.from({ length: 192 }, (_, index) => {
        const bearing = index / 192 * Math.PI * 2;
        return new THREE.Vector3(Math.cos(bearing), Math.sin(bearing), Math.sin(bearing));
      });
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x7894bd, transparent: true, opacity: 0.19 }),
      );
      scene.add(line);
      solarOrbitLines.push({ spec, line });
    }

    // Earth keeps its photographic layers above; the other seven planets are
    // built here with a procedural fallback texture (instant loading view) that
    // is upgraded in place when the bundled high-resolution map arrives, and
    // kept permanently if that load errors.
    const planetMeshes: { spec: PlanetSpec; anchor: THREE.Group; mesh: THREE.Mesh }[] = [
      { spec: findPlanet("earth")!, anchor: earthAnchor, mesh: globe },
    ];
    const planetAnchors = new Map<string, THREE.Group>([["earth", earthAnchor]]);
    const planetClickable: THREE.Mesh[] = [];
    const planetTextures: THREE.Texture[] = [];
    for (const spec of PLANETS) {
      if (spec.id === "earth") continue;
      const group = new THREE.Group();
      const position = planetWorldPosition(spec);
      group.position.set(position.x, position.y, position.z);
      group.rotation.z = spec.tiltDeg * Math.PI / 180;
      const fallbackTexture = paintPlanetFallback(spec);
      const material = new THREE.MeshPhongMaterial({
        map: fallbackTexture,
        shininess: 8,
        specular: new THREE.Color(0x222933),
        // Same twilight treatment as Earth: the far side stays dimly readable.
        emissive: new THREE.Color(0x55636f),
        emissiveMap: fallbackTexture,
        emissiveIntensity: 0.5,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.radius, 96, 48), material);
      mesh.userData.planetId = spec.id;
      group.add(mesh);
      planetClickable.push(mesh);
      planetMeshes.push({ spec, anchor: group, mesh });
      planetAnchors.set(spec.id, group);

      if (spec.ring) {
        const ring = spec.ring;
        const inner = spec.radius * ring.inner;
        const outer = spec.radius * ring.outer;
        const ringGeometry = remapRingUv(new THREE.RingGeometry(inner, outer, 160, 1), inner, outer);
        const ringMaterial = new THREE.MeshBasicMaterial({
          map: paintRingFallback(ring.tint),
          color: ring.tint,
          transparent: true,
          opacity: ring.opacity,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const ringMesh = new THREE.Mesh(ringGeometry, ringMaterial);
        ringMesh.rotation.x = -Math.PI / 2;
        group.add(ringMesh);
        if (ring.texture) {
          textureLoader.load(ring.texture, (texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = maxAnisotropy;
            ringMaterial.map = texture;
            ringMaterial.needsUpdate = true;
            planetTextures.push(texture);
          }, undefined, () => {
            // Bundled ring strip failed: the procedural strip stays on.
          });
        }
      }
      scene.add(group);

      onTextureStatusRef.current?.(spec.id, "loading");
      textureLoader.load(spec.texture!, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = maxAnisotropy;
        material.map = texture;
        material.emissiveMap = texture;
        material.needsUpdate = true;
        planetTextures.push(texture);
        onTextureStatusRef.current?.(spec.id, "ready");
      }, undefined, () => {
        // Load error: keep the procedural fallback so the planet still shows
        // its distinguishing features, and tell the selector.
        onTextureStatusRef.current?.(spec.id, "fallback");
      });
    }

    // Focus/zoom: reuses the Earth behavior (OrbitControls + calibrated
    // distance clamps) for every planet. A focus request tweens the controls
    // target and camera to the planet, then hands control back to the user with
    // per-planet wheel-zoom bounds.
    let focusTween: FocusTween | null = null;
    let focusTweenStart = 0;
    let orbitClock = createOrbitClock(performance.now());
    let scaleProgress = scaleModeRef.current === "real" ? 1 : 0;
    let scaleTarget = scaleProgress;
    let lastScaleFrame = performance.now();
    let activeFocusId: string | null = null;
    const focusPlanet = (id: string, requestedScale = scaleTarget) => {
      const spec = findPlanet(id);
      if (!spec) return;
      // Focusing freezes the orbital clock at the body's current position. The
      // user can resume from the selector, which returns to the system view.
      orbitRunningRef.current = false;
      onOrbitPauseRef.current?.();
      const earthDistance = hasFleet ? FLEET_CAMERA_DISTANCE : WORLD_CAMERA_DISTANCE;
      const earthMin = hasFleet ? FLEET_MIN_DISTANCE : WORLD_MIN_DISTANCE;
      const planetPos = planetWorldPosition(spec, orbitClock.elapsedSeconds, requestedScale);
      const current = {
        target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      };
      const end = focusEndState(current, planetPos, focusDistanceFor(spec, earthDistance, requestedScale));
      const bounds = focusBoundsFor(spec, { min: earthMin, max: 17 }, earthDistance, requestedScale);
      controls.minDistance = bounds.min;
      controls.maxDistance = bounds.max;
      camera.near = requestedScale > 0.5
        ? Math.max(0.000_001, planetRadiusAtScale(spec, requestedScale) * 0.04)
        : 0.1;
      camera.updateProjectionMatrix();
      if (reducedMotionRef.current) {
        focusTween = null;
        controls.target.set(end.target.x, end.target.y, end.target.z);
        camera.position.set(end.position.x, end.position.y, end.position.z);
        camera.lookAt(controls.target);
        controls.enabled = true;
      } else {
        focusTween = createFocusTween(current, end);
        focusTweenStart = performance.now();
        // The tween owns the camera; user orbit/zoom resumes on arrival.
        controls.enabled = false;
      }
      activeFocusId = id;
      onPlanetFocusRef.current?.(id);
    };
    const focusOverview = () => {
      const current = {
        target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      };
      const end = {
        target: { x: 0, y: 0, z: 0 },
        position: { x: 0, y: 82, z: SYSTEM_OVERVIEW_DISTANCE },
      };
      controls.minDistance = 105;
      controls.maxDistance = 360;
      camera.near = 0.1;
      camera.updateProjectionMatrix();
      if (reducedMotionRef.current) {
        focusTween = null;
        controls.target.set(0, 0, 0);
        camera.position.set(0, 82, SYSTEM_OVERVIEW_DISTANCE);
        camera.lookAt(controls.target);
        controls.enabled = true;
      } else {
        focusTween = createFocusTween(current, end);
        focusTweenStart = performance.now();
        controls.enabled = false;
      }
      activeFocusId = null;
    };
    const setScaleMode = (mode: SolarScaleMode) => {
      scaleTarget = mode === "real" ? 1 : 0;
      // Keep a selected planet centered while its physical size and orbit
      // smoothly change by flying to its final position at the same time.
      if (activeFocusId) focusPlanet(activeFocusId, scaleTarget);
    };
    focusApiRef.current = { focus: focusPlanet, overview: focusOverview, setScaleMode };

    // Node layer — rebuilt in place (arrays are cleared + repopulated, never
    // reassigned) so the animation loop and click handler keep working across
    // rebuilds without re-running this effect.
    const clickable: THREE.Mesh[] = [];
    const pulseMeshes: THREE.Mesh[] = [];
    const orbitRings: { line: THREE.LineLoop; node: GlobeNode }[] = [];
    const nodeMeshes: { mesh: THREE.Mesh; halo: THREE.Mesh; label?: THREE.Sprite; node: GlobeNode; baseScale: number }[] = [];
    let hasFleet = false;

    const disposeNodeObject = (object: any) => {
      object.parent?.remove(object);
      object.geometry?.dispose?.();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((m: any) => { m.map?.dispose?.(); m.dispose?.(); });
      else if (material) { material.map?.dispose?.(); material.dispose?.(); }
    };

    const buildNodes = () => {
      orbitRings.forEach(({ line }) => disposeNodeObject(line));
      nodeMeshes.forEach(({ mesh, halo, label }) => { disposeNodeObject(mesh); disposeNodeObject(halo); if (label) disposeNodeObject(label); });
      clickable.length = 0;
      pulseMeshes.length = 0;
      orbitRings.length = 0;
      nodeMeshes.length = 0;

      const list = nodesRef.current;
      list.forEach((node, index) => {
        const color = node.online ? accent : 0x718096;
        const baseScale = node.kind === "fleet" ? 1 : 1;

        if (node.kind === "fleet" && node.orbit) {
          const orbit = node.orbit;
          const ringGeometry = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 192 }, (_, i) =>
            orbitPosition({ ...orbit, phase: i / 192 * Math.PI * 2, speed: 0 }, 0),
          ));
          const ring = new THREE.LineLoop(ringGeometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: node.online ? 0.34 : 0.14 }));
          earthAnchor.add(ring);
          orbitRings.push({ line: ring, node });
        }

        const geometry = node.kind === "fleet"
          ? new THREE.OctahedronGeometry(0.15, 1)
          : new THREE.SphereGeometry(0.07, 20, 16);
        const material = new THREE.MeshStandardMaterial({
          color,
          emissive: new THREE.Color(color).multiplyScalar(node.online ? 0.6 : 0.1),
          roughness: 0.3,
          metalness: 0.4,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.node = node;
        earthAnchor.add(mesh);
        clickable.push(mesh);

        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(node.kind === "fleet" ? 0.31 : 0.16, 24, 18),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: node.online ? 0.30 : 0.09, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        halo.userData.offset = index * 0.63;
        earthAnchor.add(halo);
        pulseMeshes.push(halo);

        const label = node.kind === "fleet" ? satelliteLabel(node.label, new THREE.Color(color).getStyle()) : undefined;
        if (label) earthAnchor.add(label);
        nodeMeshes.push({ mesh, halo, label, node, baseScale });
      });

      // Reframe only when fleet-satellite presence actually changes (initial
      // populate or a real mode switch) — not on selection or the 30s poll,
      // so the user's current orbit/zoom is preserved.
      const nextHasFleet = list.some((node) => node.kind === "fleet");
      if (nextHasFleet !== hasFleet) {
        hasFleet = nextHasFleet;
        const earthSpec = findPlanet("earth")!;
        const earthDistance = hasFleet ? FLEET_CAMERA_DISTANCE : WORLD_CAMERA_DISTANCE;
        const earthMin = hasFleet ? FLEET_MIN_DISTANCE : WORLD_MIN_DISTANCE;
        const earthPosition = planetWorldPosition(earthSpec, orbitClock.elapsedSeconds, scaleProgress);
        const focusDistance = focusDistanceFor(earthSpec, earthDistance, scaleProgress);
        const bounds = focusBoundsFor(earthSpec, { min: earthMin, max: 17 }, earthDistance, scaleProgress);
        controls.minDistance = bounds.min;
        camera.position.set(earthPosition.x, earthPosition.y + focusDistance * 0.02, earthPosition.z + focusDistance);
        // Mode reframing is an Earth view: cancel any planet focus in flight and
        // bring the selector back to Earth.
        focusTween = null;
        orbitRunningRef.current = false;
        onOrbitPauseRef.current?.();
        controls.enabled = true;
        controls.target.set(earthPosition.x, earthPosition.y, earthPosition.z);
        controls.maxDistance = bounds.max;
        activeFocusId = "earth";
        onPlanetFocusRef.current?.("earth");
      }
    };

    rebuildNodesRef.current = buildNodes;
    buildNodes();
    lastNodeSigRef.current = nodeSignature(nodesRef.current);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    // Remember where the press started so an orbit drag (pointer travels) is not
    // mistaken for a node click on release — dragging to rotate must never fire
    // a selection state update.
    let downX = 0;
    let downY = 0;
    const pointerDown = (event: PointerEvent) => { downX = event.clientX; downY = event.clientY; };
    const click = (event: PointerEvent) => {
      if (!isClickGesture(event.clientX - downX, event.clientY - downY)) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([...clickable, ...planetClickable], false)[0];
      if (hit?.object?.userData?.node) onSelectRef.current(hit.object.userData.node as GlobeNode);
      // Clicking a planet body focuses it, same as the selector.
      else if (hit?.object?.userData?.planetId) focusPlanet(hit.object.userData.planetId as string);
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", click);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    let frame = 0;
    const started = performance.now();
    const animate = (now: number) => {
      const elapsed = (now - started) / 1000;
      const scaleDelta = Math.min(0.1, Math.max(0, (now - lastScaleFrame) / 1000));
      lastScaleFrame = now;
      scaleProgress = stepSolarScaleProgress(
        scaleProgress,
        scaleTarget,
        scaleDelta,
        reducedMotionRef.current,
      );
      orbitClock = advanceOrbitClock(orbitClock, now, orbitRunningRef.current);
      controls.autoRotate = orbitRunningRef.current;
      planetMeshes.forEach(({ spec, anchor }) => {
        const position = planetWorldPosition(spec, orbitClock.elapsedSeconds, scaleProgress);
        anchor.position.set(position.x, position.y, position.z);
        anchor.scale.setScalar(planetRadiusAtScale(spec, scaleProgress) / spec.radius);
      });
      solarOrbitLines.forEach(({ spec, line }) => {
        const distance = planetOrbitDistance(spec, scaleProgress);
        line.scale.set(distance, planetOrbitHeight(spec, scaleProgress), distance);
      });
      sun.rotation.y = elapsed * 0.035;
      const sunScale = sunRadiusAtScale(scaleProgress) / 5.2;
      sun.scale.setScalar(sunScale);
      const glowPulse = 1 + Math.sin(elapsed * 1.4) * 0.025;
      sunGlow.scale.setScalar(sunScale * glowPulse);
      globe.rotation.y = elapsed * 0.018 - 0.34;
      clouds.rotation.y = elapsed * 0.024 - 0.34;
      atmosphere.rotation.y = elapsed * 0.018;
      outerGlow.rotation.y = -elapsed * 0.006;

      // Real-clock sun: aim the light at the current subsolar point, expressed in
      // the globe's live world orientation so the lit hemisphere stays over the
      // true daylit geography as the globe rotates.
      subsolarLocalDir(new Date(), sunLocal).applyQuaternion(globe.getWorldQuaternion(sunQuat));
      sunLight.position.copy(sunLocal).multiplyScalar(10);

      // Planets spin on their own axes (Venus/Uranus retrograde via sign).
      planetMeshes.forEach(({ spec, mesh }) => {
        if (spec.id !== "earth") mesh.rotation.y = elapsed * spec.spin;
      });

      // Smooth focus flight: while a tween is active it owns the camera and
      // target; OrbitControls resumes (with the new per-planet zoom clamps)
      // the moment it lands.
      if (focusTween) {
        const sampled = sampleFocusTween(focusTween, now - focusTweenStart);
        controls.target.set(sampled.target.x, sampled.target.y, sampled.target.z);
        camera.position.set(sampled.position.x, sampled.position.y, sampled.position.z);
        camera.lookAt(controls.target);
        if (sampled.done) {
          focusTween = null;
          controls.enabled = true;
        }
      }

      pulseMeshes.forEach((mesh) => {
        const scale = 0.78 + (Math.sin(elapsed * 2.4 + mesh.userData.offset) + 1) * 0.22;
        mesh.scale.setScalar(scale);
      });

      nodeMeshes.forEach(({ mesh, halo, label, node, baseScale }) => {
        const isSelected = selectedIdRef.current === node.id;
        const selectedScale = isSelected ? 1.55 : 1;
        if (node.kind === "fleet" && node.orbit) {
          const position = orbitPosition(node.orbit, elapsed);
          mesh.position.copy(position);
          halo.position.copy(position);
          if (label) label.position.copy(position).add(new THREE.Vector3(0, 0.24, 0));
          mesh.scale.setScalar(baseScale * selectedScale);
        } else if (node.latitude != null && node.longitude != null) {
          const position = latLonVector(node.latitude, node.longitude, 2.39);
          mesh.position.copy(position);
          halo.position.copy(position);
          mesh.scale.setScalar(baseScale * selectedScale);
        }
      });

      // OrbitControls.update() applies auto-rotate and zoom clamps even while
      // disabled — skip it during a focus flight so it cannot fight the tween.
      if (!focusTween) controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      rebuildNodesRef.current = null;
      focusApiRef.current = null;
      cancelAnimationFrame(frame);
      planetTextures.forEach((texture) => texture.dispose());
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", click);
      controls.dispose();
      earthMap.dispose();
      earthNormal.dispose();
      earthSpecular.dispose();
      cloudMap.dispose();
      scene.traverse((object: any) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach((material: any) => { material.map?.dispose?.(); material.dispose?.(); });
        else if (object.material) { object.material.map?.dispose?.(); object.material.dispose?.(); }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [accent]);

  // Scale changes stay inside the live scene. They update only the animation
  // target and, when focused, schedule a new camera flight to that same planet;
  // the renderer and high-resolution textures are never recreated.
  useEffect(() => {
    focusApiRef.current?.setScaleMode(scaleMode);
  }, [scaleMode]);

  // Node-only rebuild when the node set actually changes (device online/offline,
  // added/removed, mode switch). Cheap: touches just the marker/orbit meshes,
  // leaving the renderer, Earth textures, starfield, and camera view intact.
  // The signature guard skips rebuilds when the 30s poll / presence snapshot
  // hands back a new array with identical content, so the node layer does not
  // flicker on a timer.
  useEffect(() => {
    const signature = nodeSignature(nodes);
    if (signature === lastNodeSigRef.current) return;
    lastNodeSigRef.current = signature;
    rebuildNodesRef.current?.();
  }, [nodes]);

  return <div ref={hostRef} data-ui="WorldMap:globe" style={{ position: "absolute", inset: 0 }} />;
}

function panelStyle(): CSSProperties {
  return {
    background: "linear-gradient(145deg, rgba(var(--accent-rgb),.10), var(--bg-card) 48%)",
    border: "1px solid var(--border-strong)",
    borderRadius: 16,
    boxShadow: "var(--shadow-lg)",
  };
}

export default function WorldMapPage() {
  const { t } = useLocalization();
  const colors = useThemeColors();
  const [mode, setMode] = useState<WorldMapMode>(readWorldMapMode);
  const [publicNodes, setPublicNodes] = useState<PublicPresenceNode[]>([]);
  const [fleet, setFleet] = useState<DeviceRecord[]>([]);
  const [selfId, setSelfId] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<GlobeNode | null>(null);
  const [expandedCountry, setExpandedCountry] = useState<string | null>(null);
  const [fleetError, setFleetError] = useState("");
  // Solar System explorer: which planet the camera is focused on, the imperative
  // focus bridge into the Globe scene, and per-planet texture health for the
  // selector's loading/fallback affordances.
  const [focusedPlanet, setFocusedPlanet] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [orbitRunning, setOrbitRunning] = useState(() =>
    !(typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
  const [scaleMode, setScaleMode] = useState<SolarScaleMode>(() =>
    readSolarScaleMode(typeof window === "undefined" ? undefined : window.localStorage)
  );
  const [textureStatus, setTextureStatus] = useState<Record<string, "loading" | "ready" | "fallback">>({});
  const focusApiRef = useRef<{ focus: (id: string) => void; overview: () => void; setScaleMode: (mode: SolarScaleMode) => void } | null>(null);
  const planetButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusPlanet = (id: string) => {
    setOrbitRunning(false);
    setFocusedPlanet(id);
    focusApiRef.current?.focus(id);
  };

  const toggleOrbits = () => {
    setOrbitRunning((running) => !running);
  };

  const toggleScaleMode = () => {
    setScaleMode((current) => current === "real" ? "graphic" : "real");
  };

  // Keyboard-accessible selector: arrows move through solar order (wrapping),
  // Home/End jump to Mercury/Neptune. Enter/Space activate natively (buttons).
  const onSelectorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = Math.max(0, PLANETS.findIndex((planet) => planet.id === focusedPlanet));
    let next = -1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = nextPlanetIndex(index, 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = nextPlanetIndex(index, -1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = PLANETS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    focusPlanet(PLANETS[next].id);
    planetButtonRefs.current[next]?.focus();
  };

  const onTextureStatus = (id: string, status: "loading" | "ready" | "fallback") => {
    setTextureStatus((current) => (current[id] === status ? current : { ...current, [id]: status }));
  };

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => {
      setReducedMotion(media.matches);
      if (media.matches) setOrbitRunning(false);
    };
    onChange();
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    if (!orbitRunning) return;
    setFocusedPlanet(null);
    focusApiRef.current?.overview();
  }, [orbitRunning]);

  useEffect(() => {
    saveSolarScaleMode(scaleMode, window.localStorage);
  }, [scaleMode]);

  // Presence markers and fleet satellites all live around Earth: selecting one
  // while parked at another planet flies the camera home first.
  const handleNodeSelect = (node: GlobeNode) => {
    setSelected(node);
    if (focusedPlanet !== "earth") focusPlanet("earth");
  };

  useEffect(() => {
    saveWorldMapMode(mode);
    setSelected(null);
    setExpandedCountry(null);
  }, [mode]);

  useEffect(() => {
    setLoading(true);
    return subscribeWorldPresence({
      onSnapshot: (snapshot) => {
        setPublicNodes(snapshot.nodes);
        setError("");
        setLoading(false);
      },
      onStatus: (status) => {
        setConfigured(status.configured);
        if (!status.configured) {
          setPublicNodes([]);
          setLoading(false);
        } else if (!status.connected) {
          setPublicNodes([]);
          if (status.error) {
            setError(status.error);
            setLoading(false);
          }
        } else {
          setError("");
        }
      },
    });
  }, []);

  const loadFleet = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setFleetError("");
    try {
      const [identity, devices] = await Promise.all([getIdentity(), listDevices()]);
      setSelfId(identity.device_id);
      setFleet(fleetWithSelf(identity, devices));
    } catch (reason) {
      setFleetError(String(reason));
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [identity, devices] = await Promise.all([getIdentity(), listDevices()]);
        if (!alive) return;
        setSelfId(identity.device_id);
        setFleet(fleetWithSelf(identity, devices));
        setFleetError("");
      } catch (reason) {
        if (alive) setFleetError(String(reason));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    const onDevicesRefresh = () => { void refresh(); };
    window.addEventListener("owllm:devices:refresh", onDevicesRefresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("owllm:devices:refresh", onDevicesRefresh);
    };
  }, []);

  useEffect(() => {
    if (mode === "fleet") void loadFleet(false);
  }, [mode]);

  const nodes = useMemo<GlobeNode[]>(() => mode === "world"
    ? publicNodes.map((node) => ({
        id: node.id,
        label: node.region ? regionWithFlag(node.region) : t("Anonymous OWLLM node"),
        detail: node.online ? t("Approximate server region") : t("Recorded · offline"),
        latitude: node.latitude,
        longitude: node.longitude,
        online: node.online,
        kind: "world" as const,
      }))
    : fleet.map((device) => {
        const online = isDeviceOnline(device);
        return {
          id: device.device_id,
          label: device.is_self || device.device_id === selfId ? t("This device") : device.name,
          detail: `${device.os} · ${online ? t("Online") : t("Offline")}`,
          online,
          kind: "fleet" as const,
          orbit: fleetOrbit(device.device_id),
        };
      }), [fleet, mode, publicNodes, selfId, t]);

  const onlineCount = nodes.filter((node) => node.online).length;
  const countries = useMemo(() => groupOnlinePresenceByCountry(publicNodes), [publicNodes]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  return (
    <div data-ui="WorldMapPage" style={{ height: "100%", minHeight: 0, overflow: "auto", padding: "18px 20px", color: "var(--fg)" }}>
      <div style={{ width: "100%", maxWidth: 1500, minHeight: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 18, flexWrap: "wrap" }}>
          <div>
            <div style={{ color: "var(--accent-ink)", fontSize: 11, fontWeight: 800, letterSpacing: 2.4, textTransform: "uppercase" }}>{t("OWLLM Network")}</div>
            <h1 style={{ margin: "4px 0 5px", fontSize: "clamp(28px, 4vw, 48px)", lineHeight: 1, color: "var(--fg-strong)" }}>{t("World Map")}</h1>
            <div style={{ color: "var(--fg-muted)", fontSize: 13.5 }}>{t("Anonymous presence around the world and your private device fleet.")}</div>
          </div>
          <div role="tablist" aria-label={t("World map mode")} style={{ display: "flex", padding: 4, gap: 4, borderRadius: 13, background: "var(--bg-elevated)", border: "1px solid var(--border-strong)" }}>
            {(["world", "fleet"] as const).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                style={{
                  minHeight: 38, padding: "0 17px", border: mode === value ? "1px solid var(--accent-strong)" : "1px solid transparent",
                  borderRadius: 10, background: mode === value ? "rgba(var(--accent-rgb),.16)" : "transparent",
                  color: mode === value ? "var(--accent-ink)" : "var(--fg-muted)", fontWeight: 750, cursor: "pointer",
                }}
              >{value === "world" ? t("Live World") : t("My Fleet")}</button>
            ))}
          </div>
        </header>

        <div className="world-map-layout" style={{ display: "grid", gap: 14, flex: 1, minHeight: 450 }}>
          <section className="world-map-globe-panel" style={{ ...panelStyle(), position: "relative", minHeight: 450, overflow: "hidden", background: "radial-gradient(circle at 50% 44%, #142b50 0%, #081326 38%, #020713 72%, #01030a 100%)" }}>
            <Globe
              nodes={nodes}
              accent={colors.accentInk}
              selectedId={selected?.id ?? null}
              onSelect={handleNodeSelect}
              focusApiRef={focusApiRef}
              onPlanetFocus={setFocusedPlanet}
              onTextureStatus={onTextureStatus}
              orbitRunning={orbitRunning}
              onOrbitPause={() => setOrbitRunning(false)}
              scaleMode={scaleMode}
              reducedMotion={reducedMotion}
            />
            <div
              data-ui="WorldMap:solar-controls"
              style={{
                position: "absolute", zIndex: 2, top: 13, bottom: 13, left: 13, display: "flex", alignItems: "flex-start", gap: 8,
                maxWidth: "calc(100% - 26px)",
              }}
            >
              <div
                data-ui="WorldMap:planets"
                role="listbox"
                aria-label={t("Solar System")}
                aria-activedescendant={focusedPlanet ? `world-map-planet-${focusedPlanet}` : undefined}
                tabIndex={0}
                onKeyDown={onSelectorKeyDown}
                style={{
                  display: "flex", flexDirection: "column", gap: 3, flexShrink: 0,
                  padding: 7, borderRadius: 13, background: "rgba(2,6,16,.80)", border: "1px solid rgba(var(--accent-rgb),.30)",
                  backdropFilter: "blur(10px)", maxHeight: "100%", overflowY: "auto",
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.7, textTransform: "uppercase", color: "var(--accent-ink)", padding: "2px 7px 4px" }}>{t("Solar System")}</div>
                <button
                  type="button"
                  aria-pressed={orbitRunning}
                  onClick={toggleOrbits}
                  title={reducedMotion ? t("Motion is stopped by your reduced-motion setting") : undefined}
                  style={{
                    minHeight: 32, margin: "0 2px 3px", padding: "5px 9px", borderRadius: 9,
                    cursor: "pointer", fontSize: 11.5, fontWeight: 800,
                    border: "1px solid rgba(var(--accent-rgb),.38)",
                    background: orbitRunning ? "rgba(var(--accent-rgb),.22)" : "rgba(255,255,255,.05)",
                    color: "var(--accent-ink)",
                  }}
                >
                  {orbitRunning ? `Ⅱ ${t("Pause orbits")}` : `▶ ${t("Resume orbits")}`}
                </button>
                {PLANETS.map((planet, index) => (
                  <button
                    key={planet.id}
                    id={`world-map-planet-${planet.id}`}
                    role="option"
                    aria-selected={focusedPlanet === planet.id}
                    ref={(element) => { planetButtonRefs.current[index] = element; }}
                    onClick={() => focusPlanet(planet.id)}
                    title={textureStatus[planet.id] === "fallback" ? t("Simplified view (texture failed to load)") : undefined}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, minWidth: 122, padding: "5px 9px", borderRadius: 9,
                      cursor: "pointer", textAlign: "left", fontSize: 12.5, fontWeight: 700,
                      border: focusedPlanet === planet.id ? "1px solid var(--accent-strong)" : "1px solid transparent",
                      background: focusedPlanet === planet.id ? "rgba(var(--accent-rgb),.18)" : "transparent",
                      color: focusedPlanet === planet.id ? "var(--accent-ink)" : "#dce6f6",
                    }}
                  >
                    <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", flexShrink: 0, background: planet.fallback.base, boxShadow: `0 0 6px ${planet.fallback.base}` }} />
                    {t(planet.name)}
                    {textureStatus[planet.id] === "loading" && <span aria-hidden style={{ marginLeft: "auto", fontSize: 10, color: "#93a5c4" }}>…</span>}
                    {textureStatus[planet.id] === "fallback" && <span aria-hidden style={{ marginLeft: "auto", fontSize: 10, color: "#e0b45c" }}>◌</span>}
                  </button>
                ))}
              </div>
              <div style={{ width: 168, display: "flex", flexDirection: "column", gap: 6 }}>
                <button
                  type="button"
                  data-ui="WorldMap:real-scale"
                  aria-label={t("Real size")}
                  aria-pressed={scaleMode === "real"}
                  onClick={toggleScaleMode}
                  title={scaleMode === "real" ? t("Return to the graphic representation") : t("Use true relative sizes and orbital distances")}
                  style={{
                    minHeight: 38, padding: "7px 11px", borderRadius: 11, cursor: "pointer",
                    border: scaleMode === "real" ? "1px solid var(--accent-strong)" : "1px solid rgba(var(--accent-rgb),.38)",
                    background: scaleMode === "real" ? "rgba(var(--accent-rgb),.24)" : "rgba(2,6,16,.80)",
                    color: scaleMode === "real" ? "var(--accent-ink)" : "#dce6f6",
                    backdropFilter: "blur(10px)", fontSize: 12, fontWeight: 850,
                  }}
                >
                  ⚖ {t("Real size")}
                </button>
                <div
                  role="status"
                  aria-live="polite"
                  style={{
                    padding: "7px 9px", borderRadius: 10, background: "rgba(2,6,16,.76)",
                    border: "1px solid rgba(var(--accent-rgb),.24)", color: "#b9c8df", fontSize: 10.5, lineHeight: 1.35,
                  }}
                >
                  {scaleMode === "real"
                    ? t("True scale: planets are tiny and far apart. Use the selector to focus.")
                    : t("Graphic scale keeps every planet readable.")}
                </div>
              </div>
            </div>
            <div style={{ position: "absolute", zIndex: 2, top: 13, right: 13, display: "flex", gap: 8, pointerEvents: "none", flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "58%" }}>
              <span style={{ padding: "5px 9px", borderRadius: 999, background: "rgba(2,6,16,.72)", border: "1px solid rgba(var(--accent-rgb),.28)", color: "var(--fg-strong)", fontSize: 11.5 }}>
                <b style={{ color: "var(--accent-ink)" }}>{onlineCount}</b> {mode === "world" ? t("nodes online") : t("devices online")}
              </span>
              {mode === "world" && (
                <span style={{ padding: "5px 9px", borderRadius: 999, background: "rgba(2,6,16,.72)", border: "1px solid var(--border)", color: "var(--fg-muted)", fontSize: 11.5 }}>
                  <b style={{ color: "var(--fg-strong)" }}>{nodes.length}</b> {t("recorded")}
                </span>
              )}
              <span style={{ padding: "5px 9px", borderRadius: 999, background: "rgba(2,6,16,.72)", border: "1px solid var(--border)", color: "var(--fg-muted)", fontSize: 11.5 }}>{t("Drag to orbit · scroll to zoom")}</span>
            </div>
            {mode === "world" && !configured && !loading && (
              <div style={{ position: "absolute", inset: "auto 18px 18px 18px", padding: "12px 14px", borderRadius: 12, border: "1px solid rgba(var(--accent-rgb),.35)", background: "rgba(3,7,17,.88)", backdropFilter: "blur(12px)", color: "var(--fg-muted)", fontSize: 12.5 }}>
                <b style={{ color: "var(--fg-strong)" }}>{t("World presence service is not connected yet.")}</b>{" "}
                {t("The globe is ready; real anonymous nodes will appear when the presence endpoint is configured.")}
              </div>
            )}
          </section>

          <aside style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={{ ...panelStyle(), padding: 15 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ fontSize: 11, color: "var(--accent-ink)", fontWeight: 800, letterSpacing: 1.3, textTransform: "uppercase" }}>{mode === "world" ? t("Live World") : t("My Fleet")}</div>
                {mode === "fleet" && (
                  <button
                    onClick={() => void loadFleet(true)}
                    style={{ padding: "3px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--fg-muted)", fontSize: 11, cursor: "pointer" }}
                  >{t("Refresh")}</button>
                )}
              </div>
              <div style={{ marginTop: 7, fontSize: 25, fontWeight: 800, color: "var(--fg-strong)" }}>{nodes.length}</div>
              <div style={{ color: "var(--fg-muted)", fontSize: 12.5 }}>{mode === "world" ? t("anonymous installations recorded") : t("paired OwLLM devices")}</div>
              <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 6, color: "var(--fg-muted)", fontSize: 12 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
                <span><b style={{ color: "var(--accent-ink)" }}>{onlineCount}</b> {t("online now")}</span>
              </div>
            </div>

            {mode === "world" && (
              <div style={{ ...panelStyle(), padding: 13, display: "flex", gap: 9, alignItems: "flex-start", color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.45 }}>
                <span aria-hidden style={{ marginTop: 1, color: "var(--accent-ink)" }}>🌐</span>
                <span>{t("Only your OS family and coarse region are shown — no name, account, device identity, project, prompt, or exact coordinates are shared.")}</span>
              </div>
            )}

            {mode === "fleet" && fleetError && (
              <div style={{ ...panelStyle(), padding: 12, borderColor: "var(--error)", color: "var(--error)", fontSize: 11.5, lineHeight: 1.5 }}>
                {fleetError}
              </div>
            )}

            <div style={{ ...panelStyle(), padding: 15, flex: 1, minHeight: 140, maxHeight: "68vh", overflowY: "auto" }}>
              <div style={{ color: "var(--fg-strong)", fontWeight: 750, fontSize: 13, marginBottom: 10 }}>
                {mode === "world" ? t("Connected users by country") : t("Network signals")}
              </div>
              {error && <div style={{ color: "var(--error)", fontSize: 11.5, marginBottom: 10 }}>{error}</div>}
              {(mode === "world" ? countries.length === 0 : nodes.length === 0) ? (
                <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5 }}>
                  {loading ? t("Scanning the network…") : mode === "world" ? t("No live presence data yet.") : t("No paired devices found.")}
                </div>
              ) : mode === "world" ? countries.map((country) => {
                const countryKey = country.countryCode || "unknown";
                const expanded = expandedCountry === countryKey;
                const flag = country.countryCode ? countryCodeToFlag(country.countryCode) : "🌐";
                return (
                  <div key={countryKey} style={{ borderBottom: "1px solid var(--border)", padding: "10px 2px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "62px minmax(0,1fr)", gap: 12, alignItems: "start" }}>
                      <button
                        type="button"
                        aria-label={`${expanded ? t("Hide") : t("Show")} ${country.countryCode || t("Unknown country")} ${t("connection details")}`}
                        aria-expanded={expanded}
                        aria-controls={`world-country-${countryKey}`}
                        onClick={() => setExpandedCountry((current) => current === countryKey ? null : countryKey)}
                        title={t("Click the flag for connection details")}
                        style={{
                          width: 58, height: 50, padding: 0, borderRadius: 12,
                          border: expanded ? "1px solid var(--accent-strong)" : "1px solid var(--border)",
                          background: expanded ? "rgba(var(--accent-rgb),.15)" : "var(--bg-elevated)",
                          color: "var(--fg-strong)", fontSize: 34, lineHeight: 1,
                          display: "grid", placeItems: "center",
                        }}
                      >
                        <span aria-hidden>{flag}</span>
                      </button>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: "var(--fg-strong)", fontSize: 13, fontWeight: 800 }}>
                          {country.nodes.length} {t("users online")}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6 }}>
                          {OS_DISPLAY_ORDER.filter((os) => country.osCounts[os] > 0).map((os) => (
                            <div key={os} style={{ display: "flex", justifyContent: "space-between", gap: 10, color: "var(--fg-muted)", fontSize: 11.5 }}>
                              <span>{os === "Other" ? t("Other") : os}</span>
                              <b style={{ color: "var(--fg-strong)" }}>{country.osCounts[os]}</b>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    {expanded && (
                      <div
                        id={`world-country-${countryKey}`}
                        data-ui="WorldMap:country-details"
                        style={{
                          marginTop: 9, maxHeight: 20 * 44, overflowY: "auto", overscrollBehavior: "contain",
                          border: "1px solid var(--border)", borderRadius: 10, background: "rgba(var(--accent-rgb),.05)",
                        }}
                      >
                        {[...country.nodes].sort((a, b) => a.region.localeCompare(b.region)).map((publicNode) => {
                          const globeNode = nodesById.get(publicNode.id);
                          return (
                            <button
                              key={publicNode.id}
                              type="button"
                              onClick={() => globeNode && handleNodeSelect(globeNode)}
                              style={{
                                width: "100%", minHeight: 44, display: "grid", gridTemplateColumns: "9px minmax(0,1fr)", gap: 9,
                                textAlign: "left", padding: "7px 9px", border: "none", borderBottom: "1px solid var(--border)",
                                background: selected?.id === publicNode.id ? "rgba(var(--accent-rgb),.12)" : "transparent",
                                color: "var(--fg)", cursor: "pointer",
                              }}
                            >
                              <span style={{ width: 7, height: 7, borderRadius: "50%", marginTop: 5, background: "var(--accent)", boxShadow: "0 0 9px var(--accent)" }} />
                              <span style={{ minWidth: 0 }}>
                                <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{regionWithFlag(publicNode.region)}</span>
                                <span style={{ display: "block", marginTop: 2, fontSize: 10.5, color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("Approximate server region")} · {publicNode.os === "Other" ? t("Other") : publicNode.os}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }) : [...nodes].sort((a, b) => Number(b.online) - Number(a.online)).map((node) => (
                <button key={node.id} onClick={() => handleNodeSelect(node)} style={{ width: "100%", display: "grid", gridTemplateColumns: "9px minmax(0,1fr)", gap: 9, textAlign: "left", padding: "9px 7px", border: "none", borderBottom: "1px solid var(--border)", background: selected?.id === node.id ? "rgba(var(--accent-rgb),.10)" : "transparent", color: "var(--fg)", cursor: "pointer" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", marginTop: 5, background: node.online ? "var(--accent)" : "var(--fg-dim)", boxShadow: node.online ? "0 0 9px var(--accent)" : "none" }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: "var(--fg-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.label}</span>
                    <span style={{ display: "block", marginTop: 2, fontSize: 10.5, color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.detail}</span>
                  </span>
                </button>
              ))}
            </div>

            {selected && (
              <div style={{ ...panelStyle(), padding: 15, borderColor: "var(--accent-strong)" }}>
                <div style={{ color: "var(--fg-strong)", fontWeight: 800 }}>{selected.label}</div>
                <div style={{ marginTop: 4, color: "var(--fg-muted)", fontSize: 11.5 }}>{selected.detail}</div>
                <div style={{ marginTop: 9, color: "var(--accent-ink)", fontSize: 10.5, fontWeight: 700 }}>{selected.kind === "fleet" ? t("Private fleet orbit · not a location") : t("Coarse server region only")}</div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
