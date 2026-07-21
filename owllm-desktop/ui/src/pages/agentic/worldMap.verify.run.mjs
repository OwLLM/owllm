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

  const sanitized = presence.sanitizePresenceNodes([
    { id: "ok", region: "EU West", latitude: 48, longitude: 9, lastSeen: "now", github_login: "must-not-leak" },
    { id: "bad-lat", latitude: 200, longitude: 9 },
    { id: "ok", latitude: 1, longitude: 2 },
  ]);
  check("Presence payload validates and deduplicates coordinates", sanitized.length === 1 && sanitized[0].id === "ok");
  check("Public nodes expose no account/device identity fields", !Object.hasOwn(sanitized[0], "github_login") && Object.keys(sanitized[0]).length === 5);

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
  viewerSockets[0].emit("message", { data: JSON.stringify({ type: "upsert", node: { id: "n2", region: "EU", latitude: 42, longitude: 12 } }) });
  check("Viewer applies incremental presence updates", snapshots.at(-1).nodes.map((node) => node.id).join(",") === "n1,n2");
  viewerSockets[0].emit("message", { data: JSON.stringify({ type: "remove", id: "n1" }) });
  check("Viewer removes disconnected nodes immediately", snapshots.at(-1).nodes.map((node) => node.id).join(",") === "n2");
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
  check("Opted-in installation opens one anonymous presence socket", presenceSockets.length === 1 && presenceSockets[0].url.endsWith("role=presence"));
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
  check("Globe bundles photographic Earth texture layers", page.includes("EARTH_TEXTURES.day") && page.includes("EARTH_TEXTURES.normal") && page.includes("EARTH_TEXTURES.specular") && page.includes("EARTH_TEXTURES.clouds"));
  check("Globe uses calibrated color and tone mapping", page.includes("THREE.SRGBColorSpace") && page.includes("THREE.ACESFilmicToneMapping") && page.includes("THREE.HemisphereLight"));
  check("Globe follows the readable selected GUI accent", page.includes('getPropertyValue("--accent-ink")') && page.includes("accent={colors.accentInk}"));
  check("My Fleet consumes real paired-device state", page.includes("getIdentity()") && page.includes("listDevices()") && page.includes("device.is_self"));
  check("My Fleet always includes the current installation", page.includes("fleetWithSelf(identity, devices)") && page.includes("is_self: true"));
  check("Fleet satellites have aligned orbit paths and labels", page.includes("orbitPosition({ ...orbit") && page.includes("satelliteLabel(node.label"));
  for (const asset of ["earth-day.jpg", "earth-normal.jpg", "earth-specular.jpg", "earth-clouds.png"]) {
    check(`Bundled Earth asset exists: ${asset}`, fs.statSync(path.join(UI, "../public/world-map", asset)).size > 100_000);
  }
  check("Public mode has an explicit anonymous-presence control", page.includes('type="checkbox"') && page.includes("savePresenceEnabled"));
  check("World Map consumes live WebSocket snapshots", page.includes("subscribeWorldPresence") && !page.includes("loadWorldPresence"));
  check("Opted-in presence runs application-wide", appShell.includes("<WorldPresenceRunner />") && appShell.includes("installWorldPresenceConnection()"));
  check("Consent remains device-local", vaultSync.includes('"owllm:world-map:presence-enabled"'));
  check("Worker uses hibernating sockets without retained presence", worker.includes("acceptWebSocket") && worker.includes("serializeAttachment") && !/INSERT INTO|CREATE TABLE|scheduled\s*\(/i.test(worker));
  check("Worker broadcasts incremental membership changes", worker.includes('type: "upsert"') && worker.includes('type: "remove"'));
  check("Wrangler binds a free SQLite-backed Durable Object without D1", wrangler.includes("new_sqlite_classes") && !wrangler.includes("d1_databases"));
  check("Unavailable service is disclosed", page.includes("World presence service is not connected yet."));
  check("New navigation labels have all eight locales", /\["World Map",(?:[^\]]*,){6}[^\]]*\]/.test(actions) && /\["Live World",(?:[^\]]*,){6}[^\]]*\]/.test(actions));

  for (const row of checks) console.log(`  PASS ${row.name}`);
  console.log(`world map verification: ${checks.length}/${checks.length} passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
