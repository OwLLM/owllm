/// BrowserPanel — controller for the agents' NATIVE embedded browser.
///
/// The browser is a real OwLLM-owned WebviewWindow (browser.rs) — the same
/// engine the app ships, not Python/Playwright and not an external Chromium.
/// It opens as its own popup window the user can watch and log into; the agents
/// drive it with the browser_* tools. This panel is the remote + manager:
///   • open a URL / show the window / stop it
///   • Passwords: a local encrypted vault (DPAPI on Windows) the agents autofill
///   • Import: pull saved logins from Chrome / Edge / Brave / Opera (Firefox soon)
///
/// ONE shared component, three mounts: CodePage (side-panel 🌐), AgentsPage
/// (header 🌐), and — via `inline` — the Browser agent's card body. Draggable
/// popup by default; inline drops the floating frame/drag/close and fills its
/// container so the exact same controls live on the agent card (no recode).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type BrowserStatus = { running: boolean; url: string; device: string };
type PageInfo = { url?: string; title?: string; ready?: string };
type CredMeta = { origin: string; username: string; note: string; ts: number };
type Detected = { id: string; name: string; profile: string; count: number; supported: boolean; note: string };

export default function BrowserPanel({ open = false, onClose, inline = false }: { open?: boolean; onClose?: () => void; inline?: boolean }) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [page, setPage] = useState<PageInfo | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"browse" | "pass" | "import">("browse");

  // Passwords
  const [creds, setCreds] = useState<CredMeta[]>([]);
  const [nOrigin, setNOrigin] = useState("");
  const [nUser, setNUser] = useState("");
  const [nPass, setNPass] = useState("");

  // Import
  const [detected, setDetected] = useState<Detected[]>([]);
  const [scanMsg, setScanMsg] = useState("");

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const refreshStatus = async () => {
    try { setStatus(await invoke<BrowserStatus>("browser_status")); } catch { setStatus(null); }
  };
  const refreshPage = async () => {
    try { setPage(JSON.parse(await invoke<string>("browser_view")) as PageInfo); setErr(""); }
    catch (e) { setErr(String(e)); }
  };
  const loadCreds = async () => {
    try { setCreds(await invoke<CredMeta[]>("browser_vault_list")); } catch (e) { setErr(String(e)); }
  };

  useEffect(() => {
    if (!open && !inline) return;
    void refreshStatus();
    void loadCreds();
    const t = window.setInterval(() => { void refreshStatus(); }, 3000);
    return () => window.clearInterval(t);
  }, [open, inline]);

  const navigate = async () => {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true); setErr("");
    try {
      await invoke("browser_ensure");
      await invoke("browser_start");
      await invoke("browser_cmd", { action: "navigate", params: { url: u } });
      await invoke("browser_focus");
      await refreshStatus();
      await refreshPage();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const showWindow = async () => { try { await invoke("browser_start"); await invoke("browser_focus"); await refreshStatus(); } catch (e) { setErr(String(e)); } };
  const setDevice = async (device: string) => {
    if (busy) return;
    setBusy(true); setErr("");
    try { await invoke("browser_set_device", { device }); await refreshStatus(); await refreshPage(); }
    catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { await invoke("browser_stop"); setPage(null); await refreshStatus(); }
    catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  const addCred = async () => {
    if (!nOrigin.trim() || busy) return;
    setBusy(true); setErr("");
    try {
      await invoke("browser_vault_add", { origin: nOrigin.trim(), username: nUser.trim(), password: nPass, note: null });
      setNOrigin(""); setNUser(""); setNPass("");
      await loadCreds();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const delCred = async (c: CredMeta) => {
    try { await invoke("browser_vault_delete", { origin: c.origin, username: c.username }); await loadCreds(); }
    catch (e) { setErr(String(e)); }
  };
  const autofill = async () => {
    setBusy(true); setErr("");
    try { setScanMsg(await invoke<string>("browser_vault_autofill")); }
    catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  const scan = async () => {
    setBusy(true); setErr(""); setScanMsg("");
    try {
      const d = await invoke<Detected[]>("browser_import_scan");
      setDetected(d);
      if (!d.length) setScanMsg("No browsers with saved logins found.");
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const runImport = async (d: Detected) => {
    setBusy(true); setErr(""); setScanMsg("");
    try { setScanMsg(await invoke<string>("browser_import_run", { id: d.id })); await loadCreds(); }
    catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  const onDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input")) return;
    const box = boxRef.current;
    if (!box) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current, b = boxRef.current;
      if (!d || !b) return;
      setPos({
        x: Math.min(Math.max(0, ev.clientX - d.dx), Math.max(0, window.innerWidth - b.offsetWidth)),
        y: Math.min(Math.max(0, ev.clientY - d.dy), Math.max(0, window.innerHeight - b.offsetHeight)),
      });
    };
    const up = () => { dragRef.current = null; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (!open && !inline) return null;
  const tabBtn = (id: typeof tab, label: string) => (
    <button
      onClick={() => { setTab(id); if (id === "import" && !detected.length) void scan(); }}
      style={{
        height: 26, padding: "0 12px", cursor: "pointer", fontSize: 11.5, fontWeight: 600,
        border: "1px solid " + (tab === id ? "rgba(var(--accent-rgb),0.4)" : "var(--border)"),
        borderBottom: "none", borderRadius: "7px 7px 0 0",
        background: tab === id ? "rgba(var(--accent-rgb),0.12)" : "transparent",
        color: tab === id ? "var(--accent)" : "var(--fg-muted)",
      }}
    >{label}</button>
  );
  const field: React.CSSProperties = { flex: 1, height: 26, fontSize: 12, padding: "0 8px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--fg)" };

  return (
    <>
      <style>{`@keyframes owllmBrowserFrameHue { to { filter: hue-rotate(360deg); } }`}</style>
      <div
        ref={boxRef}
        style={inline
          // Inline (Browser agent card): no floating frame — fill the tile.
          ? { flex: 1, minHeight: 0, display: "flex" }
          : {
          position: "fixed", zIndex: 1200,
          // Default 300px up from the bottom-right corner so it doesn't sit on
          // the app's own controls (user spec 2026-07-05).
          ...(pos ? { left: pos.x, top: pos.y } : { right: 24, bottom: 324 }),
          width: 560, maxWidth: "92vw",
          // Psychedelic rainbow frame — the same conic-gradient ring as the
          // Critical Thinker card. The 3px padding shows the gradient, the inner
          // panel covers the centre, and owllmBrowserFrameHue slowly hue-shifts it.
          padding: 3, borderRadius: 15,
          background: "conic-gradient(from 0deg, #ff5e7e, #ffb84c, #ffe14c, #6cff5e, #5ec6ff, #b86cff, #ff5e7e)",
          animation: "owllmBrowserFrameHue 8s linear infinite",
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={inline
          ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg-panel)", overflow: "hidden" }
          : {
          display: "flex", flexDirection: "column", maxHeight: "calc(82vh - 6px)",
          background: "var(--bg-panel)", borderRadius: 12, overflow: "hidden",
        }}>
          <div
            onMouseDown={inline ? undefined : onDragStart}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: inline ? "default" : "move", borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)" }}>🌐 Agent Browser</span>
        <span style={{ fontSize: 11, color: status?.running ? "#7dd87d" : "var(--fg-muted)" }}>
          {status?.running ? "● open" : "○ not open"}
        </span>
        <span style={{ flex: 1 }} />
        {!inline && <button className="ghost-btn" onClick={() => onClose?.()} title="Close this panel (the browser keeps running for the agents)" style={{ height: 24, width: 26, padding: 0, fontSize: 13 }}>✕</button>}
      </div>

      <div style={{ display: "flex", gap: 4, padding: "6px 10px 0" }}>
        {tabBtn("browse", "Browse")}
        {tabBtn("pass", `Passwords${creds.length ? ` (${creds.length})` : ""}`)}
        {tabBtn("import", "Import")}
      </div>

      <div style={{ padding: 10, overflow: "auto", ...(inline ? { flex: 1, minHeight: 0 } : {}) }}>
        {tab === "browse" && (
          <>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void navigate(); }}
                placeholder="open a URL (e.g. github.com) — agents inherit this session" style={field} />
              <button className="btn" disabled={busy} onClick={() => void navigate()} style={{ fontSize: 11, padding: "3px 10px" }}>Go</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button className="btn" disabled={busy} onClick={() => void showWindow()} style={{ fontSize: 11, padding: "3px 10px" }}>Show window</button>
              <button className="btn" disabled={busy || !status?.running} onClick={() => void refreshPage()} style={{ fontSize: 11, padding: "3px 10px" }}>Where am I?</button>
              <button className="btn" disabled={busy || !status?.running} onClick={() => void autofill()} title="Fill this page's login from your saved passwords" style={{ fontSize: 11, padding: "3px 10px" }}>Autofill login</button>
              <span style={{ flex: 1 }} />
              <button className="btn" disabled={busy || !status?.running} onClick={() => void stop()} style={{ fontSize: 11, padding: "3px 10px", color: "#ff8c8c" }}>⏹ Stop</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
              <span style={{ fontSize: 10.5, color: "var(--fg-muted)", fontWeight: 600 }}>DEVICE</span>
              {([["desktop", "🖥 Desktop"], ["iphone", "📱 iPhone"], ["android", "📱 Android"], ["tablet", "📱 Tablet"]] as const).map(([id, label]) => (
                <button key={id} className="btn" disabled={busy} onClick={() => void setDevice(id)}
                  title="Emulate this device: real viewport size + mobile user-agent (page reloads)"
                  style={{
                    fontSize: 10.5, padding: "2px 8px",
                    border: "1px solid " + (status?.device === id ? "rgba(var(--accent-rgb),0.4)" : "var(--border)"),
                    background: status?.device === id ? "rgba(var(--accent-rgb),0.12)" : "transparent",
                    color: status?.device === id ? "var(--accent)" : "var(--fg-muted)",
                  }}>{label}</button>
              ))}
            </div>
            {(page?.url || status?.url) && (
              <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.5, wordBreak: "break-all" }}>
                <div style={{ color: "var(--fg)", fontWeight: 600 }}>{page?.title || "(current page)"}</div>
                {page?.url || status?.url}
              </div>
            )}
            {!status?.running && (
              <div style={{ marginTop: 10, padding: "12px", fontSize: 11.5, color: "var(--fg-muted)", textAlign: "center", border: "1px dashed var(--border)", borderRadius: 8, lineHeight: 1.6 }}>
                The agents' browser is a real window they drive with the browser_* tools
                (open pages, click, type, fill forms). Open a URL above to start it and pre-log into a site — the agents inherit the session.
                Local dev servers work too (localhost:5173 opens as http), and the DEVICE chips preview mobile layouts.
              </div>
            )}
            {scanMsg && <div style={{ marginTop: 8, fontSize: 11, color: "var(--accent)" }}>{scanMsg}</div>}
          </>
        )}

        {tab === "pass" && (
          <>
            <div style={{ fontSize: 11, color: "var(--fg-muted)", marginBottom: 8 }}>
              Saved logins the agents can autofill. Stored encrypted on this device (DPAPI on Windows). Passwords are never shown here.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10 }}>
              {creds.length === 0 && <div style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>No saved passwords yet. Add one below or Import from a browser.</div>}
              {creds.map((c) => (
                <div key={c.origin + c.username} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 7 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: "var(--fg)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.origin}</div>
                    <div style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>{c.username || "(no username)"}{c.note ? ` · ${c.note}` : ""}</div>
                  </div>
                  <button className="ghost-btn" onClick={() => void delCred(c)} title="Delete" style={{ height: 24, width: 26, padding: 0, fontSize: 12, color: "#ff8c8c" }}>🗑</button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <div style={{ fontSize: 10.5, color: "var(--fg-muted)", fontWeight: 600 }}>ADD A LOGIN</div>
              <input value={nOrigin} onChange={(e) => setNOrigin(e.target.value)} placeholder="site (e.g. github.com)" style={field} />
              <input value={nUser} onChange={(e) => setNUser(e.target.value)} placeholder="username / email" style={field} />
              <input value={nPass} onChange={(e) => setNPass(e.target.value)} type="password" placeholder="password" style={field} />
              <button className="btn" disabled={busy || !nOrigin.trim()} onClick={() => void addCred()} style={{ fontSize: 11, padding: "4px 10px", alignSelf: "flex-start" }}>+ Save login</button>
            </div>
          </>
        )}

        {tab === "import" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ flex: 1, fontSize: 11, color: "var(--fg-muted)" }}>Import saved logins from your installed browsers into the vault.</div>
              <button className="btn" disabled={busy} onClick={() => void scan()} style={{ fontSize: 11, padding: "3px 10px" }}>↻ Rescan</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {detected.map((d) => (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 7 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: "var(--fg)", fontWeight: 600 }}>{d.name} <span style={{ color: "var(--fg-muted)", fontWeight: 400 }}>· {d.count} saved</span></div>
                    {!d.supported && <div style={{ fontSize: 10.5, color: "#e0a45a" }}>{d.note}</div>}
                  </div>
                  <button className="btn" disabled={busy || !d.supported || d.count === 0} onClick={() => void runImport(d)} style={{ fontSize: 11, padding: "3px 10px" }}>Import</button>
                </div>
              ))}
              {detected.length === 0 && <div style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>Press Rescan to detect browsers.</div>}
            </div>
            {scanMsg && <div style={{ marginTop: 8, fontSize: 11, color: "var(--accent)" }}>{scanMsg}</div>}
          </>
        )}

        {err && <div style={{ marginTop: 8, fontSize: 11, color: "#ff8c8c", whiteSpace: "pre-wrap" }}>{err}</div>}
      </div>
        </div>
      </div>
    </>
  );
}
