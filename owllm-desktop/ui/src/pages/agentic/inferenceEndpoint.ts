// Inference endpoint — where the agent loop sends its OpenAI-compatible
// chat requests. The whole point of the Windows-server / Linux-agents split:
// the agents don't have to run on the same box as the GPU. By default the
// endpoint is the local managed llama-server (127.0.0.1:<managed port>);
// switch it to "remote" and the agents call a llama-server running on
// another machine (e.g. the Windows GPU box) over the network.
//
// Frontend-persisted (localStorage) so it's data, not a rebuild — and read
// synchronously by the dispatch hot path. The remote server is authenticated
// with the same OpenAI-style bearer key llama-server takes via --api-key.

const KEY = "owllm.inference.endpoint";

export type InferenceMode = "local" | "remote";

export type InferenceEndpoint = {
  /// "local" = the app's own managed llama-server on 127.0.0.1.
  /// "remote" = a llama-server on another host (the split: agents here,
  /// model on the Windows GPU box).
  mode: InferenceMode;
  /// Host/IP of the remote server (ignored in local mode).
  host: string;
  /// Port of the remote server (ignored in local mode; local uses the
  /// managed port passed at call time).
  port: number;
  /// Bearer key the remote llama-server was started with (--api-key).
  /// Empty = no auth header sent.
  apiKey: string;
};

const DEFAULTS: InferenceEndpoint = { mode: "local", host: "127.0.0.1", port: 8080, apiKey: "" };

// The LOCAL managed server normally needs no auth — but when the user EXPOSES it
// on the network (Server page), llama-server is launched with `--api-key`, which
// it enforces on 127.0.0.1 connections too. So the local UI must send that same
// key or every local request 401s ("Invalid API Key"). We cache the key here
// (mirrored from inference_expose_get on startup + whenever expose is changed)
// so resolveInferenceBase — which is synchronous — can attach it.
const LOCAL_KEY = "owllm.inference.localKey";

/// Mirror the local server's required api-key (empty = none / not exposed).
export function setLocalServerKey(key: string): void {
  try {
    if (key && key.trim()) localStorage.setItem(LOCAL_KEY, key.trim());
    else localStorage.removeItem(LOCAL_KEY);
  } catch { /* private mode / quota */ }
}

function getLocalServerKey(): string | null {
  try {
    const k = localStorage.getItem(LOCAL_KEY);
    return k && k.trim() ? k.trim() : null;
  } catch { return null; }
}

export function getInferenceEndpoint(): InferenceEndpoint {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw);
    return {
      mode: p?.mode === "remote" ? "remote" : "local",
      host: typeof p?.host === "string" && p.host.trim() ? p.host.trim() : DEFAULTS.host,
      port: Number.isFinite(p?.port) && p.port > 0 ? Math.floor(p.port) : DEFAULTS.port,
      apiKey: typeof p?.apiKey === "string" ? p.apiKey : "",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setInferenceEndpoint(ep: InferenceEndpoint): void {
  try { localStorage.setItem(KEY, JSON.stringify(ep)); } catch { /* private mode / quota */ }
}

export type ResolvedInference = {
  /// Base URL WITHOUT trailing slash, e.g. "http://192.168.1.20:8080".
  baseUrl: string;
  /// Bearer key to send, or null for no Authorization header.
  apiKey: string | null;
  /// True when pointing at a remote server (caller should skip starting /
  /// waiting on a local managed server).
  remote: boolean;
};

/// Resolve the base URL for an inference call. In local mode the managed
/// server port (discovered at runtime) is used; in remote mode the saved
/// host:port + key are used and `localPort` is ignored.
export function resolveInferenceBase(localPort: number): ResolvedInference {
  const ep = getInferenceEndpoint();
  if (ep.mode === "remote" && ep.host) {
    return {
      baseUrl: `http://${ep.host}:${ep.port}`,
      apiKey: ep.apiKey.trim() ? ep.apiKey.trim() : null,
      remote: true,
    };
  }
  // Local managed server: send the expose api-key if one is set (else no auth).
  return { baseUrl: `http://127.0.0.1:${localPort}`, apiKey: getLocalServerKey(), remote: false };
}
