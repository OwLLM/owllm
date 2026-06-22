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
import { LogBox } from "../../components/LogBox";
import { invoke, Channel } from "@tauri-apps/api/core";

type WslSetupStatus = {
  stage: "virtualizationOff" | "needsInstall" | "needsDistro" | "needsReboot" | "needsUser" | "needsPython" | "ready" | "unsupported";
  virtualizationEnabled: boolean;
  distroInstalled: boolean;
  defaultDistro: string | null;
  userReady: boolean;
  defaultUser: string | null;
  pythonReady: boolean;
  awaitingReboot: boolean;
  detail: string;
};

type WslAccount = { username: string | null; hasPassword: boolean };

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
  // Sticky auto-scroll: land at the bottom when the modal (re)opens (openKey =
  // open) and follow new log lines only while the user is near the bottom
  // (log scrolling handled by the shared LogBox)
  // WSL Linux account form (created non-interactively so the user never sees
  // the Ubuntu first-run console). Pre-filled with a sensible default; saved
  // encrypted (DPAPI) on the Windows side.
  const [username, setUsername] = useState("owllm");
  const [password, setPassword] = useState("owllm");
  const [showPw, setShowPw] = useState(false);

  // Keep the latest onChanged in a ref so `refresh` can stay STABLE. If
  // `refresh` depended on onChanged's identity and the parent passed an inline
  // function (HomePage's `refreshReady` is recreated every render), refresh
  // would change every render → the open-effect below re-fires → onChanged() →
  // parent re-renders → new onChanged → … an infinite loop that flashes the
  // readiness "Checking" tag and makes this modal's buttons unresponsive.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const s = await invoke<WslSetupStatus>("wsl_setup_status");
      setStatus(s);
      onChangedRef.current?.();
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setLog([]);
      refresh();
      // Pre-fill the account form from any saved account.
      invoke<WslAccount>("wsl_setup_get_account")
        .then((a) => { if (a.username) setUsername(a.username); })
        .catch(() => { /* no saved account yet */ });
    }
  }, [open, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const ensureUser = async () => {
    if (!username.trim()) { setErr("Choose a username."); return; }
    if (!password.trim()) { setErr("Choose a password."); return; }
    setBusy("user");
    setErr(null);
    setLog((l) => [...l, `Creating Linux user “${username}”…`]);
    try {
      await invoke<WslAccount>("wsl_setup_ensure_user", { username, password });
      setLog((l) => [...l, "✓ User created and set as the default. Saved (encrypted)."]);
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

  const fieldStyle: React.CSSProperties = {
    padding: "8px 10px",
    background: "var(--bg-input)",
    border: "1px solid var(--border-strong)",
    borderRadius: 8,
    color: "var(--fg)",
    fontSize: 13,
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
              approve it. When it finishes, <b>reboot once</b> so Windows can turn on the Virtual
              Machine Platform, then come back here. We create the Linux user for you afterwards —
              you won't see a confusing Ubuntu console.
            </p>
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              {btn(busy === "install" ? "Launching…" : "🚀 Install WSL + Ubuntu", install, { primary: true })}
            </div>
          </div>
        );
      case "needsDistro":
        return (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg-strong)" }}>
              Add Ubuntu — WSL is here, but only Docker's distro
            </div>
            <p style={{ color: "var(--fg)", fontSize: 14, lineHeight: 1.6 }}>
              WSL <b>is</b> installed and working on this PC — but the only Linux in it is
              <b> Docker Desktop's</b> distro, a stripped-down userland with no <code>bash</code>,
              <code> apt</code>, or <code>uv</code>. Fine-tuning and the agent sandbox can't run there.
              One click installs <b>Ubuntu</b> alongside it — the Virtual Machine Platform is already
              on, so <b>no reboot is needed</b>. We create the Linux user for you afterwards.
            </p>
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              {btn(busy === "install" ? "Installing Ubuntu…" : "🐧 Add Ubuntu", install, { primary: true })}
            </div>
          </div>
        );
      case "needsReboot":
        return (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#FF9800" }}>
              🔄 Reboot to finish installing WSL
            </div>
            <p style={{ color: "var(--fg)", fontSize: 14, lineHeight: 1.6 }}>
              WSL was installed, but Windows needs <b>one restart</b> to switch on the Virtual
              Machine Platform. Until you reboot, Linux features stay unavailable and may feel slow.
              Save your work, then reboot — when you're back, open this dialog and the rest happens
              automatically.
            </p>
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              {btn("🔄 Reboot now", reboot, { primary: true })}
              {btn(busy ? "Working…" : "⟳ Re-check", refresh)}
            </div>
          </div>
        );
      case "needsUser":
        return (
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--fg-strong)" }}>
              Create your Linux user
            </div>
            <p style={{ color: "var(--fg)", fontSize: 14, lineHeight: 1.6 }}>
              Ubuntu is installed but has no user account yet. Pick a name and password — we
              create the account for you (no console window) and remember it <b>encrypted</b> on
              this PC. The defaults below are fine; change them if you like.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 10, alignItems: "center", margin: "12px 0", maxWidth: 420 }}>
              <label style={{ color: "var(--fg-muted)", fontSize: 13 }}>Username</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                spellCheck={false} autoCapitalize="off" autoCorrect="off"
                style={fieldStyle}
              />
              <label style={{ color: "var(--fg-muted)", fontSize: 13 }}>Password</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  spellCheck={false}
                  style={{ ...fieldStyle, flex: 1 }}
                />
                {btn(showPw ? "Hide" : "Show", () => setShowPw((v) => !v))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              {btn(busy === "user" ? "Creating…" : "👤 Create user", ensureUser, { primary: true, disabled: !username.trim() || !password.trim() })}
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
            <LogBox lines={log} title="WSL setup log" height={220} style={{ marginTop: 12 }} />
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
