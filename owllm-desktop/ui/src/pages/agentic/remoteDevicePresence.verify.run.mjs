// Regression gate for the v1.0.28 "Mac is running but shown offline" failure.
// Presence must be owned by the native backend: renderer timers are suspended
// by background/App-Nap policies, and a dead listener must be reaped before an
// idempotent start can decide that it is already healthy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

const T = "../../../../src-tauri/src";
const mod = read(`${T}/remote_devices/mod.rs`);
const lan = read(`${T}/remote_devices/lan.rs`);
const p2p = read(`${T}/remote_devices/p2p.rs`);
const vault = read(`${T}/vault.rs`);
const uiSync = read("../../runtime/vaultSync.ts");
const deviceSyncStart = vault.indexOf("pub async fn vault_sync_devices()");
const deviceSyncEnd = vault.indexOf("/// Sync the code-signing metadata", deviceSyncStart);
const deviceSync = vault.slice(deviceSyncStart, deviceSyncEnd);
const lanCurrentPort = lan.slice(
  lan.indexOf("pub fn current_port()"),
  lan.indexOf("pub fn current_endpoint()"),
);
const lanStart = lan.slice(lan.indexOf("pub fn start("), lan.indexOf("let server =", lan.indexOf("pub fn start(")));
const p2pAcceptLoop = p2p.slice(
  p2p.indexOf("async fn accept_loop("),
  p2p.indexOf("/// Decode + dispatch", p2p.indexOf("async fn accept_loop(")),
);

check(
  /const DEVICE_HEALTHCHECK_INTERVAL:[\s\S]*?Duration::from_secs\(30\)/.test(mod),
  "native supervisor checks remote-device transports every 30 seconds",
);
check(
  /pub fn init\(app: &AppHandle\)[\s\S]*?MissedTickBehavior::Delay[\s\S]*?ensure_listener_started[\s\S]*?vault_sync_devices\(\)\.await/.test(mod),
  "app launch owns a native listener + heartbeat supervisor independent of the WebView",
);
check(
  /vault_sync_devices\(\)\.await[\s\S]{0,240}?owllm:devices:refresh/.test(mod),
  "native peer ingestion refreshes an already-open Devices page",
);
check(
  deviceSync.includes("let _gate = vault_admit().await;") &&
    !deviceSync.includes("vault_admit_now()"),
  "device heartbeat waits for the vault gate instead of silently dropping the beat",
);
check(
  !uiSync.includes("REMOTE_DEVICE_HEARTBEAT_MS") &&
    !/setInterval\([^\n]*syncDevicesNow/.test(uiSync),
  "presence no longer depends on a renderer interval",
);
check(
  /fn reap_finished_listener\(state: &mut ListenerState\)[\s\S]*?(?:JoinHandle::is_finished|is_finished\(\))[\s\S]*?state\.port = None/.test(lan) &&
    /fn exited_listener_is_reaped_before_health_is_reported/.test(lan),
  "LAN state reaps an exited listener instead of reporting its stale port forever",
);
check(
  lanCurrentPort.includes("reap_finished_listener(&mut state)") &&
    lanStart.includes("reap_finished_listener(&mut state)"),
  "both listener status and restart paths detect a dead listener",
);
check(
  p2pAcceptLoop.includes("RUNNING.store(false") &&
    p2pAcceptLoop.includes("held.id() == endpoint_id") &&
    p2pAcceptLoop.includes("g.take()"),
  "P2P accept-loop exit clears the stale running endpoint",
);

console.log(`OK remote device native presence: ${passed}/${passed} checks passed`);
