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
import RemoteTerminal from "./RemoteTerminal";
import * as rd from "./remoteDevices";
import type {
  CommandKind,
  ControlState,
  DeviceIdentity,
  DeviceRecord,
  PendingApproval,
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
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [err, setErr] = useState("");

  // Console state.
  const [target, setTarget] = useState<string>("");
  const [kind, setKind] = useState<CommandKind>("diagnostics");
  const [command, setCommand] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [running, setRunning] = useState(false);
  const [consoleLines, setConsoleLines] = useState<string[]>([]);

  const [nameDraft, setNameDraft] = useState("");
  const [selftestMsg, setSelftestMsg] = useState("");
  const [manualAddr, setManualAddr] = useState("");
  const [discoverMsg, setDiscoverMsg] = useState("");
  const [publicEpDraft, setPublicEpDraft] = useState("");
  const [relayUrlDraft, setRelayUrlDraft] = useState("");
  const [shellDevice, setShellDevice] = useState<string | null>(null);

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
    const [id, devs, tr, ctl, ap, au] = await Promise.all([
      rd.getIdentity(),
      rd.listDevices(),
      rd.listTrusted(),
      rd.controlState(),
      rd.pendingApprovals(),
      rd.auditTail(200),
    ]);
    setIdentity(id);
    setDevices(devs);
    setTrusted(tr);
    setControl(ctl);
    setApprovals(ap.pending ?? []);
    setAudit((au as AuditRow[]) ?? []);
    setNameDraft((prev) => (prev === "" ? id.name : prev));
    setTarget((prev) => (prev === "" ? id.device_id : prev));
  }, []);

  useEffect(() => {
    void guard(reload);
  }, [guard, reload]);

  // Live updates: being-controlled, dangerous-action approvals, incoming pairing,
  // and vault-discovery refreshes.
  useEffect(() => {
    if (!isTauri) return;
    const uns: Array<() => void> = [];
    void (async () => {
      uns.push(
        await listen<ControlState>("remote-devices:control", (ev) => {
          setControl(ev.payload);
          if (!ev.payload.active) void rd.auditTail(200).then((a) => setAudit((a as AuditRow[]) ?? []));
        }),
      );
      uns.push(
        await listen<{ pending: PendingApproval[] }>("remote-devices:approval", (ev) => {
          setApprovals(ev.payload.pending ?? []);
        }),
      );
      uns.push(await listen("remote-devices:pairing", () => { void guard(reload); }));
    })();
    const onDevices = () => { void guard(reload); };
    window.addEventListener("owllm:devices:refresh", onDevices);
    return () => { uns.forEach((u) => u()); window.removeEventListener("owllm:devices:refresh", onDevices); };
  }, [guard, reload]);

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
      // file_write carries the file content as a base64 payload (UTF-8 safe).
      const payload =
        kind === "file_write" && fileContent
          ? btoa(unescape(encodeURIComponent(fileContent)))
          : null;
      setConsoleLines((l) => [...l, `\n$ [${stamp}] ${kind}${command ? " " + command : ""} → ${label}`]);
      try {
        const res = await rd.sendCommand(target, kind, command, payload, 60_000);
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

  const syncDiscover = () =>
    guard(async () => {
      setDiscoverMsg("syncing…");
      const changed = await rd.syncDiscovery();
      await reload();
      setDiscoverMsg(changed ? "updated from vault" : "no changes");
    });

  const pairByIp = () =>
    guard(async () => {
      const ep = manualAddr.trim();
      if (!ep) return;
      await rd.pairByAddress(ep);
      setManualAddr("");
      await reload();
    });

  const approveAction = (id: string) => guard(async () => { await rd.approveAction(id); });
  const denyAction = (id: string) => guard(async () => { await rd.denyAction(id); });

  const savePublicEndpoint = () => guard(async () => { await rd.setPublicEndpoint(publicEpDraft.trim() || null); setPublicEpDraft(""); await reload(); });
  const saveRelay = () => guard(async () => { await rd.setRelay(relayUrlDraft.trim() || null); setRelayUrlDraft(""); await reload(); });
  const toggleRelayServer = (on: boolean) => guard(async () => { if (on) await rd.relayServe(); else await rd.relayStop(); await reload(); });
  const toggleAgents = (on: boolean) => guard(async () => { await rd.setAgentsAllowed(on); await reload(); });

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

      {approvals.length > 0 && (
        <ApprovalBanner approvals={approvals} onApprove={approveAction} onDeny={denyAction} />
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
          manualAddr={manualAddr}
          setManualAddr={setManualAddr}
          onPairByIp={pairByIp}
          onDiscover={syncDiscover}
          discoverMsg={discoverMsg}
        />
      </section>

      {/* Network / WAN reachability */}
      {identity && (
        <NetworkPanel
          identity={identity}
          publicEpDraft={publicEpDraft}
          setPublicEpDraft={setPublicEpDraft}
          onSavePublic={savePublicEndpoint}
          relayUrlDraft={relayUrlDraft}
          setRelayUrlDraft={setRelayUrlDraft}
          onSaveRelay={saveRelay}
          onToggleServer={toggleRelayServer}
          onToggleAgents={toggleAgents}
        />
      )}

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
        fileContent={fileContent}
        setFileContent={setFileContent}
        running={running}
        onRun={runCommand}
        onStop={stopAll}
        lines={consoleLines}
        onClear={() => setConsoleLines([])}
        wslDisabled={wslDisabled}
        onOpenShell={() => setShellDevice(target)}
      />

      {/* Live interactive remote shell (SSH-like) */}
      {shellDevice && (
        <RemoteTerminal
          toDevice={shellDevice}
          deviceName={devices.find((d) => d.device_id === shellDevice)?.name ?? shortId(shellDevice)}
          onClose={() => setShellDevice(null)}
        />
      )}

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

function ApprovalBanner({
  approvals, onApprove, onDeny,
}: {
  approvals: PendingApproval[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  return (
    <section style={{ border: "2px solid var(--error)", borderRadius: 12, padding: 14, background: "rgba(255,60,60,0.10)", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "var(--fg-strong)", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 18 }}>⚠️</span> Dangerous action needs your approval
      </div>
      {approvals.map((a) => (
        <div key={a.request_id} style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--error)", borderRadius: 8, padding: 10, background: "var(--bg-card)" }}>
          <div style={{ fontSize: 13, color: "var(--fg)" }}>
            <b>{a.controller_name}</b> wants to run a <b style={{ color: "var(--error)" }}>{a.kind}</b> action on this machine.
          </div>
          {a.command && (
            <div style={{ fontSize: 11.5, color: "var(--fg)", fontFamily: "monospace", background: "var(--bg-input)", padding: "3px 8px", borderRadius: 6, wordBreak: "break-all" }}>
              {a.command}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button className="btn" onClick={() => onApprove(a.request_id)} style={{ background: "var(--warn)", color: "#241a00", fontWeight: 700, padding: "4px 14px" }}>
              Approve once
            </button>
            <button className="btn" onClick={() => onDeny(a.request_id)} style={{ background: "var(--error)", color: "#fff", fontWeight: 700, padding: "4px 14px" }}>
              Deny
            </button>
          </div>
        </div>
      ))}
    </section>
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
      <Row
        k="Listening"
        v={identity.listening ? `yes · ${identity.endpoint ?? "?"}` : identity.enabled ? "starting…" : "off (enable first)"}
        mono={identity.listening}
      />
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

function NetworkPanel({
  identity, publicEpDraft, setPublicEpDraft, onSavePublic, relayUrlDraft, setRelayUrlDraft, onSaveRelay, onToggleServer, onToggleAgents,
}: {
  identity: DeviceIdentity;
  publicEpDraft: string;
  setPublicEpDraft: (s: string) => void;
  onSavePublic: () => void;
  relayUrlDraft: string;
  setRelayUrlDraft: (s: string) => void;
  onSaveRelay: () => void;
  onToggleServer: (on: boolean) => void;
  onToggleAgents: (on: boolean) => void;
}) {
  return (
    <section style={{ ...cardStyle, border: "1px solid rgba(var(--accent-rgb),0.45)" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>Network &amp; reachability (WAN)</div>
      <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
        Controlling a device works across <b>any network the two machines can route to each other on</b> — same LAN, a
        Tailscale/WireGuard/VPN overlay (recommended for off-LAN, no setup here — your overlay IP is published
        automatically), a public host you set below, or a relay you host.
      </span>

      <Row k="Listening on" v={identity.endpoints.length ? identity.endpoints.join("  ·  ") : (identity.enabled ? "starting…" : "off")} mono />

      {/* Public endpoint */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        <span style={{ fontSize: 11.5, color: "var(--fg)" }}>
          Public endpoint <span style={{ color: "var(--fg-muted)" }}>(port-forward / DDNS / Tailscale MagicDNS host:port)</span>
          {identity.public_endpoint && <span style={{ ...badge("var(--ok)"), marginLeft: 6 }}>{identity.public_endpoint}</span>}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input value={publicEpDraft} onChange={(e) => setPublicEpDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSavePublic(); }}
            placeholder={identity.public_endpoint ?? "myhost.example.com:47771  (blank = clear)"}
            style={{ ...inputStyle, flex: 1, fontFamily: "monospace" }} />
          <button className="ghost-btn" onClick={onSavePublic} style={{ fontSize: 11, padding: "2px 10px" }}>Save</button>
        </div>
      </div>

      {/* Relay */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        <span style={{ fontSize: 11.5, color: "var(--fg)" }}>
          Relay <span style={{ color: "var(--fg-muted)" }}>(pure-NAT fallback — both devices dial out; it only sees ciphertext)</span>
          {identity.relay_url && <span style={{ ...badge(identity.relay_client ? "var(--ok)" : "var(--warn)"), marginLeft: 6 }}>{identity.relay_client ? "connected" : "set"}</span>}
        </span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input value={relayUrlDraft} onChange={(e) => setRelayUrlDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onSaveRelay(); }}
            placeholder={identity.relay_url ?? "https://relay.example.com  (blank = clear)"}
            style={{ ...inputStyle, flex: 1, fontFamily: "monospace" }} />
          <button className="ghost-btn" onClick={onSaveRelay} style={{ fontSize: 11, padding: "2px 10px" }}>Save</button>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, cursor: "pointer", color: identity.relay_serving ? "var(--accent)" : "var(--fg-muted)", marginTop: 2 }}>
          <input type="checkbox" checked={identity.relay_serving} onChange={(e) => onToggleServer(e.target.checked)} />
          Host a relay on this machine (bind 0.0.0.0:47772) — for an always-on box with a public URL/tunnel
          {identity.relay_serving && <span style={badge("var(--ok)")}>serving</span>}
        </label>
      </div>

      {/* Agent remote access */}
      <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: identity.agents_allowed ? "var(--accent)" : "var(--fg)" }}>
          <input type="checkbox" checked={identity.agents_allowed} onChange={(e) => onToggleAgents(e.target.checked)} />
          <b>Let agents use remote devices</b>
          {identity.agents_allowed && <span style={badge("var(--ok)")}>on</span>}
        </label>
        <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
          When on, your agents (Agentic team / Code) get a <code>remote_shell</code> tool for any device you've paired and been
          granted <b>shell</b> on — for tech support, installing software, and development on the other machine. Admin/elevation
          on the target still needs its approval. Off by default.
        </span>
      </div>
    </section>
  );
}

function DeviceList({
  devices, onPair, onForget, trusted, manualAddr, setManualAddr, onPairByIp, onDiscover, discoverMsg,
}: {
  devices: DeviceRecord[];
  onPair: (id: string) => void;
  onForget: (id: string) => void;
  trusted: TrustedController[];
  manualAddr: string;
  setManualAddr: (s: string) => void;
  onPairByIp: () => void;
  onDiscover: () => void;
  discoverMsg: string;
}) {
  const trustState = (id: string) => trusted.find((t) => t.device_id === id)?.state;
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>My OwLLM Devices</span>
        <span style={{ flex: 1 }} />
        <button className="ghost-btn" onClick={onDiscover} title="Pull device records from the GitHub vault" style={{ fontSize: 10.5, padding: "1px 8px" }}>
          🔄 Discover
        </button>
        {discoverMsg && <span style={{ fontSize: 10.5, color: "var(--fg-subtle)" }}>{discoverMsg}</span>}
      </div>
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
              <>
                <button className="ghost-btn" onClick={() => onPair(d.device_id)} title="Send this device a pairing request (it must approve you)" style={{ fontSize: 10.5, padding: "1px 6px" }}>
                  Pair
                </button>
                <button className="ghost-btn" onClick={() => onForget(d.device_id)} title="Remove from registry" style={{ fontSize: 10.5, padding: "1px 6px", color: "var(--error)" }}>
                  ✕
                </button>
              </>
            )}
          </div>
        );
      })}
      {/* Manual pair-by-IP (no vault discovery needed). */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
        <input
          value={manualAddr}
          onChange={(e) => setManualAddr(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && manualAddr.trim()) onPairByIp(); }}
          placeholder="pair by ip:port (e.g. 192.168.1.5:47771)"
          style={{ ...inputStyle, flex: 1, fontFamily: "monospace" }}
        />
        <button className="ghost-btn" disabled={!manualAddr.trim()} onClick={onPairByIp} style={{ fontSize: 11, padding: "2px 10px" }}>
          + Pair by IP
        </button>
      </div>
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
  devices, target, setTarget, kind, setKind, command, setCommand, fileContent, setFileContent, running, onRun, onStop, lines, onClear, wslDisabled, onOpenShell,
}: {
  devices: DeviceRecord[];
  target: string;
  setTarget: (s: string) => void;
  kind: CommandKind;
  setKind: (k: CommandKind) => void;
  command: string;
  setCommand: (s: string) => void;
  fileContent: string;
  setFileContent: (s: string) => void;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
  lines: string[];
  onClear: () => void;
  wslDisabled: boolean;
  onOpenShell: () => void;
}) {
  const needsCommand = kind === "shell" || kind === "wsl";
  const isFileWrite = kind === "file_write";
  const runDisabled = running || wslDisabled || ((needsCommand || isFileWrite) && command.trim() === "");
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
          <option value="file_write">File write ⚠ (approval)</option>
        </select>
        {(needsCommand || isFileWrite) && (
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !running && !isFileWrite) onRun(); }}
            placeholder={isFileWrite ? "target path (e.g. C:\\tmp\\note.txt)" : kind === "wsl" ? "uname -a" : "whoami"}
            style={{ ...inputStyle, flex: 1, minWidth: 160, fontFamily: "monospace" }}
          />
        )}
        <button className="btn" onClick={onRun} disabled={runDisabled} style={{ padding: "3px 14px", fontWeight: 700 }}>
          {running ? "Running…" : "▶ Run"}
        </button>
        <button className="btn" onClick={onOpenShell} title="Open a live interactive shell on the target (SSH-like)" style={{ padding: "3px 12px", background: "#c04bd6", color: "#fff", fontWeight: 700 }}>
          🖥 Open shell
        </button>
        <button className="ghost-btn" onClick={onStop} title="Emergency stop — cancel every in-flight remote command + session" style={{ padding: "3px 10px", color: "var(--error)" }}>
          ⛔ Stop
        </button>
        <button className="ghost-btn" onClick={onClear} style={{ padding: "3px 8px", fontSize: 11 }}>clear</button>
      </div>
      {isFileWrite && (
        <textarea
          value={fileContent}
          onChange={(e) => setFileContent(e.target.value)}
          placeholder="file content (written on the target only after it approves the action)"
          style={{ ...inputStyle, flex: "none", height: 70, padding: 8, fontFamily: "monospace", resize: "vertical" }}
        />
      )}
      {isFileWrite && <span style={{ fontSize: 11, color: "var(--warn)" }}>File write is a dangerous action — the target must approve it live (and its policy must allow file writes).</span>}
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
