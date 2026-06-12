// Account / Sync onboarding popup.
//
// First-run (and reopenable via the `owllm:open-sync` event) modal that
// invites the user to sign in with GitHub so their OWLLM follows them to
// every device. The "why" is the headline; connecting is one paste.
//
// Architecture recap (the user-facing promise this copy makes):
//   • Identity + storage = the user's OWN GitHub. We host nothing.
//   • Their chats, settings, model library and agent teams sync into a
//     PRIVATE `owllm-vault` repo they own.
//   • No separate password to lose: forget it → reset on GitHub, nothing
//     lost. Provider API keys never leave the device.
//
// Connecting reuses the existing github_connect flow (token paste →
// validated + stored + git creds wired). The actual vault repo + sync
// engine build on top of this; this modal is the front door.
import React from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  githubStatus,
  githubConnect,
  githubDisconnect,
  vaultEnsure,
  vaultStatus,
  GITHUB_TOKEN_URL,
  type GithubStatus,
  type VaultStatus,
} from "../agentic/github";

const SEEN_KEY = "owllm:sync-onboard-seen";

function openExternal(url: string) {
  invoke("shell_open_url", { url }).catch(() => {
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
  });
}

/// Imperatively open the modal from anywhere (e.g. a header button).
export function openSyncOnboarding() {
  window.dispatchEvent(new CustomEvent("owllm:open-sync"));
}

export default function AccountSyncModal() {
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<GithubStatus | null>(null);
  const [token, setToken] = React.useState("");
  const [showToken, setShowToken] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [vault, setVault] = React.useState<VaultStatus | null>(null);
  const [vaultMsg, setVaultMsg] = React.useState<string>("");

  // First-run auto-open + manual reopen.
  React.useEffect(() => {
    let firstRun = false;
    try { firstRun = !localStorage.getItem(SEEN_KEY); } catch { /* private mode */ }
    if (firstRun) setOpen(true);
    const onOpen = () => setOpen(true);
    window.addEventListener("owllm:open-sync", onOpen);
    return () => window.removeEventListener("owllm:open-sync", onOpen);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    githubStatus().then((s) => {
      setStatus(s);
      // Already connected on a prior session → make sure the vault exists
      // (idempotent), and reflect its real state.
      if (s.connected) ensureVault();
    }).catch(() => setStatus(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Create-if-missing + clone the private owllm-vault, updating the UI.
  const ensureVault = async () => {
    setVaultMsg("Setting up your private vault…");
    try {
      const v = await vaultEnsure();
      setVault(v);
      setVaultMsg(v.cloned ? "" : "Vault created — finishing local setup…");
    } catch (e) {
      // Non-fatal: sign-in still worked; surface the reason.
      setVault(await vaultStatus());
      setVaultMsg(`Couldn't finish vault setup: ${String(e)}`);
    }
  };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
    setOpen(false);
  };

  const connect = async () => {
    if (!token.trim()) { setErr("Paste your GitHub token first."); return; }
    setBusy(true); setErr(null);
    try {
      const res = await githubConnect(token.trim());
      setStatus({ connected: true, login: res.login });
      setToken("");
      // Create + clone the private vault right away so the promise is real.
      await ensureVault();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true); setErr(null);
    try {
      await githubDisconnect();
      setStatus({ connected: false, login: null });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  const connected = !!status?.connected;
  const login = status?.login ?? "";

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 9800,
        background: "rgba(0,0,0,0.66)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div style={{
        width: "min(560px, 94%)", maxHeight: "90%",
        background: "var(--bg-panel)",
        border: "2px solid rgba(var(--accent-rgb),0.78)",
        borderRadius: 16, boxShadow: "0 28px 70px rgba(0,0,0,0.6)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          background: "var(--bg-header)", color: "var(--bg-header-fg)",
          padding: "16px 22px", display: "flex", alignItems: "center",
          borderBottom: "1px solid rgba(var(--accent-rgb),0.30)",
        }}>
          <div>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: 0.4 }}>
              🦉 Take OWLLM everywhere
            </div>
            <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 2 }}>
              Your chats &amp; setup, on every device — stored in your own GitHub.
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={close} title="Close (Esc)"
            style={{
              width: 32, height: 26, border: "none", borderRadius: 6,
              background: "rgba(244,67,54,0.18)", color: "#ff8080",
              fontSize: 13, cursor: "pointer",
            }}
          >✕</button>
        </div>

        <div style={{ padding: "18px 22px", overflow: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Why */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              ["💬", <>Your <b>chats, settings, model library and agent teams</b> follow you to every computer you sign in on.</>],
              ["🔒", <>Everything lives in <b>your own private GitHub repo</b> (<code>owllm-vault</code>). You own it — we host nothing and can’t see it.</>],
              ["🔑", <>Nothing to lose: forget your password? Just <b>reset it on GitHub</b>. Your provider API keys stay on each device and never sync.</>],
            ].map(([icon, text], i) => (
              <div key={i} style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
                <span style={{ fontSize: 18, lineHeight: 1.3 }}>{icon as string}</span>
                <span style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--fg)" }}>{text}</span>
              </div>
            ))}
          </div>

          {/* Action */}
          {connected ? (
            <div style={{
              background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.4)",
              borderRadius: 10, padding: "12px 14px",
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#22c55e" }}>
                ✓ Signed in as @{login}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--fg-muted)", marginTop: 4, lineHeight: 1.5 }}>
                {vault?.cloned ? (
                  <>Your private vault <code>{login}/owllm-vault</code> is ready on this device.
                  Your chats, settings and agent teams sync here.</>
                ) : vaultMsg ? (
                  <>{vaultMsg}</>
                ) : (
                  <>GitHub is connected. Your chats, settings and agent teams will sync to a
                  private <code>owllm-vault</code> repo on <code>github.com/{login}</code>.</>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button onClick={close} style={primaryBtn}>Done</button>
                {vault?.repoUrl && (
                  <button onClick={() => openExternal(vault.repoUrl!)} style={ghostBtn}>
                    View on GitHub
                  </button>
                )}
                <button onClick={disconnect} disabled={busy} style={ghostBtn}>
                  {busy ? "…" : "Disconnect"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{
              background: "var(--bg-card)", border: "1px solid var(--border)",
              borderRadius: 10, padding: "14px",
            }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--fg-strong)", marginBottom: 8 }}>
                Sign in with GitHub — two clicks:
              </div>
              <button onClick={() => openExternal(GITHUB_TOKEN_URL)} style={{ ...stepBtn, marginBottom: 8 }}>
                ① Create a token on GitHub →
              </button>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="② Paste the token here (ghp_…)"
                  spellCheck={false} autoCapitalize="off" autoCorrect="off"
                  style={{
                    flex: 1, padding: "9px 11px", borderRadius: 8,
                    background: "var(--bg-input)", border: "1px solid var(--border-strong)",
                    color: "var(--fg)", fontSize: 13,
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") connect(); }}
                />
                <button onClick={() => setShowToken((v) => !v)} style={ghostBtn}>
                  {showToken ? "Hide" : "Show"}
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button onClick={connect} disabled={busy} style={primaryBtn}>
                  {busy ? "Connecting…" : "🔗 Connect GitHub"}
                </button>
                <button onClick={close} style={ghostBtn}>Maybe later</button>
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 10, lineHeight: 1.5 }}>
                Use a classic token with the <b>repo</b> scope (or a fine-grained token with
                Contents read/write). The token is stored only on this device — it never
                leaves it except to talk to GitHub.
              </div>
            </div>
          )}

          {err && (
            <div style={{
              padding: "10px 12px", borderRadius: 8,
              background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.4)",
              color: "#ffb4b4", fontSize: 12.5, whiteSpace: "pre-wrap",
            }}>{err}</div>
          )}

          {!connected && (
            <div style={{ textAlign: "center" }}>
              <button
                onClick={close}
                style={{ background: "none", border: "none", color: "var(--fg-muted)", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}
              >
                Keep everything on this device only
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: "9px 16px", borderRadius: 9, border: "none",
  background: "linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent))",
  color: "var(--accent-fg)", fontSize: 13.5, fontWeight: 800, cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: "9px 14px", borderRadius: 9, border: "1px solid var(--border-strong)",
  background: "var(--bg-elevated)", color: "var(--fg-strong)", fontSize: 13, fontWeight: 700, cursor: "pointer",
};
const stepBtn: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 9,
  border: "1px solid rgba(var(--accent-rgb),0.45)", background: "rgba(var(--accent-rgb),0.10)",
  color: "var(--accent)", fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "left",
};
