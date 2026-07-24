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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-world-map-"));
const source = read("pages/gamify/worldPresence.ts");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = path.join(temp, "worldPresence.mjs");
fs.writeFileSync(modulePath, compiled);
const presence = await import(pathToFileURL(modulePath).href);

const stabilitySource = read("pages/gamify/globeStability.ts");
const stabilityCompiled = ts.transpileModule(stabilitySource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const stabilityPath = path.join(temp, "globeStability.mjs");
fs.writeFileSync(stabilityPath, stabilityCompiled);
const stability = await import(pathToFileURL(stabilityPath).href);

const livenessSource = read("pages/advanced/deviceLiveness.ts");
const livenessCompiled = ts.transpileModule(livenessSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const livenessPath = path.join(temp, "deviceLiveness.mjs");
fs.writeFileSync(livenessPath, livenessCompiled);
const liveness = await import(pathToFileURL(livenessPath).href);

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
};

class FakeSocket {
  listeners = new Map();
  closed = false;
  constructor(url) { this.url = url; }
  addEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }
  emit(type, value = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}

try {
  check("World mode is the safe default", presence.readWorldMapMode(memory()) === "world");
  const modeStore = memory();
  presence.saveWorldMapMode("fleet", modeStore);
  check("My Fleet mode persists", presence.readWorldMapMode(modeStore) === "fleet");
  check("Anonymous presence defaults off", presence.readPresenceEnabled(memory()) === false);
  const consentStore = memory();
  presence.savePresenceEnabled(true, consentStore);
  check("Anonymous presence choice persists", presence.readPresenceEnabled(consentStore) === true);

  const self = { device_id: "self", name: "This device" };
  const paired = [{ device_id: "peer", name: "Peer" }];
  check("Fleet includes the current installation", presence.includeSelfDevice(self, paired).map((device) => device.device_id).join(",") === "self,peer");
  check("Fleet does not duplicate the current installation", presence.includeSelfDevice(self, [self, ...paired]).length === 2);
  const now = Date.parse("2026-07-23T12:00:00.000Z");
  check("Fleet liveness treats this device as online", liveness.isDeviceOnline({ is_self: true, last_seen: null, endpoint: null }, now) === true);
  check("Fleet liveness accepts fresh direct frames", liveness.isDeviceOnline({ is_self: false, last_seen: "2026-07-23T11:58:00.000Z", endpoint: null }, now) === true);
  check("Fleet liveness accepts fresh synced dialable metadata", liveness.isDeviceOnline({ is_self: false, last_seen: null, published_at: "2026-07-23T11:59:00.000Z", endpoint: "192.168.219.102:42445" }, now) === true);
  check("Fleet liveness accepts fresh synced P2P metadata", liveness.isDeviceOnline({ is_self: false, last_seen: "2026-07-22T05:01:35.000Z", published_at: "2026-07-23T11:59:00.000Z", endpoint: null, p2p_node_id: "node" }, now) === true);
  check("Fleet liveness keeps legacy dialable records compatible", liveness.isDeviceOnline({ is_self: false, last_seen: null, endpoint: "192.168.219.102:42445" }, now) === true);
  check("Fleet liveness rejects stale synced heartbeat records", liveness.isDeviceOnline({ is_self: false, last_seen: null, published_at: "2026-07-22T11:00:00.000Z", endpoint: "192.168.219.102:42445" }, now) === false);
  check("Fleet liveness rejects stale records with no dial path", liveness.isDeviceOnline({ is_self: false, last_seen: "2026-07-22T05:01:35.000Z", endpoint: null, endpoints: [], p2p_node_id: null }, now) === false);

  const sanitized = presence.sanitizePresenceNodes([
    { id: "ok", region: "EU West", latitude: 48, longitude: 9, firstSeen: "t0", lastSeen: "now", online: true, github_login: "must-not-leak" },
    { id: "bad-lat", latitude: 200, longitude: 9 },
    { id: "ok", latitude: 1, longitude: 2 },
    { id: "ghost", region: "AP", latitude: 1, longitude: 2, online: false },
  ]);
  check("Presence payload validates and deduplicates coordinates", sanitized.length === 2 && sanitized[0].id === "ok");
  check("Public nodes expose no account/device identity fields", !Object.hasOwn(sanitized[0], "github_login") && Object.keys(sanitized[0]).length === 7);
  check("Offline installations are retained as ghosts", sanitized.find((node) => node.id === "ghost").online === false && sanitized[0].online === true);

  const stableStore = memory();
  const firstId = presence.readOrCreateNodeId(stableStore);
  check("Stable anonymous node id is created and reused", firstId.length > 0 && presence.readOrCreateNodeId(stableStore) === firstId);
  check("Presence socket URL carries the stable node id", presence.worldPresenceSocketUrl("presence", "https://presence.example", firstId).includes(`id=${firstId}`));
  check("Viewer socket URL never carries the node id", !presence.worldPresenceSocketUrl("viewer", "https://presence.example", firstId).includes("id="));

  check("HTTPS endpoint becomes a viewer WebSocket", presence.worldPresenceSocketUrl("viewer", "https://presence.example/") === "wss://presence.example/v1/presence/connect?role=viewer");
  check("HTTP endpoint becomes a presence WebSocket", presence.worldPresenceSocketUrl("presence", "http://localhost:8787") === "ws://localhost:8787/v1/presence/connect?role=presence");
  check("Missing service has no socket URL", presence.worldPresenceSocketUrl("viewer", "") === "");
  check("Production presence endpoint is configured", presence.DEFAULT_WORLD_PRESENCE_URL === "https://owllm-world-presence.mc-9fa.workers.dev");

  const statuses = [];
  const snapshots = [];
  const viewerSockets = [];
  let reconnect = null;
  let reconnectDelay = 0;
  const stopViewer = presence.subscribeWorldPresence({
    baseUrl: "https://presence.example",
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      viewerSockets.push(socket);
      return socket;
    },
    setTimer: (callback, delay) => { reconnect = callback; reconnectDelay = delay; return 1; },
    clearTimer: () => {},
    onStatus: (status) => statuses.push(status),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  check("Viewer opens the global snapshot socket", viewerSockets.length === 1 && viewerSockets[0].url.endsWith("role=viewer"));
  viewerSockets[0].emit("open");
  viewerSockets[0].emit("message", { data: JSON.stringify({ type: "snapshot", nodes: [{ id: "n1", region: "AP", latitude: 35, longitude: 127 }] }) });
  check("Viewer accepts sanitized live snapshots", snapshots.length === 1 && snapshots[0].nodes[0].id === "n1");
  check("Viewer reports recorded-total and online counts", snapshots[0].counts.total === 1 && snapshots[0].counts.online === 1);
  viewerSockets[0].emit("message", { data: JSON.stringify({ type: "upsert", node: { id: "n2", region: "EU", latitude: 42, longitude: 12 } }) });
  check("Viewer applies incremental presence updates", snapshots.at(-1).nodes.map((node) => node.id).join(",") === "n1,n2");
  viewerSockets[0].emit("message", { data: JSON.stringify({ type: "upsert", node: { id: "n2", region: "EU", latitude: 42, longitude: 12, online: false } }) });
  check("Viewer keeps offline nodes as ghosts instead of dropping them", snapshots.at(-1).nodes.find((node) => node.id === "n2").online === false && snapshots.at(-1).counts.total === 2 && snapshots.at(-1).counts.online === 1);
  viewerSockets[0].emit("message", { data: JSON.stringify({ type: "remove", id: "n1" }) });
  check("Viewer removes only hard-evicted nodes", snapshots.at(-1).nodes.map((node) => node.id).join(",") === "n2");
  viewerSockets[0].emit("close");
  check("Viewer reports disconnect and bounded backoff", statuses.at(-1).connected === false && reconnectDelay === presence.WORLD_PRESENCE_RECONNECT_BASE_MS);
  reconnect();
  check("Viewer reconnects after a transient close", viewerSockets.length === 2);
  stopViewer();
  check("Stopping viewer closes the active socket", viewerSockets[1].closed);

  let missingStatus = null;
  presence.subscribeWorldPresence({ baseUrl: "", onStatus: (status) => { missingStatus = status; }, onSnapshot: () => {} });
  check("Missing service stays honest instead of fabricating users", missingStatus.configured === false && missingStatus.connected === false);

  const runnerStore = memory({
    [presence.WORLD_PRESENCE_ENABLED_KEY]: "1",
    "owllm:world-map:presence-token": "obsolete-d1-token",
  });
  const presenceSockets = [];
  const stopPresence = presence.installWorldPresenceConnection({
    storage: runnerStore,
    baseUrl: "https://presence.example",
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      presenceSockets.push(socket);
      return socket;
    },
  });
  check("Opted-in installation opens one anonymous presence socket", presenceSockets.length === 1 && presenceSockets[0].url.includes("role=presence"));
  check("Presence socket sends the stable per-installation node id", presenceSockets[0].url.includes("id="));
  check("Node id is persisted device-locally for the next launch", (runnerStore.getItem("owllm:world-map:node-id") ?? "").length > 0);
  check("D1-era bearer token is removed", runnerStore.getItem("owllm:world-map:presence-token") === null);
  stopPresence();
  check("Invisible or app shutdown immediately closes presence", presenceSockets[0].closed);

  const page = read("pages/gamify/WorldMapPage.tsx");
  const modules = read("core/modules.ts");
  const home = read("pages/core/HomePage.tsx");
  const actions = read("localization/catalog.actions.ts");
  const appShell = read("AppShell.tsx");
  const vaultSync = read("runtime/vaultSync.ts");
  const worker = read("../../../services/world-presence/src/index.js");
  const wrangler = read("../../../services/world-presence/wrangler.jsonc");
  check("Gamify replaces Arena with World Map", modules.includes('key: "world-map"') && modules.includes("component: WorldMapPage") && !modules.includes("component: ArenaPage"));
  check("Home links directly to World Map", home.includes('label: "World Map"') && home.includes('targetPage: "world-map"'));
  check("World Map renders a bundled Three.js globe", page.includes("new THREE.WebGLRenderer") && page.includes("new THREE.SphereGeometry") && page.includes("OrbitControls"));
  // Regression: clicking the right-column buttons (select a node, refresh the
  // fleet, switch mode) must NOT tear down the renderer/textures. The scene
  // effect depends on the theme accent ONLY; node data + selection flow in
  // through refs, and node changes trigger a cheap node-only rebuild.
  check("Globe scene is built once per accent, not per node/selection", /}, \[accent\]\);/.test(page) && !/\[accent, nodes, onSelect, selectedId\]/.test(page));
  check("Selection is read live from a ref (no scene rebuild on select)", page.includes("selectedIdRef.current === node.id"));
  check("Node changes trigger a node-only rebuild, not a renderer teardown", page.includes("rebuildNodesRef.current?.()") && /rebuildNodesRef\.current = buildNodes/.test(page));
  check("Retina drawing buffer cannot resize the globe canvas CSS box",
    page.includes('renderer.domElement.style.width = "100%"')
      && page.includes('renderer.domElement.style.height = "100%"')
      && page.includes('renderer.domElement.style.display = "block"')
      && page.includes("renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))"));

  // Regression: idle rotation must not flicker. The 30s fleet poll and each
  // presence snapshot return a NEW array with identical content; the node layer
  // must only rebuild when the node set actually changes, guarded by a stable
  // signature — otherwise the marker meshes are torn down/recreated on a timer.
  const nodesA = [
    { id: "self", kind: "fleet", online: true, label: "This device" },
    { id: "peer", kind: "fleet", online: false, label: "Peer" },
  ];
  const nodesA2 = nodesA.map((n) => ({ ...n })); // same content, new identities (poll result)
  check("Identical node sets share one signature (no timer flicker)",
    stability.nodeSignature(nodesA) === stability.nodeSignature(nodesA2));
  check("Node coming online changes the signature (real rebuild)",
    stability.nodeSignature(nodesA) !== stability.nodeSignature(nodesA.map((n) => n.id === "peer" ? { ...n, online: true } : n)));
  check("Adding a node changes the signature (real rebuild)",
    stability.nodeSignature(nodesA) !== stability.nodeSignature([...nodesA, { id: "new", kind: "world", online: true, label: "EU" }]));
  check("Globe skips the node rebuild when the signature is unchanged",
    /const signature = nodeSignature\(nodes\);/.test(page) && /if \(signature === lastNodeSigRef\.current\) return;/.test(page));

  // Regression: dragging to orbit must not fire a selection state update. Only a
  // near-stationary press counts as a click; a pointer that travelled is a drag.
  check("A stationary press is a click", stability.isClickGesture(0, 0) === true && stability.isClickGesture(4, 4) === true);
  check("A travelled pointer (orbit drag) is not a click", stability.isClickGesture(40, 5) === false && stability.isClickGesture(0, 30) === false);
  check("Globe ignores drag gestures on pointerup (no select on orbit)",
    page.includes("pointerDown") && /if \(!isClickGesture\(event\.clientX - downX, event\.clientY - downY\)\) return;/.test(page));
  check("Globe bundles photographic Earth texture layers", page.includes("EARTH_TEXTURES.day") && page.includes("EARTH_TEXTURES.normal") && page.includes("EARTH_TEXTURES.specular") && page.includes("EARTH_TEXTURES.clouds"));
  check("Globe uses calibrated color and tone mapping", page.includes("THREE.SRGBColorSpace") && page.includes("THREE.ACESFilmicToneMapping") && page.includes("THREE.HemisphereLight"));
  // The day/night terminator must follow the real UTC clock: the sun is aimed at
  // the computed subsolar point every frame, not pinned to a fixed position.
  check("Sun tracks the real subsolar point from the UTC clock",
    page.includes("subsolarLocalDir(new Date(), sunLocal)") && /sunLight\.position\.copy\(sunLocal\)/.test(page) && !/sunLight\.position\.set\(5\.8/.test(page));
  // The shadowed hemisphere must stay dimly visible (twilight), not pure black.
  check("Night hemisphere is softly lit, not pitch black",
    page.includes("emissiveMap: earthMap")
      && /emissiveIntensity:\s*0\.72/.test(page)
      && /new THREE\.AmbientLight\(0xa8c7ef,\s*0\.9\)/.test(page));
  check("Globe starts zoomed out and cannot wheel-zoom into a cropped sphere",
    page.includes("const WORLD_CAMERA_DISTANCE = 11.8")
      && page.includes("const WORLD_MIN_DISTANCE = 9.6")
      && page.includes("camera.position.set(0, 0.24, WORLD_CAMERA_DISTANCE)")
      && page.includes("controls.minDistance = WORLD_MIN_DISTANCE"));
  check("Globe follows the readable selected GUI accent", page.includes('getPropertyValue("--accent-ink")') && page.includes("accent={colors.accentInk}"));
  check("My Fleet consumes real paired-device state", page.includes("getIdentity()") && page.includes("listDevices()") && page.includes("device.is_self"));
  check("My Fleet and Devices share one online rule", page.includes('from "../advanced/deviceLiveness"') && page.includes("isDeviceOnline(device)") && read("pages/advanced/DevicesPage.tsx").includes('from "./deviceLiveness"'));
  check("My Fleet refreshes immediately after device vault sync", page.includes('window.addEventListener("owllm:devices:refresh"') && page.includes('window.removeEventListener("owllm:devices:refresh"'));
  check("Device vault records carry a publication heartbeat", read("../../src-tauri/src/remote_devices/protocol.rs").includes("published_at") && read("../../src-tauri/src/remote_devices/mod.rs").includes("rec.published_at = Some(now_rfc3339())"));
  check("My Fleet always includes the current installation", page.includes("fleetWithSelf(identity, devices)") && page.includes("is_self: true"));
  check("Fleet satellites have aligned orbit paths and labels", page.includes("orbitPosition({ ...orbit") && page.includes("satelliteLabel(node.label"));
  for (const asset of ["earth-day.jpg", "earth-normal.jpg", "earth-specular.jpg", "earth-clouds.png"]) {
    check(`Bundled Earth asset exists: ${asset}`, fs.statSync(path.join(UI, "../public/world-map", asset)).size > 100_000);
  }
  check("Public mode has an explicit anonymous-presence control", page.includes('type="checkbox"') && page.includes("savePresenceEnabled"));
  check("World Map consumes live WebSocket snapshots", page.includes("subscribeWorldPresence") && !page.includes("loadWorldPresence"));
  check("World Map ghosts recorded-but-offline nodes and shows both counts", page.includes("online: node.online") && page.includes('t("recorded")') && page.includes('t("online now")'));
  check("Opted-in presence runs application-wide", appShell.includes("<WorldPresenceRunner />") && appShell.includes("installWorldPresenceConnection()"));
  check("Consent and stable node id remain device-local", vaultSync.includes('"owllm:world-map:presence-enabled"') && vaultSync.includes('"owllm:world-map:node-id"'));
  check("Worker retains anonymous nodes in SQLite and ghosts offline ones", worker.includes("acceptWebSocket") && worker.includes("serializeAttachment") && worker.includes("CREATE TABLE IF NOT EXISTS nodes") && worker.includes("first_seen") && worker.includes("publicNode(row, false)"));
  check("Worker never reads the source IP or reintroduces a cron", !/CF-Connecting-IP|x-forwarded-for/i.test(worker) && !/scheduled\s*\(/.test(worker));
  check("Worker broadcasts incremental membership changes with counts", worker.includes('type: "upsert"') && worker.includes('type: "remove"') && worker.includes("counts:"));
  check("Wrangler binds a free SQLite-backed Durable Object without D1", wrangler.includes("new_sqlite_classes") && !wrangler.includes("d1_databases"));
  check("Unavailable service is disclosed", page.includes("World presence service is not connected yet."));
  check("New navigation labels have all eight locales", /\["World Map",(?:[^\]]*,){6}[^\]]*\]/.test(actions) && /\["Live World",(?:[^\]]*,){6}[^\]]*\]/.test(actions));
  check("New recorded/online-count labels have all eight locales", /\["recorded",(?:[^\]]*,){6}[^\]]*\]/.test(actions) && /\["online now",(?:[^\]]*,){6}[^\]]*\]/.test(actions));

  for (const row of checks) console.log(`  PASS ${row.name}`);
  console.log(`world map verification: ${checks.length}/${checks.length} passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
