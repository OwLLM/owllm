// Signing — the developer's one home for code-signing credentials.
//
// Ships a signed build without the scavenger hunt: store the Apple Developer ID
// set (certificate .p12 + passwords + identity + team) and the Windows
// Authenticode selectors once, and every OwLLM instance — and every coding
// agent, in any project — can reach them (signing.rs). One click pushes them to
// a repo's GitHub Actions secrets, so `release.yml` produces a signed +
// notarized DMG with no further setup.
//
// Storage + sync + the security model live in src-tauri/src/signing.rs; this is
// pure presentation over those commands. Secret values are never rendered — the
// page shows only "stored / not stored", an expiry countdown, and non-secret
// identifiers.

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SURFACE, TEXT, BORDER, BUTTON, INPUT, banner } from "../../theme/styles";
import {
  signingStatus, signingAppleSave, signingAppleImportP12, signingWindowsSave,
  signingClear, signingExportEnv, signingPushGithub,
  type SigningStatus, type AppleStatus, type WindowsStatus,
} from "./signing";

const APPLE_PORTAL = "https://developer.apple.com/account/resources/certificates/add";

type Msg = { tone: "info" | "success" | "error"; text: string } | null;

export default function SigningPage() {
  const [status, setStatus] = useState<SigningStatus | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await signingStatus()); }
    catch (e) { setMsg({ tone: "error", text: `Couldn't read signing store: ${e}` }); }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    const onSync = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("owllm:signing:refresh", onSync);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("owllm:signing:refresh", onSync);
    };
  }, [refresh]);

  return (
    <div style={{ ...SURFACE.page, height: "100%", overflowY: "auto", padding: "18px 22px" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ ...TEXT.strong, fontSize: 20, fontWeight: 800 }}>🖊 Signing &amp; certificates</div>
          <div style={{ ...TEXT.muted, fontSize: 12.5, lineHeight: 1.55 }}>
            Store your code-signing credentials once. They're kept encrypted on this machine, shared
            with every OwLLM window here, and reachable by the coding agents in any project — so a
            signed, notarized release is one button, not a week of portal spelunking.
          </div>
        </header>

        {msg && <div style={banner(msg.tone)}>{msg.text}</div>}

        <AppleCard apple={status?.apple ?? null} onChange={refresh} setMsg={setMsg} />
        <WindowsCard win={status?.windows ?? null} onChange={refresh} setMsg={setMsg} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apple Developer ID
// ---------------------------------------------------------------------------

function AppleCard({
  apple, onChange, setMsg,
}: { apple: AppleStatus | null; onChange: () => Promise<void>; setMsg: (m: Msg) => void }) {
  const [identity, setIdentity] = useState("");
  const [appleId, setAppleId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [appPw, setAppPw] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [askP12, setAskP12] = useState<string | null>(null); // holds the picked path while asking for its password

  // Re-seed the editable fields from the store whenever it changes (but don't
  // clobber an in-progress edit: only sync when the field is still empty or the
  // store value changed underneath us).
  const seededFor = useRef<number>(-1);
  useEffect(() => {
    if (!apple) { seededFor.current = -1; return; }
    if (seededFor.current !== apple.updatedMs) {
      setIdentity(apple.signingIdentity);
      setAppleId(apple.appleId);
      setTeamId(apple.teamId);
      seededFor.current = apple.updatedMs;
    }
  }, [apple]);

  async function pickP12() {
    try {
      const path = await invoke<string | null>("pick_file", {
        title: "Choose your Developer ID .p12",
        filters: [["Certificate", ["p12", "pfx"]]],
      });
      if (path) setAskP12(path);
    } catch (e) { setMsg({ tone: "error", text: `File picker failed: ${e}` }); }
  }

  async function importP12(password: string) {
    const path = askP12;
    setAskP12(null);
    if (!path) return;
    setBusy(true); setMsg(null);
    try {
      await signingAppleImportP12(path, password);
      await onChange();
      setMsg({ tone: "success", text: "Certificate imported. Fill in the identity/Team ID if they weren't detected, then Save." });
    } catch (e) {
      setMsg({ tone: "error", text: `Import failed: ${e}` });
    } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await signingAppleSave({
        signingIdentity: identity,
        appleId,
        teamId,
        appSpecificPassword: appPw,        // empty = keep stored
        certificateP12B64: "",             // certificate is set via Import only
        certificatePassword: "",
      });
      setAppPw("");
      await onChange();
      setMsg({ tone: "success", text: "Saved." });
    } catch (e) {
      setMsg({ tone: "error", text: `Save failed: ${e}` });
    } finally { setBusy(false); }
  }

  async function clear() {
    if (!window.confirm("Remove the stored Apple signing certificate and passwords from this machine?")) return;
    setBusy(true);
    try { await signingClear("apple"); await onChange(); setMsg({ tone: "info", text: "Apple signing set cleared." }); }
    catch (e) { setMsg({ tone: "error", text: `Clear failed: ${e}` }); }
    finally { setBusy(false); }
  }

  async function copyValues() {
    try {
      const env = await signingExportEnv("apple");
      const text = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
      await navigator.clipboard.writeText(text);
      setMsg({ tone: "success", text: "Copied the 6 APPLE_* values to the clipboard — paste them into the repo's Settings → Secrets and variables → Actions." });
    } catch (e) { setMsg({ tone: "error", text: `Copy failed: ${e}` }); }
  }

  async function pushGithub() {
    if (!owner.trim() || !repo.trim()) { setMsg({ tone: "error", text: "Enter the GitHub owner and repo first." }); return; }
    setBusy(true); setLog(""); setMsg(null);
    try {
      const out = await signingPushGithub(owner.trim(), repo.trim(), "apple");
      setLog(out);
      setMsg({ tone: "success", text: `Pushed to ${owner.trim()}/${repo.trim()}.` });
    } catch (e) {
      setMsg({ tone: "error", text: String(e) });
    } finally { setBusy(false); }
  }

  const ready = apple?.ready ?? false;
  const daysLeft = apple?.certNotAfterMs ? apple.daysLeft : null;

  return (
    <section style={{ ...SURFACE.card, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ ...TEXT.strong, fontSize: 15, fontWeight: 700 }}> Apple — Developer ID (macOS)</div>
        <StatusPill ok={ready} okText="Ready to sign" offText="Incomplete" />
        <div style={{ flex: 1 }} />
        <ExpiryChip daysLeft={daysLeft} notAfterMs={apple?.certNotAfterMs ?? 0} />
      </div>

      <Row label="Certificate (.p12)" hint="Contains the Developer ID cert + private key.">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StoredDot stored={apple?.hasCertificate ?? false} />
          <span style={{ ...TEXT.muted, fontSize: 12 }}>
            {apple?.hasCertificate ? "Stored on this machine" : "Not stored"}
            {apple?.certSubject ? ` · ${apple.certSubject}` : ""}
          </span>
          <button disabled={busy} onClick={pickP12} style={BUTTON.ghost}>Import .p12…</button>
        </div>
      </Row>

      <Row label="Signing identity" hint='"Developer ID Application: Name (TEAMID)" — auto-detected from the .p12 when possible.'>
        <input style={{ ...INPUT.field, width: "100%" }} value={identity}
          placeholder="Developer ID Application: Your Name (TEAMID)"
          onChange={(e) => setIdentity(e.target.value)} />
      </Row>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Row label="Apple ID (email)" style={{ flex: "1 1 240px" }}>
          <input style={{ ...INPUT.field, width: "100%" }} value={appleId} placeholder="you@example.com"
            onChange={(e) => setAppleId(e.target.value)} />
        </Row>
        <Row label="Team ID" style={{ flex: "1 1 160px" }}>
          <input style={{ ...INPUT.field, width: "100%" }} value={teamId} placeholder="10-char team id"
            onChange={(e) => setTeamId(e.target.value)} />
        </Row>
      </div>

      <Row label="App-specific password" hint="For notarization — created at appleid.apple.com, NOT your Apple ID password.">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StoredDot stored={apple?.hasAppPassword ?? false} />
          <input type="password" style={{ ...INPUT.field, flex: 1 }}
            value={appPw}
            placeholder={apple?.hasAppPassword ? "•••• stored — leave blank to keep" : "xxxx-xxxx-xxxx-xxxx"}
            onChange={(e) => setAppPw(e.target.value)} />
        </div>
      </Row>

      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={busy} onClick={save} style={BUTTON.primary}>Save</button>
        <button disabled={busy || !apple} onClick={clear} style={BUTTON.danger}>Clear</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => invoke("shell_open_url", { url: APPLE_PORTAL }).catch(() => {})} style={BUTTON.ghost}>
          Need a certificate? Apple portal ↗
        </button>
      </div>

      {/* Push to GitHub Actions */}
      <div style={{ borderTop: BORDER.subtle, paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ ...TEXT.strong, fontSize: 13, fontWeight: 700 }}>Ship it — GitHub Actions secrets</div>
        <div style={{ ...TEXT.muted, fontSize: 11.5, lineHeight: 1.5 }}>
          Writes the six <code>APPLE_*</code> secrets your <code>release.yml</code> reads. One-click needs
          the <code>gh</code> CLI signed in; otherwise use <b>Copy values</b> and paste them into the repo's
          Settings → Secrets.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...INPUT.field, flex: "1 1 140px" }} value={owner} placeholder="owner (e.g. ruigro)"
            onChange={(e) => setOwner(e.target.value)} />
          <span style={{ ...TEXT.subtle }}>/</span>
          <input style={{ ...INPUT.field, flex: "1 1 140px" }} value={repo} placeholder="repo (e.g. LLM-Studio)"
            onChange={(e) => setRepo(e.target.value)} />
          <button disabled={busy || !ready} onClick={pushGithub} style={BUTTON.primary}>Push to GitHub secrets</button>
          <button disabled={!ready} onClick={copyValues} style={BUTTON.ghost}>Copy values</button>
        </div>
        {!ready && (
          <div style={{ ...TEXT.subtle, fontSize: 11 }}>
            Complete every field above (certificate, both passwords, identity, Apple ID, Team ID) to enable pushing.
          </div>
        )}
        {log && (
          <pre style={{
            ...SURFACE.panel, margin: 0, padding: 10, borderRadius: 6, fontSize: 11,
            whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto", border: BORDER.subtle,
          }}>{log}</pre>
        )}
      </div>

      {askP12 !== null && (
        <PasswordPrompt
          title="Certificate password"
          hint="The passphrase that opens this .p12 (this becomes APPLE_CERTIFICATE_PASSWORD)."
          onCancel={() => setAskP12(null)}
          onSubmit={importP12}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Windows Authenticode (selectors; forward-looking companion)
// ---------------------------------------------------------------------------

function WindowsCard({
  win, onChange, setMsg,
}: { win: WindowsStatus | null; onChange: () => Promise<void>; setMsg: (m: Msg) => void }) {
  const [thumbprint, setThumbprint] = useState("");
  const [subject, setSubject] = useState("");
  const [tsa, setTsa] = useState("");
  const [busy, setBusy] = useState(false);
  const seededFor = useRef<number>(-1);

  useEffect(() => {
    if (!win) { seededFor.current = -1; return; }
    if (seededFor.current !== win.updatedMs) {
      setThumbprint(win.thumbprint); setSubject(win.subject); setTsa(win.tsa);
      seededFor.current = win.updatedMs;
    }
  }, [win]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await signingWindowsSave(thumbprint, subject, tsa, "", "");
      await onChange();
      setMsg({ tone: "success", text: "Windows signing selectors saved." });
    } catch (e) { setMsg({ tone: "error", text: `Save failed: ${e}` }); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ ...SURFACE.card, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ ...TEXT.strong, fontSize: 15, fontWeight: 700 }}> Windows — Authenticode</div>
        <StatusPill ok={win?.ready ?? false} okText="Selector set" offText="Not set" />
      </div>
      <div style={{ ...TEXT.muted, fontSize: 11.5, lineHeight: 1.5 }}>
        The publish pipeline signs with a cert already mounted on the host (Windows store, hardware
        token, or a cloud signer like SimplySign). Point it at one by thumbprint or subject — these map
        to the <code>OWLLM_SIGN_*</code> variables.
      </div>
      <Row label="Thumbprint" hint="SHA-1 of the cert in the Windows store / on the token.">
        <input style={{ ...INPUT.field, width: "100%" }} value={thumbprint} placeholder="e.g. 8A1C…"
          onChange={(e) => setThumbprint(e.target.value)} />
      </Row>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Row label="Subject (alternative selector)" style={{ flex: "1 1 240px" }}>
          <input style={{ ...INPUT.field, width: "100%" }} value={subject} placeholder="CN=Your Company"
            onChange={(e) => setSubject(e.target.value)} />
        </Row>
        <Row label="Timestamp URL (RFC3161)" style={{ flex: "1 1 200px" }}>
          <input style={{ ...INPUT.field, width: "100%" }} value={tsa} placeholder="http://time.certum.pl"
            onChange={(e) => setTsa(e.target.value)} />
        </Row>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={busy} onClick={save} style={BUTTON.primary}>Save</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

function Row({
  label, hint, children, style,
}: { label: string; hint?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, ...style }}>
      <label style={{ ...TEXT.fg, fontSize: 12, fontWeight: 600 }}>{label}</label>
      {hint && <div style={{ ...TEXT.subtle, fontSize: 11, lineHeight: 1.4 }}>{hint}</div>}
      {children}
    </div>
  );
}

function StatusPill({ ok, okText, offText }: { ok: boolean; okText: string; offText: string }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999,
      background: ok ? "rgba(34,197,94,0.18)" : "rgba(148,163,184,0.18)",
      color: ok ? "var(--ok)" : "var(--fg-muted)",
      border: `1px solid ${ok ? "rgba(34,197,94,0.45)" : "var(--border)"}`,
    }}>{ok ? okText : offText}</span>
  );
}

function StoredDot({ stored }: { stored: boolean }) {
  return (
    <span title={stored ? "stored" : "not stored"} style={{
      width: 9, height: 9, borderRadius: 999, flexShrink: 0,
      background: stored ? "var(--ok)" : "var(--fg-subtle)",
      boxShadow: stored ? "0 0 0 2px rgba(34,197,94,0.25)" : "none",
    }} />
  );
}

function ExpiryChip({ daysLeft, notAfterMs }: { daysLeft: number | null | undefined; notAfterMs: number }) {
  if (!notAfterMs || daysLeft == null) return null;
  const expired = daysLeft < 0;
  const soon = daysLeft <= 30;
  const date = new Date(notAfterMs).toISOString().slice(0, 10);
  const tone = expired ? "error" : soon ? "warn" : "ok";
  const colors: Record<string, { bg: string; fg: string; bd: string }> = {
    error: { bg: "rgba(244,67,54,0.18)", fg: "var(--error)", bd: "rgba(244,67,54,0.45)" },
    warn:  { bg: "rgba(234,179,8,0.18)",  fg: "#eab308",      bd: "rgba(234,179,8,0.45)" },
    ok:    { bg: "rgba(34,197,94,0.15)",  fg: "var(--ok)",    bd: "rgba(34,197,94,0.40)" },
  };
  const c = colors[tone];
  const text = expired ? `Expired ${date}` : `Expires ${date} · ${daysLeft}d`;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999,
      background: c.bg, color: c.fg, border: `1px solid ${c.bd}`,
    }}>{text}</span>
  );
}

function PasswordPrompt({
  title, hint, onCancel, onSubmit,
}: { title: string; hint: string; onCancel: () => void; onSubmit: (pw: string) => void }) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div onClick={onCancel} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        minWidth: 420, maxWidth: 520, ...SURFACE.card, borderRadius: 12, padding: 20,
        display: "flex", flexDirection: "column", gap: 12, boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
      }}>
        <div style={{ ...TEXT.strong, fontSize: 14, fontWeight: 700 }}>{title}</div>
        <div style={{ ...TEXT.muted, fontSize: 11.5, lineHeight: 1.5 }}>{hint}</div>
        <input ref={ref} type={show ? "text" : "password"} value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSubmit(pw); else if (e.key === "Escape") onCancel(); }}
          style={{ ...INPUT.field, fontFamily: "ui-monospace, Menlo, Consolas, monospace" }} />
        <button onClick={() => setShow((s) => !s)} style={{
          background: "transparent", color: "var(--fg-muted)", border: "none",
          textDecoration: "underline", fontSize: 11, cursor: "pointer", alignSelf: "flex-start", padding: 0,
        }}>{show ? "Hide" : "Show"}</button>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={BUTTON.ghost}>Cancel</button>
          <button onClick={() => onSubmit(pw)} style={BUTTON.primary}>Import</button>
        </div>
      </div>
    </div>
  );
}
