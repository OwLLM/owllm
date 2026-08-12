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
// regenerable caches, machine-specific workspace paths, per-screen appearance)
// are denied below.

import { invoke } from "@tauri-apps/api/core";
import { hotBlobKeys, readHotBlob, writeHotBlob, isHotBlobKey } from "./stateMirror";
import { mergeSteps, unionTombstones } from "./notebookMerge";
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
  // Appearance is a property of the SCREEN, not of the account: mode, GUI
  // colour and text colour (owllm:theme:*). Syncing them meant a second PC
  // repainted the first one behind the user's back — and because adoption
  // lands during startVaultSync, i.e. after bootstrapTheme has already painted
  // the first frame, it arrived as a visible flash. A prefix rather than three
  // literals so a future theme key is device-local by default.
  "owllm:theme:",
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
// Mirrors RunNotebook's NOTEBOOK_QUEUE_EVENT — fired only by queue-lifecycle
// writes (start, job transition, sequence end), never by note typing. See
// publishQueueNow: this is what makes a started queue visible on the user's
// other PCs immediately instead of after the poll+debounce.
const NOTEBOOK_QUEUE_EVENT_NAME = "owllm:notebook-queue-changed";
// Mirrors RunNotebook's NOTEBOOK_PULL_EVENT — a notebook surface just opened.
const NOTEBOOK_PULL_EVENT_NAME = "owllm:notebook-pull-request";
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
      const tombstones = unionTombstones(local.deletedSteps, remote.deletedSteps);
      const buried = new Set(tombstones.map((d) => d.id));
      const localAt = typeof local.updatedAt === "number" ? local.updatedAt : 0;
      const remoteAt = typeof remote.updatedAt === "number" ? remote.updatedAt : 0;
      // Order by the MONOTONIC revision when both sides have one, and only fall
      // back to the wall clock when they don't (legacy blobs, or a tie). Device
      // clocks are not synchronized — this vault's own history shows peers
      // writing out-of-order stamps — so a peer's newer queue could carry an
      // older `updatedAt` and roll a finished job back to pending. The revision
      // is a Lamport counter and cannot be skewed that way.
      const localRev = typeof local.queueRev === "number" && Number.isFinite(local.queueRev) ? local.queueRev : null;
      const remoteRev = typeof remote.queueRev === "number" && Number.isFinite(remote.queueRev) ? remote.queueRev : null;
      // Legacy blobs (written before updatedAt existed) score 0 on both sides;
      // preferring remote there preserves the previous adopt-the-peer behaviour.
      const remoteIsNewer = localRev !== null && remoteRev !== null && localRev !== remoteRev
        ? remoteRev > localRev
        : remoteAt >= localAt;
      const newer = remoteIsNewer ? remote : local;
      const localSteps = Array.isArray(local.steps) ? local.steps : [];
      const remoteSteps = Array.isArray(remote.steps) ? remote.steps : [];

      for (const f of ["text", "plan", "digest", "digestModel", "proposed", "proposedPlan"]) {
        if (newer[f] !== undefined) remote[f] = newer[f];
        else delete remote[f];
      }
      remote.steps = mergeSteps(remoteIsNewer ? remoteSteps : localSteps, remoteIsNewer ? localSteps : remoteSteps, buried);
      remote.deletedSteps = tombstones.sort((a, b) => b.ts - a.ts).slice(0, 200);
      remote.updatedAt = Math.max(localAt, remoteAt);
      // Queue identity + position follow the side that won the ordering above,
      // so "job 3 of 7" always describes the copy whose steps we just adopted.
      if (newer.queueId !== undefined) remote.queueId = newer.queueId;
      else if (local.queueId !== undefined) remote.queueId = local.queueId;
      if (newer.currentIndex !== undefined) remote.currentIndex = newer.currentIndex;
      else delete remote.currentIndex;
      // Raise the counter to the highest either PC has seen. The next local save
      // does +1 on this, so our own writes always land ahead of the peer's and
      // the counter never moves backwards on either machine.
      const highestRev = Math.max(localRev ?? 0, remoteRev ?? 0);
      if (localRev !== null || remoteRev !== null) remote.queueRev = highestRev;
      // Who owns the RUN. This is the cross-device queue lock (see RunNotebook →
      // peerQueueLock), so it follows the side that won the revision ordering
      // above — the same authority that decided the steps we just adopted.
      //
      // It used to take whichever copy carried the larger `runningOn.at`, which
      // is a straight clock comparison between two machines: the PC whose clock
      // runs fast keeps winning the field regardless of who is actually
      // driving, so an explicit takeover on the slow PC was silently undone by
      // the next pull and both devices could feed the same queue. The revision
      // is a Lamport counter and cannot be skewed that way.
      const ownerSide = newer.runningOn !== undefined ? newer : (remoteIsNewer ? local : remote);
      if (ownerSide.runningOn !== undefined) remote.runningOn = ownerSide.runningOn;
      else delete remote.runningOn;
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
  // Hot blobs are durable user state that deliberately never touches
  // localStorage (see HOT_BLOB_PREFIXES), so the loop above cannot see them.
  // The fine-tuning chat is one, and it has always synced across devices —
  // enumerating only localStorage here would have silently ended that.
  for (const k of hotBlobKeys()) {
    if (!isSyncable(k)) continue;
    const v = readHotBlob(k);
    if (v != null) out[k] = stripNotebookLease(k, v);
  }
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
    // A hot blob must go back to its own store — writing it to localStorage
    // would both re-open the broadcast hazard and be invisible to its reader.
    const merged = mergeNotebookLease(k, v);
    if (isHotBlobKey(k)) writeHotBlob(k, merged);
    else try { localStorage.setItem(k, merged); } catch { /* quota */ }
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

// How often we pull notebooks from the vault. A running queue is a live
// two-machine conversation, so it needs a tight loop; an idle notebook does not
// justify polling a git remote that often.
const NOTEBOOK_ACTIVE_PULL_MS = 10_000;
const NOTEBOOK_IDLE_PULL_MS = 60_000;

/// Does THIS device have a queue in flight? A step that was fed and has not
/// finished is the live one — the same rule RunNotebook uses for currentIndex.
/// Read straight from storage rather than tracked in a variable so a queue
/// started before this module loaded (or in another tab) still counts.
function localQueueIsRunning(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(NOTEBOOK_KEY_PREFIX)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const steps = JSON.parse(raw)?.steps;
      if (Array.isArray(steps) && steps.some((s: any) => s?.status === "sent" && s.finishedAt == null)) return true;
    }
  } catch { /* private mode / unparseable blob */ }
  return false;
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
///
/// ONE push in flight at a time. The 5-second poll used to stack a fresh
/// `vault_write_state` on top of every push still waiting on git, and each one
/// pinned a tokio blocking thread on the native side; once the pool hit its
/// 512-thread ceiling every other `spawn_blocking` in the app — chat
/// persistence, engine start — queued behind vault sync and the app stopped
/// doing anything at all. Concurrent requests collapse into a single trailing
/// re-run instead, so the newest state still goes out but never as a queue.
let _pushing = false;
let _pushAgain: { force: boolean } | null = null;

/// Take the pending trailing request and clear it.
///
/// A function rather than an inline read: control-flow analysis narrows
/// `_pushAgain` to `null` from the assignment above the `await` — it cannot see
/// that a coalescing caller reassigns it while the push is suspended — and the
/// truthy branch of an inline read is therefore typed `never`.
function takePendingPush(): { force: boolean } | null {
  const pending = _pushAgain;
  _pushAgain = null;
  return pending;
}

export async function pushNow(force = false): Promise<void> {
  if (!_enabled) return;
  if (_pushing) {
    // Keep `force` sticky: a queue publish that lands mid-push must not be
    // downgraded to a dedupe-able tick by the trailing re-run.
    _pushAgain = { force: force || _pushAgain?.force || false };
    return;
  }
  _pushing = true;
  try {
    let next: boolean | null = force;
    while (next !== null) {
      const thisForce: boolean = next;
      takePendingPush(); // anything queued before this run is carried BY it
      await pushOnce(thisForce);
      const pending = takePendingPush();
      next = pending ? pending.force : null;
    }
  } finally {
    _pushing = false;
    _pushAgain = null;
  }
}

async function pushOnce(force: boolean): Promise<void> {
  const data = snapshot();
  const dataJson = JSON.stringify(data);
  if (!force && dataJson === _lastSnapshotJson) return;
  const syncedAt = Date.now();
  const blob: Blob = { syncedAt, device: await deviceId(), data };
  try {
    const written = await invoke<boolean>("vault_write_state", { json: JSON.stringify(blob) });
    // An explicit `false` means the native side coalesced this tick into a sync
    // that was already running, so NOTHING was written. Leave the dedupe marker
    // alone so the next poll retries — advancing it here would record unsaved
    // state as published. (Test harnesses stub this command as `null`, which is
    // deliberately not `false` and still counts as written.)
    if (written === false) return;
    _lastSnapshotJson = dataJson;
    setLast(syncedAt); // our own push isn't "newer" to us next launch
  } catch (e) {
    console.warn("[vaultSync] push failed", e);
  }
}

/// Publish a QUEUE-lifecycle change to the vault right now.
///
/// The notebook is meant to be one shared object, but the only routes to the
/// vault were a 5-second snapshot poll feeding a 4-second debounce. So a queue
/// started on device A was invisible on device B for up to ~9 seconds — and not
/// at all if the run ended or the window closed before both timers elapsed,
/// which is exactly the "started it here, the other PC never knew" report.
///
/// Fully asynchronous: callers dispatch an event and return, so a run-end
/// handler never waits on git. Overlapping transitions coalesce into one
/// trailing push rather than queueing a commit per job.
let _queuePublishing = false;
let _queuePublishAgain = false;
export async function publishQueueNow(): Promise<void> {
  if (!_enabled) return;
  if (_queuePublishing) { _queuePublishAgain = true; return; }
  _queuePublishing = true;
  try {
    do {
      _queuePublishAgain = false;
      // force: a queue transition must go out even when the snapshot dedupe
      // would call it unchanged (the lease fields it touches are stripped).
      await pushNow(true);
    } while (_queuePublishAgain);
  } finally {
    _queuePublishing = false;
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
  // A queue-lifecycle write publishes immediately — see publishQueueNow.
  window.addEventListener(NOTEBOOK_QUEUE_EVENT_NAME, () => { void publishQueueNow(); });
  // A notebook surface opening asks for the peer's copy before the user acts on
  // a stale queue.
  window.addEventListener(NOTEBOOK_PULL_EVENT_NAME, () => { void pullNotebooksNow(); });
  // Notebook queues are the one localStorage store that must converge WITHOUT
  // waiting for the next launch — otherwise a step a peer already completed
  // keeps being re-fed here. Safe mid-session: see pullNotebooksNow.
  //
  // Self-rescheduling rather than a flat interval: while a queue is actually
  // running the two PCs are both writing, so a minute of blindness is long
  // enough to re-feed a card the peer already finished. Idle notebooks keep the
  // cheap cadence — this polls a git remote, so it is not free.
  const scheduleNotebookPull = () => {
    // `window.` like every other timer armed by wireListeners, NOT the bare
    // global used by schedulePush: these fire at startup, so harnesses stub
    // them out to keep a test process from being held open by a live timer.
    window.setTimeout(() => {
      if (!_enabled) { scheduleNotebookPull(); return; }
      void pullNotebooksNow().finally(scheduleNotebookPull);
    }, localQueueIsRunning() ? NOTEBOOK_ACTIVE_PULL_MS : NOTEBOOK_IDLE_PULL_MS);
  };
  scheduleNotebookPull();
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
