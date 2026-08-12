import React, { useEffect, useMemo, useRef, useState } from "react";
import { isRunActive, subscribeRunActivity } from "../runtime/runActivity";
import type { FinalizedVideo, FinalizedVideoRecorder } from "./finalizedVideoRecorder";
import {
  nativeScreencastStart,
  nativeScreencastStop,
  nativeScreencastSupported,
} from "./nativeScreencast";
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

function describeCaptureSettings(settings: MediaTrackSettings, requestedFps: number): string {
  const size = settings.width && settings.height
    ? `${settings.width}×${settings.height}`
    : "native resolution";
  const actualFps = settings.frameRate ? Math.round(settings.frameRate) : requestedFps;
  return `${size} at ${actualFps} FPS`;
}

export default function TutorialRecorder({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RecorderState>("idle");
  // Direct window capture preserves native pixels and excludes desktop chrome.
  // Whole-screen capture remains available for tutorials spanning several apps.
  const [appOnly, setAppOnly] = useState<boolean>(true);
  const [captureUiHidden, setCaptureUiHidden] = useState(false);
  // Capture frame-rate — lower keeps long recordings from filling the drive.
  const [fps, setFps] = useState<number>(() => readFps(safeLocalStorage()));
  // Auto-stop the recording a few seconds after an agent/coding job finishes.
  const [autoStopAfterJob, setAutoStopAfterJob] = useState<boolean>(() => readAutoStop(safeLocalStorage()));
  const [elapsedMs, setElapsedMs] = useState(0);
  const [mark, setMark] = useState<ClickMark | null>(null);
  const [status, setStatus] = useState("Records the OWLLM window directly at native resolution. Choose the OWLLM window in the share dialog; use Ctrl+Shift+R to stop.");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const finalizedRecorderRef = useRef<FinalizedVideoRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const captureSettingsRef = useRef<MediaTrackSettings>({});
  const startedAtRef = useRef<number>(0);
  const pausedAtRef = useRef<number | null>(null);
  const pausedTotalRef = useRef<number>(0);
  const clickIdRef = useRef(0);
  const clickTrackRef = useRef<Array<{ t: number; x: number; y: number; target: string }>>([]);
  // Auto-stop-after-job bookkeeping: pending countdown timer + whether a job was
  // ever seen running during THIS recording (so a recording started with no job
  // in flight doesn't stop itself before any work has run).
  const autoStopTimerRef = useRef<number | null>(null);
  const sawRunRef = useRef<boolean>(false);
  // GNOME Shell recorder (Linux): the portal route getDisplayMedia depends on
  // crashes, so where this is available it replaces it. Holds the file stem of
  // the running native recording, or null when the WebView path is in use.
  const [nativeCapture, setNativeCapture] = useState(false);
  const nativeStemRef = useRef<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    void nativeScreencastSupported().then((ok) => {
      if (cancelled || !ok) return;
      setNativeCapture(true);
      setStatus("Records through GNOME Shell — no share dialog. Window-only records the OWLLM window's area; Ctrl+Shift+R to stop.");
    });
    return () => { cancelled = true; };
  }, []);

  const webViewCapture = useMemo(() => (
    typeof navigator !== "undefined"
      && Boolean(navigator.mediaDevices?.getDisplayMedia)
  ), []);
  const canRecord = nativeCapture || webViewCapture;

  const stopStreams = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  };

  const hideRecorderUiForCapture = async () => {
    setCaptureUiHidden(true);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  };

  // The click track pairs with the video by name, so both paths build it the
  // same way — only the video itself differs (blob download vs. a file GNOME
  // already wrote to disk).
  const clickTrackBlob = (format: string) => {
    const durationMs = performance.now() - startedAtRef.current - pausedTotalRef.current;
    const settings = captureSettingsRef.current;
    return new Blob([JSON.stringify({
      createdAt: new Date().toISOString(),
      durationMs: Math.round(durationMs),
      format,
      width: settings.width ?? null,
      height: settings.height ?? null,
      fps: settings.frameRate ?? fps,
      clicks: clickTrackRef.current,
    }, null, 2)], { type: "application/json" });
  };

  const finishRecording = (video: FinalizedVideo) => {
    const settings = captureSettingsRef.current;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob(video.blob, `owllm-tutorial-${stamp}.${video.extension}`);
    downloadBlob(clickTrackBlob(video.mimeType), `owllm-tutorial-${stamp}-clicks.json`);
    finalizedRecorderRef.current = null;
    mediaRecorderRef.current = null;
    stopStreams();
    setCaptureUiHidden(false);
    setState("idle");
    setStatus(`Saved ${video.label} at ${describeCaptureSettings(settings, fps)}.`);
  };

  // GNOME wrote the video itself, so only the click track still needs saving.
  const finishNativeRecording = (path: string, bytes: number) => {
    const stem = nativeStemRef.current ?? "owllm-tutorial";
    downloadBlob(clickTrackBlob("video/mp4"), `${stem}-clicks.json`);
    nativeStemRef.current = null;
    setCaptureUiHidden(false);
    setState("idle");
    setStatus(`Saved ${Math.round(bytes / 1024)} KB to ${path}.`);
  };

  const failRecording = (error: unknown) => {
    finalizedRecorderRef.current = null;
    mediaRecorderRef.current = null;
    nativeStemRef.current = null;
    stopStreams();
    setCaptureUiHidden(false);
    setState("idle");
    setStatus(error instanceof Error ? error.message : "Could not save recording.");
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
      setElapsedMs(0);
      setStatus(nativeCapture
        ? "Starting the GNOME Shell recorder..."
        : appOnly
          ? "Choose the OWLLM window. The recorder panel is hidden before capture starts."
          : "Choose the screen to record. Press Ctrl+Shift+R to stop.");
      await hideRecorderUiForCapture();

      if (nativeCapture) {
        const stem = `owllm-tutorial-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        const path = await nativeScreencastStart(stem, fps, appOnly);
        nativeStemRef.current = stem;
        // GNOME reports no track settings; the requested rate is what it got.
        captureSettingsRef.current = { frameRate: fps };
        startedAtRef.current = performance.now();
        setState("recording");
        setStatus(`Recording ${appOnly ? "the OWLLM window" : "the screen"} at ${fps} FPS to ${path}. Ctrl+Shift+R to stop.`);
        return;
      }

      const screenStream = await requestDisplayStream(appOnly ? "window" : "screen", fps);
      streamRef.current = screenStream;
      const videoTrack = screenStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("The selected surface returned no video track.");
      const settings = videoTrack.getSettings();
      const surface = settings.displaySurface;
      if (appOnly && surface === "monitor") {
        throw new Error("App-only mode requires the OWLLM window, not Entire Screen. Start again and choose the OWLLM window.");
      }
      videoTrack.contentHint = "detail";
      captureSettingsRef.current = settings;
      const bitrate = bitrateForCapture(fps, settings.width, settings.height, "video/mp4");
      const { createFinalizedVideoRecorder } = await import("./finalizedVideoRecorder");
      const finalized = await createFinalizedVideoRecorder(videoTrack, fps, bitrate);
      if (finalized) {
        finalizedRecorderRef.current = finalized;
      } else {
        if (typeof MediaRecorder === "undefined") {
          throw new Error("This WebView has no compatible local video encoder.");
        }
        const format = chooseRecorderFormat((mimeType) => (
          !mimeType.includes("mp4") && MediaRecorder.isTypeSupported(mimeType)
        ));
        const options: MediaRecorderOptions = {
          videoBitsPerSecond: bitrateForCapture(fps, settings.width, settings.height, format.mimeType),
        };
        if (format.mimeType) options.mimeType = format.mimeType;
        const recorder = new MediaRecorder(screenStream, options);
        mediaRecorderRef.current = recorder;
        recorder.ondataavailable = event => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onstop = () => finishRecording({
          blob: new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" }),
          extension: "webm",
          label: "native WebM fallback",
          mimeType: recorder.mimeType || "video/webm",
        });
        recorder.start();
      }
      startedAtRef.current = performance.now();
      // Stop if the user ends the share from the browser/OS chrome.
      screenStream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
      setState("recording");
      const formatLabel = finalized?.label ?? "native WebM fallback";
      setStatus(`Recording ${describeCaptureSettings(settings, fps)} as ${formatLabel}. Ctrl+Shift+R to stop.`);
    } catch (err) {
      if (finalizedRecorderRef.current) {
        await finalizedRecorderRef.current.cancel().catch(() => {});
        finalizedRecorderRef.current = null;
      }
      stopStreams();
      setCaptureUiHidden(false);
      setState("idle");
      setStatus(err instanceof Error ? err.message : "Could not start recording.");
    }
  };

  const pause = () => {
    const recorder = mediaRecorderRef.current;
    const finalized = finalizedRecorderRef.current;
    if (state === "recording" && (finalized || recorder?.state === "recording")) {
      if (finalized) finalized.pause();
      else recorder?.pause();
      pausedAtRef.current = performance.now();
      setState("paused");
      setStatus("Paused.");
    } else if (state === "paused" && (finalized || recorder?.state === "paused")) {
      if (pausedAtRef.current != null) {
        pausedTotalRef.current += performance.now() - pausedAtRef.current;
      }
      pausedAtRef.current = null;
      if (finalized) finalized.resume();
      else recorder?.resume();
      setState("recording");
      setStatus("Recording.");
    }
  };

  const stop = () => {
    if (autoStopTimerRef.current != null) {
      window.clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    if (nativeStemRef.current) {
      setState("saving");
      setStatus("Finalizing the recording...");
      void nativeScreencastStop()
        .then(file => finishNativeRecording(file.path, file.bytes))
        .catch(failRecording);
      return;
    }
    const recorder = mediaRecorderRef.current;
    const finalized = finalizedRecorderRef.current;
    if (finalized) {
      setState("saving");
      setStatus("Finalizing seek index and saving recording...");
      void finalized.finalize().then(finishRecording).catch(failRecording);
    } else if (recorder && recorder.state !== "inactive") {
      setState("saving");
      setStatus("Saving recording...");
      recorder.stop();
    } else {
      stopStreams();
      setCaptureUiHidden(false);
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
      {!captureUiHidden && !hidePanel && (
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
          title="On: captures the OWLLM window directly at native resolution. Off: captures an entire screen."
        >
          <input
            type="checkbox"
            checked={appOnly}
            disabled={active}
            onChange={(e) => setAppOnly(e.target.checked)}
            style={{ width: 14, height: 14, accentColor: "var(--accent)" }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg-strong)" }}>
            ◩ Record the OWLLM window only (best quality)
          </span>
        </label>
        <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginBottom: 8, lineHeight: 1.35 }}>
          {nativeCapture
            ? <>GNOME Shell records the <b>window's area</b> directly — no share dialog, and no pause.</>
            : <>Choose the <b>OWLLM window</b>. The recorder panel and desktop sharing popup stay outside the saved video.</>}
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
          <b style={{ color: "var(--fg-strong)" }}>{nativeCapture ? "GNOME Shell MP4" : "Finalized H.264 MP4"}</b>
          {nativeCapture
            ? " · written straight to disk · native resolution"
            : " · indexed · seekable · native resolution · VP9 fallback"}
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
            // GNOME's recorder has no pause — only the WebView path can.
            disabled={nativeCapture || (state !== "recording" && state !== "paused")}
            title={nativeCapture ? "The GNOME Shell recorder cannot pause." : undefined}
            style={recBtn(!nativeCapture && (state === "recording" || state === "paused"), "#fbbf24")}
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
