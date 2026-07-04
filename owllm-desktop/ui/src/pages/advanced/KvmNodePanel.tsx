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

export default function KvmNodePanel() {
  const [status, setStatus] = useState<KvmStatus | null>(null);
  const [newHost, setNewHost] = useState("");
  const [err, setErr] = useState("");

  const reload = async () => {
    try { setStatus(await invoke<KvmStatus>("kvm_node_status")); setErr(""); }
    catch (e) { setErr(String(e)); }
  };
  useEffect(() => { void reload(); }, []);

  const setEnabled = async (enabled: boolean) => {
    try { await invoke("kvm_node_set_enabled", { enabled }); await reload(); }
    catch (e) { setErr(String(e)); }
  };
  const consent = async (host: string, grant: boolean) => {
    try { await invoke("kvm_node_consent", { host, grant }); setNewHost(""); await reload(); }
    catch (e) { setErr(String(e)); }
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "10px 14px", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>🖥🔌 OWLLM Node — KVM remote control</span>
        <span style={{ fontSize: 11, color: "var(--fg-muted)", flex: 1 }}>
          let agents see + operate a remote computer through a NanoKVM/PiKVM (kvm_node tool)
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: status?.enabled ? "var(--accent)" : "var(--fg-muted)" }}>
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={status?.envOverride}
            onChange={(e) => void setEnabled(e.target.checked)}
          />
          {status?.enabled ? "enabled" : "disabled"}
          {status?.envOverride && <span title="Forced on by the OWLLM_KVM_NODE environment variable — the toggle is bypassed."> (env)</span>}
        </label>
      </div>
      {status?.enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            Consented hosts — agents may INJECT (type/keys/mouse/power/mount) only into devices listed here.
            Screenshots work for any reachable device. Every action lands in a redacted audit log (kvm_audit.jsonl).
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {(status.hosts.length === 0) && <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>none yet</span>}
            {status.hosts.map((h) => (
              <span key={h} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, padding: "2px 8px", border: "1px solid var(--border-strong)", borderRadius: 12, color: "var(--fg)" }}>
                {h}
                <button className="ghost-btn" onClick={() => void consent(h, false)} title="Revoke consent for this host" style={{ height: 16, width: 16, padding: 0, fontSize: 10, color: "#ff8c8c" }}>✕</button>
              </span>
            ))}
            <input
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newHost.trim()) void consent(newHost.trim(), true); }}
              placeholder="device IP / hostname"
              style={{ height: 24, fontSize: 11.5, padding: "0 8px", width: 160, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--fg)" }}
            />
            <button className="btn" disabled={!newHost.trim()} onClick={() => void consent(newHost.trim(), true)} style={{ fontSize: 11, padding: "2px 10px" }}>+ Allow</button>
          </div>
        </div>
      )}
      {err && <span style={{ fontSize: 11, color: "#ff8c8c" }}>{err}</span>}
    </div>
  );
}
