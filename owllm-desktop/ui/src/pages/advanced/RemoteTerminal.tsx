// RemoteTerminal — a live xterm.js terminal bound to an interactive shell on a
// REMOTE OwLLM device (SSH-like). Keystrokes are sealed up via device_session_write;
// output is polled via device_session_read and painted. Everything rides the same
// end-to-end sealed transport (LAN / overlay / relay), so this works off-LAN too.
//
// Deliberately styled magenta + "REMOTE SHELL" so it can never be mistaken for
// the local terminal.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import * as rd from "./remoteDevices";

function b64FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function RemoteTerminal({
  toDevice, deviceName, onClose,
}: {
  toDevice: string;
  deviceName: string;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Consolas, 'Courier New', monospace",
      theme: { background: "#160a1c", foreground: "#e8d6f0" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (hostRef.current) {
      term.open(hostRef.current);
      try { fit.fit(); } catch { /* not laid out yet */ }
    }
    term.writeln(`\x1b[35m● opening remote shell on ${deviceName}…\x1b[0m`);

    const enc = new TextEncoder();
    term.onData((s) => {
      const sess = sessionRef.current;
      if (sess) void rd.sessionWrite(toDevice, sess, b64FromBytes(enc.encode(s))).catch(() => {});
    });

    void (async () => {
      try {
        const r = await rd.sessionOpen(toDevice, null, term.cols, term.rows);
        if (!r.ok || !r.session) {
          term.writeln(`\r\n\x1b[31m✗ ${r.error ?? r.decision} — need the shell permission granted on the target.\x1b[0m`);
          return;
        }
        sessionRef.current = r.session;
        while (aliveRef.current && sessionRef.current) {
          try {
            const rr = await rd.sessionRead(toDevice, sessionRef.current);
            if (rr.data) term.write(bytesFromB64(rr.data));
            if (rr.exited) {
              term.writeln("\r\n\x1b[33m[remote shell exited]\x1b[0m");
              sessionRef.current = null;
              break;
            }
          } catch { /* transient network blip — keep polling */ }
          await new Promise((res) => setTimeout(res, 200));
        }
      } catch (e) {
        term.writeln(`\r\n\x1b[31m✗ ${String(e)}\x1b[0m`);
      }
    })();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const s = sessionRef.current;
        if (s) void rd.sessionResize(toDevice, s, term.cols, term.rows).catch(() => {});
      } catch { /* noop */ }
    });
    if (hostRef.current) ro.observe(hostRef.current);

    return () => {
      aliveRef.current = false;
      ro.disconnect();
      const s = sessionRef.current;
      if (s) void rd.sessionClose(toDevice, s).catch(() => {});
      term.dispose();
    };
  }, [toDevice, deviceName]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: "#fff", background: "#c04bd6", padding: "1px 8px", borderRadius: 6 }}>REMOTE SHELL</span>
        <span style={{ fontSize: 12, color: "var(--fg)" }}>{deviceName}</span>
        <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>a real shell on the remote machine — type into it</span>
        <span style={{ flex: 1 }} />
        <button className="ghost-btn" onClick={onClose} style={{ fontSize: 11, padding: "2px 10px", color: "var(--error)" }}>✕ Close</button>
      </div>
      <div ref={hostRef} style={{ height: 340, border: "2px solid #c04bd6", borderRadius: 8, background: "#160a1c", padding: 4, overflow: "hidden" }} />
    </div>
  );
}
