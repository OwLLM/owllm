// Peer model catalogue — the GGUFs advertised by the user's PAIRED OwLLM
// devices, so PC A's model picker can offer PC B's models directly.
//
// The transport was already complete: `model_catalog` / `inference` command
// kinds are executed on the peer (src-tauri/src/remote_devices/executor.rs),
// and the dispatch loop can already drive a paired device (deviceChatCompletion).
// What was missing is DISCOVERY: nothing outside the Server page ever asked a
// peer what it had, so pairing two PCs surfaced no extra models anywhere.
//
// Shaped exactly like cloudCatalogue.ts (module-level cache + subscribe) so
// buildEntries() can stay a synchronous pure-ish function: the picker reads
// whatever is cached and re-renders when a background refresh lands.

import { listDevices, listRemoteModels, type RemoteModel } from "../advanced/remoteDevices";

export type PeerCatalogueEntry = {
  deviceId: string;
  deviceName: string;
  models: RemoteModel[];
  /// Model the peer currently has loaded (null = none running).
  activeModelId: string | null;
  /// Populated when the last probe of this peer failed — the peer is listed
  /// as unavailable rather than silently vanishing from the picker.
  error?: string;
};

let _cache: PeerCatalogueEntry[] = [];
let _lastRefreshMs = 0;
let _inflight: Promise<void> | null = null;

const _listeners = new Set<() => void>();
function _emit(): void { for (const l of _listeners) l(); }

/// Subscribe to peer-catalogue changes; returns an unsubscribe fn.
export function subscribePeerCatalogue(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

/// Whatever was learned by the last refresh (empty until one completes).
/// Synchronous by design — the picker never blocks on the device channel.
export function getPeerCatalogue(): PeerCatalogueEntry[] {
  return _cache;
}

/// A peer probe crosses the network (P2P/relay), so re-probing on every
/// picker open would stall the UI on an offline peer. Serve the cache
/// within this window instead.
const FRESH_MS = 60_000;

/// Refresh the catalogue from every paired device. Never rejects: a peer that
/// is offline or refuses the command contributes an `error` entry, not a throw.
/// Concurrent callers share one in-flight pass.
export function refreshPeerCatalogue(force = false): Promise<void> {
  if (_inflight) return _inflight;
  if (!force && Date.now() - _lastRefreshMs < FRESH_MS) return Promise.resolve();
  _inflight = (async () => {
    let peers: Array<{ device_id: string; name: string; is_self: boolean }>;
    try {
      peers = (await listDevices()) as unknown as Array<{ device_id: string; name: string; is_self: boolean }>;
    } catch {
      // No device subsystem / not paired — leave whatever we had.
      return;
    }
    const targets = (peers ?? []).filter(p => p && !p.is_self);
    const next = await Promise.all(targets.map(async (p): Promise<PeerCatalogueEntry> => {
      try {
        const cat = await listRemoteModels(p.device_id);
        return {
          deviceId: p.device_id,
          deviceName: p.name || p.device_id,
          models: cat.models ?? [],
          activeModelId: cat.active_model_id ?? null,
        };
      } catch (e) {
        return {
          deviceId: p.device_id,
          deviceName: p.name || p.device_id,
          models: [],
          activeModelId: null,
          error: String((e as Error)?.message ?? e),
        };
      }
    }));
    _cache = next;
    _lastRefreshMs = Date.now();
    _emit();
  })().finally(() => { _inflight = null; });
  return _inflight;
}

// ---------------------------------------------------------------------------
// Model-id encoding
//
// A peer model is addressed with the same prefix convention the picker already
// uses for `sub/` / `api/` / `auto/`:
//
//     device/<deviceId>/<modelId>
//
// deviceId is an opaque id without "/", so the first two segments split
// cleanly and the remainder is the model id verbatim (GGUF names may contain
// "/" for transformers-style dirs).
// ---------------------------------------------------------------------------

export const DEVICE_PREFIX = "device/";

export function encodeDeviceModel(deviceId: string, modelId: string): string {
  return `${DEVICE_PREFIX}${deviceId}/${modelId}`;
}

/// Split a `device/<id>/<model>` id, or null when `id` isn't one.
export function parseDeviceModel(id: string): { deviceId: string; modelId: string } | null {
  if (!id || !id.startsWith(DEVICE_PREFIX)) return null;
  const rest = id.slice(DEVICE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { deviceId: rest.slice(0, slash), modelId: rest.slice(slash + 1) };
}

/// "local" is a protocol/provider family, not necessarily a model hosted by
/// this process. Paired-device models deliberately use the local GGUF dispatch
/// loop, but their server must be started on the peer over the sealed channel.
/// Keep this decision shared so no UI surface passes `device/...` to the local
/// `server_start` command.
export function requiresManagedLocalServer(modelId: string, provider: string): boolean {
  return parseDeviceModel(modelId) === null && (provider === "local" || provider === "tuned");
}

/// Display name of a paired device from the cache, falling back to its id.
export function peerNameFor(deviceId: string): string {
  return _cache.find(p => p.deviceId === deviceId)?.deviceName || deviceId;
}
