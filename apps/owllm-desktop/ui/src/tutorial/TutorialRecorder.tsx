import React, { useEffect, useMemo, useRef, useState } from "react";

type Point = { x: number; y: number };
type ClickMark = Point & { id: number };

type RecorderState = "idle" | "recording" | "paused" | "saving";
type CaptureMode = "window" | "screen";

const TOGGLE_EVENT = "owllm:tutorial-recorder-toggle";
const ICONS = "/Page_icons";
const CORNERS = `${ICONS}/CornersNew`;
const HAND_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='42' height='46' viewBox='0 0 42 46'%3E%3Cpath d='M17.6 4.8c2.1 0 3.8 1.7 3.8 3.8v11.2l1.6-2.1c1.2-1.6 3.4-2 5.1-.8 1.1.8 1.6 2 1.6 3.2.7-.4 1.5-.5 2.4-.4 2 .4 3.3 2.3 2.9 4.3l-.3 1.5c.7-.2 1.5-.1 2.2.2 1.9.8 2.7 3 1.9 4.9l-2.1 5c-1.9 4.6-6.4 7.5-11.4 7.5h-4.8c-4 0-7.8-1.9-10.1-5.2L3.6 28c-1.1-1.6-.8-3.8.8-5 1.3-1 3.2-.9 4.4.2l5 4.6V8.6c0-2.1 1.7-3.8 3.8-3.8Z' fill='%23ffe0a8' stroke='%23271407' stroke-width='2.2' stroke-linejoin='round'/%3E%3Cpath d='M21.4 19.8v8.8M29.5 20.1l-3.3 8.8M34.7 25.5l-2.2 6.8M13.8 27.8v5.6' stroke='%239f6430' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E\") 10 8, pointer";

const MIN_PARENT_W = 800;
const MIN_PARENT_H = 500;
const BADGE_W = 300;
const BADGE_H = 195;
const BORDER_T = 18;
const CORNER_OUTSET = 10;
const SHIFT_OUT = BORDER_T / 2;
const EXTRA_TOP = 35;
const EXTRA_RIGHT = 0;
const EXTRA_BOTTOM = 0;
const CORNER_PNG_W = 160;
const CORNER_PNG_H_TL = Math.round(CORNER_PNG_W * 513 / 486);
const CORNER_PNG_H_TR = Math.round(CORNER_PNG_W * 484 / 516);
const CORNER_PNG_H_BL = Math.round(CORNER_PNG_W * 512 / 488);
const CORNER_PNG_H_BR = Math.round(CORNER_PNG_W * 488 / 512);
const PARENT_X = SHIFT_OUT + CORNER_OUTSET;
const PARENT_Y = EXTRA_TOP + SHIFT_OUT + CORNER_OUTSET;

export function toggleTutorialRecorder() {
  window.dispatchEvent(new CustomEvent(TOGGLE_EVENT));
}

function useViewportSize() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
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

function CaptureFrameOverlay({
  active,
  outerW,
  outerH,
}: {
  active: boolean;
  outerW: number;
  outerH: number;
}) {
  if (!active) return null;
  const parent_w = Math.max(MIN_PARENT_W, outerW - EXTRA_RIGHT - 2 * SHIFT_OUT - 2 * CORNER_OUTSET);
  const parent_h = Math.max(MIN_PARENT_H, outerH - EXTRA_TOP - EXTRA_BOTTOM - 2 * SHIFT_OUT - 2 * CORNER_OUTSET);
  const parent_x = PARENT_X;
  const parent_y = PARENT_Y;
  const t = BORDER_T;
  const so = SHIFT_OUT;
  const outerL = parent_x - so;
  const outerT = parent_y - so;
  const outerW2 = parent_w + 2 * so;
  const outerH2 = parent_h + 2 * so;
  const outerR = outerL + outerW2;
  const outerB = outerT + outerH2;
  const innerL = parent_x - so + t;
  const innerT = parent_y - so + t;
  const innerW = parent_w + 2 * so - 2 * t;
  const innerH = parent_h + 2 * so - 2 * t;
  const topBar = { x: parent_x - so, y: parent_y - so, w: parent_w + 2 * so, h: t };
  const botBar = { x: parent_x - so, y: parent_y + parent_h - t / 2, w: parent_w + 2 * so, h: t };
  const leftBar = { x: parent_x - so, y: parent_y - so, w: t, h: parent_h + 2 * so };
  const rightBar = { x: parent_x + parent_w - so, y: parent_y - so, w: t, h: parent_h + 2 * so };
  const brkL = 36;
  const brkI = 14;
  const bxL = outerL + brkI;
  const bxR = outerR - brkI;
  const byT = outerT + brkI;
  const byB = outerB - brkI;
  const tckL = 18;
  const tckI = 10;
  const midx = (outerL + outerR) / 2;
  const midy = (outerT + outerB) / 2;
  const cnTL = { x: outerL - CORNER_OUTSET, y: outerT - CORNER_OUTSET };
  const cnTR = { x: outerR - CORNER_PNG_W + 1 + CORNER_OUTSET, y: outerT - CORNER_OUTSET };
  const cnBL = { x: outerL - CORNER_OUTSET, y: outerB - CORNER_PNG_H_BL + 1 + CORNER_OUTSET };
  const cnBR = { x: outerR - CORNER_PNG_W + 1 + CORNER_OUTSET, y: outerB - CORNER_PNG_H_BR + 1 + CORNER_OUTSET };
  const badgeX = parent_x + (parent_w - BADGE_W) / 2;
  const badgeY = parent_y - BADGE_H / 2;
  const frameColor = "rgba(var(--accent-rgb), 0.86)";
  const frameAccent = "rgba(var(--accent-rgb), 0.78)";
  const frameBg = "var(--bg-header)";
  return (
    <div
      data-ui="TutorialCaptureFrame"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 11900,
        pointerEvents: "none",
      }}
    >
      <div style={{ position: "absolute", left: topBar.x, top: topBar.y, width: topBar.w, height: topBar.h, background: frameBg }} />
      <div style={{ position: "absolute", left: botBar.x, top: botBar.y, width: botBar.w, height: botBar.h, background: frameBg }} />
      <div style={{ position: "absolute", left: leftBar.x, top: leftBar.y, width: leftBar.w, height: leftBar.h, background: frameBg }} />
      <div style={{ position: "absolute", left: rightBar.x, top: rightBar.y, width: rightBar.w, height: rightBar.h, background: frameBg }} />
      <svg width={outerW} height={outerH} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}>
        <rect x={outerL + 1} y={outerT + 1} width={outerW2 - 2} height={outerH2 - 2} rx={14} ry={14} fill="none" stroke={frameColor} strokeWidth={1} />
        <rect x={innerL} y={innerT} width={innerW} height={innerH} rx={10} ry={10} fill="none" stroke={frameAccent} strokeWidth={1} />
        <g stroke={frameAccent} strokeWidth={1}>
          <line x1={bxL} y1={byT} x2={bxL + brkL} y2={byT} />
          <line x1={bxL} y1={byT} x2={bxL} y2={byT + brkL} />
          <line x1={bxR} y1={byT} x2={bxR - brkL} y2={byT} />
          <line x1={bxR} y1={byT} x2={bxR} y2={byT + brkL} />
          <line x1={bxL} y1={byB} x2={bxL + brkL} y2={byB} />
          <line x1={bxL} y1={byB} x2={bxL} y2={byB - brkL} />
          <line x1={bxR} y1={byB} x2={bxR - brkL} y2={byB} />
          <line x1={bxR} y1={byB} x2={bxR} y2={byB - brkL} />
        </g>
        <g stroke={frameAccent} strokeWidth={1}>
          <line x1={midx - tckL / 2} y1={outerT + tckI} x2={midx + tckL / 2} y2={outerT + tckI} />
          <line x1={midx - tckL / 2} y1={outerB - tckI} x2={midx + tckL / 2} y2={outerB - tckI} />
          <line x1={outerL + tckI} y1={midy - tckL / 2} x2={outerL + tckI} y2={midy + tckL / 2} />
          <line x1={outerR - tckI} y1={midy - tckL / 2} x2={outerR - tckI} y2={midy + tckL / 2} />
        </g>
      </svg>
      <img src={`${CORNERS}/corner_br.png`} style={{ position: "absolute", left: cnBR.x, top: cnBR.y, width: CORNER_PNG_W, height: CORNER_PNG_H_BR, pointerEvents: "none" }} />
      <img src={`${CORNERS}/corner_ul.png`} style={{ position: "absolute", left: cnTL.x, top: cnTL.y, width: CORNER_PNG_W, height: CORNER_PNG_H_TL, pointerEvents: "none" }} />
      <img src={`${CORNERS}/corner_ur.png`} style={{ position: "absolute", left: cnTR.x, top: cnTR.y, width: CORNER_PNG_W, height: CORNER_PNG_H_TR, pointerEvents: "none" }} />
      <img src={`${CORNERS}/corner_bl.png`} style={{ position: "absolute", left: cnBL.x, top: cnBL.y, width: CORNER_PNG_W, height: CORNER_PNG_H_BL, pointerEvents: "none" }} />
      <img src={`${ICONS}/owl_studio_square.png`} style={{ position: "absolute", left: badgeX, top: badgeY, width: BADGE_W, height: BADGE_H, pointerEvents: "none" }} />
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
  const [status, setStatus] = useState("Window mode records OWLLM and draws a clean frame into the video.");
  const viewport = useViewportSize();

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
        ? "Recording full screen. The real overlay frame is included."
        : `Recording window. The clean frame is matched to ${window.innerWidth} x ${window.innerHeight}.`);

      const stream = await requestDisplayStream(captureMode);
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
      <CaptureFrameOverlay active={active && captureMode === "window"} outerW={viewport.w} outerH={viewport.h} />
      <ClickPulseOverlay mark={mark} active={active} />
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
