import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isRunActive, subscribeRunActivity } from "../runtime/runActivity";
import {
  AUTO_STOP_DELAY_MS,
  DEFAULT_FPS,
  FPS_OPTIONS,
  bitrateForCapture,
  chooseRecorderFormat,
  jobJustEnded,
  readAutoStop,
  readFps,
  saveAutoStop,
  saveFps,
} from "./tutorialRecorderPrefs";

type Point = { x: number; y: number };
type ClickMark = Point & { id: number };

type RecorderState = "idle" | "recording" | "paused" | "saving";

function recorderIsActive(state: RecorderState): boolean {
  return state === "recording" || state === "paused" || state === "saving";
}
type CaptureMode = "window" | "screen";

const TOGGLE_EVENT = "owllm:tutorial-recorder-toggle";
const TUTORIAL_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='30' viewBox='0 0 24 30'%3E%3Cpath d='M3 2.5 20.2 17h-7.7l4.4 8.2-4.3 2.3-4.3-8.2-5.3 5.1Z' fill='%23081120' stroke='%237ce7ff' stroke-width='1.8' stroke-linejoin='round'/%3E%3Cpath d='m5.7 6.6 9.6 8.1h-4.9l2.9 5.5' fill='none' stroke='%23ffffff' stroke-opacity='.72' stroke-width='1.15' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\") 3 3, pointer";

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

// localStorage guarded for non-browser/blocked contexts (SSR, private mode).
function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

// Crop a full-screen capture down to the app rectangle. The frame lives in a
// SEPARATE window OUTSIDE the main content window, so the only surface that
// holds both is the screen; we draw the app's sub-rect of the screen video to
// an off-screen canvas every frame and record THAT. Async so we can wait for
// the first decoded frame before building the recorded stream (otherwise the
// MediaRecorder can start on a zero-content canvas and produce nothing).
async function cropScreenToApp(src: MediaStream, geom: CaptureGeometry, fps: number): Promise<{ stream: MediaStream; stop: () => void }> {
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
  // Crop to EXACTLY the overlay window's rect. By construction that rect
  // already spans content + frame: the frame art lives in the overlay window
  // and its corner PNGs reach (and are clipped ~1px at) all four overlay edges
  // — see overlay_frame.rs constants + overlay-frame.html layout(). So NO
  // guessed padding is needed; the overlay extends past the content window by
  // 19/54/19/19 px and geom already encodes that. The only reason a flush crop
  // ever shaved the frame was sub-pixel DPI scaling (sx/sy) + Math.round, so we
  // round the rect OUTWARD: floor the top-left, ceil the bottom-right. Rounding
  // can then only ever ADD ≤1px of desktop, never trim a frame pixel.
  const left = (geom.x - geom.monitor_x) * sx;
  const top = (geom.y - geom.monitor_y) * sy;
  const right = (geom.x - geom.monitor_x + geom.w) * sx;
  const bottom = (geom.y - geom.monitor_y + geom.h) * sy;
  let cx = Math.floor(left);
  let cy = Math.floor(top);
  let cw = Math.ceil(right) - cx;
  let ch = Math.ceil(bottom) - cy;
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

  const stream = canvas.captureStream(fps);
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

async function requestDisplayStream(mode: CaptureMode, fps: number): Promise<MediaStream> {
  const media = navigator.mediaDevices as MediaDevices & {
    getDisplayMedia(options?: unknown): Promise<MediaStream>;
  };
  const preferred = {
    video: {
      frameRate: fps,
      width: { max: 1920 },
      height: { max: 1080 },
      cursor: "always",
      displaySurface: mode === "screen" ? "monitor" : "window",
    },
    audio: false,
    preferCurrentTab: false,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
  };
  try {
    const stream = await media.getDisplayMedia(preferred);
    const track = stream.getVideoTracks()[0];
    if (track) track.contentHint = "detail";
    return stream;
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw err;
    }
    const stream = await media.getDisplayMedia({ video: { frameRate: fps }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (track) track.contentHint = "detail";
    return stream;
  }
}

export default function TutorialRecorder({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RecorderState>("idle");
  // We always capture a whole screen; this toggle decides whether the result is
  // cropped down to just the OWLLM app (frame included) or kept as the full screen.
  const [cropToApp, setCropToApp] = useState<boolean>(true);
  // Capture frame-rate — lower keeps long recordings from filling the drive.
  const [fps, setFps] = useState<number>(() => readFps(safeLocalStorage()));
  // Auto-stop the recording a few seconds after an agent/coding job finishes.
  const [autoStopAfterJob, setAutoStopAfterJob] = useState<boolean>(() => readAutoStop(safeLocalStorage()));
  const [elapsedMs, setElapsedMs] = useState(0);
  const [mark, setMark] = useState<ClickMark | null>(null);
  const [status, setStatus] = useState("Records your screen and auto-crops to just the OWLLM app (frame included). In the share dialog, choose “Entire Screen”. Use Ctrl+Shift+R to stop.");

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
  // Auto-stop-after-job bookkeeping: pending countdown timer + whether a job was
  // ever seen running during THIS recording (so a recording started with no job
  // in flight doesn't stop itself before any work has run).
  const autoStopTimerRef = useRef<number | null>(null);
  const sawRunRef = useRef<boolean>(false);

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

  // Auto-stop: once a job (agent/coding run) has been seen running during this
  // recording, stop AUTO_STOP_DELAY_MS after the LAST run finishes. A new run
  // starting within that window cancels the countdown, so overlapping jobs keep
  // the recording alive until everything is idle.
  useEffect(() => {
    const clearTimer = () => {
      if (autoStopTimerRef.current != null) {
        window.clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }
    };
    if (state !== "recording" || !autoStopAfterJob) {
      clearTimer();
      return;
    }
    let prevActive = isRunActive();
    if (prevActive) sawRunRef.current = true;
    const evaluate = () => {
      const nowActive = isRunActive();
      if (nowActive) {
        sawRunRef.current = true;
        if (autoStopTimerRef.current != null) {
          clearTimer();
          setStatus("Recording. A new job started — auto-stop cancelled.");
        }
      } else if (jobJustEnded(prevActive, nowActive) && sawRunRef.current && autoStopTimerRef.current == null) {
        const secs = Math.round(AUTO_STOP_DELAY_MS / 1000);
        setStatus(`Job finished — stopping in ${secs}s…`);
        autoStopTimerRef.current = window.setTimeout(() => {
          autoStopTimerRef.current = null;
          stop();
        }, AUTO_STOP_DELAY_MS);
      }
      prevActive = nowActive;
    };
    const unsub = subscribeRunActivity(evaluate);
    return () => {
      unsub();
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, autoStopAfterJob]);

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
    style.textContent = `html.${cursorClass}, html.${cursorClass} * { cursor: ${TUTORIAL_CURSOR} !important; }`;
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
  const preferredFormat = useMemo(() => (
    canRecord ? chooseRecorderFormat(MediaRecorder.isTypeSupported) : null
  ), [canRecord]);

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
      sawRunRef.current = false;
      if (autoStopTimerRef.current != null) {
        window.clearTimeout(autoStopTimerRef.current);
        autoStopTimerRef.current = null;
      }
      startedAtRef.current = performance.now();
      setElapsedMs(0);
      setStatus(cropToApp
        ? "In the share dialog, click “Entire Screen” and pick the screen OWLLM is on — I crop it to just the app (frame included). Press Ctrl+Shift+R to stop."
        : "Recording the whole screen. In the share dialog choose “Entire Screen”. Press Ctrl+Shift+R to stop.");

      // We always capture a whole SCREEN (the frame is a separate window OUTSIDE
      // the main one, so only the screen holds both). The "crop to app" toggle
      // then decides whether we trim it down to the app rect or keep it whole.
      const geom = cropToApp
        ? await invoke<CaptureGeometry | null>("overlay_frame_capture_geometry").catch(() => null)
        : null;

      const screenStream = await requestDisplayStream("screen", fps);
      streamRef.current = screenStream;

      // Crop ONLY if the user actually shared a whole screen — a single window
      // share has no screen-relative geometry, so record it as-is rather than a
      // broken sliver.
      const surface = (screenStream.getVideoTracks()[0]?.getSettings?.() as { displaySurface?: string } | undefined)?.displaySurface;
      let recordStream = screenStream;
      if (cropToApp && geom && surface === "monitor") {
        try {
          const handle = await cropScreenToApp(screenStream, geom, fps);
          cropHandleRef.current = handle;
          recordStream = handle.stream;
        } catch {
          // Crop pipeline failed → record the full screen rather than nothing.
          recordStream = screenStream;
        }
      } else if (cropToApp && surface !== "monitor") {
        setStatus("Recording the chosen window as-is. For the OWLLM frame, stop and re-record, choosing “Entire Screen”. Ctrl+Shift+R to stop.");
      }

      let format = chooseRecorderFormat(MediaRecorder.isTypeSupported);
      const videoTrack = recordStream.getVideoTracks()[0];
      if (videoTrack) videoTrack.contentHint = "detail";
      const settings = videoTrack?.getSettings();
      const recorderOptions: MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number } = {
        // Size the budget for the actual frame instead of starving a 4K source
        // with the same bitrate as 720p. The capture request is capped at 1080p
        // for a sharp, compact tutorial rather than a blurry oversized file.
        videoBitsPerSecond: bitrateForCapture(
          fps,
          settings?.width,
          settings?.height,
          format.mimeType,
        ),
        // Frequent keyframes make scrubbing responsive in players/editors.
        videoKeyFrameIntervalDuration: 2000,
      };
      if (format.mimeType) recorderOptions.mimeType = format.mimeType;
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(recordStream, recorderOptions);
      } catch (err) {
        // Some WebViews advertise an OS H.264 encoder that still refuses the
        // current stream profile. Fall back to WebM instead of losing Record.
        if (!format.mimeType.includes("mp4")) throw err;
        format = chooseRecorderFormat((mimeType) => (
          !mimeType.includes("mp4") && MediaRecorder.isTypeSupported(mimeType)
        ));
        recorderOptions.videoBitsPerSecond = bitrateForCapture(
          fps,
          settings?.width,
          settings?.height,
          format.mimeType,
        );
        if (format.mimeType) recorderOptions.mimeType = format.mimeType;
        else delete recorderOptions.mimeType;
        recorder = new MediaRecorder(recordStream, recorderOptions);
      }
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const durationMs = performance.now() - startedAtRef.current - pausedTotalRef.current;
        const outputMimeType = recorder.mimeType || format.mimeType || "video/webm";
        const extension = outputMimeType.includes("mp4") ? "mp4" : format.extension;
        const video = new Blob(chunksRef.current, { type: outputMimeType });
        const track = new Blob([JSON.stringify({
          createdAt: new Date().toISOString(),
          durationMs: Math.round(durationMs),
          format: outputMimeType,
          width: settings?.width ?? null,
          height: settings?.height ?? null,
          fps,
          clicks: clickTrackRef.current,
        }, null, 2)], { type: "application/json" });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadBlob(video, `owllm-tutorial-${stamp}.${extension}`);
        downloadBlob(track, `owllm-tutorial-${stamp}-clicks.json`);
        cropHandleRef.current?.stop();
        cropHandleRef.current = null;
        if (autoStopTimerRef.current != null) {
          window.clearTimeout(autoStopTimerRef.current);
          autoStopTimerRef.current = null;
        }
        stopStreams();
        setState("idle");
        setStatus(`Saved ${format.label} video and click track.`);
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
    if (autoStopTimerRef.current != null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
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
  const active = recorderIsActive(state);
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
        <label
          style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
            padding: "7px 9px", borderRadius: 6,
            border: "1px solid rgba(var(--accent-rgb),0.35)",
            background: "rgba(var(--accent-rgb),0.08)",
            cursor: active ? "not-allowed" : "pointer", opacity: active ? 0.6 : 1,
          }}
          title="On: trims the screen recording down to just the OWLLM app + frame. Off: keeps the whole screen."
        >
          <input
            type="checkbox"
            checked={cropToApp}
            disabled={active}
            onChange={(e) => setCropToApp(e.target.checked)}
            style={{ width: 14, height: 14, accentColor: "var(--accent)" }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg-strong)" }}>
            ✂ Crop to the OWLLM app (frame included)
          </span>
        </label>
        <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginBottom: 8, lineHeight: 1.35 }}>
          In the share dialog, choose <b>Entire Screen</b> (not Window). Off = record the whole screen.
        </div>
        <div
          data-ui="TutorialRecorderFormat"
          style={{
            marginBottom: 8, padding: "6px 9px", borderRadius: 6,
            border: "1px solid rgba(var(--accent-rgb),0.3)",
            background: "rgba(var(--accent-rgb),0.06)",
            color: "var(--fg-muted)", fontSize: 10.5,
          }}
        >
          <b style={{ color: "var(--fg-strong)" }}>{preferredFormat?.label ?? "Native video"}</b>
          {preferredFormat?.extension === "mp4"
            ? " · seekable · editor-friendly · 1080p max"
            : " · compatible WebM fallback · 1080p max"}
        </div>
        <label
          style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
            padding: "6px 9px", borderRadius: 6,
            border: "1px solid rgba(var(--accent-rgb),0.35)",
            background: "rgba(var(--accent-rgb),0.08)",
            cursor: active ? "not-allowed" : "pointer", opacity: active ? 0.6 : 1,
          }}
          title="Lower frame rates make much smaller files — ideal for long recordings so they don't fill the drive."
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg-strong)" }}>🎞 Frame rate</span>
          <div style={{ flex: 1 }} />
          <select
            value={fps}
            disabled={active}
            onChange={(e) => {
              const next = Number(e.target.value) || DEFAULT_FPS;
              setFps(next);
              saveFps(next, safeLocalStorage());
            }}
            data-ui="TutorialRecorderFps"
            style={{
              height: 26, padding: "0 6px", borderRadius: 5,
              border: "1px solid rgba(var(--accent-rgb),0.4)",
              background: "rgba(255,255,255,0.06)", color: "var(--fg)",
              fontSize: 12, fontWeight: 700,
              cursor: active ? "not-allowed" : "pointer",
            }}
          >
            {FPS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{opt} fps</option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
            padding: "7px 9px", borderRadius: 6,
            border: "1px solid rgba(var(--accent-rgb),0.35)",
            background: "rgba(var(--accent-rgb),0.08)",
            cursor: active ? "not-allowed" : "pointer", opacity: active ? 0.6 : 1,
          }}
          title="When a running agent/coding job finishes, the recording stops itself 3 seconds later. A new job starting within those 3s cancels the stop."
        >
          <input
            type="checkbox"
            checked={autoStopAfterJob}
            disabled={active}
            onChange={(e) => {
              setAutoStopAfterJob(e.target.checked);
              saveAutoStop(e.target.checked, safeLocalStorage());
            }}
            data-ui="TutorialRecorderAutoStop"
            style={{ width: 14, height: 14, accentColor: "var(--accent)" }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg-strong)" }}>
            ⏱ Stop 3s after the job finishes
          </span>
        </label>
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
