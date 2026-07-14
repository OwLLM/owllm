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
  signingStatus, signingAppleSave, signingAppleImportP12, signingAppleImportCert,
  signingAppleGenCsr, signingWindowsSave,
  signingClear, signingExportEnv, signingPushGithub,
  signingHubStatus, signingPortalOpen,
  type SigningStatus, type AppleStatus, type WindowsStatus, type CsrResult, type HubStatus,
} from "./signing";

type Msg = { tone: "info" | "success" | "error"; text: string } | null;

/** Open a provider portal in the app-styled OwLLM browser (auto-logged-in when
 *  the vault holds the site's login) and surface the outcome. */
async function openPortal(provider: string, setMsg: (m: Msg) => void, url?: string) {
  try { setMsg({ tone: "info", text: await signingPortalOpen(provider, url) }); }
  catch (e) { setMsg({ tone: "error", text: `Couldn't open the portal: ${e}` }); }
}

export default function SigningPage() {
  const [status, setStatus] = useState<SigningStatus | null>(null);
  const [hub, setHub] = useState<HubStatus | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await signingStatus()); }
    catch (e) { setMsg({ tone: "error", text: `Couldn't read signing store: ${e}` }); }
    // Environment probes (cert store / SimplySign / gh / openssl) are separate
    // and slower — never let a probe hiccup blank the credential cards.
    try { setHub(await signingHubStatus()); } catch { /* keep last */ }
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
      <div style={{ maxWidth: 1500, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ ...TEXT.strong, fontSize: 20, fontWeight: 800 }}>🖊 Signing &amp; credentials</div>
          <div style={{ ...TEXT.muted, fontSize: 12.5, lineHeight: 1.55 }}>
            Everything a shipping developer juggles — certificates, signing selectors, portal logins,
            tokens — managed in one place, kept encrypted on this machine. Provider portals open inside
            OwLLM's own browser, already signed in from your saved logins, so "renew the cert" stops
            being an afternoon of password resets.
          </div>
        </header>

        <HubStrip hub={hub} status={status} onRefresh={refresh} />

        {msg && <div style={banner(msg.tone)}>{msg.text}</div>}

        {/* Two full-width, auto-resizing columns: the tall Apple set on the left,
            Windows + Web logins stacked on the right. Collapses to a single
            column on narrow viewports via auto-fit. */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
          gap: 16, alignItems: "start",
        }}>
          <AppleCard apple={status?.apple ?? null} onChange={refresh} setMsg={setMsg} />
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <WindowsCard win={status?.windows ?? null} hub={hub} onChange={refresh} setMsg={setMsg} />
            <WebLoginsCard hub={hub} onChange={refresh} setMsg={setMsg} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Readiness strip — one glance answers "can this machine sign & ship, and what
// is missing?". Live probes, not stored flags.
// ---------------------------------------------------------------------------

function HubStrip({ hub, status, onRefresh }: {
  hub: HubStatus | null; status: SigningStatus | null; onRefresh: () => Promise<void>;
}) {
  const chips: { label: string; tone: "ok" | "warn" | "dim"; title?: string }[] = [];
  const win = status?.windows ?? null;
  if (hub?.certInStore != null) {
    chips.push(hub.certInStore
      ? { label: "Windows cert mounted", tone: "ok", title: hub.certStoreDetail || undefined }
      : { label: "Windows cert NOT in store", tone: "warn", title: "The stored thumbprint isn't mounted right now — plug the token / start SimplySign." });
  } else if (win?.thumbprint) {
    chips.push({ label: "Windows cert: unknown", tone: "dim" });
  }
  if (hub?.simplysignRunning != null) {
    chips.push(hub.simplysignRunning
      ? { label: "SimplySign running", tone: "ok" }
      : { label: "SimplySign not running", tone: "dim", title: "Only needed when your Authenticode cert lives in Certum's cloud." });
  }
  chips.push(status?.apple?.ready
    ? { label: "Apple ready", tone: "ok" }
    : { label: "Apple incomplete", tone: "dim" });
  if (hub) {
    chips.push(hub.opensslOk
      ? { label: "openssl ok", tone: "ok" }
      : { label: "openssl missing", tone: "warn", title: "Needed by the Apple CSR / .cer import flows. On Windows it ships with Git." });
    chips.push(hub.ghInstalled
      ? (hub.ghAccount
        ? { label: `gh: ${hub.ghAccount}`, tone: "ok" }
        : { label: "gh: not logged in", tone: "warn", title: "Run `gh auth login` to enable secret pushing and releases." })
      : { label: "gh CLI missing", tone: "warn" });
    chips.push({ label: `${hub.webLoginCount} web login${hub.webLoginCount === 1 ? "" : "s"}`, tone: hub.webLoginCount ? "ok" : "dim" });
  }
  const tones = {
    ok:   { bg: "rgba(34,197,94,0.15)",   fg: "var(--ok)",       bd: "rgba(34,197,94,0.4)" },
    warn: { bg: "rgba(234,179,8,0.15)",   fg: "#eab308",         bd: "rgba(234,179,8,0.45)" },
    dim:  { bg: "rgba(148,163,184,0.12)", fg: "var(--fg-muted)", bd: "var(--border)" },
  };
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {chips.map((c, i) => {
        const t = tones[c.tone];
        return (
          <span key={i} title={c.title} style={{
            fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999,
            background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
            cursor: c.title ? "help" : "default",
          }}>{c.label}</span>
        );
      })}
      <div style={{ flex: 1 }} />
      <button onClick={() => void onRefresh()} style={{ ...BUTTON.ghost, fontSize: 11, padding: "3px 10px" }}>
        ⟳ Re-check
      </button>
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

  async function pickCertificate() {
    try {
      const path = await invoke<string | null>("pick_file", {
        title: "Choose your certificate (.p12 from Keychain, or the .cer Apple downloads)",
        filters: [["Certificate", ["p12", "pfx", "cer", "cert", "crt", "pem", "der"]]],
      });
      if (!path) return;
      // A .p12/.pfx carries the key and needs its passphrase; the bare
      // .cer/.cert Apple serves has no password — import it directly (paired
      // with the key from "Generate signing request").
      if (/\.(p12|pfx)$/i.test(path)) { setAskP12(path); return; }
      setBusy(true); setMsg(null);
      try {
        await signingAppleImportCert(path);
        await onChange();
        setMsg({ tone: "success", text: "Certificate imported and paired with your key. Fill in the identity/Team ID if they weren't detected, then Save." });
      } catch (e) {
        setMsg({ tone: "error", text: `Import failed: ${e}` });
      } finally { setBusy(false); }
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

      <Row label="Certificate (.p12 or Apple's .cer)"
        hint="A .p12 (Keychain export) carries cert + private key. Apple's portal downloads a bare .cer — import it after generating your signing request below, and OwLLM pairs it with the key it holds.">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StoredDot stored={apple?.hasCertificate ?? false} />
          <span style={{ ...TEXT.muted, fontSize: 12 }}>
            {apple?.hasCertificate ? "Stored on this machine" : "Not stored"}
            {apple?.certSubject ? ` · ${apple.certSubject}` : ""}
          </span>
          <button disabled={busy} onClick={pickCertificate} style={BUTTON.ghost}>Import certificate…</button>
        </div>
      </Row>

      <CsrSection apple={apple} appleId={appleId} identity={identity} busy={busy} setBusy={setBusy} setMsg={setMsg} onChange={onChange} />

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
          <button onClick={() => void openPortal("apple-id", setMsg)} style={BUTTON.ghost}
            title="Opens appleid.apple.com in the OwLLM browser, signed in from your saved login.">
            Get one — Apple ID portal
          </button>
        </div>
      </Row>

      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={busy} onClick={save} style={BUTTON.primary}>Save</button>
        <button disabled={busy || !apple} onClick={clear} style={BUTTON.danger}>Clear</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => void openPortal("apple-dev", setMsg)} style={BUTTON.ghost}
          title="Opens Apple's certificate page in the OwLLM browser, signed in from your saved login.">
          Need a certificate? Open Apple portal
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
// CSR generation — the no-Mac path. Apple's portal only ISSUES a bare .cer;
// the private key lives wherever the signing request was made. Making the
// request here means OwLLM holds the key (encrypted), so the .cer import above
// works on any OS — no Keychain Access required.
// ---------------------------------------------------------------------------

function CsrSection({
  apple, appleId, identity, busy, setBusy, setMsg, onChange,
}: {
  apple: AppleStatus | null; appleId: string; identity: string;
  busy: boolean; setBusy: (b: boolean) => void; setMsg: (m: Msg) => void;
  onChange: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [csr, setCsr] = useState<CsrResult | null>(null);

  async function generate() {
    const cn = name.trim() || identity.trim();
    const em = email.trim() || appleId.trim();
    if (!cn || !em) { setMsg({ tone: "error", text: "Enter your name and e-mail — Apple requires both on the request." }); return; }
    if (apple?.hasPrivateKey && !window.confirm(
      "A signing key already exists here. Generating a new request replaces it — a .cer issued for the OLD request can then no longer be imported. Continue?",
    )) return;
    setBusy(true); setMsg(null);
    try {
      const r = await signingAppleGenCsr(cn, em);
      setCsr(r);
      await onChange();
      setMsg({ tone: "success", text: "Request generated — upload the file below at Apple's portal, then import the .cer it issues." });
    } catch (e) {
      setMsg({ tone: "error", text: `Couldn't generate the request: ${e}` });
    } finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button onClick={() => setOpen((v) => !v)} style={{
        background: "transparent", border: "none", padding: 0, cursor: "pointer",
        color: "var(--fg-muted)", fontSize: 12, fontWeight: 600, textAlign: "left",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        <span>{open ? "▾" : "▸"}</span>
        <StoredDot stored={apple?.hasPrivateKey ?? false} />
        No Mac? Generate the signing request (CSR) here
        {apple?.hasPrivateKey ? <span style={{ ...TEXT.subtle, fontWeight: 500 }}>· key stored — ready for the .cer</span> : null}
      </button>
      {open && (
        <div style={{ ...SURFACE.panel, border: BORDER.subtle, borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ ...TEXT.muted, fontSize: 11.5, lineHeight: 1.5 }}>
            OwLLM creates the private key (kept encrypted on this machine) and a
            <code> .certSigningRequest</code> file. Upload that file at Apple's
            "Create a certificate" page, download the issued <code>.cer</code>, then use
            <b> Import certificate…</b> above — the key and the .cer are combined automatically.
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Row label="Your name" style={{ flex: "1 1 200px" }}>
              <input style={{ ...INPUT.field, width: "100%" }} value={name} placeholder="Name on the request"
                onChange={(e) => setName(e.target.value)} />
            </Row>
            <Row label="E-mail" style={{ flex: "1 1 220px" }}>
              <input style={{ ...INPUT.field, width: "100%" }} value={email} placeholder={appleId || "you@example.com"}
                onChange={(e) => setEmail(e.target.value)} />
            </Row>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button disabled={busy} onClick={generate} style={BUTTON.primary}>Generate request</button>
            <button onClick={() => void openPortal("apple-dev", setMsg)} style={BUTTON.ghost}
              title="Opens Apple's certificate page in the OwLLM browser, signed in from your saved login.">
              Open Apple portal
            </button>
          </div>
          {csr && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ ...TEXT.fg, fontSize: 12 }}>
                Saved to: <code style={{ fontSize: 11 }}>{csr.csrPath}</code>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={BUTTON.ghost} onClick={async () => {
                  try { await navigator.clipboard.writeText(csr.csrPath); setMsg({ tone: "success", text: "Path copied." }); }
                  catch (e) { setMsg({ tone: "error", text: `Copy failed: ${e}` }); }
                }}>Copy path</button>
                <button style={BUTTON.ghost} onClick={async () => {
                  try { await navigator.clipboard.writeText(csr.csrPem); setMsg({ tone: "success", text: "Request PEM copied." }); }
                  catch (e) { setMsg({ tone: "error", text: `Copy failed: ${e}` }); }
                }}>Copy PEM</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Windows Authenticode (selectors; forward-looking companion)
// ---------------------------------------------------------------------------

function WindowsCard({
  win, hub, onChange, setMsg,
}: { win: WindowsStatus | null; hub: HubStatus | null; onChange: () => Promise<void>; setMsg: (m: Msg) => void }) {
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
      {hub?.certInStore != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StoredDot stored={hub.certInStore} />
          <span style={{ ...TEXT.muted, fontSize: 12 }}>
            {hub.certInStore
              ? `Mounted in the store right now${hub.certStoreDetail ? ` · ${hub.certStoreDetail}` : ""}`
              : "Not in the certificate store right now — plug the token, or start SimplySign for a Certum cloud cert."}
            {hub.simplysignRunning != null && ` · SimplySign ${hub.simplysignRunning ? "running" : "not running"}`}
          </span>
        </div>
      )}
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
        <div style={{ flex: 1 }} />
        <button onClick={() => void openPortal("certum", setMsg)} style={BUTTON.ghost}
          title="Opens Certum's panel (SimplySign / cert management) in the OwLLM browser, signed in from your saved login.">
          Open Certum panel
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Web logins — the portal credential pool. Same encrypted vault the agent
// browser autofills from (browser_vault.rs): passwords never reach this page,
// only origin/username. Feeding it is what makes every "Open … portal" button
// above land already signed in.
// ---------------------------------------------------------------------------

type CredMeta = { origin: string; username: string; note: string; ts: number };
type Detected = { id: string; name: string; profile: string; count: number; supported: boolean; note: string };

function WebLoginsCard({
  hub, onChange, setMsg,
}: { hub: HubStatus | null; onChange: () => Promise<void>; setMsg: (m: Msg) => void }) {
  const [creds, setCreds] = useState<CredMeta[]>([]);
  const [origin, setOrigin] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [note, setNote] = useState("");
  const [detected, setDetected] = useState<Detected[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setCreds(await invoke<CredMeta[]>("browser_vault_list")); } catch { /* vault empty/unreadable */ }
  }, []);
  useEffect(() => { void load(); }, [load, hub?.webLoginCount]);

  async function add() {
    if (!origin.trim() || !pass) { setMsg({ tone: "error", text: "A site and a password are required." }); return; }
    setBusy(true);
    try {
      await invoke("browser_vault_add", { origin: origin.trim(), username: user.trim(), password: pass, note: note.trim() || null });
      setOrigin(""); setUser(""); setPass(""); setNote("");
      await load(); await onChange();
      setMsg({ tone: "success", text: "Login saved — portal buttons for this site now open signed in." });
    } catch (e) { setMsg({ tone: "error", text: `Save failed: ${e}` }); }
    finally { setBusy(false); }
  }

  async function remove(c: CredMeta) {
    if (!window.confirm(`Delete the saved login for ${c.origin} (${c.username || "no username"})?`)) return;
    try { await invoke("browser_vault_delete", { origin: c.origin, username: c.username }); await load(); await onChange(); }
    catch (e) { setMsg({ tone: "error", text: `Delete failed: ${e}` }); }
  }

  async function scan() {
    setBusy(true);
    try { setDetected(await invoke<Detected[]>("browser_import_scan")); }
    catch (e) { setMsg({ tone: "error", text: `Scan failed: ${e}` }); }
    finally { setBusy(false); }
  }

  async function importFrom(d: Detected) {
    setBusy(true);
    try {
      const out = await invoke<string>("browser_import_run", { id: d.id });
      setMsg({ tone: "success", text: out });
      await load(); await onChange();
    } catch (e) { setMsg({ tone: "error", text: `Import failed: ${e}` }); }
    finally { setBusy(false); }
  }

  async function importCsv() {
    setBusy(true);
    try {
      const path = await invoke<string | null>("pick_file", {
        title: "Choose a passwords CSV exported from your browser",
        filters: [["CSV", ["csv"]]],
      });
      if (!path) return;
      const out = await invoke<string>("browser_import_csv", { path });
      setMsg({ tone: "success", text: out });
      await load(); await onChange();
    } catch (e) { setMsg({ tone: "error", text: `CSV import failed: ${e}` }); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ ...SURFACE.card, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ ...TEXT.strong, fontSize: 15, fontWeight: 700 }}>🌐 Web logins — portal auto-sign-in</div>
        <StatusPill ok={creds.length > 0} okText={`${creds.length} saved`} offText="None saved" />
      </div>
      <div style={{ ...TEXT.muted, fontSize: 11.5, lineHeight: 1.5 }}>
        Saved logins live encrypted on this machine and are only ever injected straight into the matching
        page inside the OwLLM browser — they never appear here or leave the vault. They power every
        "Open … portal" button on this page, and the agents' browser too.
      </div>

      {creds.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {creds.map((c) => (
            <div key={`${c.origin}|${c.username}`} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "6px 10px",
              ...SURFACE.panel, border: BORDER.subtle, borderRadius: 7,
            }}>
              <span style={{ ...TEXT.fg, fontSize: 12, fontWeight: 600 }}>{c.origin.replace(/^https?:\/\//, "")}</span>
              <span style={{ ...TEXT.muted, fontSize: 12 }}>{c.username}</span>
              {c.note && <span style={{ ...TEXT.subtle, fontSize: 11 }}>· {c.note}</span>}
              <div style={{ flex: 1 }} />
              <button onClick={() => void openPortal("custom", setMsg, c.origin)} style={{ ...BUTTON.ghost, fontSize: 11, padding: "2px 8px" }}
                title="Open this site in the OwLLM browser and sign in.">Open signed-in</button>
              <button onClick={() => void remove(c)} style={{ ...BUTTON.ghost, fontSize: 11, padding: "2px 8px", color: "var(--error)" }}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...INPUT.field, flex: "1 1 170px" }} value={origin} placeholder="site (e.g. developer.apple.com)"
          onChange={(e) => setOrigin(e.target.value)} />
        <input style={{ ...INPUT.field, flex: "1 1 140px" }} value={user} placeholder="username / email"
          onChange={(e) => setUser(e.target.value)} />
        <input type="password" style={{ ...INPUT.field, flex: "1 1 120px" }} value={pass} placeholder="password"
          onChange={(e) => setPass(e.target.value)} />
        <input style={{ ...INPUT.field, flex: "1 1 110px" }} value={note} placeholder="note (optional)"
          onChange={(e) => setNote(e.target.value)} />
        <button disabled={busy} onClick={add} style={BUTTON.primary}>Save login</button>
      </div>

      <div style={{ borderTop: BORDER.subtle, paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ ...TEXT.strong, fontSize: 12.5, fontWeight: 700 }}>Import from your browsers</div>
          <button disabled={busy} onClick={scan} style={{ ...BUTTON.ghost, fontSize: 11, padding: "3px 10px" }}>Scan</button>
          <div style={{ flex: 1 }} />
          <button disabled={busy} onClick={importCsv} style={{ ...BUTTON.ghost, fontSize: 11, padding: "3px 10px" }}
            title="Import a passwords CSV exported from any browser — works around Chrome/Edge 127+ App-Bound Encryption.">Import CSV…</button>
        </div>
        <div style={{ ...TEXT.subtle, fontSize: 11, lineHeight: 1.45 }}>
          Chrome/Edge 127+ protect saved passwords with App-Bound Encryption, so direct import can't read them.
          Export a CSV (browser Settings → Passwords → ⋮ → Export passwords) and use “Import CSV…”.
        </div>
        {detected && detected.length === 0 && (
          <div style={{ ...TEXT.subtle, fontSize: 11.5 }}>No browsers with saved passwords found.</div>
        )}
        {detected && detected.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {detected.map((d) => (
              <button key={d.id} disabled={busy || !d.supported} onClick={() => void importFrom(d)}
                title={d.supported ? `${d.profile} — ${d.count} saved logins` : d.note}
                style={{ ...BUTTON.ghost, fontSize: 11.5 }}>
                {d.name} ({d.count}){d.supported ? "" : " — unsupported"}
              </button>
            ))}
          </div>
        )}
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
