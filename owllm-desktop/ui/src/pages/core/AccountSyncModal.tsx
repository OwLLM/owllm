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
import { openWebUrl } from "../../utils/openWebUrl";
import {
  githubStatus,
  githubConnect,
  githubDisconnect,
  githubDeviceStart,
  githubDevicePoll,
  vaultEnsure,
  vaultStatus,
  GITHUB_TOKEN_URL,
  type GithubStatus,
  type VaultStatus,
} from "../agentic/github";

const LEGACY_SEEN_KEY = "owllm:sync-onboard-seen";
const ONBOARDING_COMPLETE_KEY = "owllm:onboarding:v2:complete";
const ACCOUNT_ONBOARDING_KEY = "owllm:accounts:onboarding-provider";
const GITHUB_SIGNUP_URL = "https://github.com/signup";

type OnboardingStage = "identity" | "access";

const SUBSCRIPTION_CHOICES = [
  { key: "openai", icon: "◎", name: "ChatGPT Plus / Pro", detail: "Use your OpenAI Codex subscription" },
  { key: "anthropic", icon: "A", name: "Claude Pro / Max", detail: "Use your Claude Code subscription" },
  { key: "gemini", icon: "✦", name: "Google AI Pro / Ultra", detail: "Use your Gemini subscription" },
  { key: "moonshot", icon: "K", name: "Kimi", detail: "Use your Kimi Code subscription" },
  { key: "xai", icon: "𝕏", name: "SuperGrok / X Premium+", detail: "Use your Grok subscription" },
] as const;

function openExternal(url: string) {
  openWebUrl(url).catch((error) => console.error("Could not open the OwLLM browser", error));
}

/// Imperatively open the modal from anywhere (e.g. a header button).
export function openSyncOnboarding() {
  window.dispatchEvent(new CustomEvent("owllm:open-sync"));
}

export default function AccountSyncModal() {
  const [open, setOpen] = React.useState(false);
  const [stage, setStage] = React.useState<OnboardingStage>("identity");
  const [status, setStatus] = React.useState<GithubStatus | null>(null);
  const [token, setToken] = React.useState("");
  const [showToken, setShowToken] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [vault, setVault] = React.useState<VaultStatus | null>(null);
  const [vaultMsg, setVaultMsg] = React.useState<string>("");
  // Device Flow ("Sign in with GitHub" — no token paste).
  const [device, setDevice] = React.useState<{ userCode: string; verificationUri: string } | null>(null);
  const [showTokenFallback, setShowTokenFallback] = React.useState(false);
  const pollAlive = React.useRef(false);
  // True while a device-flow sign-in is in progress (code on screen / starting).
  // Used to keep the popup OPEN so switching to the browser to enter the code
  // doesn't dismiss it (the bug: backdrop/Esc closed it and lost the code).
  const inFlow = busy || !!device;
  const inFlowRef = React.useRef(false);
  React.useEffect(() => { inFlowRef.current = inFlow; }, [inFlow]);

  // First-run auto-open + manual reopen.
  React.useEffect(() => {
    let firstRun = false;
    try { firstRun = !localStorage.getItem(ONBOARDING_COMPLETE_KEY); } catch { /* private mode */ }
    if (firstRun) {
      setOpen(true);
    }
    const onOpen = () => {
      setStage("identity");
      setOpen(true);
    };
    window.addEventListener("owllm:open-sync", onOpen);
    return () => window.removeEventListener("owllm:open-sync", onOpen);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    // Fresh open → clear any stale state so a previous interrupted attempt
    // can't leave the button stuck on "Starting…".
    setBusy(false); setErr(null); setDevice(null); pollAlive.current = false;
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
      // Kick off sync now so they don't have to restart.
      if (v.cloned) { import("../../runtime/vaultSync").then((m) => m.onVaultConnected()).catch(() => {}); }
    } catch (e) {
      // Non-fatal: sign-in still worked; surface the reason.
      setVault(await vaultStatus());
      setVaultMsg(`Couldn't finish vault setup: ${String(e)}`);
    }
  };

  React.useEffect(() => {
    // Esc closes — but NOT while a device-flow is mid-sign-in (so it survives
    // the trip to the browser). Cancel/✕ still work to abort.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !inFlowRef.current) close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    pollAlive.current = false; // stop any in-flight device-flow polling
    setDevice(null);
    setBusy(false); // never leave the button stuck on "Starting…"
    setOpen(false);
  };

  const completeOnboarding = () => {
    try {
      localStorage.setItem(ONBOARDING_COMPLETE_KEY, "1");
      localStorage.setItem(LEGACY_SEEN_KEY, "1");
    } catch { /* storage unavailable */ }
  };

  const finishLater = () => {
    completeOnboarding();
    try { localStorage.setItem("owllm.wizard.completed", "1"); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("owllm:skip-module-wizard"));
    close();
  };

  const openAccountSetup = (provider: string) => {
    completeOnboarding();
    try {
      sessionStorage.setItem(ACCOUNT_ONBOARDING_KEY, provider);
      // A cloud account does not need the large local-runtime download prompt.
      localStorage.setItem("owllm.wizard.completed", "1");
    } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent("owllm:skip-module-wizard"));
    close();
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: "accounts" } }));
    }, 0);
  };

  const openLocalSetup = () => {
    completeOnboarding();
    close();
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: "models" } }));
    }, 0);
  };

  // Device Flow: ask GitHub for a code, open the browser, then poll until the
  // user authorizes. No token to create or paste.
  const startDeviceFlow = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await githubDeviceStart();
      setDevice({ userCode: d.userCode, verificationUri: d.verificationUri });
      // Auto-copy the code so the user can just paste it in the browser —
      // no need to alt-tab back to read it off this popup.
      try { await navigator.clipboard?.writeText(d.userCode); } catch { /* ok */ }
      openExternal(d.verificationUri);
      pollAlive.current = true;
      const poll = async () => {
        if (!pollAlive.current) return;
        let r;
        try { r = await githubDevicePoll(d.deviceCode); }
        catch (e) { setErr(String(e)); setBusy(false); setDevice(null); pollAlive.current = false; return; }
        if (!pollAlive.current) return;
        if (r.status === "authorized") {
          pollAlive.current = false;
          setDevice(null); setBusy(false);
          setStatus({ connected: true, login: r.login });
          await ensureVault();
          setStage("access");
          return;
        }
        if (r.status === "denied" || r.status === "expired" || r.status === "error") {
          pollAlive.current = false;
          setDevice(null); setBusy(false);
          setErr(r.detail || (r.status === "expired" ? "The code expired — try again."
            : r.status === "denied" ? "Authorization was declined." : "Sign-in failed."));
          return;
        }
        const next = (r.status === "slowDown" ? d.interval + 5 : d.interval) * 1000;
        setTimeout(poll, next);
      };
      setTimeout(poll, d.interval * 1000);
    } catch (e) {
      setErr(String(e)); setBusy(false);
    }
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
      setStage("access");
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
      onMouseDown={(e) => { if (e.target === e.currentTarget && !inFlow) close(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 10020,
        background: "rgba(0,0,0,0.66)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <style>{`@keyframes owllm-spin { to { transform: rotate(360deg); } }`}</style>
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
          <img
            src="/Page_icons/owllm_main.png"
            alt="OWLLM"
            style={{ height: 38, width: "auto", marginRight: 12, flexShrink: 0 }}
          />
          <div>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: 0.4 }}>
              {stage === "identity" ? "Welcome to OwLLM" : "Choose how you use AI"}
            </div>
            <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 2 }}>
              {stage === "identity"
                ? "Start with one secure identity — or continue locally."
                : "We’ll take you to the right setup for what you already pay for."}
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
          <div data-ui="OnboardingProgress" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {["1  Identity", "2  AI access"].map((label, index) => {
              const active = (stage === "identity" ? 0 : 1) === index;
              return <div key={label} style={{
                padding: "7px 10px", borderRadius: 8, fontSize: 11.5, fontWeight: 800,
                color: active ? "var(--accent-ink)" : "var(--fg-muted)",
                background: active ? "rgba(var(--accent-rgb),0.14)" : "var(--bg-card)",
                border: active ? "1px solid var(--accent-strong)" : "1px solid var(--border)",
              }}>{label}</div>;
            })}
          </div>

          {stage === "identity" ? <>
          {/* Why — synthetic, scannable benefit chips. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {([
              ["🔄", "Everywhere you sign in", "Chats, settings & agent teams sync to every device."],
              ["🔒", "Totally private", "Lives in your own GitHub repo — we host nothing, see nothing."],
              ["🤖", "Agents that ship code", "They clone your private repos and push commits, safely sandboxed."],
              ["🐞", "One-click bug reports", "Report it from inside the app — and get it fixed."],
              ["🔑", "Never locked out", "Forgot your password? Reset it on GitHub. API keys never sync."],
            ] as [string, string, string][]).map(([icon, title, sub], i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", padding: "9px 11px", borderRadius: 10, background: "var(--bg-card)", border: "1px solid var(--border)" }}>
                <span style={{ fontSize: 19, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 9, background: "rgba(var(--accent-rgb),0.12)", flexShrink: 0 }}>{icon}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: "var(--fg-strong)" }}>{title}</div>
                  <div style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.4 }}>{sub}</div>
                </div>
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
                <button onClick={() => setStage("access")} style={primaryBtn}>Continue to AI setup →</button>
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
          ) : device ? (
            // Device Flow in progress — show the code to enter in the browser.
            <div style={{
              background: "var(--bg-card)", border: "1px solid rgba(var(--accent-rgb),0.5)",
              borderRadius: 10, padding: "14px",
            }}>
              <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.5 }}>
                We opened <b>github.com/login/device</b> in your browser and <b>copied your code</b> —
                just <b>paste</b> it there and click <b>Authorize</b>. This window stays open; you
                don’t need to come back to it.
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0" }}>
                <div style={{
                  fontFamily: "Consolas, monospace", fontSize: 26, fontWeight: 800, letterSpacing: 4,
                  color: "var(--fg-strong)", background: "var(--bg-input)",
                  border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 16px",
                }}>{device.userCode}</div>
                <button onClick={() => navigator.clipboard?.writeText(device.userCode)} style={ghostBtn}>Copy</button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  width: 13, height: 13, borderRadius: "50%",
                  border: "2px solid rgba(var(--accent-rgb),0.35)", borderTopColor: "var(--accent)",
                  display: "inline-block", animation: "owllm-spin 0.7s linear infinite",
                }} />
                <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>Waiting for you to authorize…</span>
                <div style={{ flex: 1 }} />
                <button onClick={() => openExternal(device.verificationUri)} style={ghostBtn}>Open page</button>
                <button onClick={() => { pollAlive.current = false; setDevice(null); setBusy(false); }} style={ghostBtn}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{
              background: "var(--bg-card)", border: "1px solid var(--border)",
              borderRadius: 10, padding: "14px",
            }}>
              <button onClick={startDeviceFlow} disabled={busy} style={{ ...primaryBtn, width: "100%", padding: "12px", fontSize: 14.5 }}>
                {busy ? "Starting…" : "🔗 Sign in with GitHub"}
              </button>
              <div style={{ fontSize: 11.5, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.5 }}>
                Opens GitHub in your browser — click Authorize and you’re in. Nothing to paste.
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                <button onClick={() => openExternal(GITHUB_SIGNUP_URL)} style={ghostBtn}>Create a GitHub account</button>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => setShowTokenFallback((v) => !v)}
                  style={{ background: "none", border: "none", color: "var(--fg-muted)", fontSize: 11.5, cursor: "pointer", textDecoration: "underline" }}
                >{showTokenFallback ? "Hide token option" : "Prefer to paste a token?"}</button>
              </div>
              {showTokenFallback && (
                <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
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
                    <button onClick={connect} disabled={busy} style={primaryBtn}>
                      {busy ? "…" : "Connect"}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.5 }}>
                    Classic token with the <b>repo</b> scope. Stored only on this device.
                  </div>
                </div>
              )}
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
                onClick={() => setStage("access")}
                style={{ background: "none", border: "none", color: "var(--fg-muted)", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}
              >
                Continue without GitHub — keep everything on this device
              </button>
            </div>
          )}
          </> : (
            <>
              <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--fg-muted)" }}>
                Choose the option that matches your account. OwLLM will never turn a consumer
                subscription into an API key or pretend that one provider’s plan works with another.
              </div>

              <div data-ui="SubscriptionChoices" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 9 }}>
                {SUBSCRIPTION_CHOICES.map((choice) => (
                  <button key={choice.key} onClick={() => openAccountSetup(choice.key)} style={choiceCard}>
                    <span aria-hidden="true" style={choiceIcon}>{choice.icon}</span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 13.5, fontWeight: 850 }}>{choice.name}</span>
                      <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.4, marginTop: 2 }}>{choice.detail}</span>
                    </span>
                    <span aria-hidden="true" style={{ marginLeft: "auto", color: "var(--accent)", fontWeight: 900 }}>→</span>
                  </button>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 9 }}>
                <button onClick={() => openAccountSetup("api")} style={choiceCard}>
                  <span aria-hidden="true" style={choiceIcon}>🔑</span>
                  <span>
                    <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 13.5, fontWeight: 850 }}>I have API keys</span>
                    <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.4, marginTop: 2 }}>Usage-billed OpenAI, Anthropic, Gemini and other APIs</span>
                  </span>
                </button>
                <button onClick={openLocalSetup} style={choiceCard}>
                  <span aria-hidden="true" style={choiceIcon}>🖥</span>
                  <span>
                    <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 13.5, fontWeight: 850 }}>I want local models</span>
                    <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.4, marginTop: 2 }}>Private, offline inference using this computer</span>
                  </span>
                </button>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => setStage("identity")} style={ghostBtn}>← Back</button>
                <div style={{ flex: 1 }} />
                <button onClick={finishLater} style={ghostBtn}>Set up later</button>
              </div>
            </>
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
  color: "var(--accent-ink)", fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "left",
};
const choiceCard: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 11, minHeight: 68,
  padding: "11px 12px", borderRadius: 11, textAlign: "left",
  border: "1px solid var(--border-strong)", background: "var(--bg-card)",
  color: "var(--fg)", cursor: "pointer",
};
const choiceIcon: React.CSSProperties = {
  width: 34, height: 34, flexShrink: 0, borderRadius: 9,
  display: "grid", placeItems: "center", fontSize: 17, fontWeight: 900,
  background: "rgba(var(--accent-rgb),0.13)", color: "var(--accent-ink)",
  border: "1px solid rgba(var(--accent-rgb),0.3)",
};
