// DevicesPage — OwLLM Remote Devices / Fleet Control.
//
// Secure remote control of one OwLLM install from another. The permission to
// control a machine is a paired, cryptographic device key — NOT a GitHub login.
// See docs/REMOTE_DEVICES.md. This page surfaces: this device's identity, the
// known-device registry, the trust/pairing flow (with an UNMISTAKABLE approval
// prompt), the four permission toggles, a VISIBLY-DISTINCT remote console
// (diagnostics / shell / "Run in WSL"), the "being controlled" banner + an
// emergency Stop, and the redacted audit trail.
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import LogBox from "../../components/LogBox";
import * as rd from "./remoteDevices";
import type {
  CommandKind,
  ControlState,
  DeviceIdentity,
  DeviceRecord,
  PermissionPolicy,
  TrustedController,
} from "./remoteDevices";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type AuditRow = {
  ts?: string;
  dir?: string;
  kind?: string;
  decision?: string;
  ok?: boolean;
  command?: string;
  error?: string | null;
};

const POLICY_LABELS: Array<{ key: keyof PermissionPolicy; label: string; danger?: boolean }> = [
  { key: "allow_shell", label: "Shell commands" },
  { key: "allow_wsl", label: "WSL commands" },
  { key: "allow_file_writes", label: "File writes", danger: true },
  { key: "allow_admin", label: "Admin / system", danger: true },
];

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function relativeSeen(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function isOnline(d: DeviceRecord): boolean {
  if (d.is_self) return true;
  if (!d.last_seen) return false;
  const t = Date.parse(d.last_seen);
  return !Number.isNaN(t) && Date.now() - t < 5 * 60 * 1000;
}

export default function DevicesPage() {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [trusted, setTrusted] = useState<TrustedController[]>([]);
  const [control, setControl] = useState<ControlState>({ active: false, sessions: [] });
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [err, setErr] = useState("");

  // Console state.
  const [target, setTarget] = useState<string>("");
  const [kind, setKind] = useState<CommandKind>("diagnostics");
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [consoleLines, setConsoleLines] = useState<string[]>([]);

  const [nameDraft, setNameDraft] = useState("");
  const [selftestMsg, setSelftestMsg] = useState("");

  const guard = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
      setErr("");
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  const reload = useCallback(async () => {
    if (!isTauri) return;
    const [id, devs, tr, ctl, au] = await Promise.all([
      rd.getIdentity(),
      rd.listDevices(),
      rd.listTrusted(),
      rd.controlState(),
      rd.auditTail(200),
    ]);
    setIdentity(id);
    setDevices(devs);
    setTrusted(tr);
    setControl(ctl);
    setAudit((au as AuditRow[]) ?? []);
    setNameDraft((prev) => (prev === "" ? id.name : prev));
    setTarget((prev) => (prev === "" ? id.device_id : prev));
  }, []);

  useEffect(() => {
    void guard(reload);
  }, [guard, reload]);

  // Live "being controlled" updates.
  useEffect(() => {
    if (!isTauri) return;
    let un: (() => void) | undefined;
    void (async () => {
      un = await listen<ControlState>("remote-devices:control", (ev) => {
        setControl(ev.payload);
        // Refresh the audit tail whenever a session ends.
        if (!ev.payload.active) void rd.auditTail(200).then((a) => setAudit((a as AuditRow[]) ?? []));
      });
    })();
    return () => un?.();
  }, []);

  const pending = trusted.filter((t) => t.state === "pending");
  const trustedActive = trusted.filter((t) => t.state === "trusted");
  const revoked = trusted.filter((t) => t.state === "revoked");
  const targetDevice = devices.find((d) => d.device_id === target);
  const wslDisabled = kind === "wsl" && !!targetDevice && !targetDevice.capabilities.wsl;

  const runCommand = () =>
    guard(async () => {
      if (!identity) return;
      setRunning(true);
      const stamp = new Date().toLocaleTimeString();
      const label = targetDevice?.name ?? shortId(target);
      setConsoleLines((l) => [...l, `\n$ [${stamp}] ${kind}${command ? " " + command : ""} → ${label}`]);
      try {
        const res = await rd.sendCommand(target, kind, command, 60_000);
        const head = res.ok ? "[ok]" : `[${res.decision}]`;
        const body = [res.stdout, res.stderr, res.error ? `error: ${res.error}` : ""]
          .filter(Boolean)
          .join("\n");
        setConsoleLines((l) => [...l, `${head} (${res.duration_ms}ms)`, body].filter(Boolean));
      } finally {
        setRunning(false);
        await rd.auditTail(200).then((a) => setAudit((a as AuditRow[]) ?? []));
      }
    });

  const stopAll = () =>
    guard(async () => {
      const r = await rd.stopRemoteControl();
      setConsoleLines((l) => [...l, `⛔ Stop remote control — cancelled ${r.cancelled} session(s)`]);
      await reload();
    });

  const runSelfTest = () =>
    guard(async () => {
      setSelftestMsg("running…");
      const r = await rd.selfTest();
      setSelftestMsg(
        `${r.ok ? "✅ passed" : "❌ failed"} — sealed:${r.sealed_opaque ? "opaque" : "LEAK"} · ` +
          `signature:${r.signature_verified ? "verified" : "BAD"} · decision:${r.decision}`,
      );
    });

  if (!isTauri) {
    return (
      <div style={{ padding: 20, color: "var(--fg-muted)" }}>
        Remote Devices requires the desktop app (Tauri) runtime.
      </div>
    );
  }

  return (
    <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 14, overflow: "auto", height: "100%" }}>
      <Header identity={identity} onToggle={(on) => guard(async () => { await rd.setEnabled(on); await reload(); })} />

      {control.active && (
        <ControlledBanner state={control} onStop={stopAll} />
      )}

      {err && (
        <div style={{ fontSize: 12, color: "var(--error)", border: "1px solid var(--error)", borderRadius: 8, padding: "6px 10px", background: "rgba(255,80,80,0.08)" }}>
          {err}
        </div>
      )}

      {/* Pairing requests — the unmistakable approval prompt. */}
      {pending.length > 0 && (
        <section style={{ border: "2px solid var(--warn)", borderRadius: 12, padding: 14, background: "rgba(255,180,40,0.10)", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "var(--fg-strong)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 18 }}>🔐</span> Pairing request — approval required
          </div>
          {pending.map((c) => (
            <div key={c.device_id} style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--warn)", borderRadius: 8, padding: 10, background: "var(--bg-card)" }}>
              <div style={{ fontSize: 13, color: "var(--fg)" }}>
                <b>{c.name}</b> wants to control this machine.
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-muted)", fontFamily: "monospace" }}>
                device {shortId(c.device_id)} · key {shortId(c.ed25519_pub)}
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                Approving grants <b>read-only diagnostics only</b>. Widen permissions below afterward.
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button className="btn" onClick={() => guard(async () => { await rd.approvePairing(c.device_id, rd.READ_ONLY_POLICY); await reload(); })}
                  style={{ background: "var(--ok)", color: "#00110a", fontWeight: 700, padding: "4px 14px" }}>
                  ✓ Approve (read-only)
                </button>
                <button className="ghost-btn" onClick={() => guard(async () => { await rd.denyPairing(c.device_id); await reload(); })}
                  style={{ color: "var(--error)" }}>
                  ✕ Deny
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* My device + registry */}
      <section style={{ display: "grid", gridTemplateColumns: "minmax(280px, 1fr) minmax(320px, 1.4fr)", gap: 14 }}>
        <MyDeviceCard
          identity={identity}
          nameDraft={nameDraft}
          setNameDraft={setNameDraft}
          onRename={() => guard(async () => { await rd.setDeviceName(nameDraft); await reload(); })}
          onSelfTest={runSelfTest}
          selftestMsg={selftestMsg}
        />
        <DeviceList
          devices={devices}
          onPair={(id) => guard(async () => { await rd.requestPairing(id); await reload(); })}
          onForget={(id) => guard(async () => { await rd.forgetDevice(id); await reload(); })}
          trusted={trusted}
        />
      </section>

      {/* Trusted controllers + permission toggles */}
      {(trustedActive.length > 0 || revoked.length > 0) && (
        <TrustedControllers
          trusted={trustedActive}
          revoked={revoked}
          onToggle={(id, policy) => guard(async () => { await rd.setPolicy(id, policy); await reload(); })}
          onRevoke={(id) => guard(async () => { await rd.revokeTrust(id); await reload(); })}
          onRemove={(id) => guard(async () => { await rd.removeTrust(id); await reload(); })}
        />
      )}

      {/* Remote console — deliberately styled unlike the local terminal */}
      <RemoteConsole
        devices={devices}
        target={target}
        setTarget={setTarget}
        kind={kind}
        setKind={setKind}
        command={command}
        setCommand={setCommand}
        running={running}
        onRun={runCommand}
        onStop={stopAll}
        lines={consoleLines}
        onClear={() => setConsoleLines([])}
        wslDisabled={wslDisabled}
      />

      {/* Audit trail */}
      <AuditView rows={audit} />
    </div>
  );
}

function Header({ identity, onToggle }: { identity: DeviceIdentity | null; onToggle: (on: boolean) => void }) {
  const enabled = identity?.enabled ?? false;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: "var(--fg-strong)" }}>🖥 Remote Devices</span>
        <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>
          Control your other OwLLM machines. Pairing + a cryptographic device key are required — a GitHub login alone never grants control.
        </span>
      </div>
      <span style={{ flex: 1 }} />
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: identity?.env_override ? "default" : "pointer", color: enabled ? "var(--accent)" : "var(--fg-muted)" }}>
        <input type="checkbox" checked={enabled} disabled={identity?.env_override} onChange={(e) => onToggle(e.target.checked)} />
        {enabled ? "enabled" : "disabled"}
        {identity?.env_override && <span title="Forced on by OWLLM_REMOTE_DEVICES."> (env)</span>}
      </label>
    </div>
  );
}

function ControlledBanner({ state, onStop }: { state: ControlState; onStop: () => void }) {
  return (
    <div style={{ border: "2px solid var(--error)", borderRadius: 12, padding: "10px 14px", background: "rgba(255,60,60,0.12)", display: "flex", alignItems: "center", gap: 12, animation: "pulse 1.6s ease-in-out infinite" }}>
      <span style={{ fontSize: 20 }}>🛑</span>
      <div style={{ flex: 1, fontSize: 13, color: "var(--fg-strong)" }}>
        <b>This machine is being controlled remotely.</b>{" "}
        {state.sessions.map((s) => `${s.controller_name} · ${s.kind}`).join("  |  ")}
      </div>
      <button className="btn" onClick={onStop} style={{ background: "var(--error)", color: "#fff", fontWeight: 800, padding: "6px 16px" }}>
        Stop remote control
      </button>
    </div>
  );
}

function MyDeviceCard({
  identity, nameDraft, setNameDraft, onRename, onSelfTest, selftestMsg,
}: {
  identity: DeviceIdentity | null;
  nameDraft: string;
  setNameDraft: (s: string) => void;
  onRename: () => void;
  onSelfTest: () => void;
  selftestMsg: string;
}) {
  if (!identity) return <div style={cardStyle}>loading…</div>;
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>This device</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} style={inputStyle} />
        <button className="ghost-btn" onClick={onRename} disabled={nameDraft.trim() === "" || nameDraft === identity.name} style={{ fontSize: 11, padding: "2px 8px" }}>
          Rename
        </button>
      </div>
      <Row k="Device ID" v={shortId(identity.device_id)} mono />
      <Row k="OS" v={`${identity.os} · ${identity.arch}`} />
      <Row k="OwLLM" v={identity.app_version} />
      <Row k="GitHub" v={identity.github_login ?? "not signed in"} />
      <Row k="WSL" v={identity.capabilities.wsl ? "available" : "n/a"} />
      <Row k="Signing key" v={shortId(identity.ed25519_pub)} mono />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
        <button className="ghost-btn" onClick={onSelfTest} style={{ fontSize: 11.5, padding: "3px 10px" }}>
          🔬 Run secure self-test
        </button>
        {selftestMsg && <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{selftestMsg}</span>}
      </div>
    </div>
  );
}

function DeviceList({
  devices, onPair, onForget, trusted,
}: {
  devices: DeviceRecord[];
  onPair: (id: string) => void;
  onForget: (id: string) => void;
  trusted: TrustedController[];
}) {
  const trustState = (id: string) => trusted.find((t) => t.device_id === id)?.state;
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>My OwLLM Devices</div>
      {devices.map((d) => {
        const online = isOnline(d);
        const ts = trustState(d.device_id);
        return (
          <div key={d.device_id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-card)" }}>
            <span className="status-dot" style={{ background: online ? "var(--ok)" : "var(--fg-subtle)", width: 8, height: 8, borderRadius: 4 }} />
            <span style={{ fontWeight: 700, color: "var(--fg)" }}>{d.name}</span>
            {d.is_self && <span style={badge("var(--accent)")}>this PC</span>}
            {ts === "trusted" && <span style={badge("var(--ok)")}>trusted</span>}
            {ts === "pending" && <span style={badge("var(--warn)")}>pending</span>}
            {ts === "revoked" && <span style={badge("var(--error)")}>revoked</span>}
            <span style={{ color: "var(--fg-muted)" }}>{d.os}</span>
            <span style={{ color: "var(--fg-subtle)" }}>v{d.app_version}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10.5, color: "var(--fg-subtle)" }}>{online ? "online" : relativeSeen(d.last_seen)}</span>
            {d.is_self ? (
              <button className="ghost-btn" onClick={() => onPair(d.device_id)} title="Simulate a pairing request (v1 loopback) to drive the approve→control flow" style={{ fontSize: 10.5, padding: "1px 6px" }}>
                Pair (self-test)
              </button>
            ) : (
              <button className="ghost-btn" onClick={() => onForget(d.device_id)} title="Remove from registry" style={{ fontSize: 10.5, padding: "1px 6px", color: "var(--error)" }}>
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TrustedControllers({
  trusted, revoked, onToggle, onRevoke, onRemove,
}: {
  trusted: TrustedController[];
  revoked: TrustedController[];
  onToggle: (id: string, policy: PermissionPolicy) => void;
  onRevoke: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <section style={cardStyle}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>Trusted controllers &amp; permissions</div>
      {trusted.length === 0 && <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>none yet</span>}
      {trusted.map((c) => (
        <div key={c.device_id} style={{ border: "1px solid var(--ok)", borderRadius: 8, padding: 10, background: "var(--bg-card)", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 12.5, color: "var(--fg)" }}>{c.name}</span>
            <span style={{ fontSize: 10.5, color: "var(--fg-subtle)", fontFamily: "monospace" }}>{shortId(c.device_id)}</span>
            <span style={{ flex: 1 }} />
            <button className="ghost-btn" onClick={() => onRevoke(c.device_id)} style={{ fontSize: 10.5, padding: "1px 8px", color: "var(--error)" }}>Revoke</button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {POLICY_LABELS.map(({ key, label, danger }) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, cursor: "pointer", color: danger ? "var(--warn)" : "var(--fg)" }}>
                <input type="checkbox" checked={c.policy[key]} onChange={(e) => onToggle(c.device_id, { ...c.policy, [key]: e.target.checked })} />
                {label}{danger && " ⚠"}
              </label>
            ))}
          </div>
          <span style={{ fontSize: 10.5, color: "var(--fg-subtle)" }}>
            Default is read-only diagnostics. File writes &amp; admin also require a per-action approval on this machine (not executable in v1).
          </span>
        </div>
      ))}
      {revoked.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>Revoked</div>
          {revoked.map((c) => (
            <div key={c.device_id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, padding: "3px 6px" }}>
              <span style={{ color: "var(--fg-muted)" }}>{c.name}</span>
              <span style={{ fontFamily: "monospace", color: "var(--fg-subtle)" }}>{shortId(c.device_id)}</span>
              <span style={{ flex: 1 }} />
              <button className="ghost-btn" onClick={() => onRemove(c.device_id)} style={{ fontSize: 10, padding: "1px 6px" }}>forget</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RemoteConsole({
  devices, target, setTarget, kind, setKind, command, setCommand, running, onRun, onStop, lines, onClear, wslDisabled,
}: {
  devices: DeviceRecord[];
  target: string;
  setTarget: (s: string) => void;
  kind: CommandKind;
  setKind: (k: CommandKind) => void;
  command: string;
  setCommand: (s: string) => void;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
  lines: string[];
  onClear: () => void;
  wslDisabled: boolean;
}) {
  const needsCommand = kind === "shell" || kind === "wsl";
  return (
    // Distinct from the local terminal: magenta "remote" chrome + a REMOTE badge.
    <section style={{ border: "2px solid #c04bd6", borderRadius: 12, background: "rgba(192,75,214,0.06)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, color: "#fff", background: "#c04bd6", padding: "1px 8px", borderRadius: 6 }}>REMOTE</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>Remote console</span>
        <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>runs on the selected device, not this one</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={target} onChange={(e) => setTarget(e.target.value)} style={selectStyle}>
          {devices.map((d) => (
            <option key={d.device_id} value={d.device_id}>{d.name}{d.is_self ? " (this PC)" : ""}</option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as CommandKind)} style={selectStyle}>
          <option value="diagnostics">Diagnostics (read-only)</option>
          <option value="shell">Shell</option>
          <option value="wsl">Run in WSL</option>
        </select>
        {needsCommand && (
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !running) onRun(); }}
            placeholder={kind === "wsl" ? "uname -a" : "whoami"}
            style={{ ...inputStyle, flex: 1, minWidth: 160, fontFamily: "monospace" }}
          />
        )}
        <button className="btn" onClick={onRun} disabled={running || wslDisabled || (needsCommand && command.trim() === "")} style={{ padding: "3px 14px", fontWeight: 700 }}>
          {running ? "Running…" : "▶ Run"}
        </button>
        <button className="ghost-btn" onClick={onStop} title="Emergency stop — cancel every in-flight remote command" style={{ padding: "3px 10px", color: "var(--error)" }}>
          ⛔ Stop
        </button>
        <button className="ghost-btn" onClick={onClear} style={{ padding: "3px 8px", fontSize: 11 }}>clear</button>
      </div>
      {wslDisabled && <span style={{ fontSize: 11, color: "var(--warn)" }}>The selected device does not report WSL — pick another target or a different mode.</span>}
      <LogBox lines={lines.length ? lines : ["(remote output appears here)"]} height={200} title="Remote console" />
    </section>
  );
}

function AuditView({ rows }: { rows: AuditRow[] }) {
  const lines = rows.map((r) => {
    const ok = r.ok ? "ok " : "DENY";
    const arrow = r.dir === "outbound" ? "→" : "←";
    const cmd = r.command ? ` ${r.command}` : "";
    const errPart = r.error ? `  !${r.error}` : "";
    return `${(r.ts ?? "").replace("T", " ").slice(0, 19)}  ${arrow} ${ok}  ${r.kind ?? "?"}/${r.decision ?? "?"}${cmd}${errPart}`;
  });
  return (
    <section style={cardStyle}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>Audit log</div>
      <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
        Every request, both sides, redacted (command output is never stored — only a length + digest).
      </span>
      <LogBox lines={lines.length ? lines : ["(no activity yet)"]} height={160} title="Remote devices audit" />
    </section>
  );
}

// ---- small building blocks ----
function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 11.5 }}>
      <span style={{ color: "var(--fg-muted)", minWidth: 84 }}>{k}</span>
      <span style={{ color: "var(--fg)", fontFamily: mono ? "monospace" : undefined }}>{v}</span>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 12,
  background: "var(--bg-panel)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const inputStyle: React.CSSProperties = {
  height: 26,
  fontSize: 12,
  padding: "0 8px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 7,
  color: "var(--fg)",
  flex: 1,
};

const selectStyle: React.CSSProperties = {
  height: 28,
  fontSize: 12,
  padding: "0 6px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 7,
  color: "var(--fg)",
};

function badge(color: string): React.CSSProperties {
  return {
    fontSize: 9.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color,
    border: `1px solid ${color}`,
    borderRadius: 5,
    padding: "0 5px",
  };
}
