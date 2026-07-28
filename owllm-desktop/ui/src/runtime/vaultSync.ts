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
import { REMOTE_DEVICE_HEARTBEAT_MS } from "../pages/advanced/deviceLiveness";

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
  "owllm:world-map:presence-enabled", // legacy opt-in (presence is always on now) — never sync a stray value
  "owllm:world-map:presence-token",   // anonymous server token is device-local
  "owllm:world-map:node-id",          // stable anonymous node id is per device
  // Open tabs and their selected project are workspace UI on THIS computer.
  // Project/chat content syncs separately through SQLite; syncing these keys
  // made another PC's open projects suddenly become this PC's open pages.
  "owllm:agents:pages",
  "owllm:agents:activePage",
  "owllm:assets:selectedProject",
  "owllm:server:model",       // local model registry differs on every device
]);
// Prefixes for machine-specific state that shouldn't follow the user (paths
// to WSL workspaces differ per device).
const DENY_PREFIX = [
  "owllm:code:",
  "owllm:agents:page:",
];

// The notebook blob (owllm:agents:notebook:<pid>) DOES sync — its notes, plan
// and steps are shared content — but its RUN-LEASE fields must not. Those name
// the live window that owns the running queue; syncing them would make a peer
// PC think its own window owns a queue it never started (and two windows could
// then drive the one team). We strip them on push and preserve the LOCAL lease
// on adopt, so content converges while the lease stays device-local.
const NOTEBOOK_KEY_PREFIX = "owllm:agents:notebook:";
// Mirrors RunNotebook's NOTEBOOK_EVENT. Kept as a local literal rather than an
// import so this runtime module stays free of page-level dependencies.
const NOTEBOOK_EVENT_NAME = "owllm:notebook-changed";
const NOTEBOOK_RUN_LEASE_FIELDS = [
  "autoFeed", "autoFeedOwner", "autoFeedHeartbeat", "autoFeedStartedAt", "autoFeedFinishedAt", "autoFeedStopped",
  // One-shot "start the queue when the current run ends", set by a click on THIS
  // window. Syncing it would let a peer PC start a queue nobody asked it to.
  "autoFeedArmed",
];

/// Return the notebook blob value with its device-local run-lease fields
/// removed, ready to sync. Non-notebook keys and unparseable values pass
/// through untouched. Exported for the notebookSync verifier.
export function stripNotebookLease(key: string, value: string): string {
  if (!key.startsWith(NOTEBOOK_KEY_PREFIX)) return value;
  try {
    const obj = JSON.parse(value);
    if (!obj || typeof obj !== "object") return value;
    for (const f of NOTEBOOK_RUN_LEASE_FIELDS) delete obj[f];
    return JSON.stringify(obj);
  } catch {
    return value; // not JSON we understand — never corrupt it
  }
}

/// How far a step has progressed. This is only the tie-breaker when two copies
/// have the same lifecycle timestamp; a newer explicit Reopen must be allowed
/// to move a step from archived back to pending.
function stepProgress(s: any): number {
  if (!s || typeof s !== "object") return 0;
  if (s.status === "done") return 4;
  if (s.status === "sent" && s.finishedAt != null) return 3;
  if (s.status === "failed") return 2;
  if (s.status === "sent") return 1;
  return 0; // pending
}

function stepLifecycleAt(s: any): number {
  if (!s || typeof s !== "object") return 0;
  for (const value of [s.stepUpdatedAt, s.archivedAt, s.finishedAt, s.startedAt, s.ts]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

/// Union two step lists by id, newest-lifecycle-wins, with deleted ids buried.
/// Order follows the newer side, then any ids only the older side still has,
/// so a reordering on the newer device survives without dropping the other's
/// additions.
function mergeSteps(newer: any[], older: any[], buried: Set<string>): any[] {
  const byId = new Map<string, any>();
  for (const s of older) if (s?.id && !buried.has(s.id)) byId.set(s.id, s);
  for (const s of newer) {
    if (!s?.id || buried.has(s.id)) continue;
    const prev = byId.get(s.id);
    const currentAt = stepLifecycleAt(s);
    const previousAt = stepLifecycleAt(prev);
    const winner = !prev
      || currentAt > previousAt
      || (currentAt === previousAt && stepProgress(s) >= stepProgress(prev))
      ? s
      : prev;
    byId.set(s.id, winner);
  }
  const out: any[] = [];
  const emitted = new Set<string>();
  for (const src of [newer, older]) {
    for (const s of src) {
      if (!s?.id || emitted.has(s.id) || !byId.has(s.id)) continue;
      emitted.add(s.id);
      out.push(byId.get(s.id));
    }
  }
  return out;
}

/// Merge an adopted notebook blob with the local one.
///
/// Two separate jobs:
///   1. KEEP this device's live run-lease — content comes from the peer, but an
///      in-flight queue on this PC is never hijacked by a sync.
///   2. UNION the step lists instead of replacing them. Adoption used to take
///      the remote array wholesale, so whichever PC pushed last won outright:
///      a step this device had just finished came back as pending, and steps
///      created here since the peer's last push were deleted. Tombstones
///      (deletedSteps) keep a union from resurrecting deliberate deletions.
///
/// Scalar fields (notes, plan, digest) still take one side wholesale — but by
/// each notebook's OWN `updatedAt`, not the vault blob's single `syncedAt`,
/// which covered every localStorage key at once and let an unrelated setting
/// change on a stale PC republish its stale notebook as "newer".
/// Exported for the notebookSync verifier.
export function mergeNotebookLease(key: string, remoteValue: string): string {
  if (!key.startsWith(NOTEBOOK_KEY_PREFIX)) return remoteValue;
  try {
    const remote = JSON.parse(remoteValue);
    if (!remote || typeof remote !== "object") return remoteValue;
    let local: any = null;
    try { const rawLocal = localStorage.getItem(key); if (rawLocal) local = JSON.parse(rawLocal); } catch { local = null; }

    if (local && typeof local === "object") {
      // Tombstones are a union: a delete on EITHER device is authoritative.
      const tombstones = new Map<string, { id: string; ts: number }>();
      for (const src of [local.deletedSteps, remote.deletedSteps]) {
        if (!Array.isArray(src)) continue;
        for (const d of src) {
          if (d && typeof d.id === "string" && typeof d.ts === "number") tombstones.set(d.id, d);
        }
      }
      const buried = new Set(tombstones.keys());
      const localAt = typeof local.updatedAt === "number" ? local.updatedAt : 0;
      const remoteAt = typeof remote.updatedAt === "number" ? remote.updatedAt : 0;
      // Legacy blobs (written before updatedAt existed) score 0 on both sides;
      // preferring remote there preserves the previous adopt-the-peer behaviour.
      const remoteIsNewer = remoteAt >= localAt;
      const newer = remoteIsNewer ? remote : local;
      const localSteps = Array.isArray(local.steps) ? local.steps : [];
      const remoteSteps = Array.isArray(remote.steps) ? remote.steps : [];

      for (const f of ["text", "plan", "digest", "digestModel", "proposed", "proposedPlan"]) {
        if (newer[f] !== undefined) remote[f] = newer[f];
        else delete remote[f];
      }
      remote.steps = mergeSteps(remoteIsNewer ? remoteSteps : localSteps, remoteIsNewer ? localSteps : remoteSteps, buried);
      remote.deletedSteps = [...tombstones.values()].sort((a, b) => b.ts - a.ts).slice(0, 200);
      remote.updatedAt = Math.max(localAt, remoteAt);
      // Advisory only (never a lock) — keep whichever device started a queue
      // most recently so each PC can say where the run is happening.
      const runs = [local.runningOn, remote.runningOn].filter((r: any) => r && typeof r.at === "number");
      remote.runningOn = runs.sort((a: any, b: any) => b.at - a.at)[0] ?? undefined;
      if (remote.runningOn === undefined) delete remote.runningOn;
    }

    for (const f of NOTEBOOK_RUN_LEASE_FIELDS) {
      if (local && local[f] !== undefined) remote[f] = local[f];
      else delete remote[f];
    }
    return JSON.stringify(remote);
  } catch {
    return remoteValue;
  }
}

// A notebook keyed by a raw FOLDER PATH — CodePage's fallback scope
// (`code:<absolute path>`) for a folder that is not a registered project — is
// device-local by definition: that path does not exist on the user's other PCs.
// Syncing it planted a second, orphan notebook for the same project on every
// machine, alongside the durable-id one. Durable project ids still sync.
const NOTEBOOK_PATH_FALLBACK_PREFIX = `${NOTEBOOK_KEY_PREFIX}code:`;

function isSyncable(key: string): boolean {
  if (DENY_EXACT.has(key)) return false;
  if (DENY_PREFIX.some((p) => key.startsWith(p))) return false;
  if (key.startsWith(NOTEBOOK_PATH_FALLBACK_PREFIX)) return false;
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
      if (v != null) out[k] = stripNotebookLease(k, v);
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

/// Stop remote sync immediately when the user logs out. Local projects/chats
/// remain usable offline; only the account-backed transport is disabled.
export function stopVaultSync(): void {
  _enabled = false;
  _started = false;
  if (_pushTimer) {
    clearTimeout(_pushTimer);
    _pushTimer = null;
  }
  if (_projectSyncTimer) {
    clearTimeout(_projectSyncTimer);
    _projectSyncTimer = null;
  }
  _lastSnapshotJson = "";
}

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
  const adoptedNotebookPids: string[] = [];
  for (const [k, v] of Object.entries(blob.data || {})) {
    // Old vault blobs can still contain page/folder bindings from versions
    // before the deny-list was corrected. Never re-import them.
    if (!isSyncable(k)) continue;
    // Keep this device's live queue lease; adopt only the peer's content.
    try { localStorage.setItem(k, mergeNotebookLease(k, v)); } catch { /* quota */ }
    if (k.startsWith(NOTEBOOK_KEY_PREFIX)) adoptedNotebookPids.push(k.slice(NOTEBOOK_KEY_PREFIX.length));
  }
  setLast(blob.syncedAt);
  try { await invoke("vault_align"); } catch { /* best effort */ }
  // When we DON'T do a full reload (the user has already interacted), open
  // notebook surfaces hold stale in-memory steps even though localStorage now
  // has the adopted copy. Tell them to reload so the queue reflects work a
  // peer PC already completed instead of showing done steps as pending.
  for (const pid of adoptedNotebookPids) {
    try { window.dispatchEvent(new CustomEvent(NOTEBOOK_EVENT_NAME, { detail: { projectId: pid } })); } catch { /* non-browser */ }
  }
  return true;
}

/// Key-order-independent JSON identity. The merged notebook is rebuilt from the
/// PEER's object, so its key order can differ from ours even when the content is
/// byte-identical in meaning. Comparing raw strings would then see a change every
/// single poll — writing, repainting and re-pushing forever between two idle PCs.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sameNotebookJson(a: string | null, b: string): boolean {
  if (a === b) return true;
  if (a == null) return false;
  try { return stableJson(JSON.parse(a)) === stableJson(JSON.parse(b)); } catch { return false; }
}

/// Mid-session NOTEBOOK refresh.
///
/// pullAndAdopt above runs exactly once, at launch, because adopting rewrites
/// every synced localStorage key under every store's feet — which is why it is
/// paired with a one-shot reload and deliberately skipped once the user has
/// interacted. The consequence was a one-way sync: after launch this PC pushed
/// forever and never adopted anything, so a peer that completed steps was
/// invisible here and its finished cards kept showing as pending.
///
/// Notebooks are the one synced store that can converge safely mid-session:
/// they own a real in-place repaint path (NOTEBOOK_EVENT), and mergeNotebook
/// unions steps with a most-advanced-wins ratchet, so adopting cannot roll back
/// an in-flight run on this PC. So pull just those keys, on an interval and
/// whenever the window regains focus.
export async function pullNotebooksNow(): Promise<boolean> {
  if (!_enabled) return false;
  let raw: string | null = null;
  try { raw = await invoke<string | null>("vault_read_remote_state"); } catch { return false; }
  if (!raw) return false;
  let blob: Blob;
  try { blob = JSON.parse(raw) as Blob; } catch { return false; }
  if (!blob?.syncedAt || blob.device === await deviceId()) return false;
  let changed = false;
  for (const [k, v] of Object.entries(blob.data || {})) {
    if (!k.startsWith(NOTEBOOK_KEY_PREFIX) || !isSyncable(k)) continue;
    const merged = mergeNotebookLease(k, v);
    let current: string | null = null;
    try { current = localStorage.getItem(k); } catch { /* private mode */ }
    if (sameNotebookJson(current, merged)) continue;
    try { localStorage.setItem(k, merged); } catch { continue; /* quota */ }
    changed = true;
    // NOT setLast(): we adopted only notebooks, so the launch path must still
    // see this blob as unadopted and take the rest of its keys.
    try { window.dispatchEvent(new CustomEvent(NOTEBOOK_EVENT_NAME, { detail: { projectId: k.slice(NOTEBOOK_KEY_PREFIX.length) } })); } catch { /* non-browser */ }
  }
  return changed;
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
  // Hidden → publish what we did. Visible again → the user may have been
  // working on another PC in the meantime, so adopt notebook progress before
  // they look at a stale queue.
  const onHide = () => {
    if (document.visibilityState === "hidden") { void pushNow(); void syncProjectsNow(); }
    else void pullNotebooksNow();
  };
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
  // Notebook queues are the one localStorage store that must converge WITHOUT
  // waiting for the next launch — otherwise a step a peer already completed
  // keeps being re-fed here. Safe mid-session: see pullNotebooksNow.
  window.setInterval(() => { if (_enabled) void pullNotebooksNow(); }, 60_000);
  // Fleet liveness heartbeat: republish OUR device record (fresh published_at)
  // and ingest peers' heartbeats. Without this the record was published once at
  // launch, so isDeviceOnline's 5-minute freshness window was unhittable for
  // any idle machine and every fleet count went stale.
  window.setInterval(() => { if (_enabled) void syncDevicesNow(); }, REMOTE_DEVICE_HEARTBEAT_MS);
}

// githubDisconnect emits this after the native credential scrub completes.
// Install the listener at module load so logout also stops a sync engine that
// was started earlier in this same WebView session.
if (typeof window !== "undefined") {
  window.addEventListener("owllm:vault-disconnected", stopVaultSync);
}
