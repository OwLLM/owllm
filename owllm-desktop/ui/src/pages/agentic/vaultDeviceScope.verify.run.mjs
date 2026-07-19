// Regression pins for cross-device state boundaries. Project/chat content is
// shared; open tabs, selected projects and absolute folders belong to a single
// device and must never be adopted from a peer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");
const DESKTOP = path.resolve(SRC, "../..");
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const check = (ok, message) => {
  if (!ok) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};

const sync = read(path.join(SRC, "runtime", "vaultSync.ts"));
for (const key of [
  "owllm:agents:pages",
  "owllm:agents:activePage",
  "owllm:assets:selectedProject",
]) {
  check(sync.includes(`"${key}"`), `${key} is device-local`);
}
check(sync.includes('"owllm:agents:page:"'), "per-page project selection is device-local");
check(sync.includes("if (!isSyncable(k)) continue"),
  "old remote blobs cannot re-import newly denied device-local keys");
check(sync.includes('invoke<string>("device_get_id")'),
  "vault metadata uses the backend's stable cryptographic device id");

const remote = read(path.join(DESKTOP, "src-tauri", "src", "remote_devices", "mod.rs"));
check(remote.includes("pub fn device_get_id()") && remote.includes("self_device_id()"),
  "the UI identity and folder-map identity are the same backend id");

const vault = read(path.join(DESKTOP, "src-tauri", "src", "vault.rs"));
check(vault.includes("belongs_to_peer") && vault.includes("reconcile project location"),
  "existing legacy project rows reconcile foreign folder paths");
check(vault.includes("fn import_clears_existing_foreign_legacy_path"),
  "a regression test covers already-contaminated project rows");
check(vault.includes("fn import_restores_this_devices_path_on_existing_row"),
  "a regression test covers same-device folder restoration");
const projects = read(path.join(DESKTOP, "src-tauri", "src", "projects.rs"));
check(projects.includes("location_device_id") && projects.includes("Path::new(&location).is_dir()"),
  "legacy rows are locally owned only when their folder exists on this computer");
check(projects.includes("CASE WHEN location_device_id = ?1 THEN location ELSE '' END"),
  "the project API never exposes a folder owned by another device");

console.log(`\nall checks passed (${passed})`);
