// Account / Sync onboarding popup.
//
// First-run (and reopenable via the `owllm:open-sync` event) modal laid out
// as side-by-side step columns so the whole journey is visible at once:
//   ① Your GitHub identity — why to have it, sign in / sign up.
//   ② Where your projects live — the folder they already sync with GitHub, or
//      OwLLM's own `~/OwLLM/Projects`. Device-local; see projectsRoot.ts.
//   ③ Your AI access — subscription, API keys, or local models.
//   ④ Start creating — jump straight into the Coding page or the Agentic Team.
// Everything behind the buttons is automatic: the private vault is created and
// cloned on sign-in, the provider is pre-highlighted on the Accounts page, and
// the local-runtime wizard is skipped when it would be redundant.
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
import { projectsRootGet, projectsRootSet } from "../agentic/projectsRoot";
import {
  OpenAILogo,
  AnthropicLogo,
  GeminiLogo,
  MoonshotLogo,
  XaiLogo,
} from "../advanced/brandLogos";
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

const SUBSCRIPTION_CHOICES = [
  { key: "openai", Logo: OpenAILogo, color: "#10a37f", name: "ChatGPT Plus / Pro", detail: "Use your OpenAI Codex subscription" },
  { key: "anthropic", Logo: AnthropicLogo, color: "#cc785c", name: "Claude Pro / Max", detail: "Use your Claude Code subscription" },
  { key: "gemini", Logo: GeminiLogo, color: "#4285f4", name: "Google AI Pro / Ultra", detail: "Use your Gemini subscription" },
  { key: "moonshot", Logo: MoonshotLogo, color: "#d36bff", name: "Kimi", detail: "Use your Kimi Code subscription" },
  { key: "xai", Logo: XaiLogo, color: "#9aa0a6", name: "SuperGrok / X Premium+", detail: "Use your Grok subscription" },
] as const;

function openExternal(url: string) {
  openWebUrl(url).catch((error) => console.error("Could not open the OwLLM browser", error));
}

async function openAndFillGithubDeviceCode(url: string, code: string): Promise<boolean> {
  const opened = await invoke<string>("browser_open_tab", { url, activate: true });
  let tabId: number | undefined;
  try {
    const parsed = JSON.parse(opened) as { tab_id?: number };
    tabId = parsed.tab_id;
  } catch {
    // Older browser builds return a readable sentence instead of JSON. The
    // active-tab fallback still lets browser_cmd target the page.
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt) await new Promise((resolve) => window.setTimeout(resolve, 350));
    try {
      const result = await invoke<string>("browser_cmd", {
        action: "fill_device_code",
        params: { code, submit: true, tab_id: tabId ?? null },
      });
      if (result.includes("filled GitHub device code")) return true;
    } catch {
      // The bridge is injected after navigation. Retry while GitHub's device
      // page and its React form finish loading.
    }
  }
  return false;
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
  // Step ② — where new projects get created. Either the folder the user
  // already syncs with GitHub, or OwLLM's own default. Device-local.
  const [projectsRoot, setProjectsRoot] = React.useState<{ path: string; configured: boolean } | null>(null);
  const [rootBusy, setRootBusy] = React.useState(false);
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
    const onOpen = () => setOpen(true);
    window.addEventListener("owllm:open-sync", onOpen);
    return () => window.removeEventListener("owllm:open-sync", onOpen);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    // Fresh open → clear any stale state so a previous interrupted attempt
    // can't leave the button stuck on "Starting…".
    setBusy(false); setErr(null); setDevice(null); pollAlive.current = false;
    projectsRootGet().then(setProjectsRoot).catch(() => setProjectsRoot(null));
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

  // Accept OwLLM's default (`path: null`) or the folder the user already syncs
  // with GitHub. Either way the folder is created now, so the first project
  // needs no second prompt.
  const chooseProjectsRoot = async (path: string | null) => {
    setRootBusy(true); setErr(null);
    try {
      setProjectsRoot(await projectsRootSet(path));
    } catch (e) {
      setErr(`Could not use that projects folder: ${String(e)}`);
    } finally {
      setRootBusy(false);
    }
  };

  const browseProjectsRoot = async () => {
    try {
      const picked = await invoke<string | null>("pick_folder", {
        title: "Pick the folder where your projects live",
        startDir: projectsRoot?.path || null,
      });
      if (picked) await chooseProjectsRoot(picked);
    } catch (e) {
      setErr(`Folder pick failed: ${String(e)}`);
    }
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

  // Step ③ — jump straight into a workspace. Mirrors finishLater's wizard
  // handling so no second first-run prompt appears underneath.
  const startCreating = (pageKey: "code" | "agents") => {
    completeOnboarding();
    try { localStorage.setItem("owllm.wizard.completed", "1"); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("owllm:skip-module-wizard"));
    close();
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: pageKey } }));
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
      const filled = await openAndFillGithubDeviceCode(d.verificationUri, d.userCode);
      if (!filled) {
        setErr("GitHub opened, but OWLLM could not fill the code automatically. The code is copied; paste it into the page.");
      }
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
          setErr(null);
          setStatus({ connected: true, login: r.login });
          await ensureVault();
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
      setVault(null);
      setVaultMsg("Signed out. Remote sync is stopped; local projects and chats remain available offline.");
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
        width: "min(1440px, 98%)", maxHeight: "92%",
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
              Welcome to OwLLM
            </div>
            <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 2 }}>
              A few steps and you’re creating — everything behind them is set up automatically.
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

        {/* Four step columns */}
        <div data-ui="OnboardingColumns" style={{
          padding: "18px 20px 12px", overflow: "auto", flex: 1,
          display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 14, alignItems: "stretch",
        }}>

          {/* ── ① GitHub identity ─────────────────────────────────────── */}
          <StepColumn
            n={1} done={connected}
            title="Your GitHub identity"
            subtitle={connected
              ? `Signed in as @${login} — your private vault syncs from here.`
              : "One secure account powers sync, agents and backups. Free to create."}
          >
            {!connected && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {([
                  ["🔄", "Everywhere you sign in", "Chats, settings & agent teams follow you to every device."],
                  ["🔒", "Totally private", "Lives in your own GitHub repo — we host nothing, see nothing."],
                  ["🤖", "Agents that ship code", "They clone your repos and push commits, safely sandboxed."],
                  ["🔑", "Never locked out", "Forgot your password? Reset it on GitHub. API keys never sync."],
                ] as [string, string, string][]).map(([icon, title, sub], i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", borderRadius: 10, background: "var(--bg-card)", border: "1px solid var(--border)" }}>
                    <span style={{ fontSize: 17, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, background: "rgba(var(--accent-rgb),0.12)", flexShrink: 0 }}>{icon}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--fg-strong)" }}>{title}</div>
                      <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.35 }}>{sub}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {connected ? (
              <div style={{
                background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.4)",
                borderRadius: 10, padding: "12px 14px",
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#22c55e" }}>
                  ✓ Signed in as @{login}
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 4, lineHeight: 1.5 }}>
                  {vault?.cloned ? (
                    <>Your private vault <code>{login}/owllm-vault</code> is ready on this device.
                    Chats, settings and agent teams sync automatically.</>
                  ) : vaultMsg ? (
                    <>{vaultMsg}</>
                  ) : (
                    <>Your chats, settings and agent teams will sync to a private{" "}
                    <code>owllm-vault</code> repo on <code>github.com/{login}</code>.</>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
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
                borderRadius: 10, padding: "12px",
              }}>
                <div style={{ fontSize: 12.5, color: "var(--fg)", lineHeight: 1.5 }}>
                  We opened <b>github.com/login/device</b> and <b>filled your code automatically</b>.
                  Review GitHub's authorization screen, then click <b>Authorize</b>. This window stays open.
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0", flexWrap: "wrap" }}>
                  <div style={{
                    fontFamily: "Consolas, monospace", fontSize: 21, fontWeight: 800, letterSpacing: 3,
                    color: "var(--fg-strong)", background: "var(--bg-input)",
                    border: "1px solid var(--border-strong)", borderRadius: 8, padding: "7px 12px",
                  }}>{device.userCode}</div>
                  <button onClick={() => navigator.clipboard?.writeText(device.userCode)} style={ghostBtn}>Copy</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{
                    width: 13, height: 13, borderRadius: "50%",
                    border: "2px solid rgba(var(--accent-rgb),0.35)", borderTopColor: "var(--accent)",
                    display: "inline-block", animation: "owllm-spin 0.7s linear infinite",
                  }} />
                  <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>Waiting for you to authorize…</span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => openExternal(device.verificationUri)} style={ghostBtn}>Open page</button>
                  <button onClick={() => { pollAlive.current = false; setDevice(null); setBusy(false); }} style={ghostBtn}>Cancel</button>
                </div>
              </div>
            ) : (
              <div>
                <button onClick={startDeviceFlow} disabled={busy} style={{ ...primaryBtn, width: "100%", padding: "12px", fontSize: 14 }}>
                  {busy ? "Starting…" : "🔗 Sign in with GitHub"}
                </button>
                <div style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 6, lineHeight: 1.45 }}>
                  Opens GitHub in your browser — click Authorize and you’re in. Nothing to paste.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => openExternal(GITHUB_SIGNUP_URL)} style={ghostBtn}>Create a GitHub account</button>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={() => setShowTokenFallback((v) => !v)}
                    style={{ background: "none", border: "none", color: "var(--fg-muted)", fontSize: 11, cursor: "pointer", textDecoration: "underline" }}
                  >{showTokenFallback ? "Hide token option" : "Prefer to paste a token?"}</button>
                </div>
                {showTokenFallback && (
                  <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
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
                          flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8,
                          background: "var(--bg-input)", border: "1px solid var(--border-strong)",
                          color: "var(--fg)", fontSize: 12.5,
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
                    <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 6, lineHeight: 1.45 }}>
                      Classic token with the <b>repo</b> scope. Stored only on this device.
                    </div>
                  </div>
                )}
                <div style={{ textAlign: "center", marginTop: 10 }}>
                  <button
                    onClick={finishLater}
                    style={{ background: "none", border: "none", color: "var(--fg-muted)", fontSize: 11.5, cursor: "pointer", textDecoration: "underline" }}
                  >
                    Continue without GitHub — keep everything on this device
                  </button>
                </div>
              </div>
            )}
          </StepColumn>

          {/* ── ② Where your projects live ────────────────────────────── */}
          <StepColumn
            n={2} done={!!projectsRoot?.configured}
            dataUi="OnboardingProjectsRoot"
            title="Where your projects live"
            subtitle={projectsRoot?.configured
              ? "New projects are created here automatically."
              : "Point OwLLM at the folder you already sync with GitHub, or use ours."}
          >
            <div style={{
              display: "flex", alignItems: "center", gap: 8, padding: "10px 12px",
              borderRadius: 10, background: "var(--bg-input)", border: "1px solid var(--border-strong)",
            }}>
              <span aria-hidden="true" style={{ fontSize: 16 }}>📁</span>
              <code style={{
                fontSize: 12, color: "var(--fg-strong)", wordBreak: "break-all", lineHeight: 1.4,
              }}>{projectsRoot?.path || "…"}</code>
            </div>
            <button onClick={browseProjectsRoot} disabled={rootBusy} style={launchCard}>
              <span aria-hidden="true" style={{ ...choiceIcon, width: 44, height: 44, fontSize: 23 }}>🔗</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 15, fontWeight: 850 }}>Use my own folder</span>
                <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.45, marginTop: 3 }}>
                  Already keep your repos somewhere — the folder you sync with GitHub? Point OwLLM at it.
                </span>
              </span>
              <span aria-hidden="true" style={{ marginLeft: "auto", color: "var(--accent)", fontWeight: 900, fontSize: 17 }}>→</span>
            </button>
            <button onClick={() => chooseProjectsRoot(null)} disabled={rootBusy} style={launchCard}>
              <span aria-hidden="true" style={{ ...choiceIcon, width: 44, height: 44, fontSize: 23 }}>✨</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 15, fontWeight: 850 }}>Use OwLLM’s folder</span>
                <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.45, marginTop: 3 }}>
                  We create <code>~/OwLLM/Projects</code> for you — nothing to decide.
                </span>
              </span>
              <span aria-hidden="true" style={{ marginLeft: "auto", color: "var(--accent)", fontWeight: 900, fontSize: 17 }}>→</span>
            </button>
            <div style={{ fontSize: 10.5, color: "var(--fg-muted)", lineHeight: 1.45 }}>
              This folder stays on this device — OwLLM never syncs paths between machines.
              You can change it later from Settings.
            </div>
          </StepColumn>

          {/* ── ③ AI access ───────────────────────────────────────────── */}
          <StepColumn
            n={3}
            title="Connect your AI"
            subtitle="Pick what you already pay for — or go fully local. OwLLM opens the existing Accounts page with that provider highlighted, so sign-in is one click away."
            dataUi="OnboardingAccountLoginPanel"
          >
            <div data-ui="OnboardingInlineSubscriptionChoices" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {SUBSCRIPTION_CHOICES.map((choice) => (
                <button key={choice.key} onClick={() => openAccountSetup(choice.key)} style={choiceCard}>
                  <span aria-hidden="true" style={{ ...choiceIcon, background: `${choice.color}1a`, borderColor: `${choice.color}4d`, color: choice.color }}>
                    <choice.Logo size={20} color={choice.color} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 12.5, fontWeight: 850 }}>{choice.name}</span>
                    <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 11, lineHeight: 1.35, marginTop: 1 }}>{choice.detail}</span>
                  </span>
                  <span aria-hidden="true" style={{ marginLeft: "auto", color: "var(--accent)", fontWeight: 900 }}>→</span>
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
              <button onClick={() => openAccountSetup("api")} style={choiceCard}>
                <span aria-hidden="true" style={choiceIcon}>🔑</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 12.5, fontWeight: 850 }}>I have API keys</span>
                  <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 11, lineHeight: 1.35, marginTop: 1 }}>Usage-billed provider APIs</span>
                </span>
              </button>
              <button onClick={openLocalSetup} style={choiceCard}>
                <span aria-hidden="true" style={choiceIcon}>🖥</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 12.5, fontWeight: 850 }}>I want local models</span>
                  <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 11, lineHeight: 1.35, marginTop: 1 }}>Private, offline inference on this computer</span>
                </span>
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: "var(--fg-muted)", lineHeight: 1.45 }}>
              OwLLM never turns a consumer subscription into an API key or pretends one
              provider’s plan works with another.
            </div>
          </StepColumn>

          {/* ── ④ Start creating ──────────────────────────────────────── */}
          <StepColumn
            n={4}
            title="Start creating"
            subtitle="Jump straight into a workspace — you can always finish the earlier steps later from Settings."
          >
            <button onClick={() => startCreating("code")} style={launchCard}>
              <span aria-hidden="true" style={{ ...choiceIcon, width: 44, height: 44, fontSize: 23 }}>💻</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 15, fontWeight: 850 }}>Coding page</span>
                <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.45, marginTop: 3 }}>
                  Open a project and pair with an AI coder — edits, terminal and preview in one place.
                </span>
              </span>
              <span aria-hidden="true" style={{ marginLeft: "auto", color: "var(--accent)", fontWeight: 900, fontSize: 17 }}>→</span>
            </button>
            <button onClick={() => startCreating("agents")} style={launchCard}>
              <span aria-hidden="true" style={{ ...choiceIcon, width: 44, height: 44, fontSize: 23 }}>🤖</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", color: "var(--fg-strong)", fontSize: 15, fontWeight: 850 }}>Agentic Team</span>
                <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.45, marginTop: 3 }}>
                  A whole team of AI agents that plan, build and review together — you direct.
                </span>
              </span>
              <span aria-hidden="true" style={{ marginLeft: "auto", color: "var(--accent)", fontWeight: 900, fontSize: 17 }}>→</span>
            </button>
            <div style={{
              padding: "10px 12px", borderRadius: 10,
              background: "rgba(var(--accent-rgb),0.08)", border: "1px dashed rgba(var(--accent-rgb),0.4)",
              fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5,
            }}>
              ✨ <b style={{ color: "var(--fg-strong)" }}>Automatic for you:</b> your private vault,
              device sync, and provider setup are wired up behind the scenes — no config files,
              no terminals.
            </div>
          </StepColumn>
        </div>

        {/* Footer */}
        <div style={{ padding: "0 20px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          {err && (
            <div style={{
              padding: "10px 12px", borderRadius: 8,
              background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.4)",
              color: "#ffb4b4", fontSize: 12.5, whiteSpace: "pre-wrap",
            }}>{err}</div>
          )}
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
              Reopen anytime from <b>Settings → Finish onboarding</b>.
            </div>
            <div style={{ flex: 1 }} />
            <button onClick={finishLater} style={ghostBtn}>Set up later</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/// One numbered step container. `done` flips the badge to a green check and
/// softly highlights the border so progress reads at a glance.
function StepColumn({ n, title, subtitle, done, dataUi, children }: {
  n: number;
  title: string;
  subtitle: string;
  done?: boolean;
  dataUi?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-ui={dataUi} style={{
      display: "flex", flexDirection: "column", gap: 10,
      padding: 14, borderRadius: 14, minWidth: 0,
      background: done
        ? "linear-gradient(180deg, rgba(34,197,94,0.07), var(--bg-card))"
        : "linear-gradient(180deg, rgba(var(--accent-rgb),0.09), var(--bg-card))",
      border: done ? "1px solid rgba(34,197,94,0.45)" : "1px solid rgba(var(--accent-rgb),0.35)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span aria-hidden="true" style={{
          width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
          display: "grid", placeItems: "center", fontSize: 14, fontWeight: 900,
          background: done ? "rgba(34,197,94,0.18)" : "rgba(var(--accent-rgb),0.16)",
          color: done ? "#22c55e" : "var(--accent-ink)",
          border: done ? "1px solid rgba(34,197,94,0.55)" : "1px solid rgba(var(--accent-rgb),0.5)",
        }}>{done ? "✓" : n}</span>
        <span style={{ fontSize: 15.5, fontWeight: 850, color: "var(--fg-strong)" }}>{title}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.5 }}>{subtitle}</div>
      {children}
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: "9px 16px", borderRadius: 9, border: "none",
  background: "linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent))",
  color: "var(--accent-fg)", fontSize: 13.5, fontWeight: 800, cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 9, border: "1px solid var(--border-strong)",
  background: "var(--bg-elevated)", color: "var(--fg-strong)", fontSize: 12.5, fontWeight: 700, cursor: "pointer",
};
const stepBtn: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 9,
  border: "1px solid rgba(var(--accent-rgb),0.45)", background: "rgba(var(--accent-rgb),0.10)",
  color: "var(--accent-ink)", fontSize: 13, fontWeight: 700, cursor: "pointer", textAlign: "left",
};
const choiceCard: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
  padding: "9px 11px", borderRadius: 11, textAlign: "left",
  border: "1px solid var(--border-strong)", background: "var(--bg-card)",
  color: "var(--fg)", cursor: "pointer",
};
const choiceIcon: React.CSSProperties = {
  width: 32, height: 32, flexShrink: 0, borderRadius: 9,
  display: "grid", placeItems: "center", fontSize: 16, fontWeight: 900,
  background: "rgba(var(--accent-rgb),0.13)", color: "var(--accent-ink)",
  border: "1px solid rgba(var(--accent-rgb),0.3)",
};
const launchCard: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 12, minHeight: 82,
  padding: "13px 14px", borderRadius: 12, textAlign: "left",
  border: "1px solid rgba(var(--accent-rgb),0.5)",
  background: "linear-gradient(135deg, rgba(var(--accent-rgb),0.12), var(--bg-card))",
  color: "var(--fg)", cursor: "pointer",
};
