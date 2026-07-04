/// BrowserPanel — the user-facing window onto the agents' web browser.
///
/// The browser itself is an app-global Playwright daemon (browser.rs +
/// resources/tools/browser_daemon.py) that agents drive with the browser_*
/// tools. This panel is a VIEWER + manual remote: see what page the browser
/// is on (live screenshot), navigate it yourself (e.g. to pre-open a site),
/// and stop the daemon. Closing the panel never touches the browser — it is
/// shared by every agent in the app.
///
/// ONE shared component: mounted by CodePage (🌐 button in the side panel) and
/// AgentsPage (header 🌐 button). Draggable popup, same chrome pattern as the
/// Code page terminal popup — floats above THIS app's UI only.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type BrowserStatus = { running: boolean; pid: number | null };

export default function BrowserPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [shot, setShot] = useState<string>("");     // base64 PNG of the live page
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [auto, setAuto] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const refreshStatus = async () => {
    try { setStatus(await invoke<BrowserStatus>("browser_status")); } catch { setStatus(null); }
  };

  const refreshView = async () => {
    try {
      const b64 = await invoke<string>("browser_view");
      setShot(b64);
      setErr("");
    } catch (e) {
      setErr(String(e));
    }
  };

  // Status poll + optional live view poll, only while the panel is open.
  useEffect(() => {
    if (!open) return;
    void refreshStatus();
    const t = window.setInterval(() => { void refreshStatus(); }, 3000);
    return () => window.clearInterval(t);
  }, [open]);
  useEffect(() => {
    if (!open || !auto || !status?.running) return;
    void refreshView();
    const t = window.setInterval(() => { void refreshView(); }, 2500);
    return () => window.clearInterval(t);
  }, [open, auto, status?.running]);

  const navigate = async () => {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true); setErr("");
    try {
      await invoke<string>("browser_ensure");
      await invoke<string>("browser_start");
      const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
      await invoke<string>("browser_cmd", { action: "navigate", params: { url: full } });
      await refreshStatus();
      await refreshView();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try { await invoke<string>("browser_stop"); setShot(""); await refreshStatus(); }
    catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  const onDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input")) return;
    const box = boxRef.current;
    if (!box) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      const b = boxRef.current;
      if (!d || !b) return;
      setPos({
        x: Math.min(Math.max(0, ev.clientX - d.dx), Math.max(0, window.innerWidth - b.offsetWidth)),
        y: Math.min(Math.max(0, ev.clientY - d.dy), Math.max(0, window.innerHeight - b.offsetHeight)),
      });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  if (!open) return null;
  return (
    <div
      ref={boxRef}
      style={{
        position: "fixed", zIndex: 1200,
        ...(pos ? { left: pos.x, top: pos.y } : { right: 24, bottom: 24 }),
        width: 560, maxWidth: "92vw",
        display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border-strong)",
        borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.5)", overflow: "hidden",
      }}
    >
      <div
        onMouseDown={onDragStart}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", cursor: "move", borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--fg)" }}>🌐 Agent Browser</span>
        <span style={{ fontSize: 11, color: status?.running ? "#7dd87d" : "var(--fg-muted)" }}>
          {status?.running ? `● running (pid ${status.pid ?? "?"})` : "○ not running"}
        </span>
        <span style={{ flex: 1 }} />
        <button className="ghost-btn" onClick={onClose} title="Close this panel (the browser keeps running for the agents)" style={{ height: 24, width: 26, padding: 0, fontSize: 13 }}>✕</button>
      </div>
      <div style={{ display: "flex", gap: 6, padding: "7px 10px", alignItems: "center" }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void navigate(); }}
          placeholder="open a URL (e.g. github.com) — agents inherit the session"
          style={{ flex: 1, height: 26, fontSize: 12, padding: "0 8px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--fg)" }}
        />
        <button className="btn" disabled={busy} onClick={() => void navigate()} style={{ fontSize: 11, padding: "3px 10px" }}>Go</button>
        <button className="btn" disabled={busy || !status?.running} onClick={() => void refreshView()} title="Grab a fresh screenshot of the current page" style={{ fontSize: 11, padding: "3px 10px" }}>📸</button>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--fg-muted)", cursor: "pointer" }} title="Refresh the view every ~2.5s while the browser runs">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> live
        </label>
        <button className="btn" disabled={busy || !status?.running} onClick={() => void stop()} title="Stop the browser daemon (logins persist on disk for the next start)" style={{ fontSize: 11, padding: "3px 10px", color: "#ff8c8c" }}>⏹ Stop</button>
      </div>
      {err && <div style={{ padding: "0 10px 6px", fontSize: 11, color: "#ff8c8c", whiteSpace: "pre-wrap" }}>{err}</div>}
      <div style={{ padding: "0 10px 10px" }}>
        {shot ? (
          <img src={`data:image/png;base64,${shot}`} alt="current browser page" style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)", display: "block" }} />
        ) : (
          <div style={{ padding: "22px 12px", fontSize: 11.5, color: "var(--fg-muted)", textAlign: "center", border: "1px dashed var(--border)", borderRadius: 8, lineHeight: 1.6 }}>
            This is the agents' shared web browser — they drive it with the browser_* tools
            (open pages, click, type, screenshot; logins persist across runs).<br />
            Ask an agent to browse, or open a URL above and 📸 to see the page.
          </div>
        )}
      </div>
    </div>
  );
}
