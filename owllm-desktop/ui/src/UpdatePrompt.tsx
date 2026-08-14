// UpdatePrompt — in-app branded modal for the auto-updater.
//
// Replaces tauri-plugin-dialog's native ask() (which renders a plain
// Windows MessageBox) with a React component that matches the rest
// of the OwLLM Desktop UI: accent border, HybridFrame-flavoured
// background, owl mark, and a real download progress bar wired to
// the updater's per-chunk events.
//
// Self-mounting: drop <UpdateController /> at the AppShell root and it checks
// 2.5s after mount and every RECHECK_MS after that. A found update is NOT shown
// as a modal — it is published to runtime/updateAvailability, which the chrome
// turns into the owl's speech bubble and then a small badge; this modal opens
// only when the user asks (OPEN_UPDATE_EVENT). Routine offline failures stay
// non-blocking; release/configuration failures are surfaced so a platform cannot
// silently lose auto-update support again.

import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openWebUrl } from "./utils/openWebUrl";
import { OPEN_UPDATE_EVENT, setUpdateAvailable } from "./runtime/updateAvailability";
import { RECHECK_MS, nextCheckDelayMs, shouldSurfaceCheckError } from "./runtime/updateSchedule";

const ICONS = "/Page_icons";

// Where package-managed installs (Linux deb/rpm) are sent to fetch the new
// version by hand — the public dist repo's latest release, same target as
// the download page cards.
const RELEASES_URL = "https://github.com/OwLLM/owllm/releases/latest";

type Phase = "hidden" | "prompt" | "downloading" | "installing" | "error";

type Update = {
  version: string;
  body?: string;
  // Tauri's update object — typed loosely so we don't have to import
  // the plugin's TS types at module top level (they're loaded via
  // dynamic import to keep the boot path small).
  download: (cb?: (event: any) => void) => Promise<void>;
  install: () => Promise<void>;
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
    // Drop git-plumbing noise that older auto-generated notes leaked in: code
    // fences and shortstat summaries ("1 file changed, 1 insertion(+)…"). These
    // are developer diagnostics, never user-facing "what's new".
    if (/^(```|~~~)/.test(line)) continue;
    if (/^\d+ files? changed(,|$)/.test(line)) continue;
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

function actionableCheckError(value: unknown): string | null {
  const message = String((value as any)?.message ?? value);
  // Connectivity is transient and must not interrupt startup. A missing target,
  // invalid manifest, or signature problem means the published release is
  // broken for this platform and must be visible instead of console-only.
  if (!/(target|platform).*(not found|missing)|signature|manifest|invalid json|http status (404|410)/i.test(message)) {
    return null;
  }
  return `Automatic update is unavailable for this platform: ${message}`;
}

export default function UpdateController() {
  const [phase, setPhase] = useState<Phase>("hidden");
  const [update, setUpdate] = useState<Update | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Linux AppImage uses a separate mode: the downloaded, signature-verified
  // AppImage waits for this process to exit and then swaps files atomically.
  // That avoids SIGBUS crashes in WebKitGTK processes which still map the old
  // AppImage. deb/rpm remain manual because the package manager owns them.
  const [installMode, setInstallMode] = useState<"auto" | "linux-appimage" | "manual">("auto");

  // First check 2.5s after mount, then REPEATEDLY — the next one is scheduled
  // by the check that just finished, never by a fixed setInterval. A one-shot
  // per-launch check is why long-running installs sat on old versions, and a
  // fixed interval is why they still did: a check landing inside a multi-OS
  // publish window throws TargetNotFound for the platforms not merged yet
  // (see runtime/updateSchedule), and the app then waited a whole period
  // before asking again. It now backs off in minutes, not hours.
  //
  // Finding an update no longer opens this modal. It publishes the fact to
  // runtime/updateAvailability, and the chrome greets the user with the owl
  // bubble; the modal opens only when they ask for it (OPEN_UPDATE_EVENT).
  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
    let disposed = false;
    let timer = 0;
    let failures = 0;
    let lastRunAt = 0;
    // Only a check error may clear itself; an install error must survive.
    let checkErrorShown = false;

    const schedule = (ms: number) => {
      if (disposed) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(runCheck, ms);
    };

    const runCheck = async () => {
      if (disposed) return;
      lastRunAt = Date.now();
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const u = await check();
        if (disposed) return;
        failures = 0;
        // The release answered, so any "unavailable for this platform" we put
        // up during a publish window was transient. Take it back down.
        if (checkErrorShown) {
          checkErrorShown = false;
          setError(null);
          setPhase((p) => (p === "error" ? "hidden" : p));
        }
        if (u && (u as any).available !== false) {
          try {
            const mode = await invoke<string>("update_install_mode");
            if (!disposed && (mode === "manual" || mode === "linux-appimage")) setInstallMode(mode);
          } catch { /* older backend without the command — assume auto */ }
          if (disposed) return;
          setUpdate(u as unknown as Update);
          setUpdateAvailable(String((u as any).version ?? ""));
        }
        schedule(RECHECK_MS);
      } catch (e) {
        if (disposed) return;
        failures += 1;
        console.warn(`[updater] check failed (${failures} in a row):`, e);
        const actionable = actionableCheckError(e);
        if (actionable && shouldSurfaceCheckError(failures)) {
          checkErrorShown = true;
          setError(actionable);
          setPhase("error");
        }
        schedule(nextCheckDelayMs(failures));
      }
    };

    // A laptop that slept through its timer, or a machine that was offline
    // when the release landed, must not wait out the rest of the period.
    const onOnline = () => {
      if (disposed) return;
      if (Date.now() - lastRunAt < nextCheckDelayMs(1)) return;
      schedule(0);
    };
    window.addEventListener("online", onOnline);

    schedule(2500);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // Opened on demand — from the owl's bubble, the chrome badge, or the Info
  // page. Never auto-shown, so it can't interrupt work.
  useEffect(() => {
    const open = () => setPhase((p) => (p === "downloading" || p === "installing" ? p : "prompt"));
    window.addEventListener(OPEN_UPDATE_EVENT, open as EventListener);
    return () => window.removeEventListener(OPEN_UPDATE_EVENT, open as EventListener);
  }, []);

  // Closing the modal only hides it. The badge under the OWLLM mark stays, so
  // "Later" is never a dead end — the previous behaviour recorded a dismissal
  // and left no way back to the update at all.
  const dismiss = () => setPhase("hidden");

  // Manual-mode path (Linux deb/rpm): open the releases page in the
  // OwLLM browser and dismiss — there is nothing we can install in place.
  const onDownload = () => {
    openWebUrl(RELEASES_URL).catch((error) => console.error("Could not open the OwLLM browser", error));
    dismiss();
  };

  const onInstall = async () => {
    if (!update) return;
    setPhase("downloading");
    setError(null);
    try {
      // Release our own child processes BEFORE the installer runs. The NSIS
      // updater only terminates owllm-desktop.exe; a still-running llama-server
      // (or other sidecar) can keep a handle on files under the install dir, so
      // the passive installer stalls on a file-in-use overwrite retry that never
      // gets answered — which is how stale "*-installer.exe" processes pile up in
      // the background across updates. Best-effort: never block the update on it.
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("server_stop").catch(() => {});
      } catch { /* best effort — proceed with the install regardless */ }
      if (installMode === "linux-appimage") {
        // Same crash-safe marker handling as the Windows/macOS path: the
        // AppImage helper waits for this process to exit and then swaps
        // files. If RunEvent::Exit never fires (the event loop can be torn
        // down before the helper finishes waiting), the marker survives and
        // the next boot reports a crash that was actually an update.
        await invoke("session_health_expect_replacement").catch(() => {});
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<{ downloaded: number; total?: number }>(
          "owllm:update-progress",
          ({ payload }) => {
            setDownloaded(payload.downloaded);
            if (typeof payload.total === "number") setTotal(payload.total);
          },
        );
        try {
          await invoke("linux_appimage_update_install", { expectedVersion: update.version });
          setPhase("installing");
        } finally {
          unlisten();
        }
        return;
      }

      await update.download((evt: any) => {
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
      // Download and install are separate calls purely so this can sit between
      // them: `install()` does not return on Windows — it hands the NSIS
      // installer to the shell and leaves through `std::process::exit(0)`, and
      // the installer terminates owllm-desktop.exe besides. Either way
      // RunEvent::Exit never fires, so the session marker survives and the
      // freshly installed build opens by telling the user the previous one
      // crashed. Say the death is expected instead. Doing it here rather than
      // before the download keeps a real crash mid-download reportable.
      await invoke("session_health_expect_replacement").catch(() => {});
      await update.install();
      // Reached only where install() returns rather than replacing us. Done as
      // a separate dynamic import so we don't pay the cost on every boot.
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e: any) {
      // Still here, so nothing replaced us: put the marker back or this
      // session's death would go unrecorded.
      invoke("session_health_rearm").catch(() => {});
      setPhase("error");
      setError(String(e?.message ?? e));
    }
  };

  if (phase === "hidden" || (!update && phase !== "error")) return null;

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
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.4, color: "var(--accent-ink)", textTransform: "uppercase" }}>
              {update ? "OwLLM Desktop · Update available" : "OwLLM Desktop · Update service error"}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-strong)" }}>
              {update ? `Version ${update.version}` : "Automatic update needs attention"}
            </div>
          </div>
        </div>

        {/* Release notes — rendered as a structured "What's new" list. */}
        {update?.body && update.body.trim() ? (
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
              const bullets = toReleaseBullets(update.body);
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
                      <span style={{ color: "var(--accent-ink)", flexShrink: 0, fontWeight: 700, lineHeight: 1.5 }}>▸</span>
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
          <div>
            {installMode === "manual" && (
              <div style={{
                fontSize: 12,
                lineHeight: 1.5,
                color: "rgba(255,255,255,0.65)",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                padding: "9px 12px",
                marginBottom: 14,
              }}>
                This copy was installed from a system package (deb/rpm), which can't
                update itself. Grab the new package from the releases page and install
                it with your package manager.
              </div>
            )}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              onClick={dismiss}
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
              onClick={installMode === "manual" ? onDownload : onInstall}
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
              {installMode === "manual" ? "Download update ↗" : "Install now"}
            </button>
          </div>
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
                onClick={update ? onInstall : onDownload}
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
              >{update ? "Try again" : "Open releases ↗"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
