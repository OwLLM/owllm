// The Watcher — OWLLM's in-app support assistant (P0-8).
//
// Summoned from the unlabeled owl in the HybridFrame top-center. This is
// the Slice-1/2 surface: an animated drawer with app-aware actions —
// "What page am I on?", "Check my setup" (the support_snapshot command,
// composed from the app's real probes) and a "Report a bug" entry point
// (the full reporter ships in a later slice). Everything here is local;
// nothing leaves the device.

import React from "react";
import { invoke } from "@tauri-apps/api/core";

type ReadinessRow = { ok: boolean; warn: boolean; detail: string };
type SupportSnapshot = {
  appVersion: string;
  os: string;
  arch: string;
  cpu: string;
  gpus: string[];
  ramTotalGb: number;
  readiness: { wsl: ReadinessRow; gpu: ReadinessRow; env: ReadinessRow; runtime: ReadinessRow };
  server: { running: boolean; model_id: string | null; port: number | null; message: string };
  wslStage: string;
  wslDetail: string;
  modules: string[];
};

type Entry = { from: "watcher" | "you"; text: string };

/// Human blurbs for the page the user is looking at — keyed by activeKey.
const PAGE_BLURBS: Record<string, string> = {
  home: "the Home page — system status, readiness checks, and quick setup actions live here.",
  agents: "the Agentic Team page — orchestrator + specialist agents that fan out on your goal. Pick a project location, type a goal, hit Run.",
  code: "the Code page — a single coding agent working in a project folder (isolated in WSL when the badge is green).",
  chat: "the fine-tuning Chat playground — talk to local or cloud models, with tools, in up to three columns.",
  train: "the Train page — fine-tune models on your data (needs the environment installed: Environment button).",
  models: "the Models page — your downloaded and fine-tuned models.",
  server: "the Server page — start/stop the local llama.cpp model server.",
  bridges: "the Bridges page — connect Telegram / WhatsApp / Discord / Slack / email to your agents.",
};

function rowIcon(r: ReadinessRow): string {
  return r.ok ? "✅" : r.warn ? "⚠️" : "❌";
}

export default function WatcherDrawer({
  open,
  onClose,
  mode,
  activeKey,
}: {
  open: boolean;
  onClose: () => void;
  mode: string;
  activeKey: string;
}) {
  const [entries, setEntries] = React.useState<Entry[]>([
    {
      from: "watcher",
      text: "I'm The Watcher — I can see how this app is doing and help you when something misbehaves. Everything I look at stays on this device.",
    },
  ]);
  const [busy, setBusy] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const say = (text: string, from: Entry["from"] = "watcher") =>
    setEntries((es) => [...es, { from, text }]);

  const whatPage = () => {
    say("What page am I on?", "you");
    const blurb = PAGE_BLURBS[activeKey] ?? `the "${activeKey}" page (mode: ${mode}).`;
    say(`You're on ${blurb}`);
  };

  const checkSetup = async () => {
    say("Check my setup", "you");
    setBusy(true);
    try {
      const s = await invoke<SupportSnapshot>("support_snapshot");
      const lines = [
        `OWLLM ${s.appVersion} · ${s.os}/${s.arch}`,
        `CPU: ${s.cpu || "?"} · RAM ${Math.round(s.ramTotalGb)} GB`,
        `GPU: ${s.gpus.length ? s.gpus.join(", ") : "none detected"}`,
        ``,
        `${rowIcon(s.readiness.wsl)} WSL / Linux sandbox — ${s.readiness.wsl.detail}`,
        `${rowIcon(s.readiness.gpu)} GPU & CUDA — ${s.readiness.gpu.detail}`,
        `${rowIcon(s.readiness.env)} Fine-tuning env — ${s.readiness.env.detail}`,
        `${rowIcon(s.readiness.runtime)} Local LLM runtime — ${s.readiness.runtime.detail}`,
        ``,
        s.server.running
          ? `🟢 Model server: running (${s.server.model_id ?? "?"} on :${s.server.port ?? "?"})`
          : `⚪ Model server: not running${s.server.message ? ` — ${s.server.message}` : ""}`,
        `📦 Modules: ${s.modules.length ? s.modules.join(", ") : "none installed"}`,
      ];
      say(lines.join("\n"));
      const bad = [s.readiness.wsl, s.readiness.env, s.readiness.runtime].filter((r) => !r.ok && !r.warn);
      if (bad.length > 0) {
        say("Something above is ❌ — the Home page has a Set-up button for each red row.");
      }
    } catch (e) {
      say(`I couldn't read the app state: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const reportBug = () => {
    say("Report a bug", "you");
    say(
      "The full bug reporter (screenshot + diagnostics + preview before sending) ships in an upcoming update. " +
      "For now: run “Check my setup” above and screenshot it together with what went wrong — that's exactly what I'll package for you soon.",
    );
  };

  const actionBtn: React.CSSProperties = {
    padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)", color: "var(--fg-strong)", fontSize: 12.5,
    fontWeight: 700, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 9600, background: "rgba(0,0,0,0.45)" }}
    >
      <style>{`
        @keyframes owllm-watcher-in { from { transform: translateY(14px); opacity: 0; } to { transform: none; opacity: 1; } }
      `}</style>
      <div style={{
        position: "absolute", top: 64, left: "50%", transform: "translateX(-50%)",
        width: "min(560px, 92%)", maxHeight: "min(620px, 82%)",
        background: "var(--bg-panel)", border: "2px solid rgba(var(--accent-rgb),0.78)",
        borderRadius: 14, boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        animation: "owllm-watcher-in 220ms ease-out",
      }}>
        <div style={{
          height: 50, background: "var(--bg-header)", color: "var(--bg-header-fg)",
          display: "flex", alignItems: "center", gap: 10, padding: "0 16px",
          borderBottom: "1px solid rgba(var(--accent-rgb),0.30)",
        }}>
          <span style={{ fontSize: 20 }}>🦉</span>
          <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: 0.4 }}>The Watcher</div>
          <div style={{ fontSize: 11, color: "var(--fg-muted)", marginLeft: 4 }}>local support assistant</div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{ width: 32, height: 24, border: "none", background: "rgba(244,67,54,0.18)", color: "#ff8080", fontSize: 13, cursor: "pointer", borderRadius: 5 }}
          >✕</button>
        </div>

        <div ref={listRef} style={{ flex: 1, overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {entries.map((e, i) => (
            <div key={i} style={{
              alignSelf: e.from === "you" ? "flex-end" : "flex-start",
              maxWidth: "88%", padding: "8px 12px", borderRadius: 10,
              whiteSpace: "pre-wrap", fontSize: 12.5, lineHeight: 1.55,
              background: e.from === "you" ? "rgba(var(--accent-rgb),0.16)" : "var(--bg-card)",
              border: `1px solid ${e.from === "you" ? "rgba(var(--accent-rgb),0.4)" : "var(--border)"}`,
              color: "var(--fg)",
            }}>{e.text}</div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
          <button style={actionBtn} disabled={busy} onClick={whatPage}>📍 What page am I on?</button>
          <button style={actionBtn} disabled={busy} onClick={checkSetup}>{busy ? "⏳ Checking…" : "🩺 Check my setup"}</button>
          <button style={actionBtn} disabled={busy} onClick={reportBug}>🐞 Report a bug</button>
        </div>
      </div>
    </div>
  );
}
