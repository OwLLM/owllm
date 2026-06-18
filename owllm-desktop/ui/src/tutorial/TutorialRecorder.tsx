import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Point = { x: number; y: number };
type ClickMark = Point & { id: number };

type RecorderState = "idle" | "recording" | "paused" | "saving";
type CaptureMode = "window" | "screen";

const TOGGLE_EVENT = "owllm:tutorial-recorder-toggle";
const HAND_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='42' height='46' viewBox='0 0 42 46'%3E%3Cpath d='M17.6 4.8c2.1 0 3.8 1.7 3.8 3.8v11.2l1.6-2.1c1.2-1.6 3.4-2 5.1-.8 1.1.8 1.6 2 1.6 3.2.7-.4 1.5-.5 2.4-.4 2 .4 3.3 2.3 2.9 4.3l-.3 1.5c.7-.2 1.5-.1 2.2.2 1.9.8 2.7 3 1.9 4.9l-2.1 5c-1.9 4.6-6.4 7.5-11.4 7.5h-4.8c-4 0-7.8-1.9-10.1-5.2L3.6 28c-1.1-1.6-.8-3.8.8-5 1.3-1 3.2-.9 4.4.2l5 4.6V8.6c0-2.1 1.7-3.8 3.8-3.8Z' fill='%23ffe0a8' stroke='%23271407' stroke-width='2.2' stroke-linejoin='round'/%3E%3Cpath d='M21.4 19.8v8.8M29.5 20.1l-3.3 8.8M34.7 25.5l-2.2 6.8M13.8 27.8v5.6' stroke='%239f6430' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E\") 10 8, pointer";

// The full app rectangle (content window + the frame that's drawn in the
// separate, larger overlay window around it) plus the monitor it's on, in
// physical px. Returned by the Rust `overlay_frame_capture_geometry` command.
type CaptureGeometry = {
  x: number; y: number; w: number; h: number;
  monitor_x: number; monitor_y: number; monitor_w: number; monitor_h: number;
  scale_factor: number;
};

export function toggleTutorialRecorder() {
  window.dispatchEvent(new CustomEvent(TOGGLE_EVENT));
}

// Crop a full-screen capture down to the app rectangle. The frame lives in a
// SEPARATE window OUTSIDE the main content window, so the only surface that
// holds both is the screen; we draw the app's sub-rect of the screen video to
// an off-screen canvas every frame and record THAT. Async so we can wait for
// the first decoded frame before building the recorded stream (otherwise the
// MediaRecorder can start on a zero-content canvas and produce nothing).
async function cropScreenToApp(src: MediaStream, geom: CaptureGeometry): Promise<{ stream: MediaStream; stop: () => void }> {
  const video = document.createElement("video");
  video.srcObject = src;
  video.muted = true;
  (video as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  // Must be in the DOM (even if invisible) for WebView2 to decode frames a
  // canvas can read; a fully-detached <video> often stays at 0×0.
  video.style.cssText = "position:fixed;left:-99999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);
  await video.play().catch(() => {});
  // Wait for the first frame (videoWidth becomes non-zero), with a timeout so
  // a stuck stream still proceeds rather than hanging the Record button.
  await new Promise<void>((resolve) => {
    if (video.videoWidth) return resolve();
    const done = () => resolve();
    video.addEventListener("loadeddata", done, { once: true });
    setTimeout(done, 1500);
  });

  const vw = video.videoWidth || geom.monitor_w;
  const vh = video.videoHeight || geom.monitor_h;
  // The video may be captured at a different resolution than the monitor's
  // reported physical size, so scale by videoWidth/monitorW (DPI / downscale).
  const sx = vw / Math.max(1, geom.monitor_w);
  const sy = vh / Math.max(1, geom.monitor_h);
  // A few px of breathing room so the frame isn't cropped flush. The overlay
  // window already leaves a left margin, so pad only TOP / RIGHT / BOTTOM.
  const PAD = 16;
  let cx = (geom.x - geom.monitor_x) * sx;
  let cy = (geom.y - PAD - geom.monitor_y) * sy;
  let cw = (geom.w + PAD) * sx;
  let ch = (geom.h + 2 * PAD) * sy;
  cx = Math.max(0, Math.min(cx, Math.max(0, vw - 2)));
  cy = Math.max(0, Math.min(cy, Math.max(0, vh - 2)));
  cw = Math.max(2, Math.min(cw, vw - cx));
  ch = Math.max(2, Math.min(ch, vh - cy));

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cw);
  canvas.height = Math.round(ch);
  const ctx = canvas.getContext("2d");
  // Paint once so captureStream has real content immediately.
  if (ctx) { ctx.fillStyle = "#0a0e1a"; ctx.fillRect(0, 0, canvas.width, canvas.height); }

  let raf = 0;
  let stopped = false;
  const draw = () => {
    if (stopped) return;
    if (ctx && video.videoWidth) {
      try { ctx.drawImage(video, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height); } catch { /* frame not ready */ }
    }
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);

  const stream = canvas.captureStream(30);
  return {
    stream,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
      try { video.pause(); } catch { /* ignore */ }
      video.srcObject = null;
      video.remove();
    },
  };
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function ClickPulseOverlay({
  mark,
  active,
}: {
  mark: ClickMark | null;
  active: boolean;
}) {
  if (!active) return null;
  return (
    <div
      data-ui="TutorialPointerLayer"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 12000,
        pointerEvents: "none",
      }}
    >
      {mark && (
        <div
          key={mark.id}
          data-ui="TutorialClickPulse"
          style={{
            position: "absolute",
            left: mark.x,
            top: mark.y,
            width: 36,
            height: 36,
            marginLeft: -18,
            marginTop: -18,
            borderRadius: "50%",
            border: "2px solid rgba(var(--accent-rgb),0.86)",
            boxShadow: "0 0 18px rgba(var(--accent-rgb),0.55)",
            animation: "owllmTutorialPulse 520ms ease-out forwards",
          }}
        />
      )}
      <style>{`
        @keyframes owllmTutorialPulse {
          0% { transform: scale(0.3); opacity: 0.95; }
          100% { transform: scale(1.8); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

async function requestDisplayStream(mode: CaptureMode): Promise<MediaStream> {
  const media = navigator.mediaDevices as MediaDevices & {
    getDisplayMedia(options?: unknown): Promise<MediaStream>;
  };
  const preferred = {
    video: {
      frameRate: 30,
      cursor: "always",
      displaySurface: mode === "screen" ? "monitor" : "window",
    },
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
  };
  try {
    return await media.getDisplayMedia(preferred);
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw err;
    }
    return media.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  }
}

export default function TutorialRecorder({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RecorderState>("idle");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("window");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [mark, setMark] = useState<ClickMark | null>(null);
  const [status, setStatus] = useState("“Window + frame” records the screen and auto-crops to the OWLLM app (frame included). Pick the screen OWLLM is on. Use Ctrl+Shift+R to stop.");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number>(0);
  const pausedAtRef = useRef<number | null>(null);
  const pausedTotalRef = useRef<number>(0);
  const clickIdRef = useRef(0);
  const clickTrackRef = useRef<Array<{ t: number; x: number; y: number; target: string }>>([]);
  // Crop pipeline for "window" mode (screen capture cropped to the app rect).
  const cropHandleRef = useRef<{ stream: MediaStream; stop: () => void } | null>(null);

  useEffect(() => {
    const onToggle = () => {
      if (!enabled) return;
      if (state === "recording" || state === "paused") {
        stop();
        return;
      }
      setOpen(v => !v);
    };
    window.addEventListener(TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_EVENT, onToggle);
  }, [enabled, state]);

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (state !== "recording") return;
    const id = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAtRef.current - pausedTotalRef.current);
    }, 250);
    return () => window.clearInterval(id);
  }, [state]);

  useEffect(() => {
    if (state !== "recording" && state !== "paused") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        stop();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [state]);

  useEffect(() => {
    if (state !== "recording") return;
    const cursorClass = "owllm-tutorial-recording";
    const style = document.createElement("style");
    style.dataset.owllmTutorialCursor = "1";
    style.textContent = `html.${cursorClass}, html.${cursorClass} * { cursor: ${HAND_CURSOR} !important; }`;
    document.head.appendChild(style);
    document.documentElement.classList.add(cursorClass);
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof HTMLElement
        ? e.target.closest("[data-ui], button, input, select, textarea, a") as HTMLElement | null
        : null;
      const next = { x: e.clientX, y: e.clientY };
      const id = ++clickIdRef.current;
      setMark({ ...next, id });
      clickTrackRef.current.push({
        t: performance.now() - startedAtRef.current - pausedTotalRef.current,
        x: Math.round(next.x),
        y: Math.round(next.y),
        target: target?.getAttribute("data-ui") || target?.textContent?.trim().slice(0, 80) || "",
      });
      window.setTimeout(() => {
        setMark(current => current?.id === id ? null : current);
      }, 600);
    };
    window.addEventListener("click", onClick, true);
    return () => {
      document.documentElement.classList.remove(cursorClass);
      style.remove();
      window.removeEventListener("click", onClick, true);
    };
  }, [state]);

  const canRecord = useMemo(() => (
    typeof navigator !== "undefined"
      && Boolean(navigator.mediaDevices?.getDisplayMedia)
      && typeof MediaRecorder !== "undefined"
  ), []);

  const stopStreams = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  };

  const start = async () => {
    if (!canRecord) {
      setStatus("Screen capture is not available in this WebView.");
      return;
    }
    try {
      chunksRef.current = [];
      clickTrackRef.current = [];
      pausedTotalRef.current = 0;
      pausedAtRef.current = null;
      startedAtRef.current = performance.now();
      setElapsedMs(0);
      setStatus(captureMode === "screen"
        ? "Recording full screen. The recorder panel is hidden from the video. Press Ctrl+Shift+R or the header Record button to stop."
        : "In the dialog, click “Entire Screen” and pick the screen OWLLM is on — I crop it to just the app (frame included). Press Ctrl+Shift+R to stop.");

      // "Window" mode: the frame is a SEPARATE window OUTSIDE the main one, so
      // a single-window capture can't include it. Capture the whole screen and
      // crop to the app's real rect (content + frame) instead.
      const geom = captureMode === "window"
        ? await invoke<CaptureGeometry | null>("overlay_frame_capture_geometry").catch(() => null)
        : null;

      // Both modes capture a display surface; window mode then crops — but
      // ONLY if the user actually shared a whole screen. If they pick a single
      // window the crop math (screen-relative) doesn't apply, so we record
      // that window as-is rather than producing a broken sliver.
      const screenStream = await requestDisplayStream("screen");
      streamRef.current = screenStream;

      const surface = (screenStream.getVideoTracks()[0]?.getSettings?.() as { displaySurface?: string } | undefined)?.displaySurface;
      let recordStream = screenStream;
      if (captureMode === "window" && geom && surface === "monitor") {
        try {
          const handle = await cropScreenToApp(screenStream, geom);
          cropHandleRef.current = handle;
          recordStream = handle.stream;
        } catch {
          // Crop pipeline failed → record the full screen rather than nothing.
          recordStream = screenStream;
        }
      } else if (captureMode === "window" && surface !== "monitor") {
        setStatus("Recording the chosen window as-is. To include the OWLLM frame, stop and re-record, choosing “Entire Screen”. Ctrl+Shift+R to stop.");
      }

      const recorder = new MediaRecorder(recordStream, {
        mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm",
      });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const durationMs = performance.now() - startedAtRef.current - pausedTotalRef.current;
        const video = new Blob(chunksRef.current, { type: "video/webm" });
        const track = new Blob([JSON.stringify({
          createdAt: new Date().toISOString(),
          durationMs: Math.round(durationMs),
          clicks: clickTrackRef.current,
        }, null, 2)], { type: "application/json" });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(video, `owllm-tutorial-${stamp}.webm`);
        downloadBlob(track, `owllm-tutorial-${stamp}-clicks.json`);
        cropHandleRef.current?.stop();
        cropHandleRef.current = null;
        stopStreams();
        setState("idle");
        setStatus("Saved video and click track.");
      };
      // Stop if the user ends the share from the browser/OS chrome.
      screenStream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
      recorder.start(250);
      setState("recording");
    } catch (err) {
      cropHandleRef.current?.stop();
      cropHandleRef.current = null;
      stopStreams();
      setState("idle");
      setStatus(err instanceof Error ? err.message : "Could not start recording.");
    }
  };

  const pause = () => {
    const recorder = mediaRecorderRef.current;
    if (state === "recording" && recorder?.state === "recording") {
      recorder.pause();
      pausedAtRef.current = performance.now();
      setState("paused");
      setStatus("Paused.");
    } else if (state === "paused" && recorder?.state === "paused") {
      if (pausedAtRef.current != null) {
        pausedTotalRef.current += performance.now() - pausedAtRef.current;
      }
      pausedAtRef.current = null;
      recorder.resume();
      setState("recording");
      setStatus("Recording.");
    }
  };

  const stop = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setState("saving");
      setStatus("Saving recording...");
      recorder.stop();
    } else {
      cropHandleRef.current?.stop();
      cropHandleRef.current = null;
      stopStreams();
      setState("idle");
    }
  };

  if (!enabled || !open) return null;

  const recording = state === "recording";
  const active = state === "recording" || state === "paused" || state === "saving";
  const hidePanel = active;

  return (
    <>
      <ClickPulseOverlay mark={mark} active={active} />
      {!hidePanel && (
        <div
          data-ui="TutorialRecorderPanel"
          style={{
            position: "fixed",
            right: 82,
            top: 76,
            zIndex: 13000,
            width: 310,
            padding: 10,
            borderRadius: 8,
            background: "rgba(10,14,26,0.94)",
            border: "1px solid rgba(var(--accent-rgb),0.45)",
            boxShadow: "0 12px 36px rgba(0,0,0,0.48)",
            color: "var(--fg)",
            fontSize: 12,
          }}
        >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <strong style={{ color: "var(--fg-strong)" }}>Tutorial Recorder</strong>
          <div style={{ flex: 1 }} />
          <span style={{ fontVariantNumeric: "tabular-nums", color: recording ? "#40ff88" : "var(--fg-muted)" }}>
            {formatTime(elapsedMs)}
          </span>
          <button
            onClick={() => setOpen(false)}
            disabled={active}
            style={{
              width: 22,
              height: 22,
              border: "none",
              borderRadius: 4,
              background: active ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.12)",
              color: "var(--fg)",
              cursor: active ? "not-allowed" : "pointer",
            }}
          >
            ×
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
          <button
            onClick={() => setCaptureMode("window")}
            disabled={active}
            style={modeBtn(captureMode === "window", active)}
          >
            Window + frame
          </button>
          <button
            onClick={() => setCaptureMode("screen")}
            disabled={active}
            style={modeBtn(captureMode === "screen", active)}
          >
            Full screen
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button
            onClick={start}
            disabled={state !== "idle"}
            style={recBtn(state === "idle", "#18c96e")}
          >
            Record
          </button>
          <button
            onClick={pause}
            disabled={state !== "recording" && state !== "paused"}
            style={recBtn(state === "recording" || state === "paused", "#fbbf24")}
          >
            {state === "paused" ? "Resume" : "Pause"}
          </button>
          <button
            onClick={stop}
            disabled={state === "idle" || state === "saving"}
            style={recBtn(state !== "idle" && state !== "saving", "#ef4444")}
          >
            Stop
          </button>
        </div>
        <div style={{ color: "var(--fg-muted)", lineHeight: 1.35 }}>
          {status}
        </div>
        </div>
      )}
    </>
  );
}

function modeBtn(selected: boolean, locked: boolean): React.CSSProperties {
  return {
    height: 26,
    borderRadius: 5,
    border: selected ? "1px solid rgba(var(--accent-rgb),0.72)" : "1px solid rgba(255,255,255,0.14)",
    background: selected ? "rgba(var(--accent-rgb),0.22)" : "rgba(255,255,255,0.06)",
    color: selected ? "#ffffff" : "var(--fg-muted)",
    fontSize: 11,
    fontWeight: 700,
    cursor: locked ? "not-allowed" : "pointer",
  };
}

function recBtn(enabled: boolean, color: string): React.CSSProperties {
  return {
    height: 28,
    padding: "0 10px",
    borderRadius: 5,
    border: `1px solid ${enabled ? color : "rgba(255,255,255,0.16)"}`,
    background: enabled ? `${color}2c` : "rgba(255,255,255,0.06)",
    color: enabled ? "#ffffff" : "var(--fg-muted)",
    fontWeight: 700,
    fontSize: 12,
    cursor: enabled ? "pointer" : "not-allowed",
  };
}
