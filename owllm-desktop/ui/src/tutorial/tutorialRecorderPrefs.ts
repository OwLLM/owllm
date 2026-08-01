// tutorialRecorderPrefs.ts — pure, storage-injectable preferences for the
// Tutorial Recorder: the capture frame-rate (so long recordings don't fill the
// drive) and the "auto-stop N seconds after the job finishes" toggle. Kept free
// of React/DOM so the clamp/persistence/transition logic is unit-testable (see
// tutorialRecorder.verify.run.mjs), mirroring chatFontPreferences.ts.

export const RECORDER_FPS_KEY = "owllm:tutorial-recorder:fps";
export const RECORDER_AUTOSTOP_KEY = "owllm:tutorial-recorder:autostop-after-job";

// Five and ten FPS made scrolling, pointer motion, and seeking look broken.
// Fifteen is the compact floor; 30 is the default for a normal UI recording.
export const FPS_OPTIONS = [15, 24, 30, 60] as const;
export const DEFAULT_FPS = 30;

export type RecorderFormat = {
  mimeType: string;
  extension: "mp4" | "webm";
  label: string;
};

// H.264 MP4 is the first choice because normal desktop/browser players can
// index, seek, scrub, and edit it reliably. Not every WebView ships an H.264
// encoder, so keep efficient WebM codecs as capability-tested fallbacks.
export const RECORDER_FORMATS: readonly RecorderFormat[] = [
  { mimeType: "video/mp4;codecs=avc1.640028", extension: "mp4", label: "H.264 MP4" },
  { mimeType: "video/mp4;codecs=avc1.42E01E", extension: "mp4", label: "H.264 MP4" },
  { mimeType: "video/mp4;codecs=avc1", extension: "mp4", label: "H.264 MP4" },
  { mimeType: "video/mp4", extension: "mp4", label: "MP4" },
  { mimeType: "video/webm;codecs=vp9", extension: "webm", label: "VP9 WebM" },
  { mimeType: "video/webm;codecs=vp8", extension: "webm", label: "VP8 WebM" },
  { mimeType: "video/webm", extension: "webm", label: "WebM" },
] as const;

export function chooseRecorderFormat(isTypeSupported: (mimeType: string) => boolean): RecorderFormat {
  for (const format of RECORDER_FORMATS) {
    try {
      if (isTypeSupported(format.mimeType)) return format;
    } catch {
      // A partial WebView implementation can throw instead of returning false.
    }
  }
  // An empty MIME asks MediaRecorder to choose its native format. WebM is the
  // conservative filename fallback; the recorder's actual MIME wins on save.
  return { mimeType: "", extension: "webm", label: "Native video" };
}

// How long after a job ends before the recorder stops itself.
export const AUTO_STOP_DELAY_MS = 3000;

type Store = Pick<Storage, "getItem" | "setItem">;

/// Snap any number to the nearest allowed FPS option; junk falls back to the
/// default. Guarantees the recorder never captures at an unsupported rate.
export function clampFps(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FPS;
  let best = FPS_OPTIONS[0] as number;
  let bestDist = Math.abs(value - best);
  for (const opt of FPS_OPTIONS) {
    const dist = Math.abs(value - opt);
    if (dist < bestDist) { best = opt; bestDist = dist; }
  }
  return best;
}

export function readFps(store: Store | null | undefined): number {
  try {
    const raw = store?.getItem(RECORDER_FPS_KEY);
    if (raw == null || raw === "") return DEFAULT_FPS;
    return clampFps(Number(raw));
  } catch {
    return DEFAULT_FPS;
  }
}

export function saveFps(value: number, store: Store | null | undefined): void {
  try {
    store?.setItem(RECORDER_FPS_KEY, String(clampFps(value)));
  } catch {
    /* storage blocked — the in-memory selection still applies this session */
  }
}

export function readAutoStop(store: Store | null | undefined): boolean {
  try {
    return store?.getItem(RECORDER_AUTOSTOP_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAutoStop(value: boolean, store: Store | null | undefined): void {
  try {
    store?.setItem(RECORDER_AUTOSTOP_KEY, value ? "1" : "0");
  } catch {
    /* storage blocked — the in-memory selection still applies this session */
  }
}

// A capture-stream/MediaRecorder bitrate that actually shrinks low-FPS files.
// The MediaRecorder default targets a fixed bitrate regardless of frame rate, so
// dropping FPS alone would NOT reduce disk use — the drive-filling the user hit.
// Tie the bitrate to FPS (~120 kbps per fps) so 5 fps ≈ 0.6 Mbps and 30 fps ≈
// 3.6 Mbps. Clamped to a sane floor/ceiling.
export function bitrateForFps(fps: number): number {
  const perFps = 120_000;
  return Math.max(300_000, Math.min(8_000_000, Math.round(clampFps(fps) * perFps)));
}

// Preserve UI/text detail without spending a fixed number of bits on every
// resolution. The previous 0.075 bpp/frame ceiling starved dense UI captures.
// This higher quality budget is still variable-rate, so static screens remain
// compact while scrolling and small text receive enough bits to stay sharp.
export function bitrateForCapture(
  fps: number,
  width: number | undefined,
  height: number | undefined,
  mimeType: string,
): number {
  const safeWidth = Number.isFinite(width) && Number(width) > 0 ? Number(width) : 1920;
  const safeHeight = Number.isFinite(height) && Number(height) > 0 ? Number(height) : 1080;
  const bitsPerPixelFrame = mimeType.includes("vp9") ? 0.11 : 0.14;
  const calculated = safeWidth * safeHeight * clampFps(fps) * bitsPerPixelFrame;
  return Math.max(4_000_000, Math.min(24_000_000, Math.round(calculated)));
}

/// True the instant a run goes from active → inactive: the edge that means "the
/// job just finished", which arms the auto-stop countdown. Pure so the recorder
/// component and the test share one definition of "job ended".
export function jobJustEnded(prevActive: boolean, nowActive: boolean): boolean {
  return prevActive && !nowActive;
}
