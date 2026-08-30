// Host services that leak under an agent workload. Sibling of SandboxDiskCard:
// that one bounds what OwLLM WRITES, this one bounds memory a Windows service
// leaks because of what OwLLM DOES (measured: PcaSvc holding 2,994 MB of
// private bytes for 1 MB of data after 14 days of agent turns).
//
// Stopping the service needs admin, and a background sweep must never raise a
// UAC dialog — so the reclaim lives in a SYSTEM scheduled task installed once,
// with one consent. This card is where that consent is offered, and where the
// task's own log is shown so "installed" can be told from "actually ran".
// Backend: src-tauri/src/host_guard.rs.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, Row } from "./infoCards";

type LeakyService = {
  name: string; label: string;
  thresholdBytes: number; privateBytes: number; pid: number; overThreshold: boolean;
};
type HostGuardStatus = {
  supported: boolean; guardInstalled: boolean;
  services: LeakyService[]; lastRuns: string[];
};

export default function HostGuardCard() {
  const [status, setStatus] = useState<HostGuardStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const fmt = (b: number) =>
    b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.max(0, Math.round(b / 1e3))} KB`;

  const load = async () => {
    try { setStatus(await invoke<HostGuardStatus>("host_guard_status")); }
    catch {
      // Non-Windows or the command is unavailable → hide rather than show
      // perpetual placeholders, same contract as the sandbox disk card.
      setStatus({ supported: false, guardInstalled: false, services: [], lastRuns: [] });
    }
  };
  useEffect(() => { load(); }, []);

  const install = async () => {
    if (busy) return;
    setBusy("install");
    setMsg("🛡 Registering the guard — approve the admin prompt when it appears. This is asked once.");
    try {
      const s = await invoke<HostGuardStatus>("host_guard_install");
      setStatus(s);
      setMsg("✅ Guard installed. It checks every 6 hours as a system task and restarts a listed service only when it is over its threshold — no further prompts.");
    } catch (e) { setMsg("Install failed: " + String(e)); }
    finally { setBusy(null); }
  };

  const remove = async () => {
    if (busy) return;
    if (!window.confirm("Remove the host-service guard?\n\nThese services will go back to growing unattended until you restart them yourself. Needs one admin prompt.")) return;
    setBusy("remove");
    setMsg("Removing the scheduled task — approve the admin prompt…");
    try {
      const s = await invoke<HostGuardStatus>("host_guard_remove");
      setStatus(s);
      setMsg("Guard removed.");
    } catch (e) { setMsg("Remove failed: " + String(e)); }
    finally { setBusy(null); }
  };

  const reclaimNow = async () => {
    if (busy) return;
    setBusy("now");
    setMsg("♻️ Reclaiming — approve the admin prompt. The service is stopped gracefully first and restarts on demand…");
    try {
      const verdicts = await invoke<string[]>("host_guard_reclaim_now");
      setMsg("Result: " + verdicts.join("  ·  "));
      await load();
    } catch (e) { setMsg("Reclaim failed: " + String(e)); }
    finally { setBusy(null); }
  };

  // Hide entirely where there is no such service to guard (macOS, Linux).
  if (status && !status.supported) return null;

  const value = (v: string) => <span style={{ color: "var(--fg-strong)", fontWeight: 700 }}>{v}</span>;
  const hint = (t: string) => <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>{"  "}{t}</span>;

  const actionBtn = (label: string, onClick: () => void, key: string, primary?: boolean) => (
    <button
      data-ui={`HostGuard:${key}`}
      onClick={onClick}
      disabled={!!busy}
      style={{
        minHeight: 34, padding: "7px 14px", borderRadius: 9,
        border: `1px solid ${primary ? "var(--accent-strong)" : "var(--border-strong)"}`,
        background: "var(--bg-elevated)", color: "var(--fg-strong)",
        fontSize: 12.5, fontWeight: 700, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
      }}
    >{busy === key ? "⏳ Working…" : label}</button>
  );

  return (
    <Card
      title="🛡 Leaky host services"
      action={<button className="ghost-btn" onClick={load} disabled={!!busy}>🔄 Refresh</button>}
    >
      <Row
        label="Guard"
        value={status
          ? (status.guardInstalled
            ? <>{value("installed")}{hint("system task, every 6 hours — no further prompts")}</>
            : <>{value("not installed")}{hint("these services grow unattended until you restart them")}</>)
          : "…"}
      />
      {(status?.services ?? []).map((s) => (
        <Row
          key={s.name}
          label={s.name}
          value={s.pid === 0
            ? <>{value("not running")}{hint(s.label)}</>
            : <>
                {value(fmt(s.privateBytes))}
                {hint(`${s.overThreshold ? "over" : "under"} the ${fmt(s.thresholdBytes)} threshold · pid ${s.pid} · ${s.label}`)}
              </>}
        />
      ))}
      {(status?.lastRuns ?? []).length > 0 && (
        <Row label="Last guard runs" value={<span style={{ whiteSpace: "pre-wrap" }}>{status!.lastRuns.join("\n")}</span>} />
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
        {status?.guardInstalled
          ? actionBtn("Remove guard", remove, "remove")
          : actionBtn("🛡 Install guard", install, "install", true)}
        {actionBtn("Reclaim now", reclaimNow, "now")}
      </div>

      {msg && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>{msg}</div>
      )}
    </Card>
  );
}
