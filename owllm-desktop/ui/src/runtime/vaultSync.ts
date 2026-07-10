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
import { vaultStatus } from "../pages/agentic/github";

// Device-local marker of the newest blob we've adopted OR pushed. Compared
// against the remote blob's syncedAt to decide whether to adopt. NOT synced.
const LAST_KEY = "owllm:sync-last";
const DEVICE_KEY = "owllm:sync-device";

// Keys that must NOT sync (device-local / regenerable / machine-specific).
const DENY_EXACT = new Set<string>([
  "owllm:sync-onboard-seen", // per-device onboarding dismissal
  "owllm:sync-last",         // this marker
  "owllm:sync-device",       // this device's id
  "owllm.wizard.completed",  // per-device module setup
  "owllm:cloud-models-remote", // regenerated from the remote catalogue
]);
// Prefixes for machine-specific state that shouldn't follow the user (paths
// to WSL workspaces differ per device).
const DENY_PREFIX = ["owllm:code:"];

function isSyncable(key: string): boolean {
  if (DENY_EXACT.has(key)) return false;
  if (DENY_PREFIX.some((p) => key.startsWith(p))) return false;
  return key.startsWith("owllm:") || key.startsWith("owllm.");
}

function deviceId(): string {
  try {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d) {
      d = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      localStorage.setItem(DEVICE_KEY, d);
    }
    return d;
  } catch {
    return "unknown";
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
  if (!blob?.syncedAt || blob.device === deviceId()) return false;
  if (blob.syncedAt <= getLast()) return false;
  // Adopt: write each synced key. We DON'T delete local-only keys — a merge,
  // not a mirror, so device-local prefs survive.
  for (const [k, v] of Object.entries(blob.data || {})) {
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
  const blob: Blob = { syncedAt, device: deviceId(), data };
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

/// A vault adoption rewrites localStorage/SQLite under every store's feet, so
/// a full reload is the blunt-but-reliable repaint. But each reload re-runs
/// main.tsx — including the update prompt's fresh check() — and two devices
/// converging can report "changed" for SEVERAL successive sync cycles, so the
/// update dialog flashed in and out 3-4 times at launch. Allow ONE reload per
/// launch (sessionStorage survives reloads); after that, repaint in place via
/// the refresh event and let the next launch pick up any residual diff.
function reloadOnce(): boolean {
  try {
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
  try { st = await vaultStatus(); } catch { return; }
  if (!st?.cloned) return; // not connected / vault not set up → local-only
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
  if (await syncProjectsNow()) reloadOnce();
}

/// Push on tab-hidden, app-close, and a debounced diff poll (localStorage's
/// 'storage' event only fires cross-tab, so same-tab writes need the poll).
function wireListeners(): void {
  if (_listenersWired) return;
  _listenersWired = true;
  const onHide = () => { if (document.visibilityState === "hidden") { void pushNow(); void syncProjectsNow(); } };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("beforeunload", () => { void pushNow(); void syncProjectsNow(); });
  window.setInterval(() => {
    if (!_enabled) return;
    const j = JSON.stringify(snapshot());
    if (j !== _lastSnapshotJson) schedulePush();
  }, 5000);
}
