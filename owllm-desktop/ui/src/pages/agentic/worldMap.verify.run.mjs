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
  // Anonymous presence is always on now: there is no opt-in flag to read/save.
  // Counting an install shares only an opaque id + coarse region, so nothing is
  // gated on consent — the presence module exposes no enabled getter/setter.
  check("No consent gate exists on the presence module", presence.readPresenceEnabled === undefined && presence.savePresenceEnabled === undefined);

  const self = { device_id: "self", name: "This device" };
  const paired = [{ device_id: "peer", name: "Peer" }];
  check("Fleet includes the current installation", presence.includeSelfDevice(self, paired).map((device) => device.device_id).join(",") === "self,peer");
  check("Fleet does not duplicate the current installation", presence.includeSelfDevice(self, [self, ...paired]).length === 2);
  const now = Date.parse("2026-07-23T12:00:00.000Z");
  check("Fleet liveness treats this device as online", liveness.isDeviceOnline({ is_self: true, last_seen: null, endpoint: null }, now) === true);
  check("Fleet liveness accepts fresh direct frames", liveness.isDeviceOnline({ is_self: false, last_seen: "2026-07-23T11:58:00.000Z", endpoint: null }, now) === true);
  check("Fleet liveness accepts fresh synced dialable metadata", liveness.isDeviceOnline({ is_self: false, last_seen: null, published_at: "2026-07-23T11:59:00.000Z", endpoint: "192.168.219.102:42445" }, now) === true);
  check("Fleet liveness accepts fresh synced P2P metadata", liveness.isDeviceOnline({ is_self: false, last_seen: "2026-07-22T05:01:35.000Z", published_at: "2026-07-23T11:59:00.000Z", endpoint: null, p2p_node_id: "node" }, now) === true);
  check("Fleet liveness rejects heartbeat-less records (no immortal-online legacy grace)", liveness.isDeviceOnline({ is_self: false, last_seen: null, endpoint: "192.168.219.102:42445" }, now) === false);
  check("Fleet liveness rejects stale synced heartbeat records", liveness.isDeviceOnline({ is_self: false, last_seen: null, published_at: "2026-07-22T11:00:00.000Z", endpoint: "192.168.219.102:42445" }, now) === false);
  check("Heartbeat cadence beats twice per liveness window", liveness.REMOTE_DEVICE_HEARTBEAT_MS * 2 <= liveness.REMOTE_DEVICE_RECENT_MS);
  check("Fleet liveness rejects stale records with no dial path", liveness.isDeviceOnline({ is_self: false, last_seen: "2026-07-22T05:01:35.000Z", endpoint: null, endpoints: [], p2p_node_id: null }, now) === false);

  const sanitized = presence.sanitizePresenceNodes([
    { id: "ok", region: "KR · Seoul", os: "Windows", latitude: 48, longitude: 9, firstSeen: "t0", lastSeen: "now", online: true, github_login: "must-not-leak" },
    { id: "bad-lat", latitude: 200, longitude: 9 },
    { id: "ok", latitude: 1, longitude: 2 },
    { id: "linux", region: "KR · Busan", os: "Linux", latitude: 2, longitude: 3, online: true },
    { id: "ghost", region: "IT · Rome", os: "macOS", latitude: 1, longitude: 2, online: false },
  ]);
  check("Presence payload validates and deduplicates coordinates", sanitized.length === 3 && sanitized[0].id === "ok");
  check("Public nodes expose no account/device identity fields", !Object.hasOwn(sanitized[0], "github_login") && Object.keys(sanitized[0]).length === 8);
  check("Offline installations are retained as ghosts", sanitized.find((node) => node.id === "ghost").online === false && sanitized[0].online === true);
  check("OS data is normalized to four anonymous families",
    presence.normalizePresenceOs("Win32") === "Windows"
      && presence.normalizePresenceOs("Macintosh") === "macOS"
      && presence.normalizePresenceOs("X11; Linux") === "Linux"
      && presence.normalizePresenceOs("unknown") === "Other");
  check("Presence rows expose the city separately from the country code",
    presence.presenceCountryCode("KR · Seoul") === "KR"
      && presence.presenceCity("KR · Seoul") === "Seoul"
      && presence.presenceCity("KR") === "");
  const countries = presence.groupPresenceByCountry(sanitized);
  check("Recorded users group by country and retain offline countries",
    countries.length === 2
      && countries[0].countryCode === "KR"
      && countries[0].nodes.length === 2
      && countries[0].onlineCount === 2
      && countries[1].countryCode === "IT"
      && countries[1].nodes.length === 1
      && countries[1].onlineCount === 0);
  check("Country summaries split total and online users by operating system",
    countries[0].osCounts.Windows.total === 1
      && countries[0].osCounts.Windows.online === 1
      && countries[0].osCounts.Linux.total === 1
      && countries[0].osCounts.Linux.online === 1
      && countries[1].osCounts.macOS.total === 1
      && countries[1].osCounts.macOS.online === 0);
  const onlineFirstCountries = presence.groupPresenceByCountry([
    { id: "offline-a", region: "US · Boston", os: "Windows", latitude: 1, longitude: 1, online: false },
    { id: "offline-b", region: "US · Seattle", os: "Linux", latitude: 2, longitude: 2, online: false },
    { id: "online", region: "KR · Seoul", os: "Windows", latitude: 3, longitude: 3, online: true },
  ]);
  check("Countries are ordered by online users before recorded totals",
    onlineFirstCountries.map((country) => country.countryCode).join(",") === "KR,US");

  const stableStore = memory();
  const firstId = presence.readOrCreateNodeId(stableStore);
  check("Stable anonymous node id is created and reused", firstId.length > 0 && presence.readOrCreateNodeId(stableStore) === firstId);
  const devicePresenceId = await presence.presenceNodeIdForDevice("device-A");
  const sameDevicePresenceId = await presence.presenceNodeIdForDevice("DEVICE-A");
  const peerPresenceId = await presence.presenceNodeIdForDevice("device-B");
  check("Native devices derive stable opaque public-presence ids",
    devicePresenceId.length === 64
      && devicePresenceId === sameDevicePresenceId
      && devicePresenceId !== peerPresenceId
      && !devicePresenceId.includes("device"));
  const presenceIds = new Map([["device-A", devicePresenceId], ["device-B", peerPresenceId]]);
  check("Fleet liveness reconciles the same installations with Live World",
    presence.isFleetDeviceLiveInWorld("device-A", presenceIds, [{ id: devicePresenceId, online: true }])
      && !presence.isFleetDeviceLiveInWorld("device-B", presenceIds, [{ id: peerPresenceId, online: false }]));
  check("Public server codes are stable and do not expose the node id",
    presence.presenceServerCode(devicePresenceId) === presence.presenceServerCode(devicePresenceId)
      && /^OW-[0-9A-Z]{7}$/.test(presence.presenceServerCode(devicePresenceId))
      && !presence.presenceServerCode(devicePresenceId).includes(devicePresenceId.slice(0, 6)));
  check("Presence socket URL carries the stable node id", presence.worldPresenceSocketUrl("presence", "https://presence.example", firstId).includes(`id=${firstId}`));
  check("Presence socket may carry only a normalized OS family",
    presence.worldPresenceSocketUrl("presence", "https://presence.example", firstId, "Windows").includes("os=Windows"));
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

  // No enabled flag is seeded: presence must connect for every install.
  const runnerStore = memory({
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
  check("Every installation opens one anonymous presence socket (always on, no consent)", presenceSockets.length === 1 && presenceSockets[0].url.includes("role=presence"));
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
  check("Globe uses calibrated color and tone mapping", page.includes("THREE.SRGBColorSpace") && page.includes("THREE.ACESFilmicToneMapping") && page.includes("THREE.AmbientLight"));
  // The day/night terminator must follow the real UTC clock: the sun is aimed at
  // the computed subsolar point every frame, not pinned to a fixed position.
  check("Sun tracks the real subsolar point from the UTC clock",
    page.includes("subsolarLocalDir(new Date(), sunLocal)")
      && page.includes("light.position.copy(anchor.position).addScaledVector(sunLocal, 10)")
      && !page.includes("sunLight.position.set(5.8"));
  check("Every planet's sun-facing peak is exactly 18.75 percent above its baseline",
    page.includes("const PLANET_BASE_LIGHT_INTENSITY = 1")
      && page.includes("const PLANET_SUNLIGHT_INTENSITY = PLANET_BASE_LIGHT_INTENSITY * 0.15 * 1.25")
      && page.includes("const planetSunLights = planetMeshes.map")
      && page.includes("light.layers.set(layer)")
      && page.includes("new THREE.AmbientLight(0xffffff, PLANET_BASE_LIGHT_INTENSITY)")
      && !page.includes("new THREE.PointLight(0xfff2d0"));
  // The shadowed hemisphere stays fully texture-readable through the neutral
  // baseline; no emissive/specular term can push the bright face past 15%.
  check("Night hemisphere stays readable without extra highlight terms",
    page.includes("new THREE.AmbientLight(0xffffff, PLANET_BASE_LIGHT_INTENSITY)")
      && /specular:\s*new THREE\.Color\(0x000000\)/.test(page)
      && !page.includes("emissiveIntensity"));
  check("Earth retains its readable focus distance while orbital mode starts in system overview",
    page.includes("const WORLD_CAMERA_DISTANCE = 11.8")
      && page.includes("const WORLD_MIN_DISTANCE = 9.6")
      && page.includes("camera.position.set(0, 82, SYSTEM_OVERVIEW_DISTANCE)")
      && page.includes("controls.minDistance = 105")
      && page.includes("focusBoundsFor(spec, { min: earthMin, max: 17 }, earthDistance, requestedScale)"));
  check("Globe follows the readable selected GUI accent", page.includes('getPropertyValue("--accent-ink")') && page.includes("accent={colors.accentInk}"));
  check("My Fleet consumes real paired-device state", page.includes("getIdentity()") && page.includes("listDevices()") && page.includes("device.is_self"));
  check("My Fleet uses Live World first and the Devices heartbeat as fallback",
    page.includes("isFleetDeviceLiveInWorld(device.device_id, fleetPresenceIds, publicNodes)")
      && page.includes("|| isDeviceOnline(device)")
      && read("pages/advanced/DevicesPage.tsx").includes('from "./deviceLiveness"'));
  check("My Fleet refreshes immediately after device vault sync", page.includes('window.addEventListener("owllm:devices:refresh"') && page.includes('window.removeEventListener("owllm:devices:refresh"'));
  check("Device vault records carry a publication heartbeat", read("../../src-tauri/src/remote_devices/protocol.rs").includes("published_at") && read("../../src-tauri/src/remote_devices/mod.rs").includes("rec.published_at = Some(now_rfc3339())"));
  check("Running apps republish the heartbeat on an interval", vaultSync.includes("REMOTE_DEVICE_HEARTBEAT_MS") && vaultSync.includes("void syncDevicesNow(); }, REMOTE_DEVICE_HEARTBEAT_MS"));
  check("My Fleet always includes the current installation", page.includes("fleetWithSelf(identity, devices)") && page.includes("is_self: true"));
  check("Fleet satellites have aligned orbit paths and labels", page.includes("orbitPosition({ ...orbit") && page.includes("satelliteLabel(node.label"));
  for (const asset of ["earth-day.jpg", "earth-normal.jpg", "earth-specular.jpg", "earth-clouds.png"]) {
    check(`Bundled Earth asset exists: ${asset}`, fs.statSync(path.join(UI, "../public/world-map", asset)).size > 100_000);
  }
  // Presence is always on — there must be NO opt-in checkbox/toggle. Public mode
  // instead shows a passive note that counting is anonymous.
  check("Public mode has no presence opt-in checkbox or consent toggle", !page.includes('type="checkbox"') && !page.includes("savePresenceEnabled") && !page.includes("presenceEnabled"));
  check("Public mode discloses anonymous coarse-region and OS counting without a consent control",
    page.includes("Only your OS family and approximate city are shown"));
  check("World Map consumes live WebSocket snapshots", page.includes("subscribeWorldPresence") && !page.includes("loadWorldPresence"));
  check("World Map ghosts recorded-but-offline nodes and shows both counts", page.includes("online: node.online") && page.includes('t("recorded")') && page.includes('t("online now")'));
  check("Presence runs application-wide from the opaque native-device hash",
    appShell.includes("<WorldPresenceRunner />")
      && appShell.includes("presenceNodeIdForDevice(identity.device_id)")
      && appShell.includes("installWorldPresenceConnection({ nodeId })"));
  check("Stable node id (and any legacy consent key) stay device-local", vaultSync.includes('"owllm:world-map:node-id"') && vaultSync.includes('"owllm:world-map:presence-enabled"'));
  check("Worker retains anonymous nodes in SQLite and ghosts offline ones",
    worker.includes("acceptWebSocket")
      && worker.includes("serializeAttachment")
      && worker.includes("CREATE TABLE IF NOT EXISTS nodes")
      && worker.includes("first_seen")
      && worker.includes("publicNode(row, false)")
      && worker.includes("SELECT id, region, os, latitude"));
  check("Worker never reads the source IP or reintroduces a cron", !/CF-Connecting-IP|x-forwarded-for/i.test(worker) && !/scheduled\s*\(/.test(worker));
  check("Worker broadcasts incremental membership changes with counts", worker.includes('type: "upsert"') && worker.includes('type: "remove"') && worker.includes("counts:"));
  check("Wrangler binds a free SQLite-backed Durable Object without D1", wrangler.includes("new_sqlite_classes") && !wrangler.includes("d1_databases"));
  check("Unavailable service is disclosed", page.includes("World presence service is not connected yet."));
  check("New navigation labels have all eight locales", /\["World Map",(?:[^\]]*,){6}[^\]]*\]/.test(actions) && /\["Live World",(?:[^\]]*,){6}[^\]]*\]/.test(actions));
  check("New recorded/online-count labels have all eight locales", /\["recorded",(?:[^\]]*,){6}[^\]]*\]/.test(actions) && /\["online now",(?:[^\]]*,){6}[^\]]*\]/.test(actions));
  // The anonymous-counting note contains commas in its text, so verify locale
  // coverage by its English key plus the last-column (pt) translation.
  check("Anonymous OS/city disclosure is translated (en + pt endpoints present)",
    actions.includes("Only your OS family and approximate city are shown")
      && actions.includes("Somente a família do sistema operacional e a cidade aproximada são mostradas"));
  // Server list shows the nation flag instead of the bare 2-letter code.
  check("Region labels convert the country code to a flag", page.includes("regionWithFlag(node.region)") && page.includes("0x1f1e6 + ch.charCodeAt(0) - 65"));
  check("World list groups every recorded user into country summaries with large flag controls",
    page.includes("groupPresenceByCountry(publicNodes)")
      && page.includes('gridTemplateColumns: "62px minmax(0,1fr)"')
      && page.includes("country.nodes.length")
      && page.includes("country.onlineCount")
      && page.includes("country.osCounts[os].total")
      && page.includes("country.osCounts[os].online"));
  check("Country and OS summaries are online-first and show online/total",
    source.includes("b.onlineCount - a.onlineCount")
      && page.includes("country.osCounts[b].online - country.osCounts[a].online")
      && page.includes("{country.onlineCount}/{country.nodes.length} {t(\"online now\")}")
      && page.includes("{country.osCounts[os].online}/{country.osCounts[os].total}"));
  check("Country flag opens a scrollable detail list capped at twenty rows",
    page.includes('data-ui="WorldMap:country-details"')
      && page.includes("maxHeight: 20 * 44")
      && page.includes('overflowY: "auto"')
      && page.includes("setExpandedCountry"));
  check("Country rows expose cities and use stable server codes instead of row numbers",
    page.includes("countryDisplayName(country.countryCode, language)")
      && page.includes("cities.join(\", \")")
      && page.includes('const city = presenceCity(publicNode.region) || t("Unknown city")')
      && page.includes('{countryName} · {t("Server")} {presenceServerCode(publicNode.id)}')
      && page.includes('{city} · {publicNode.os === "Other" ? t("Other") : publicNode.os}')
      && !page.includes('{t("Server")} {index + 1}')
      && !page.includes(">{regionWithFlag(publicNode.region)}</span>"));
  check("Sun-side illumination is raised by exactly twenty-five percent",
    page.includes("PLANET_BASE_LIGHT_INTENSITY * 0.15 * 1.25")
      && page.includes("new THREE.DirectionalLight(0xffffff, PLANET_SUNLIGHT_INTENSITY)"));
  check("Worker persists only normalized OS families for recorded/offline summaries",
    worker.includes("normalizeOsFamily")
      && worker.includes("request.headers.get(\"User-Agent\")")
      && worker.includes("server.serializeAttachment({ role, id, os")
      && worker.includes('headers.set("X-OWLLM-City"')
      && worker.includes("ALTER TABLE nodes ADD COLUMN os TEXT NOT NULL DEFAULT 'Other'")
      && worker.includes("region = excluded.region, os = excluded.os"));
  check("Country summary labels have all eight locales",
    /\["Users by country",(?:[^\]]*,){6}[^\]]*\]/.test(actions)
      && /\["Total users",(?:[^\]]*,){6}[^\]]*\]/.test(actions)
      && /\["Online users",(?:[^\]]*,){6}[^\]]*\]/.test(actions)
      && /\["users online",(?:[^\]]*,){6}[^\]]*\]/.test(actions)
      && /\["Click the flag for connection details",(?:[^\]]*,){6}[^\]]*\]/.test(actions)
      && /\["Unknown city",(?:[^\]]*,){6}[^\]]*\]/.test(actions)
      && /\["Server",(?:[^\]]*,){6}[^\]]*\]/.test(actions));
  check("Flag font is bundled for Windows (no native flag emoji)", fs.statSync(path.join(UI, "../public/fonts/TwemojiCountryFlags.woff2")).size > 50_000);
  const styles = read("styles.css");
  check("Flag font is registered flag-codepoints-only and first in the stack", styles.includes('font-family: "Twemoji Country Flags"') && styles.includes("unicode-range: U+1F1E6-1F1FF") && styles.includes('font-family: "Twemoji Country Flags", "Segoe UI"'));

  for (const row of checks) console.log(`  PASS ${row.name}`);
  console.log(`world map verification: ${checks.length}/${checks.length} passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
