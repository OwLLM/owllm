// Sandbox disk usage + reclaim controls. Lives on the Info page (moved off the
// Home page, which is a launcher, not a maintenance console).
//
// "Clear caches" drops regenerable build caches (uv/npm/pip) — safe, instant, no
// restart, but only frees space INSIDE the .vhdx. "Reclaim disk space" then
// physically shrinks the .vhdx file (fstrim + wsl --shutdown + diskpart compact)
// — needs admin + restarts WSL, so it's explicit + warned.
// Backend: src-tauri/src/sandbox.rs (sandbox_disk_usage / _clear_caches / _reclaim_disk).
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, Row } from "./infoCards";

type SandboxDisk = {
  vhdxBytes: number; vhdxPath: string | null;
  cacheBytes: number; copiesBytes: number; available: boolean;
};

export default function SandboxDiskCard() {
  const [disk, setDisk] = useState<SandboxDisk | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const fmt = (b: number) =>
    b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.max(0, Math.round(b / 1e3))} KB`;

  const load = async () => {
    try { setDisk(await invoke<SandboxDisk>("sandbox_disk_usage", { distro: null })); }
    catch {
      // Non-WSL platform or no distro → mark unavailable so the card hides
      // itself instead of showing perpetual "…" placeholders.
      setDisk({ vhdxBytes: 0, vhdxPath: null, cacheBytes: 0, copiesBytes: 0, available: false });
    }
  };
  useEffect(() => { load(); }, []);

  const clearCaches = async () => {
    if (busy) return;
    setBusy("clear");
    setMsg("🧹 Clearing regenerable caches inside WSL…");
    try {
      const freed = await invoke<number>("sandbox_clear_caches", { distro: null });
      setMsg(`✅ Freed ${fmt(freed)} of build caches. They rebuild automatically when needed. To shrink the disk file itself, use Reclaim disk space.`);
      await load();
    } catch (e) { setMsg("Clear caches failed: " + String(e)); }
    finally { setBusy(null); }
  };

  const reclaim = async () => {
    if (busy) return;
    if (!window.confirm(
      "Reclaim disk space?\n\nThis physically shrinks the WSL disk file. It will:\n• RESTART WSL (any running agents stop)\n• ask for a Windows admin prompt\n• take up to a minute\n\nTip: press “Clear caches” first so there’s more to reclaim. Continue?"
    )) return;
    setBusy("reclaim");
    setMsg("💿 Restarting WSL and compacting the disk — approve the admin prompt when it appears. This can take a minute…");
    try {
      const r = await invoke<{ beforeBytes: number; afterBytes: number; freedBytes: number }>("sandbox_reclaim_disk", { distro: null });
      setMsg(r.freedBytes > 0
        ? `✅ Reclaimed ${fmt(r.freedBytes)} — the WSL disk went from ${fmt(r.beforeBytes)} to ${fmt(r.afterBytes)}.`
        : "Done — nothing to reclaim right now (the disk is already compact, or there were no freed blocks to give back). Clearing caches first usually helps.");
      await load();
    } catch (e) { setMsg("Reclaim failed: " + String(e)); }
    finally { setBusy(null); }
  };

  // Hide entirely on non-WSL platforms or when no distro is present.
  if (disk && !disk.available) return null;

  const hint = (t: string) => <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>{"  "}{t}</span>;
  const value = (v: string) => <span style={{ color: "var(--fg-strong)", fontWeight: 700 }}>{v}</span>;

  const actionBtn = (label: string, onClick: () => void, key: string, primary?: boolean) => (
    <button
      data-ui={`SandboxDisk:${key}`}
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
      title="💾 Sandbox disk"
      action={<button className="ghost-btn" onClick={load} disabled={!!busy}>🔄 Refresh</button>}
    >
      <Row label="WSL disk file"          value={<>{value(disk ? fmt(disk.vhdxBytes) : "…")}{hint("grows over time; shrink with Reclaim")}</>} />
      <Row label="Reclaimable caches"     value={<>{value(disk ? fmt(disk.cacheBytes) : "…")}{hint("uv / npm / pip — safe to clear")}</>} />
      <Row label="Project sandbox copies" value={<>{value(disk ? fmt(disk.copiesBytes) : "…")}{hint("freed automatically when you delete a project")}</>} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
        {actionBtn("🧹 Clear caches", clearCaches, "clear", true)}
        {actionBtn("💿 Reclaim disk space", reclaim, "reclaim")}
      </div>
      {msg && (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--fg)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{msg}</div>
      )}
    </Card>
  );
}
