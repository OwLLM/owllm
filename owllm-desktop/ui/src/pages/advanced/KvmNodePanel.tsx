/// KvmNodePanel — user-facing switchboard for OWLLM Node (agents driving a
/// remote computer through a NanoKVM/PiKVM device with the kvm_node tool).
///
/// The capability ships DISABLED. This panel is the opt-in: a master toggle
/// (persisted in kvm_consent.json, same file the consent gate reads) plus the
/// per-host consent allowlist — injection actions (type/keys/mouse/power)
/// are refused for any host not granted here, fail-closed. Screenshots (the
/// read-only "eyes") work for any reachable device once the feature is on.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type KvmStatus = { enabled: boolean; envOverride: boolean; hosts: string[] };
type KvmNode = { host: string; username: string; port?: number; transport: string; hasPassword: boolean };

export default function KvmNodePanel() {
  const [status, setStatus] = useState<KvmStatus | null>(null);
  const [newHost, setNewHost] = useState("");
  const [err, setErr] = useState("");
  // Saved-node credential store (kvm_nodes.json, password DPAPI-encrypted).
  // Agents' kvm_node_exec autofills host/port/login from here — without it the
  // model had to guess the device's IP, port, and web-UI password.
  const [nodes, setNodes] = useState<KvmNode[]>([]);
  const [nHost, setNHost] = useState("");
  const [nUser, setNUser] = useState("");
  const [nPass, setNPass] = useState("");
  const [nPort, setNPort] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    try { setStatus(await invoke<KvmStatus>("kvm_node_status")); setErr(""); }
    catch (e) { setErr(String(e)); }
    try { setNodes(((await invoke<{ nodes: KvmNode[] }>("kvm_node_list")).nodes) ?? []); }
    catch { /* list is best-effort; the status error above already surfaces */ }
  };
  useEffect(() => { void reload(); }, []);

  const saveNode = async () => {
    const host = nHost.trim();
    if (!host) return;
    setSaving(true);
    try {
      await invoke("kvm_node_save", {
        host,
        username: nUser.trim() || null,
        password: nPass, // empty = keep existing (Rust-side rule)
        port: nPort.trim() ? Number(nPort.trim()) : null,
        transport: null,
        sshKeyPath: null,
      });
      setNHost(""); setNUser(""); setNPass(""); setNPort("");
      await reload();
    } catch (e) { setErr(String(e)); }
    finally { setSaving(false); }
  };
  const deleteNode = async (host: string) => {
    try { await invoke("kvm_node_delete", { host }); await reload(); }
    catch (e) { setErr(String(e)); }
  };

  const setEnabled = async (enabled: boolean) => {
    try { await invoke("kvm_node_set_enabled", { enabled }); await reload(); }
    catch (e) { setErr(String(e)); }
  };
  const consent = async (host: string, grant: boolean) => {
    try { await invoke("kvm_node_consent", { host, grant }); setNewHost(""); await reload(); }
    catch (e) { setErr(String(e)); }
  };

  return (
    <section
      data-ui="DevicesKvmSection"
      style={{
        border: "1px solid rgba(var(--accent-rgb),0.55)",
        borderRadius: 14,
        padding: 14,
        background: "linear-gradient(135deg, rgba(var(--accent-rgb),0.11), var(--bg-panel) 42%)",
        boxShadow: status?.enabled ? "0 0 22px rgba(var(--accent-rgb),0.09)" : "none",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div
          aria-hidden="true"
          style={{
            width: 42,
            height: 42,
            borderRadius: 11,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            fontSize: 21,
            background: "rgba(var(--accent-rgb),0.17)",
            border: "1px solid rgba(var(--accent-rgb),0.45)",
          }}
        >
          🖥️
        </div>
        <div style={{ minWidth: 210, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: "var(--fg-strong)" }}>OWLLM Node</span>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.7, color: "var(--accent-ink)", border: "1px solid rgba(var(--accent-rgb),0.55)", borderRadius: 6, padding: "1px 6px" }}>
              Hardware KVM
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--fg-muted)", marginTop: 3, lineHeight: 1.45 }}>
            Give agents secure eyes and hands on a remote computer through a NanoKVM or PiKVM.
          </div>
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 34,
            padding: "0 11px",
            borderRadius: 18,
            border: `1px solid ${status?.enabled ? "var(--accent-strong)" : "var(--border-strong)"}`,
            background: status?.enabled ? "rgba(var(--accent-rgb),0.14)" : "var(--bg-elevated)",
            color: status?.enabled ? "var(--accent-ink)" : "var(--fg-muted)",
            fontSize: 12,
            fontWeight: 750,
            cursor: status?.envOverride ? "default" : "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={status?.envOverride}
            onChange={(e) => void setEnabled(e.target.checked)}
          />
          {status?.enabled ? "Enabled" : "Disabled"}
          {status?.envOverride && <span title="Forced on by the OWLLM_KVM_NODE environment variable — the toggle is bypassed.">ENV</span>}
        </label>
      </div>
      {status?.enabled && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(310px, 1fr))", gap: 10 }}>
          <div data-ui="KvmAllowedHosts" style={subCardStyle}>
            <div style={subTitleStyle}><span aria-hidden="true">🛡️</span> Allowed KVM hosts</div>
            <span style={helpStyle}>
              Agents may type, press keys, use the mouse, or power-control only the hosts allowed here. Screenshots remain read-only.
            </span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {status.hosts.length === 0 && <span style={emptyStyle}>No hosts allowed yet</span>}
              {status.hosts.map((h) => (
                <span key={h} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, padding: "3px 8px", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: 12, color: "var(--fg)" }}>
                  <span aria-hidden="true" style={{ color: "var(--ok)" }}>●</span>{h}
                  <button className="ghost-btn" onClick={() => void consent(h, false)} title="Revoke consent for this host" style={{ height: 17, width: 17, padding: 0, fontSize: 10, color: "var(--error)" }}>✕</button>
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", marginTop: "auto" }}>
              <input
                value={newHost}
                onChange={(e) => setNewHost(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newHost.trim()) void consent(newHost.trim(), true); }}
                placeholder="KVM IP or hostname"
                style={{ ...fieldStyle, flex: "1 1 180px" }}
              />
              <button className="btn" disabled={!newHost.trim()} onClick={() => void consent(newHost.trim(), true)} style={primaryButtonStyle}>+ Allow host</button>
            </div>
          </div>

          <div data-ui="KvmSavedNodes" style={subCardStyle}>
            <div style={subTitleStyle}><span aria-hidden="true">🔐</span> Saved KVM nodes</div>
            <span style={helpStyle}>
              Save connection details once so screenshots and controls work without guessing. Passwords stay encrypted on this PC.
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {nodes.length === 0 && <span style={emptyStyle}>No KVM nodes saved yet</span>}
              {nodes.map((n) => (
                <div key={n.host} style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", fontSize: 11.5, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-elevated)", color: "var(--fg)" }}>
                  <span aria-hidden="true">🖥️</span>
                  <span style={{ fontWeight: 750 }}>{n.host}{n.port != null ? `:${n.port}` : ""}</span>
                  <span style={{ color: "var(--fg-muted)" }}>{n.username || "no username"}</span>
                  <span style={{ color: n.hasPassword ? "var(--ok)" : "var(--warn)" }}>{n.hasPassword ? "Password saved" : "Password missing"}</span>
                  <span style={{ flex: 1 }} />
                  <button className="ghost-btn" onClick={() => { setNHost(n.host); setNUser(n.username); setNPort(n.port != null ? String(n.port) : ""); setNPass(""); }} title="Load into the form to update; leave password blank to keep it" style={{ height: 22, padding: "0 7px", fontSize: 10.5 }}>Edit</button>
                  <button className="ghost-btn" onClick={() => void deleteNode(n.host)} title="Remove this saved Node" style={{ height: 22, width: 22, padding: 0, fontSize: 10, color: "var(--error)" }}>✕</button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: "auto" }}>
              <input value={nHost} onChange={(e) => setNHost(e.target.value)} placeholder="IP / hostname" style={{ ...fieldStyle, flex: "1 1 135px" }} />
              <input value={nUser} onChange={(e) => setNUser(e.target.value)} placeholder="username" style={{ ...fieldStyle, flex: "1 1 110px" }} />
              <input value={nPass} onChange={(e) => setNPass(e.target.value)} type="password" placeholder="password" style={{ ...fieldStyle, flex: "1 1 110px" }} />
              <input value={nPort} onChange={(e) => setNPort(e.target.value.replace(/[^0-9]/g, ""))} placeholder="port" style={{ ...fieldStyle, flex: "0 1 82px" }} />
              <button className="btn" disabled={!nHost.trim() || saving} onClick={() => void saveNode()} style={primaryButtonStyle}>{saving ? "Saving…" : "Save Node"}</button>
            </div>
          </div>
        </div>
      )}
      {err && <div role="alert" style={{ fontSize: 11.5, color: "var(--error)", border: "1px solid var(--error)", borderRadius: 8, padding: "6px 9px", background: "rgba(255,80,80,0.08)" }}>{err}</div>}
    </section>
  );
}

const subCardStyle: React.CSSProperties = {
  minWidth: 0,
  minHeight: 150,
  padding: 11,
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "rgba(var(--accent-rgb),0.035)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const subTitleStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontSize: 12.5,
  fontWeight: 800,
  color: "var(--fg-strong)",
};

const helpStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.45,
  color: "var(--fg-muted)",
};

const emptyStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: "var(--fg-muted)",
  fontStyle: "italic",
};

const fieldStyle: React.CSSProperties = {
  minWidth: 0,
  height: 28,
  padding: "0 8px",
  fontSize: 11.5,
  color: "var(--fg)",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 7,
};

const primaryButtonStyle: React.CSSProperties = {
  minHeight: 28,
  padding: "3px 11px",
  fontSize: 11,
  fontWeight: 750,
  whiteSpace: "nowrap",
};
