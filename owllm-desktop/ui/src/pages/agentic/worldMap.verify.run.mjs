import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)));
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
  };
};

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

  let request = null;
  const fetcher = async (url, init) => {
    request = { url, init };
    return { ok: true, status: 200, json: async () => ({ nodes: [{ id: "n1", region: "AP", latitude: 35, longitude: 127 }] }) };
  };
  const snapshot = await presence.loadWorldPresence(undefined, fetcher, "https://presence.example/");
  check("Configured service loads real snapshot nodes", snapshot.configured && snapshot.nodes.length === 1);
  check("Snapshot uses the versioned presence endpoint", request.url === "https://presence.example/v1/presence" && request.init.method === "GET");
  await presence.sendAnonymousHeartbeat(true, undefined, fetcher, "https://presence.example");
  check("Heartbeat sends an empty anonymous body", request.init.method === "POST" && request.init.body === "{}");
  const offline = await presence.loadWorldPresence(undefined, fetcher, "");
  check("Missing service stays honest instead of fabricating users", !offline.configured && offline.nodes.length === 0);

  const page = read("pages/gamify/WorldMapPage.tsx");
  const modules = read("core/modules.ts");
  const home = read("pages/core/HomePage.tsx");
  const actions = read("localization/catalog.actions.ts");
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
  check("Public mode has an explicit anonymous-presence control", page.includes('type="checkbox"') && page.includes("sendAnonymousHeartbeat"));
  check("Unavailable service is disclosed", page.includes("World presence service is not connected yet."));
  check("New navigation labels have all eight locales", /\["World Map",(?:[^\]]*,){6}[^\]]*\]/.test(actions) && /\["Live World",(?:[^\]]*,){6}[^\]]*\]/.test(actions));

  for (const row of checks) console.log(`  PASS ${row.name}`);
  console.log(`world map verification: ${checks.length}/${checks.length} passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
