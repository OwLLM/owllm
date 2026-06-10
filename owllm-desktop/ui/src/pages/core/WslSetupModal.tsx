// Guided WSL setup — so the user never touches the CLI.
//
// Walks the machine through the stages reported by wsl_setup_status:
//   virtualizationOff → the ONE manual step (a BIOS toggle no app can do)
//   needsInstall      → one-click elevated `wsl --install -d Ubuntu`
//   needsPython       → streamed apt-install of python3/pip + uv inside Ubuntu
//   ready             → green, done
//
// Everything automatable is a single button; the only thing we ask the user
// to do by hand is the firmware virtualization toggle, and only when it's
// genuinely off — with exact steps instead of a cryptic failure.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";

type WslSetupStatus = {
  stage: "virtualizationOff" | "needsInstall" | "needsPython" | "ready" | "unsupported";
  virtualizationEnabled: boolean;
  distroInstalled: boolean;
  defaultDistro: string | null;
  pythonReady: boolean;
  detail: string;
};

type SetupEvent =
  | { kind: "started" }
  | { kind: "log"; line: string }
  | { kind: "finished" }
  | { kind: "failed"; error: string };

export default function WslSetupModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [status, setStatus] = useState<WslSetupStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // label of the in-flight action
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const s = await invoke<WslSetupStatus>("wsl_setup_status");
      setStatus(s);
      onChanged?.();
    } catch (e) {
      setErr(String(e));
    }
  }, [onChanged]);

  useEffect(() => {
    if (open) {
      setLog([]);
      refresh();
    }
  }, [open, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  if (!open) return null;

  const install = async () => {
    setBusy("install");
    setErr(null);
    try {
      await invoke("wsl_setup_install");
      // The elevated installer runs in its own window; give the user the
      // follow-up instructions and let them re-check / reboot.
      setLog((l) => [
        ...l,
        "Launched the Windows installer. Approve the UAC prompt and let it finish —",
        "it may ask you to reboot. After it's done (and you've rebooted if asked),",
        "click “Re-check” below.",
      ]);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const provision = async () => {
    setBusy("python");
    setErr(null);
    setLog([]);
    try {
      const ch = new Channel<SetupEvent>();
      ch.onmessage = (ev) => {
        if (ev.kind === "log") setLog((l) => [...l, ev.line]);
        else if (ev.kind === "failed") setErr(ev.error);
      };
      await invoke("wsl_setup_provision_python", { channel: ch });
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const reboot = async () => {
    try { await invoke("wsl_reboot"); } catch (e) { setErr(String(e)); }
  };

  const btn = (label: string, onClick: () => void, opts?: { primary?: boolean; disabled?: boolean }) => (
    <button
      onClick={onClick}
      disabled={opts?.disabled || !!busy}
      style={{
        padding: "10px 18px",
        borderRadius: 10,
        border: opts?.primary ? "none" : "1px solid var(--border-strong)",
        background: opts?.primary
          ? "linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent))"
          : "var(--bg-elevated)",
        color: opts?.primary ? "var(--accent-fg)" : "var(--fg-strong)",
        fontSize: 14,
        fontWeight: 700,
        cursor: busy ? "wait" : "pointer",
        opacity: opts?.disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );

  const Stage = () => {
    if (!status) return <div style={{ color: "var(--fg-muted)" }}>Checking…</div>;
    switch (status.stage) {
      case "ready":
        return (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#22c55e" }}>
              ✅ WSL is ready{status.defaultDistro ? ` (${status.defaultDistro})` : ""}
            </div>
            <p style={{ color: "var(--fg-muted)", fontSize: 14 }}>
              The Coder and fine-tuning now run inside Linux. Nothing else to do.
            </p>
          </div>
        );
      case "virtualizationOff":
        return (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#FF9800" }}>
              ⚠️ One manual step: enable virtualization in your BIOS
            </div>
            <p style={{ color: "var(--fg)", fontSize: 14, lineHeight: 1.6 }}>
              This is a firmware switch — <b>no app can change it</b>, not even Windows' own
              installer. It's a one-time toggle:
            </p>
            <ol style={{ color: "var(--fg)", fontSize: 14, lineHeight: 1.7, paddingLeft: 20 }}>
              <li>Restart and press <b>Del</b> or <b>F2</b> at boot to enter the BIOS/UEFI.</li>
              <li>Find <b>Intel Virtualization Technology (VT-x)</b> — on AMD it's <b>SVM Mode</b> —
                usually under <b>Advanced → CPU Configuration</b>. Set it to <b>Enabled</b>.</li>
              <li>Save &amp; exit. Back in Windows, click <b>Re-check</b> below.</li>
            </ol>
            <p style={{ color: "var(--fg-muted)", fontSize: 13 }}>
              On most PCs this is already on — yours just happens to have it off.
            </p>
          </div>
        );
      case "needsInstall":
        return (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg-strong)" }}>
              Install WSL + Ubuntu
            </div>
            <p style={{ color: "var(--fg)", fontSize: 14, lineHeight: 1.6 }}>
              One click installs everything automatically. Windows will show a <b>UAC prompt</b> —
              approve it. The installer may ask you to <b>reboot</b>; do that, then come back and
              click <b>Re-check</b>.
            </p>
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              {btn(busy === "install" ? "Launching…" : "🚀 Install WSL + Ubuntu", install, { primary: true })}
              {btn("⟳ Reboot now", reboot)}
            </div>
          </div>
        );
      case "needsPython":
        return (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg-strong)" }}>
              Almost there — install Python in Ubuntu
            </div>
            <p style={{ color: "var(--fg)", fontSize: 14, lineHeight: 1.6 }}>
              Ubuntu is installed{status.defaultDistro ? ` (${status.defaultDistro})` : ""}. This
              adds Python 3, pip and <code>uv</code> inside it so the Coder and fine-tuning work.
            </p>
            <div style={{ marginTop: 8 }}>
              {btn(busy === "python" ? "Installing…" : "🐍 Install Python in Ubuntu", provision, { primary: true })}
            </div>
          </div>
        );
      default:
        return (
          <div style={{ color: "var(--fg-muted)" }}>
            Guided WSL setup is only available on Windows.
          </div>
        );
    }
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9500,
        background: "rgba(0,0,0,0.62)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div style={{
        width: "min(640px, 92%)", maxHeight: "86%",
        background: "var(--bg-panel)",
        border: "2px solid rgba(var(--accent-rgb), 0.78)",
        borderRadius: 14,
        boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{
          height: 54, background: "var(--bg-header)", color: "var(--bg-header-fg)",
          display: "flex", alignItems: "center", padding: "0 20px",
          borderBottom: "1px solid rgba(var(--accent-rgb), 0.30)",
        }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 0.5 }}>🐧 Set up WSL</div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              width: 34, height: 26, border: "none",
              background: "rgba(244,67,54,0.18)", color: "#ff8080",
              fontSize: 13, cursor: "pointer", borderRadius: 5,
            }}
          >✕</button>
        </div>

        <div style={{ padding: "18px 22px", overflow: "auto" }}>
          <Stage />

          {err && (
            <div style={{
              marginTop: 12, padding: "10px 12px", borderRadius: 8,
              background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.4)",
              color: "#ffb4b4", fontSize: 13, whiteSpace: "pre-wrap",
            }}>{err}</div>
          )}

          {log.length > 0 && (
            <div
              ref={logRef}
              style={{
                marginTop: 12, padding: "10px 12px", borderRadius: 8,
                background: "rgba(0,0,0,0.35)", border: "1px solid var(--border)",
                color: "var(--fg)", fontSize: 12.5, fontFamily: "Consolas, monospace",
                maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap",
              }}
            >
              {log.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
        </div>

        <div style={{
          padding: "12px 22px", borderTop: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          {status && (
            <span style={{ color: "var(--fg-muted)", fontSize: 12.5 }}>{status.detail}</span>
          )}
          <div style={{ flex: 1 }} />
          {btn(busy ? "Working…" : "⟳ Re-check", refresh)}
          {btn("Close", onClose)}
        </div>
      </div>
    </div>
  );
}
