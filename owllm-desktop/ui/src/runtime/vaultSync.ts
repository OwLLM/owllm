// Cross-device sync engine (front-end half).
//
// The app's user state — chat history, drafts, goals, settings, model picks,
// per-agent prefs — lives in localStorage (chatRuntime delegates chat
// persistence to localStorage; pages keep their own prefs there too). So
// "everything everywhere" = mirror the syncable localStorage keys into the
// user's private owllm-vault repo and adopt the newest copy on each device.
//
// Protocol (last-write-wins by timestamp, conflict-free for sequential
// device use):
//   • The vault holds ONE blob: state/local.json =
//       { syncedAt: <ms>, device: <id>, data: { <key>: <value>, … } }
//   • On launch (vault cloned): read the REMOTE blob; if it's newer than what
//     this device last adopted/pushed, write its keys into localStorage,
//     fast-forward the clone (vault_align), and reload so every store repaints.
//   • On change/idle/close: snapshot localStorage → vault_write_state (commit
//     + push). We bump our adopted-marker so our own push doesn't look "new".
//
// Secrets never touch this — they live in the Rust accounts store, not
// localStorage. Device-local keys (sync markers, one-time wizard flags,
// regenerable caches, machine-specific workspace paths) are denied below.

import { invoke } from "@tauri-apps/api/core";
import { vaultEnsure, vaultStatus } from "../pages/agentic/github";

// Device-local marker of the newest blob we've adopted OR pushed. Compared
// against the remote blob's syncedAt to decide whether to adopt. NOT synced.
const LAST_KEY = "owllm:sync-last";
const DEVICE_KEY = "owllm:sync-device";
const USER_INTERACTED_KEY = "owllm:session:user-interacted";

// Keys that must NOT sync (device-local / regenerable / machine-specific).
const DENY_EXACT = new Set<string>([
  "owllm:sync-onboard-seen", // per-device onboarding dismissal
  "owllm:sync-last",         // this marker
  "owllm:sync-device",       // this device's id
  "owllm.wizard.completed",  // per-device module setup
  "owllm:cloud-models-remote", // regenerated from the remote catalogue
  "owllm:world-map:presence-enabled", // consent is independent per device
  "owllm:world-map:presence-token",   // anonymous server token is device-local
  // Open tabs and their selected project are workspace UI on THIS computer.
  // Project/chat content syncs separately through SQLite; syncing these keys
  // made another PC's open projects suddenly become this PC's open pages.
  "owllm:agents:pages",
  "owllm:agents:activePage",
  "owllm:assets:selectedProject",
]);
// Prefixes for machine-specific state that shouldn't follow the user (paths
// to WSL workspaces differ per device).
const DENY_PREFIX = [
  "owllm:code:",
  "owllm:agents:page:",
];

function isSyncable(key: string): boolean {
  if (DENY_EXACT.has(key)) return false;
  if (DENY_PREFIX.some((p) => key.startsWith(p))) return false;
  return key.startsWith("owllm:") || key.startsWith("owllm.");
}

let _stableDeviceId: string | null = null;

async function deviceId(): Promise<string> {
  if (_stableDeviceId) return _stableDeviceId;
  try {
    // One identity system everywhere: Rust's persisted cryptographic device id
    // also keys project.locations. The former random localStorage id vanished
    // with the very profile migration it was supposed to identify.
    _stableDeviceId = await invoke<string>("device_get_id");
    try { localStorage.setItem(DEVICE_KEY, _stableDeviceId); } catch { /* marker only */ }
    return _stableDeviceId;
  } catch {
    // Compatibility fallback for a damaged identity store. Keep it stable for
    // this profile, but never generate a new id on every call.
    try {
      let d = localStorage.getItem(DEVICE_KEY);
      if (!d) {
        d = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        localStorage.setItem(DEVICE_KEY, d);
      }
      _stableDeviceId = d;
      return d;
    } catch {
      return "unknown";
    }
  }
}

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !isSyncable(k)) continue;
      const v = localStorage.getItem(k);
      if (v != null) out[k] = v;
    }
  } catch { /* private mode */ }
  return out;
}

type Blob = { syncedAt: number; device: string; data: Record<string, string> };

let _started = false;
let _enabled = false;
let _listenersWired = false;
let _pushTimer: ReturnType<typeof setTimeout> | null = null;
let _lastSnapshotJson = "";

function getLast(): number {
  try { return Number(localStorage.getItem(LAST_KEY) || "0") || 0; } catch { return 0; }
}
function setLast(ts: number): void {
  try { localStorage.setItem(LAST_KEY, String(ts)); } catch { /* ignore */ }
}

/// Pull the remote blob and adopt it if newer than what we last saw.
/// Returns true when localStorage was changed (caller should reload).
async function pullAndAdopt(): Promise<boolean> {
  let raw: string | null = null;
  try { raw = await invoke<string | null>("vault_read_remote_state"); } catch { return false; }
  if (!raw) return false;
  let blob: Blob;
  try { blob = JSON.parse(raw) as Blob; } catch { return false; }
  if (!blob?.syncedAt || blob.device === await deviceId()) return false;
  if (blob.syncedAt <= getLast()) return false;
  // Adopt: write each synced key. We DON'T delete local-only keys — a merge,
  // not a mirror, so device-local prefs survive.
  for (const [k, v] of Object.entries(blob.data || {})) {
    // Old vault blobs can still contain page/folder bindings from versions
    // before the deny-list was corrected. Never re-import them.
    if (!isSyncable(k)) continue;
    try { localStorage.setItem(k, v); } catch { /* quota */ }
  }
  setLast(blob.syncedAt);
  try { await invoke("vault_align"); } catch { /* best effort */ }
  return true;
}

/// Snapshot + push localStorage to the vault. No-op if nothing changed since
/// the last push (cheap dedupe via the serialized snapshot).
export async function pushNow(force = false): Promise<void> {
  if (!_enabled) return;
  const data = snapshot();
  const dataJson = JSON.stringify(data);
  if (!force && dataJson === _lastSnapshotJson) return;
  const syncedAt = Date.now();
  const blob: Blob = { syncedAt, device: await deviceId(), data };
  try {
    await invoke("vault_write_state", { json: JSON.stringify(blob) });
    _lastSnapshotJson = dataJson;
    setLast(syncedAt); // our own push isn't "newer" to us next launch
  } catch (e) {
    console.warn("[vaultSync] push failed", e);
  }
}

function schedulePush(): void {
  if (!_enabled) return;
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => { _pushTimer = null; void pushNow(); }, 4000);
}

// Projects + chats live in SQLite, not localStorage, so the blob sync above
// never carries them. vault_sync_projects mirrors the agent_projects rows
// (name, team, graph, chat transcript, agent logs) through the vault,
// last-writer-wins per project. When it imports a newer copy from another
// device we fire owllm:projects:refresh so the Agents page reloads.
let _projSyncing = false;
let _projectSyncTimer: ReturnType<typeof setTimeout> | null = null;
export async function syncProjectsNow(): Promise<boolean> {
  if (!_enabled || _projSyncing) return false;
  _projSyncing = true;
  try {
    const changed = await invoke<boolean>("vault_sync_projects");
    if (changed) {
      // Refresh the project list + active chat in place (mid-session callers).
      try { window.dispatchEvent(new CustomEvent("owllm:projects:refresh")); } catch { /* non-browser */ }
    }
    return changed;
  } catch (e) {
    console.warn("[vaultSync] project sync failed", e);
    return false;
  } finally {
    _projSyncing = false;
  }
}

function scheduleProjectSync(): void {
  if (!_enabled) return;
  if (_projectSyncTimer) clearTimeout(_projectSyncTimer);
  _projectSyncTimer = setTimeout(() => {
    _projectSyncTimer = null;
    void syncProjectsNow();
  }, 4000);
}

// Remote-device records (public metadata: name, OS, version, LAN endpoint,
// capabilities) sync through the vault too, so "My OwLLM Devices" auto-populates
// across the account. Metadata only — control never flows through git. On a
// change we fire owllm:devices:refresh so the Devices page reloads.
let _devSyncing = false;
export async function syncDevicesNow(): Promise<boolean> {
  if (!_enabled || _devSyncing) return false;
  _devSyncing = true;
  try {
    const changed = await invoke<boolean>("vault_sync_devices");
    if (changed) {
      try { window.dispatchEvent(new CustomEvent("owllm:devices:refresh")); } catch { /* non-browser */ }
    }
    return changed;
  } catch (e) {
    console.warn("[vaultSync] device sync failed", e);
    return false;
  } finally {
    _devSyncing = false;
  }
}

// Code-signing metadata (identity, team, expiry — never the certificate bytes
// or passwords) syncs through the vault too, so the user's other PCs SEE that
// signing is configured and know to import the .p12 locally. Metadata only —
// secret material never enters the git repo. On a change we fire
// owllm:signing:refresh so an open Signing page reloads.
let _signSyncing = false;
export async function syncSigningNow(): Promise<boolean> {
  if (!_enabled || _signSyncing) return false;
  _signSyncing = true;
  try {
    const changed = await invoke<boolean>("vault_sync_signing");
    if (changed) {
      try { window.dispatchEvent(new CustomEvent("owllm:signing:refresh")); } catch { /* non-browser */ }
    }
    return changed;
  } catch (e) {
    console.warn("[vaultSync] signing sync failed", e);
    return false;
  } finally {
    _signSyncing = false;
  }
}

/// A vault adoption rewrites localStorage/SQLite under every store's feet, so
/// a full reload is the blunt-but-reliable repaint. But each reload re-runs
/// main.tsx — including the update prompt's fresh check() — and two devices
/// converging can report "changed" for SEVERAL successive sync cycles, so the
/// update dialog flashed in and out 3-4 times at launch. Allow ONE reload per
/// launch (sessionStorage survives reloads); after that, repaint in place via
/// the refresh event and let the next launch pick up any residual diff.
function reloadOnce(): boolean {
  try {
    // Once the user has clicked or typed, a full reload would cancel their
    // work just because a background sync finished. Components that own data
    // receive their normal refresh events below instead; a complete repaint is
    // only acceptable during an untouched initial boot.
    if (sessionStorage.getItem(USER_INTERACTED_KEY) === "1") return false;
    if (sessionStorage.getItem("owllm:vault:reloaded")) return false;
    sessionStorage.setItem("owllm:vault:reloaded", "1");
  } catch { return false; /* storage blocked → never risk a reload loop */ }
  location.reload();
  return true;
}

/// Start the sync engine once at app launch. Safe to call when logged out /
/// no vault — it just no-ops. Wired from ChatRuntimeProvider.
export async function startVaultSync(): Promise<void> {
  if (_started) return;
  _started = true;
  let st;
  try {
    st = await vaultStatus();
    if (!st?.connected) return; // signed out → local-only
    // A reinstall/profile repair can preserve the encrypted GitHub account
    // while losing the local vault clone. Previously startup returned here
    // forever, so projects on the user's existing remote vault never reached
    // this PC unless they manually reopened the account modal. Self-heal the
    // clone on every connected startup; vaultEnsure is idempotent.
    if (!st.cloned) st = await vaultEnsure();
  } catch (e) {
    // Do not permanently latch startup off after a transient clone/network
    // failure. A later account action (or the next launch) may retry safely.
    _started = false;
    console.warn("[vaultSync] vault startup failed", e);
    return;
  }
  if (!st.cloned) {
    _started = false;
    return;
  }
  _enabled = true;

  // 1) Adopt newer remote state, then reload (once) so every store repaints.
  if (await pullAndAdopt()) {
    if (reloadOnce()) return;
    // Already reloaded this launch — repaint what we can in place and carry on.
    try { window.dispatchEvent(new CustomEvent("owllm:projects:refresh")); } catch { /* non-browser */ }
  }
  // 2) Seed/refresh the vault with our current state (covers a fresh device
  //    that has nothing remote yet).
  _lastSnapshotJson = JSON.stringify(snapshot());
  void pushNow(true);

  // 2b) Sync custom agent teams + roles (files, not localStorage) — union
  //     across devices. Fire-and-forget; failures don't block.
  invoke("vault_sync_teams").catch(() => {});

  // 2b2) Sync remote-device records (metadata only) so the fleet is discoverable.
  void syncDevicesNow();

  // 2b3) Sync code-signing metadata (non-secret) so signed-release config follows the user.
  void syncSigningNow();

  // 2c) Sync projects + chats (SQLite rows) so conversations follow the user.
  //     If we pulled in newer projects/chats from another device, reload (once)
  //     so the whole UI repaints from the freshly-synced database.
  //     syncProjectsNow already fired owllm:projects:refresh as the in-place
  //     fallback when the reload budget is spent.
  if (await syncProjectsNow() && reloadOnce()) return;

  // 3) Keep pushing on the moments that matter.
  wireListeners();
}

/// Enable sync right after the user connects + the vault is created (so they
/// don't have to restart). The vault is fresh/empty, so we just push our
/// current state to seed it and start watching for changes.
export async function onVaultConnected(): Promise<void> {
  _enabled = true;
  _started = true;
  wireListeners();
  _lastSnapshotJson = JSON.stringify(snapshot());
  await pushNow(true);
  invoke("vault_sync_teams").catch(() => {});
  void syncDevicesNow();
  void syncSigningNow();
  if (await syncProjectsNow()) reloadOnce();
}

/// Push on tab-hidden, app-close, and a debounced diff poll (localStorage's
/// 'storage' event only fires cross-tab, so same-tab writes need the poll).
function wireListeners(): void {
  if (_listenersWired) return;
  _listenersWired = true;
  const onHide = () => { if (document.visibilityState === "hidden") { void pushNow(); void syncProjectsNow(); } };
  const onMemoryChanged = () => scheduleProjectSync();
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("owllm:memory:changed", onMemoryChanged as EventListener);
  window.addEventListener("beforeunload", () => { void pushNow(); void syncProjectsNow(); });
  window.setInterval(() => {
    if (!_enabled) return;
    const j = JSON.stringify(snapshot());
    if (j !== _lastSnapshotJson) schedulePush();
  }, 5000);
  // SQLite changes do not affect the localStorage snapshot above. Periodically
  // reconcile projects/facts as a backstop for native memory writes and abrupt
  // exits; event-driven writes normally sync after the 4-second debounce.
  window.setInterval(() => { if (_enabled) void syncProjectsNow(); }, 60_000);
}
