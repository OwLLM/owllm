// Voice (TTS) for agent replies. Wraps window.speechSynthesis so the
// rest of the agentic UI can speak without poking the browser API
// directly. Browser TTS is the v1 backend — it works in the Tauri
// WebView on Windows out of the box (uses SAPI under the hood), gives
// us 30+ voices for free, and means no Rust/python wiring for the
// initial pass. A native Piper/Edge backend can replace this later by
// swapping the body of `speak` and `listVoices` — the public surface
// is what callers depend on.
//
// Mirrors `_AgentVoiceRow` from python-app/desktop_app/pages/agents_page.py
// at a functional level (enabled / voice_id / rate, plus a stable
// per-agent fallback when voice_id is empty).

export type VoiceConfig = {
  enabled: boolean;
  voiceURI: string;  // "" = Auto (deterministic per-agent pick)
  rate: number;      // 0 = default, otherwise 0.1..10 (SpeechSynthesis scale)
};

export const DEFAULT_VOICE: VoiceConfig = {
  enabled: false,
  voiceURI: "",
  rate: 0,
};

let _cached: SpeechSynthesisVoice[] | null = null;
const _listeners = new Set<(voices: SpeechSynthesisVoice[]) => void>();

function _refresh(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    _cached = [];
    return _cached;
  }
  _cached = window.speechSynthesis.getVoices().slice();
  return _cached;
}

if (typeof window !== "undefined" && "speechSynthesis" in window) {
  // Chromium / Edge fire `voiceschanged` once the OS voice list is
  // populated. Without the listener `getVoices()` returns [] on the
  // first call and listVoices() would lie about availability.
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    _refresh();
    for (const cb of _listeners) {
      try { cb(_cached!); } catch { /* listener errors don't kill TTS */ }
    }
  });
}

/// List installed voices. Returns the cached array if voiceschanged
/// hasn't fired yet (which is fine — the listener will repopulate it).
export function listVoices(): SpeechSynthesisVoice[] {
  if (_cached === null) _refresh();
  return _cached ?? [];
}

/// Subscribe to voice-list updates. Returns an unsubscribe fn. React
/// components use this to re-render when the OS voice list arrives
/// after the initial paint.
export function onVoicesChanged(cb: (voices: SpeechSynthesisVoice[]) => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

/// Deterministic agent-name → voice pick. Used when an agent's config
/// is on Auto (voiceURI === ""). Same name always maps to the same
/// voice across sessions so the user hears the orchestrator with one
/// voice and the coder with another, instead of a random shuffle every
/// run.
export function stableVoiceFor(agent: string, voices?: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const list = voices ?? listVoices();
  if (list.length === 0) return null;
  let h = 0;
  for (let i = 0; i < agent.length; i++) {
    h = (h * 31 + agent.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % list.length;
  return list[idx] ?? null;
}

/// Resolve a VoiceConfig (plus agent name) to the concrete
/// SpeechSynthesisVoice object to use. Returns null when the system
/// has no voices installed at all.
export function resolveVoice(cfg: VoiceConfig, agent: string): SpeechSynthesisVoice | null {
  const list = listVoices();
  if (list.length === 0) return null;
  if (cfg.voiceURI) {
    const hit = list.find(v => v.voiceURI === cfg.voiceURI);
    if (hit) return hit;
    // Persisted voice no longer installed — fall through to Auto.
  }
  return stableVoiceFor(agent, list);
}

// Per-agent "currently speaking" tracker so a new utterance for the
// same agent cancels its predecessor (we don't want overlapping audio
// when the orchestrator emits two replies back-to-back). cancel() is
// global on speechSynthesis, so we just rely on the queue + a small
// guard rather than per-agent channels.
const _pending = new Set<SpeechSynthesisUtterance>();

/// Speak `text` with the resolved voice/rate from cfg. No-op when
/// disabled, when text is empty, or when no voices are installed.
export function speak(cfg: VoiceConfig, agent: string, text: string): void {
  if (!cfg.enabled) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const clean = (text || "").trim();
  if (!clean) return;

  const u = new SpeechSynthesisUtterance(clean);
  const voice = resolveVoice(cfg, agent);
  if (voice) u.voice = voice;
  // Map our integer rate (wpm-ish, 0..400) onto the SpeechSynthesis
  // 0.1..10 scale. 200 wpm ≈ default human cadence ≈ rate 1.0, so
  // each 200 wpm = 1.0× speed. 0 means "use engine default" (1.0).
  if (cfg.rate && cfg.rate > 0) {
    u.rate = Math.max(0.1, Math.min(10, cfg.rate / 200));
  }
  _pending.add(u);
  u.onend = () => { _pending.delete(u); };
  u.onerror = () => { _pending.delete(u); };
  try {
    window.speechSynthesis.speak(u);
  } catch {
    _pending.delete(u);
  }
}

/// Preview a sample line in the given voice. Always runs regardless
/// of `enabled` — the preview button must work even when the agent's
/// voice is muted, so users can audition before committing.
export function preview(cfg: VoiceConfig, agent: string): void {
  const sample = `Hi, I'm ${agent}. This is what my voice sounds like.`;
  speak({ ...cfg, enabled: true }, agent, sample);
}

/// Stop any in-flight speech. Called when the user hits Cancel on the
/// goal dispatch or switches projects mid-run.
export function stopAll(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try { window.speechSynthesis.cancel(); } catch { /* engine teardown */ }
  _pending.clear();
}

/// True when at least one voice is installed and the API is present.
/// The Voice controls render disabled when this returns false.
export function ttsAvailable(): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
  return listVoices().length > 0;
}
