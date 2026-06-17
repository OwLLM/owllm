// ProjectSettingsDialog — ONE popup that is both "⚙ Project settings" (edit the
// current project) and "+ New project" (create one). It absorbs everything that
// used to crowd the inline project strip: folder/Browse, the trust + isolation +
// full-access + Verify/Isolate cluster, the Bridge shortcut, the team template
// picker, Rename, and a double-approval Delete. The toolbar keeps only a project
// dropdown + a ⚙ button that opens this.
//
// Edit-mode field changes reuse the parent's existing callbacks (onChangeLocation
// / onToggleTrustWrites …), which already persist to the project row via the
// AgentsPage effects — so this dialog adds NO new persistence path for those.

import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isolationBadge } from "./isolationBadge";
import { isWslPath } from "./wslIsolation";
import { sandboxSyncLogins, sandboxConvertProject, sandboxHarden } from "./isolation";

type Team = {
  id: string; name: string; display: string; category: string;
  description: string; icon: string;
  agents: { name: string; base: string; icon?: string | null }[];
  edges: { source: string; target: string }[];
  visibility?: "recommended" | "more" | "examples" | "legacy" | "custom";
  workflowRank?: number; requiredMcp?: string[];
};
type ProjectRow = {
  id: string; name: string; description: string; location: string;
  trust_writes: boolean; auto_approve_all: boolean;
  team: string[]; team_default_model_id: string; graph_json: string;
  chat_json: string; agent_logs_json: string; updated_at: string;
};

export type ProjectSettingsDialogProps = {
  open: boolean;
  mode: "new" | "edit";
  onClose: () => void;
  teams: Team[];
  pickedTeamId: string | null;
  onPickTeam: (id: string | null) => void;
  // NEW mode
  defaultTeamName?: string | null;
  onCreated: (row: ProjectRow) => void;
  // EDIT mode — the live project + the parent callbacks that already persist.
  project: ProjectRow | null;
  location: string;
  effectiveCwd: string;
  onChangeLocation: (v: string) => void;
  trustWrites: boolean;
  onToggleTrustWrites: () => void;
  fullAccess: boolean;
  onToggleFullAccess: () => void;
  bridgeOn: boolean;
  isolationRequested: boolean;
  onAfterRename: () => void;
  onAfterDelete: () => void;
};

const LBL: React.CSSProperties = { fontSize: 11, color: "var(--fg-muted)", letterSpacing: 0.5, textTransform: "uppercase" };
const INPUT: React.CSSProperties = { height: 38, padding: "0 12px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 14 };

export default function ProjectSettingsDialog(props: ProjectSettingsDialogProps) {
  const {
    open, mode, onClose, teams, pickedTeamId, onPickTeam,
    defaultTeamName, onCreated,
    project, location, effectiveCwd, onChangeLocation,
    trustWrites, onToggleTrustWrites, fullAccess, onToggleFullAccess,
    bridgeOn, isolationRequested, onAfterRename, onAfterDelete,
  } = props;

  // --- new-project form state ---
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [teamName, setTeamName] = useState("");
  const [newTrust, setNewTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // --- edit-project local state ---
  const [renameVal, setRenameVal] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actBusy, setActBusy] = useState<string | null>(null);
  const [actMsg, setActMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null); setActMsg(null); setActBusy(null); setConfirmDelete(false);
    if (mode === "new") {
      setName(""); setDescription(""); setNewLocation(""); setNewTrust(false);
      const initial = defaultTeamName && teams.some(t => t.name === defaultTeamName)
        ? defaultTeamName : (teams[0]?.name ?? "");
      setTeamName(initial);
    } else {
      setRenameVal(project?.name ?? "");
    }
  }, [open, mode, project?.id, defaultTeamName, teams]);

  if (!open) return null;

  const team = teams.find(t => t.name === teamName) ?? null;

  // ---- shared actions ----
  const browse = async (set: (v: string) => void) => {
    try {
      const picked = await invoke<string | null>("pick_folder", { title: "Pick a project folder" });
      if (picked) set(picked);
    } catch (e: any) { setErr(`Folder pick failed: ${e?.message ?? e}`); }
  };

  const onCreate = async () => {
    if (!name.trim()) { setErr("Project name is required."); return; }
    if (!team) { setErr("Pick a team template."); return; }
    setBusy(true); setErr(null);
    try {
      const row = await invoke<ProjectRow>("create_project", {
        input: {
          name: name.trim(), description: description.trim(), location: newLocation.trim(),
          team: team.agents.map(a => a.name),
          graph_json: team.edges.length > 0 ? JSON.stringify({ edges: team.edges }) : "",
          team_default_model_id: "", trust_writes: newTrust, auto_approve_all: false,
        },
      });
      onCreated(row); onClose();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };

  const doRename = async () => {
    if (!project) return;
    const next = renameVal.trim();
    if (!next || next === project.name) return;
    try {
      await invoke("update_project", { input: { id: project.id, name: next } });
      onAfterRename();
    } catch (e: any) { setActMsg(`Rename failed: ${e?.message ?? e}`); }
  };

  const doDelete = async () => {
    if (!project) return;
    setActBusy("delete");
    try {
      await invoke("delete_project", { id: project.id });
      onAfterDelete(); onClose();
    } catch (e: any) { setActMsg(`Delete failed: ${e?.message ?? e}`); }
    finally { setActBusy(null); }
  };

  // ---- isolation actions (moved here off the toolbar) ----
  const probeIsolation = async () => {
    const r = await invoke<{ stdout: string; stderr: string; exitCode: number }>("tool_shell_exec", {
      command: 'uname -a; echo "PWD=$(pwd)"; echo "USER=$(whoami)"; echo "CDRIVE=$(ls /mnt/c/Windows >/dev/null 2>&1 && echo VISIBLE || echo HIDDEN)"',
      cwd: effectiveCwd || undefined,
    });
    const out = `${r.stdout}\n${r.stderr}`.trim();
    const inWsl = /microsoft-standard-WSL2/i.test(out) || (/\bLinux\b/.test(r.stdout) && !/PWD=[A-Za-z]:\\/.test(out));
    const confined = /CDRIVE=HIDDEN/.test(out);
    return { out, inWsl, confined };
  };
  const verifyIsolation = async () => {
    if (actBusy) return;
    setActBusy("verify"); setActMsg("🔍 Running the probe through an agent's own shell…");
    try {
      let { out, inWsl, confined } = await probeIsolation();
      if (inWsl && !confined) {
        setActMsg("🛡 Runs in WSL — sealing it to ONLY this folder (installing bubblewrap, ~10–20s)…");
        try { await sandboxHarden(null); ({ out, inWsl, confined } = await probeIsolation()); }
        catch (e) {
          setActMsg("✅ Runs in WSL (Linux), but couldn't seal it to just this folder: " + String(e) +
            "\n\nAgents still run isolated in WSL — they just also see the rest of /mnt (C: drive). " +
            "Open the WSL distro and run: sudo apt-get install -y bubblewrap");
          return;
        }
      }
      const verdict = !inWsl
        ? "⚠️ NOT ISOLATED — agents run on the Windows host. Press 🛡 Isolate to move the project into the sandbox."
        : confined
          ? "✅ FULLY ISOLATED — agents run in WSL (Linux) AND are sealed to ONLY this folder: they can't see the rest of your C: drive."
          : "✅ ISOLATED in WSL (Linux), but NOT folder-sealed — agents can still see the rest of /mnt. Install bubblewrap in the distro to seal it.";
      setActMsg(verdict + "\n\nProbe output:\n" + (out || "(no output)"));
    } catch (e) { setActMsg("Verify failed: " + String(e)); }
    finally { setActBusy(null); }
  };
  const mirrorLogins = async (): Promise<string> => {
    const r = await sandboxSyncLogins(null);
    return r.synced.length ? `logins synced into the sandbox: ${r.synced.join(", ")}`
      : r.found_on_host.length ? `found on Windows (${r.found_on_host.join(", ")}) but none landed in the sandbox`
      : "no logins to mirror yet (connect GitHub on Home, or a CLI on Accounts)";
  };
  const isolate = async () => {
    if (actBusy) return;
    if (isWslPath(location)) { setActMsg("Already isolated — this project lives inside WSL."); return; }
    if (!location.trim()) { setActMsg("Pick a project folder first (Browse…)."); return; }
    if (!window.confirm("Copy this project INTO the Linux sandbox and switch to the copy?\n\nThe original folder stays where it is. A large repo can take a minute.")) return;
    setActBusy("isolate"); setActMsg("🛡 Copying the project into the Linux sandbox… this can take a minute. The app stays responsive.");
    try {
      const p = await sandboxConvertProject(location);
      onChangeLocation(p.path);
      setActMsg("🔑 Isolated. Mirroring your GitHub / CLI logins into the sandbox…");
      let syncMsg: string;
      try { syncMsg = await mirrorLogins(); } catch (e) { syncMsg = "login mirror skipped: " + String(e); }
      setActMsg(`✅ Isolated + ${syncMsg}.\nNow working in: ${p.path}\nAgents run in WSL — press 🔍 Verify to confirm.`);
    } catch (e) { setActMsg("Convert failed: " + String(e)); }
    finally { setActBusy(null); }
  };

  const teamSelect = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={e => onChange(e.target.value)} style={INPUT}>
      {teams.length === 0 ? <option value="">(no templates available)</option>
        : teams.map(t => (
            <option key={t.id} value={t.name}>
              {t.visibility === "recommended" ? "Core: " : ""}{t.display} ({t.agents.length} agents)
            </option>
          ))}
    </select>
  );

  const iso = isolationBadge(effectiveCwd, isolationRequested);
  const aBtn = (label: string, onClick: () => void, key: string) => (
    <button type="button" onClick={onClick} disabled={!!actBusy}
      style={{ height: 34, padding: "0 12px", borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", color: "var(--fg-strong)", fontSize: 12.5, fontWeight: 700, cursor: actBusy ? "wait" : "pointer", opacity: actBusy ? 0.6 : 1 }}
    >{actBusy === key ? "⏳ Working…" : label}</button>
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--bg-overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "min(640px, 92vw)", maxHeight: "92vh", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 14, boxShadow: "var(--shadow-lg)", overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--fg-strong)", flex: 1 }}>
            {mode === "new" ? "+ New project" : `⚙ Project settings${project ? ` — ${project.name}` : ""}`}
          </div>
          <button onClick={onClose} title="Close" style={{ width: 32, height: 32, border: "none", background: "var(--bg-surface)", color: "var(--fg)", borderRadius: 8, fontSize: 16, cursor: "pointer" }}>✕</button>
        </div>

        {mode === "new" ? (
          <>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5 }}>
              A project couples a folder, a roster of agents, and the team's wiring. The
              orchestrator dispatches against this roster when you click Run.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={LBL}>Name</label>
              <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. esp-flash, cleanup-pr, paper-draft" style={INPUT} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={LBL}>Description (optional)</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="One line of context for the team to start with." rows={2} style={{ ...INPUT, height: "auto", padding: "8px 12px", resize: "vertical", minHeight: 40 }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={LBL}>Folder / location</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={newLocation} onChange={e => setNewLocation(e.target.value)} placeholder="/path/to/repo or any project folder" style={{ ...INPUT, flex: 1 }} />
                <button onClick={() => browse(setNewLocation)} className="ghost-btn" style={{ height: 38, padding: "0 14px" }}>Browse…</button>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={LBL}>Team template</label>
              {teamSelect(teamName, setTeamName)}
              {team && <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5, padding: "4px 2px" }}>{team.description}</div>}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: newTrust ? "#ffb56a" : "var(--fg)" }}>
              <input type="checkbox" checked={newTrust} onChange={() => setNewTrust(v => !v)} style={{ width: 14, height: 14, accentColor: "var(--accent)" }} />
              <span>Trust writes — let the team edit files directly without the sandbox guard.</span>
            </label>
          </>
        ) : (
          <>
            {/* Name + rename */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={LBL}>Name</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={renameVal} onChange={e => setRenameVal(e.target.value)} style={{ ...INPUT, flex: 1 }} />
                <button onClick={doRename} className="ghost-btn" disabled={!renameVal.trim() || renameVal.trim() === project?.name} style={{ height: 38, padding: "0 14px" }}>Rename</button>
              </div>
            </div>
            {/* Folder */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={LBL}>Folder / location</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={location} onChange={e => onChangeLocation(e.target.value)} placeholder="/path/to/repo · github.com/me/x" style={{ ...INPUT, flex: 1 }} />
                <button onClick={() => browse(onChangeLocation)} className="ghost-btn" style={{ height: 38, padding: "0 14px" }}>Browse…</button>
              </div>
            </div>
            {/* Security */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 10, background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
              <label style={LBL}>Security</label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: trustWrites ? "#ffb56a" : "var(--fg)" }}>
                <input type="checkbox" checked={trustWrites} onChange={onToggleTrustWrites} style={{ width: 14, height: 14, accentColor: "var(--accent)" }} />
                <span>Trust writes — agents edit files directly (skip the write guard).</span>
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {fullAccess
                  ? <button type="button" onClick={onToggleFullAccess} title="Agents run OUTSIDE the sandbox — full access to your PC. Click to turn back off." style={{ height: 24, padding: "2px 8px", background: "#3a1416", color: "#ff8c8c", border: "1px solid #ff5a5a", borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: "pointer" }}>⚠ HOST ACCESS — sandbox OFF</button>
                  : <span title={iso.title} style={{ height: 24, display: "inline-flex", alignItems: "center", padding: "2px 8px", background: iso.bg, color: iso.color, border: `1px solid ${iso.border}`, borderRadius: 6, fontSize: 11, fontWeight: iso.hostFallback ? 800 : 600 }}>{iso.text}</span>}
                {aBtn("🔍 Verify", verifyIsolation, "verify")}
                {!isWslPath(effectiveCwd) && aBtn("🛡 Isolate", isolate, "isolate")}
                {!fullAccess && <button type="button" onClick={onToggleFullAccess} title="Let this project's agents run OUTSIDE the sandbox. Use only for projects you trust." style={{ height: 24, padding: "2px 8px", background: "var(--bg-elevated)", color: "var(--fg-muted)", border: "1px solid var(--border-strong)", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>🔓 Full access…</button>}
              </div>
            </div>
            {/* Team template (canvas) + Bridge */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={LBL}>Team template (shown on the canvas)</label>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={teams.find(t => t.id === pickedTeamId)?.name ?? ""} onChange={e => { const t = teams.find(x => x.name === e.target.value); onPickTeam(t ? t.id : null); }} style={{ ...INPUT, flex: 1 }}>
                  <option value="">(use project roster)</option>
                  {teams.map(t => <option key={t.id} value={t.name}>{t.display} ({t.agents.length} agents)</option>)}
                </select>
                <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: "bridges" } }))} className="ghost-btn" style={{ height: 38, padding: "0 14px" }}>{bridgeOn ? "📱 Bridge: ON" : "📱 Bridge: OFF"}</button>
              </div>
            </div>
            {/* Danger zone — double approval */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 10, background: "rgba(255,90,90,0.06)", border: "1px solid rgba(255,90,90,0.35)" }}>
              <label style={{ ...LBL, color: "#ff8c8c" }}>Danger zone</label>
              {!confirmDelete ? (
                <button type="button" onClick={() => setConfirmDelete(true)} disabled={!project} style={{ alignSelf: "flex-start", height: 34, padding: "0 14px", borderRadius: 8, border: "1px solid rgba(255,140,140,0.5)", background: "rgba(255,140,140,0.10)", color: "#ff8c8c", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>🗑 Delete project…</button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12.5, color: "var(--fg)", lineHeight: 1.5 }}>
                    Permanently delete <b>{project?.name}</b>?{" "}
                    {isWslPath(project?.location ?? "") && (project?.location ?? "").toLowerCase().includes("/owllm/") && !(project?.location ?? "").toLowerCase().includes("/mnt/")
                      ? "This also removes its sandbox copy inside WSL (frees that disk space). Your original folder, if any, stays put."
                      : "This only removes the project; your folder on disk stays."}{" "}
                    This cannot be undone.
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => setConfirmDelete(false)} className="ghost-btn" style={{ height: 34, padding: "0 14px" }}>Cancel</button>
                    <button type="button" onClick={doDelete} disabled={!!actBusy} style={{ height: 34, padding: "0 16px", borderRadius: 8, border: "none", background: "#e0433f", color: "white", fontSize: 13, fontWeight: 800, cursor: actBusy ? "wait" : "pointer" }}>{actBusy === "delete" ? "Deleting…" : "Yes, permanently delete"}</button>
                  </div>
                </div>
              )}
            </div>
            {actMsg && (
              <div style={{ fontSize: 12.5, color: "var(--fg)", whiteSpace: "pre-wrap", lineHeight: 1.5, background: "var(--bg-elevated)", border: "1px solid rgba(var(--accent-rgb),0.4)", borderRadius: 8, padding: "8px 10px" }}>{actMsg}</div>
            )}
          </>
        )}

        {err && (
          <div style={{ color: "#ff8c8c", fontSize: 12, background: "rgba(255,140,140,0.10)", border: "1px solid rgba(255,140,140,0.30)", borderRadius: 8, padding: "8px 10px" }}>{err}</div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={onClose} disabled={busy} className="ghost-btn" style={{ height: 38, padding: "0 14px" }}>{mode === "new" ? "Cancel" : "Done"}</button>
          <div style={{ flex: 1 }} />
          {mode === "new" && (
            <button onClick={onCreate} disabled={busy || !name.trim() || !team}
              style={{ height: 38, padding: "0 22px", border: "none", borderRadius: 9, background: busy || !name.trim() || !team ? "rgba(var(--accent-rgb),0.30)" : "var(--accent)", color: busy || !name.trim() || !team ? "var(--fg-muted)" : "var(--accent-fg)", fontWeight: 700, fontSize: 14, cursor: busy || !name.trim() || !team ? "not-allowed" : "pointer" }}
            >{busy ? "Creating…" : "Create project"}</button>
          )}
        </div>
      </div>
    </div>
  );
}
