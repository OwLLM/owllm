import React, { useEffect, useMemo, useRef, useState } from "react";

type Point = { x: number; y: number };
type ClickMark = Point & { id: number };

type RecorderState = "idle" | "recording" | "paused" | "saving";

const TOGGLE_EVENT = "owllm:tutorial-recorder-toggle";

export function toggleTutorialRecorder() {
  window.dispatchEvent(new CustomEvent(TOGGLE_EVENT));
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

function PointerOverlay({
  point,
  mark,
  active,
}: {
  point: Point;
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
      <div
        data-ui="TutorialPointer"
        style={{
          position: "absolute",
          left: point.x,
          top: point.y,
          transform: "translate(-10px, -8px)",
          transition: "left 420ms cubic-bezier(.2,.9,.25,1), top 420ms cubic-bezier(.2,.9,.25,1)",
          filter: "drop-shadow(0 3px 7px rgba(0,0,0,0.65))",
          animation: mark ? "owllmTutorialTap 360ms ease-out" : "none",
          transformOrigin: "18px 8px",
        }}
      >
        <svg width="42" height="46" viewBox="0 0 42 46" aria-hidden="true">
          <path
            d="M17.6 4.8c2.1 0 3.8 1.7 3.8 3.8v11.2l1.6-2.1c1.2-1.6 3.4-2 5.1-.8 1.1.8 1.6 2 1.6 3.2.7-.4 1.5-.5 2.4-.4 2 .4 3.3 2.3 2.9 4.3l-.3 1.5c.7-.2 1.5-.1 2.2.2 1.9.8 2.7 3 1.9 4.9l-2.1 5c-1.9 4.6-6.4 7.5-11.4 7.5h-4.8c-4 0-7.8-1.9-10.1-5.2L3.6 28c-1.1-1.6-.8-3.8.8-5 1.3-1 3.2-.9 4.4.2l5 4.6V8.6c0-2.1 1.7-3.8 3.8-3.8Z"
            fill="#ffe0a8"
            stroke="#271407"
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
          <path
            d="M21.4 19.8v8.8M29.5 20.1l-3.3 8.8M34.7 25.5l-2.2 6.8"
            stroke="#9f6430"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M13.8 27.8v5.6"
            stroke="#9f6430"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </div>
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
        @keyframes owllmTutorialTap {
          0% { transform: translate(-10px, -8px) rotate(0deg) scale(1); }
          45% { transform: translate(-10px, -8px) rotate(-9deg) scale(0.88); }
          100% { transform: translate(-10px, -8px) rotate(0deg) scale(1); }
        }
      `}</style>
    </div>
  );
}

async function requestDisplayStream(): Promise<MediaStream> {
  const media = navigator.mediaDevices as MediaDevices & {
    getDisplayMedia(options?: unknown): Promise<MediaStream>;
  };
  const preferred = {
    video: {
      frameRate: 30,
      cursor: "never",
      displaySurface: "monitor",
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
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pointer, setPointer] = useState<Point>({ x: 160, y: 120 });
  const [mark, setMark] = useState<ClickMark | null>(null);
  const [status, setStatus] = useState("Select Entire Screen to include the decorative frame.");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number>(0);
  const pausedAtRef = useRef<number | null>(null);
  const pausedTotalRef = useRef<number>(0);
  const clickIdRef = useRef(0);
  const clickTrackRef = useRef<Array<{ t: number; x: number; y: number; target: string }>>([]);

  useEffect(() => {
    const onToggle = () => {
      if (!enabled) return;
      setOpen(v => !v);
    };
    window.addEventListener(TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_EVENT, onToggle);
  }, [enabled]);

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
    if (state !== "recording") return;
    const oldCursor = document.body.style.cursor;
    document.body.style.cursor = "none";
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof HTMLElement
        ? e.target.closest("[data-ui], button, input, select, textarea, a") as HTMLElement | null
        : null;
      const next = { x: e.clientX, y: e.clientY };
      const id = ++clickIdRef.current;
      setPointer(next);
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
      document.body.style.cursor = oldCursor;
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
      setPointer({ x: Math.round(window.innerWidth / 2), y: 120 });
      setStatus("Recording. For frame capture, the picker must be Entire Screen, not OWLLM window.");

      const stream = await requestDisplayStream();
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, {
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
        stopStreams();
        setState("idle");
        setStatus("Saved video and click track.");
      };
      stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
      recorder.start(250);
      setState("recording");
    } catch (err) {
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
      stopStreams();
      setState("idle");
    }
  };

  if (!enabled || !open) return null;

  const recording = state === "recording";
  const active = state === "recording" || state === "paused" || state === "saving";

  return (
    <>
      <PointerOverlay point={pointer} mark={mark} active={active} />
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
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button
            onClick={start}
            disabled={state !== "idle"}
            style={recBtn(state === "idle", "#18c96e")}
          >
            Record Screen
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
