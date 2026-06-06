// UpdatePrompt — in-app branded modal for the auto-updater.
//
// Replaces tauri-plugin-dialog's native ask() (which renders a plain
// Windows MessageBox) with a React component that matches the rest
// of the OwLLM Desktop UI: accent border, HybridFrame-flavoured
// background, owl mark, and a real download progress bar wired to
// the updater's per-chunk events.
//
// Self-mounting: drop <UpdateController /> at the AppShell root and
// it fires its own check() 2.5s after mount, then renders the modal
// only when there's actually a newer version on the server. Errors
// (offline, 404, etc.) get swallowed — the user just doesn't see
// the modal, which is the right failure mode.

import React, { useEffect, useState } from "react";

const ICONS = "/Page_icons";

type Phase = "hidden" | "prompt" | "downloading" | "installing" | "error";

type Update = {
  version: string;
  body?: string;
  // Tauri's update object — typed loosely so we don't have to import
  // the plugin's TS types at module top level (they're loaded via
  // dynamic import to keep the boot path small).
  downloadAndInstall: (cb?: (event: any) => void) => Promise<void>;
};

/// Turn a release-notes body into a clean bullet list so the modal reads
/// like a professional changelog instead of a wall of prose. Handles both
/// shapes: notes already authored with markdown bullets/numbers (one bullet
/// per marker, kept verbatim), and unstructured prose (split into bullets on
/// sentence + semicolon boundaries). The period split is conservative — it
/// only fires on ". " that follows a word/paren and precedes a capital, so
/// version numbers (0.4.8), URLs (claude.com/x) and abbreviations don't get
/// chopped.
function toReleaseBullets(body: string): string[] {
  const out: string[] = [];
  for (let line of body.replace(/\r/g, "").split("\n")) {
    line = line.trim();
    if (!line) continue;
    // A markdown heading becomes its own (bold-ish) lead line, kept whole.
    if (/^#{1,6}\s+/.test(line)) { out.push(line.replace(/^#{1,6}\s+/, "")); continue; }
    const stripped = line.replace(/^([-*•]|\d+[.)])\s+/, "").trim();
    if (stripped !== line) { if (stripped) out.push(stripped.replace(/[.;]\s*$/, "")); continue; }
    // Unstructured prose → split into clause/sentence bullets.
    const parts = stripped
      .split(/;\s+|(?<=[a-z0-9)\]"'])\.\s+(?=[A-Z])/g)
      .map(s => s.trim())
      .filter(Boolean);
    for (const p of parts) out.push(p.replace(/[.;]\s*$/, ""));
  }
  return out;
}

export default function UpdateController() {
  const [phase, setPhase] = useState<Phase>("hidden");
  const [update, setUpdate] = useState<Update | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // One-shot check on mount. We don't poll — Tauri's updater is
  // designed for once-per-launch checks. Users who keep the app
  // running for days won't see new versions until next launch, which
  // matches every other desktop app's behaviour.
  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
    const t = window.setTimeout(async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const u = await check();
        if (u && (u as any).available !== false) {
          setUpdate(u as unknown as Update);
          setPhase("prompt");
        }
      } catch (e) {
        // Offline / 404 / corp proxy — silent fail is correct here.
        console.warn("[updater] check failed:", e);
      }
    }, 2500);
    return () => window.clearTimeout(t);
  }, []);

  const onInstall = async () => {
    if (!update) return;
    setPhase("downloading");
    setError(null);
    try {
      await update.downloadAndInstall((evt: any) => {
        // Tauri emits {event, data}: "Started" with contentLength,
        // "Progress" with chunkLength, "Finished".
        if (evt?.event === "Started" && typeof evt?.data?.contentLength === "number") {
          setTotal(evt.data.contentLength);
        } else if (evt?.event === "Progress" && typeof evt?.data?.chunkLength === "number") {
          setDownloaded((d) => d + evt.data.chunkLength);
        } else if (evt?.event === "Finished") {
          setPhase("installing");
        }
      });
      // Replace running process with the new one. Done as a separate
      // dynamic import so we don't pay the cost on every boot.
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e: any) {
      setPhase("error");
      setError(String(e?.message ?? e));
    }
  };

  if (phase === "hidden" || !update) return null;

  const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  const mbDown = (downloaded / 1024 / 1024).toFixed(1);
  const mbTotal = total > 0 ? (total / 1024 / 1024).toFixed(1) : "?";

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999999,
        background: "rgba(6, 8, 13, 0.72)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        animation: "owllm-update-fade 220ms ease both",
      }}
    >
      <style>{`
        @keyframes owllm-update-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes owllm-update-pop {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0)    scale(1); }
        }
      `}</style>

      <div
        style={{
          width: 480,
          maxWidth: "100%",
          background: "linear-gradient(180deg, rgba(28, 38, 72, 0.96), rgba(10, 14, 28, 0.98))",
          border: "1px solid rgba(var(--accent-rgb), 0.55)",
          borderRadius: 14,
          padding: "26px 28px",
          color: "var(--fg-strong)",
          boxShadow: "0 28px 64px -12px rgba(0,0,0,0.55), 0 0 0 1px rgba(var(--accent-rgb),0.18), 0 0 36px -6px rgba(var(--accent-rgb),0.35)",
          animation: "owllm-update-pop 220ms ease both",
        }}
      >
        {/* Header: owl + headline */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
          <img
            src={`${ICONS}/owl_startup.png`}
            alt=""
            style={{ width: 48, height: 48, objectFit: "contain", flexShrink: 0 }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.4, color: "var(--accent)", textTransform: "uppercase" }}>
              OwLLM Desktop · Update available
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-strong)" }}>
              Version {update.version}
            </div>
          </div>
        </div>

        {/* Release notes — rendered as a structured "What's new" list. */}
        {update.body && update.body.trim() ? (
          <div
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8,
              padding: "12px 14px",
              maxHeight: 210,
              overflow: "auto",
              marginBottom: 18,
            }}
          >
            <div style={{
              fontSize: 10.5, fontWeight: 700, letterSpacing: 1.2,
              textTransform: "uppercase", color: "rgba(255,255,255,0.45)",
              marginBottom: 9,
            }}>
              What's new
            </div>
            {(() => {
              const bullets = toReleaseBullets(update.body!);
              if (bullets.length === 0) {
                return (
                  <div style={{ fontSize: 13, lineHeight: 1.55, color: "rgba(255,255,255,0.82)", whiteSpace: "pre-wrap" }}>
                    {update.body}
                  </div>
                );
              }
              return (
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 7 }}>
                  {bullets.map((b, i) => (
                    <li key={i} style={{ display: "flex", gap: 9, fontSize: 13, lineHeight: 1.5, color: "rgba(255,255,255,0.85)" }}>
                      <span style={{ color: "var(--accent)", flexShrink: 0, fontWeight: 700, lineHeight: 1.5 }}>▸</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </div>
        ) : null}

        {/* Phase-specific body */}
        {phase === "prompt" && (
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              onClick={() => setPhase("hidden")}
              style={{
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "rgba(255,255,255,0.75)",
                borderRadius: 8,
                padding: "10px 18px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                transition: "background 120ms ease, color 120ms ease",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              Later
            </button>
            <button
              onClick={onInstall}
              style={{
                background: "linear-gradient(180deg, rgba(var(--accent-rgb),0.85), rgba(var(--accent-rgb),0.65))",
                border: "1px solid rgba(var(--accent-rgb),0.95)",
                color: "white",
                borderRadius: 8,
                padding: "10px 22px",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                boxShadow: "0 6px 18px -6px rgba(var(--accent-rgb), 0.7)",
                transition: "transform 120ms ease, box-shadow 120ms ease",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-1px)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = "translateY(0)"; }}
            >
              Install now
            </button>
          </div>
        )}

        {(phase === "downloading" || phase === "installing") && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12, color: "rgba(255,255,255,0.85)" }}>
              <span>{phase === "installing" ? "Installing…" : `Downloading ${mbDown} / ${mbTotal} MB`}</span>
              <span style={{ fontWeight: 700 }}>{phase === "installing" ? "" : `${pct}%`}</span>
            </div>
            <div style={{
              height: 10,
              background: "rgba(255,255,255,0.08)",
              borderRadius: 6,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.10)",
            }}>
              <div style={{
                width: phase === "installing" ? "100%" : `${pct}%`,
                height: "100%",
                background: "linear-gradient(90deg, rgba(var(--accent-rgb), 0.95), rgba(var(--accent-rgb), 0.55))",
                transition: "width 200ms linear",
                boxShadow: "0 0 16px -2px rgba(var(--accent-rgb), 0.8)",
              }} />
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: "rgba(255,255,255,0.55)", textAlign: "center" }}>
              {phase === "installing"
                ? "Verifying signature and swapping the binary. The app will restart in a moment."
                : "Don't close the app — it will restart automatically when ready."}
            </div>
          </div>
        )}

        {phase === "error" && (
          <div>
            <div style={{
              fontSize: 13,
              color: "#ffb0b0",
              background: "rgba(255,80,80,0.10)",
              border: "1px solid rgba(255,80,80,0.4)",
              borderRadius: 8,
              padding: 12,
              marginBottom: 14,
              wordBreak: "break-word",
            }}>
              {error ?? "Update failed."}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setPhase("hidden")}
                style={{
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "rgba(255,255,255,0.75)",
                  borderRadius: 8,
                  padding: "10px 18px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >Dismiss</button>
              <button
                onClick={onInstall}
                style={{
                  background: "linear-gradient(180deg, rgba(var(--accent-rgb),0.85), rgba(var(--accent-rgb),0.65))",
                  border: "1px solid rgba(var(--accent-rgb),0.95)",
                  color: "white",
                  borderRadius: 8,
                  padding: "10px 22px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >Try again</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
