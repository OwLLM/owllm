#!/usr/bin/env node
// Regression gate for duplicate + undeletable device records.
//
// The symptom: one PC that had re-paired 17 times showed as 17 rows in "My
// OwLLM Devices" and 17 satellites in the World Map fleet orbit (36 rows for 9
// real machines on the reporting install), and pressing ✕ removed a row that
// came straight back on the next vault beat.
//
// The mechanism: `device_id` is `hex(SHA-256(ed25519_pub))` — stable per
// KEYPAIR, not per machine — and every dead identity keeps its own
// `state/devices/<id>.json` in the account vault forever, so `vault_sync_devices`
// re-ingested the whole graveyard after every local prune.
//
// Two layers, and unlike the older Rust-backed gates BOTH run by default:
//   1. source contract — the rules exist, are pure, and are actually wired into
//      the registry / vault / both views (a rule nothing calls is not a fix);
//   2. executed proof — `devices-harness` runs the real canonical.rs through
//      multi-PC sync, repeated logins, deletion, restart and a stale client,
//      plus canonical.rs's own unit tests.
//
// Layer 2 needs cargo. If cargo is missing this FAILS rather than skipping:
// a gate that quietly downgrades to "the source still mentions the function"
// is how these bugs came back the first time.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");

let passed = 0;
const failures = [];
const check = (cond, label) => {
  if (cond) passed += 1;
  else failures.push(label);
};

// A missing file is reported as a failure, not a crash: this gate has to run
// legibly against an older tree when someone asks "did this ever work?".
// CRLF-normalized because `*.rs` is not pinned to LF in .gitattributes, and a
// needle spanning a line break has false-failed the release gate before.
const read = (rel) => {
  try {
    return fs.readFileSync(path.join(APP, rel), "utf8").replace(/\r\n/g, "\n");
  } catch {
    failures.push(`missing file: ${rel}`);
    return "";
  }
};

const canonical = read("src-tauri/src/remote_devices/canonical.rs");
const protocol = read("src-tauri/src/remote_devices/protocol.rs");
const identity = read("src-tauri/src/remote_devices/identity.rs");
const hardware = read("src-tauri/src/hardware.rs");
const registry = read("src-tauri/src/remote_devices/registry.rs");
const mod = read("src-tauri/src/remote_devices/mod.rs");
const vault = read("src-tauri/src/vault.rs");
const bindings = read("ui/src/pages/advanced/remoteDevices.ts");
const devicesPage = read("ui/src/pages/advanced/DevicesPage.tsx");
const worldMap = read("ui/src/pages/gamify/WorldMapPage.tsx");
const harness = read("src-tauri/devices-harness/src/main.rs");

// ---------------------------------------------------------------------------
// 1. A stable per-MACHINE identifier exists and is published
// ---------------------------------------------------------------------------
check(/pub fn machine_uid\(\)/.test(hardware), "hardware::machine_uid is missing");
for (const [os, needle] of [
  ["windows", "MachineGuid"],
  ["linux", "/etc/machine-id"],
  ["macos", "IOPlatformUUID"],
]) {
  check(hardware.includes(needle), `machine_uid has no ${os} source (${needle})`);
}
check(
  /#\[cfg\(not\(any\(target_os = "windows", target_os = "linux", target_os = "macos"\)\)\)\]/.test(hardware),
  "machine_uid has no fallback arm — an unlisted OS would fail to compile",
);
check(
  /OnceLock/.test(hardware.slice(hardware.indexOf("pub fn machine_uid"), hardware.indexOf("fn read_machine_uid_os"))),
  "machine_uid is not cached — it runs on every vault beat and shells out",
);
check(/pub fn machine_key\(\)/.test(identity), "identity::machine_key is missing");
check(
  identity.includes("MACHINE_KEY_DOMAIN") && identity.includes("Sha256"),
  "machine_key must be a domain-separated hash, never the raw OS machine id",
);
check(
  /machine_key: machine_key\(\)/.test(identity),
  "public_record no longer publishes the machine key — records cannot be grouped",
);
check(
  /#\[serde\(default\)\]\s*pub machine_key: Option<String>/.test(protocol),
  "DevicePublic.machine_key must be #[serde(default)] so older records still parse",
);

// ---------------------------------------------------------------------------
// 2. The canonical rules are pure, so the harness executes the shipped code
// ---------------------------------------------------------------------------
for (const fn of [
  "pub fn canonicalize",
  "pub fn accepts_ingest",
  "pub fn suppressed_by",
  "pub fn clears_tombstone",
  "pub fn merge_tombstones",
  "pub fn order_for_resolution",
  "pub struct Tombstone",
]) {
  check(canonical.includes(fn), `canonical.rs is missing ${fn}`);
}
for (const impurity of ["crate::", "tauri::", "std::fs", "std::process"]) {
  check(
    !canonical.includes(impurity),
    `canonical.rs must stay pure (found ${impurity}) or devices-harness cannot compile it`,
  );
}
check(
  canonical.includes("deleted_at"),
  "a tombstone without a deletion instant cannot tell a stale record from a live one",
);
check(
  /published <= deleted/.test(canonical),
  "tombstone suppression no longer compares the heartbeat against the deletion — either every deleted device is permanent, or none are",
);
check(
  /!rec\.is_self && suppressed_by/.test(canonical),
  "canonicalize must never tombstone the machine the user is sitting at",
);

// ---------------------------------------------------------------------------
// 3. The registry actually applies them — at INGEST, not only at read
// ---------------------------------------------------------------------------
check(
  /canonical::accepts_ingest\(&public, &f\.devices, &tombs\)/.test(registry),
  "registry::upsert no longer filters incoming records — the vault will re-add every dead identity",
);
check(
  /canonical::canonicalize\(f\.devices, &tombstones\(\)\)/.test(registry),
  "registry::list no longer returns the canonical collection",
);
check(
  /pub fn forget\(device_id: &str\) -> Result<Tombstone, String>/.test(registry),
  "registry::forget must return a tombstone to publish; a local retain() alone never stuck",
);
check(
  registry.includes("it cannot be removed"),
  "registry::forget no longer refuses to delete this machine",
);
check(
  /pub fn upsert_paired/.test(registry) && /clears_tombstone/.test(registry),
  "a re-pairing handshake must clear the tombstone, or a re-paired device can never reappear",
);
check(
  /registry::upsert_paired/.test(mod) && /registry::upsert_paired/.test(read("src-tauri/src/remote_devices/lan.rs")),
  "the pairing paths no longer use upsert_paired",
);

// ---------------------------------------------------------------------------
// 4. Deletion reaches the authoritative store and the other PCs
// ---------------------------------------------------------------------------
check(
  /pub async fn device_forget/.test(mod) && mod.includes("vault_publish_device_tombstone"),
  "device_forget no longer publishes the deletion to the vault",
);
check(
  /pub async fn vault_publish_device_tombstone/.test(vault),
  "vault::vault_publish_device_tombstone is missing",
);
const publishBody = vault.slice(
  vault.indexOf("pub async fn vault_publish_device_tombstone"),
  vault.indexOf("/// Sync the code-signing metadata"),
);
check(
  publishBody.includes("remove_file(dev_dir.join"),
  "publishing a tombstone must also delete the device's vault record file",
);
const syncBody = vault.slice(
  vault.indexOf("pub async fn vault_sync_devices"),
  vault.indexOf("pub async fn vault_publish_device_tombstone"),
);
const applyAt = syncBody.indexOf("apply_device_tombstones");
const ingestAt = syncBody.indexOf("ingest_peer_record");
check(
  applyAt >= 0 && ingestAt >= 0 && applyAt < ingestAt,
  "vault_sync_devices must apply peers' tombstones BEFORE reading records, or the read resurrects them",
);
check(
  syncBody.includes("device_tombstones()") && syncBody.includes("tomb_dir"),
  "vault_sync_devices no longer publishes this PC's deletions",
);

// ---------------------------------------------------------------------------
// 5. Both views consume the one collection, and both can delete from it
// ---------------------------------------------------------------------------
check(
  bindings.includes("export async function forgetDeviceEverywhere"),
  "the shared deletion path is missing",
);
check(
  /forgetDeviceEverywhere[\s\S]{0,240}owllm:devices:refresh/.test(bindings),
  "forgetDeviceEverywhere no longer broadcasts the refresh — the other view keeps the stale row",
);
check(
  devicesPage.includes("rd.forgetDeviceEverywhere(id)"),
  "the Devices list ✕ no longer uses the shared deletion path",
);
check(
  worldMap.includes("forgetDeviceEverywhere"),
  "the World Map fleet cannot delete a device",
);
check(
  /selected\.kind === "fleet" && selected\.id !== selfId/.test(worldMap),
  "the World Map remove button must not offer to delete this machine",
);
for (const [file, source] of [["DevicesPage", devicesPage], ["WorldMapPage", worldMap]]) {
  check(source.includes("listDevices()"), `${file} no longer reads the canonical device list`);
}
check(
  /window\.addEventListener\("owllm:devices:refresh"/.test(worldMap) &&
    /window\.addEventListener\("owllm:devices:refresh"/.test(devicesPage),
  "a view that never listens for the refresh will show a device the other one deleted",
);

// ---------------------------------------------------------------------------
// 6. The executed proof covers every reported scenario
// ---------------------------------------------------------------------------
check(
  harness.includes('#[path = "../../src/remote_devices/canonical.rs"]'),
  "devices-harness no longer compiles the exact canonical.rs the app ships",
);
for (const scenario of [
  "control_pre_fix_behaviour_reproduces_the_bug",
  "legacy_duplicate_cleanup",
  "repeated_logins_stay_one_row",
  "deletion_persists_across_sync_restart_and_peers",
  "deletion_from_either_view_matches",
  "stale_client_cannot_resurrect",
  "a_live_device_can_come_back",
  "multi_device_sync_converges",
]) {
  check(harness.includes(`fn ${scenario}`), `harness scenario missing: ${scenario}`);
}

// ---------------------------------------------------------------------------
// 7. Run it
// ---------------------------------------------------------------------------
const manifest = path.join(APP, "src-tauri/devices-harness/Cargo.toml");
const cargo = (args) =>
  spawnSync("cargo", [...args, "--manifest-path", manifest], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

const probe = cargo(["run", "--quiet"]);
if (probe.error && probe.error.code === "ENOENT") {
  failures.push("cargo is not on PATH — the executed device-identity proof cannot run");
} else {
  const out = `${probe.stdout || ""}${probe.stderr || ""}`;
  if (probe.status !== 0) {
    failures.push(`devices-harness scenarios failed:\n${out.trim()}`);
  } else {
    passed += (out.match(/^PASS /gm) || []).length;
    console.log(out.trim());
  }
  const units = cargo(["test", "--quiet"]);
  const unitOut = `${units.stdout || ""}${units.stderr || ""}`;
  if (units.status !== 0) {
    failures.push(`canonical.rs unit tests failed:\n${unitOut.trim()}`);
  } else {
    const count = /(\d+) passed/.exec(unitOut);
    passed += count ? Number(count[1]) : 0;
    console.log(unitOut.trim().split("\n").slice(-1)[0]);
  }
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`FAIL device identity: ${failures.length} problem(s), ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS device identity: ${passed} checks (source contract + executed harness)`);
