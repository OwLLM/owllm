// NewProjectDialog — modal to create a project from a team template.
// Writes a new row into LLM/data/owllm_state.db's agent_projects
// table via the `create_project` Tauri command. Picks the project's
// agent roster from the team template's `agents` list, and seeds
// graph_json from the team's routing edges so the orbital + graph
// views render the correct flow on first open.

import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Team = {
  id: string;
  name: string;
  display: string;
  category: string;
  description: string;
  icon: string;
  agents: { name: string; base: string; icon?: string | null }[];
  edges: { source: string; target: string }[];
  visibility?: "recommended" | "more" | "examples" | "legacy" | "custom";
  workflowRank?: number;
  requiredMcp?: string[];
};

type ProjectRow = {
  id: string; name: string; description: string; location: string;
  trust_writes: boolean; auto_approve_all: boolean;
  team: string[]; team_default_model_id: string; graph_json: string;
  chat_json: string; agent_logs_json: string;
  updated_at: string;
};

export default function NewProjectDialog({
  open, onClose, onCreated, teams, defaultTeamName,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (row: ProjectRow) => void;
  teams: Team[];
  /// Template to pre-select. Falls back to the first team in the list.
  defaultTeamName?: string | null;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [teamName, setTeamName] = useState<string>("");
  const [trustWrites, setTrustWrites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setLocation("");
    setTrustWrites(false);
    setErr(null);
    const initial = defaultTeamName && teams.some(t => t.name === defaultTeamName)
      ? defaultTeamName
      : (teams[0]?.name ?? "");
    setTeamName(initial);
  }, [open, defaultTeamName, teams]);

  const team = teams.find(t => t.name === teamName) ?? null;

  const onBrowse = async () => {
    try {
      const picked = await invoke<string | null>("pick_folder", { title: "Pick a project folder" });
      if (picked) setLocation(picked);
    } catch (e: any) {
      setErr(`Folder pick failed: ${e?.message ?? e}`);
    }
  };

  const onCreate = async () => {
    if (!name.trim()) { setErr("Project name is required."); return; }
    if (!team) { setErr("Pick a team template."); return; }
    setBusy(true); setErr(null);
    try {
      const teamMembers = team.agents.map(a => a.name);
      const graph = team.edges.length > 0 ? { edges: team.edges } : null;
      const row = await invoke<ProjectRow>("create_project", {
        input: {
          name: name.trim(),
          description: description.trim(),
          location: location.trim(),
          team: teamMembers,
          graph_json: graph ? JSON.stringify(graph) : "",
          team_default_model_id: "",
          trust_writes: trustWrites,
          auto_approve_all: false,
        },
      });
      onCreated(row);
      onClose();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "var(--bg-overlay)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "min(640px, 92vw)", maxHeight: "92vh",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 14, padding: 22,
          display: "flex", flexDirection: "column", gap: 14,
          boxShadow: "var(--shadow-lg)",
          overflow: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--fg-strong)", flex: 1 }}>+ New project</div>
          <button
            onClick={onClose}
            title="Cancel"
            style={{ width: 32, height: 32, border: "none", background: "var(--bg-surface)", color: "var(--fg)", borderRadius: 8, fontSize: 16, cursor: "pointer" }}
          >✕</button>
        </div>
        <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5 }}>
          A project couples a folder, a roster of agents, and the team's wiring.
          The orchestrator dispatches against this roster when you click Run on
          the Agents tab.
        </div>

        {/* Name */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 11, color: "var(--fg-muted)", letterSpacing: 0.5, textTransform: "uppercase" }}>Name</label>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. esp-flash, cleanup-pr, paper-draft"
            style={{ height: 38, padding: "0 12px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 14 }}
          />
        </div>

        {/* Description */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 11, color: "var(--fg-muted)", letterSpacing: 0.5, textTransform: "uppercase" }}>Description (optional)</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="One line of context for the team to start with."
            rows={2}
            style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 13, resize: "vertical", minHeight: 40 }}
          />
        </div>

        {/* Location + Browse */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 11, color: "var(--fg-muted)", letterSpacing: 0.5, textTransform: "uppercase" }}>Folder / location</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="/path/to/repo or any project folder"
              style={{ flex: 1, height: 38, padding: "0 12px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 14 }}
            />
            <button
              onClick={onBrowse}
              className="ghost-btn"
              style={{ height: 38, padding: "0 14px" }}
            >Browse…</button>
          </div>
        </div>

        {/* Team template */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 11, color: "var(--fg-muted)", letterSpacing: 0.5, textTransform: "uppercase" }}>Team template</label>
          <select
            value={teamName}
            onChange={e => setTeamName(e.target.value)}
            style={{ height: 38, padding: "0 12px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 14 }}
          >
            {teams.length === 0
              ? <option value="">(no templates available)</option>
              : teams.map(t => (
                  <option key={t.id} value={t.name}>
                    {t.visibility === "recommended" ? "Core: " : ""}{t.display} ({t.agents.length} agents)
                  </option>
                ))
            }
          </select>
          {team && (
            <div style={{ color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.5, padding: "4px 2px" }}>
              {team.description}
            </div>
          )}
          {team && team.agents.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {team.agents.map(a => (
                <span key={a.name} style={{ background: "var(--bg-surface)", color: "var(--fg-muted)", fontSize: 10, fontFamily: "Consolas, monospace", borderRadius: 4, padding: "2px 6px" }}>{a.name}</span>
              ))}
            </div>
          )}
          {team && (team.requiredMcp?.length ?? 0) > 0 && (
            <div style={{ color: "#a8b8ff", fontSize: 11, lineHeight: 1.4, padding: "2px 2px" }}>
              Uses MCP: {team.requiredMcp!.map(m => m.replace(/^mcp\./, "")).join(", ")}.
            </div>
          )}
        </div>

        {/* Trust writes */}
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: trustWrites ? "#ffb56a" : "var(--fg)" }}>
          <input type="checkbox" checked={trustWrites} onChange={() => setTrustWrites(v => !v)} style={{ width: 14, height: 14, accentColor: "var(--accent)" }} />
          <span>
            Trust writes — let the team edit files directly without the sandbox guard.
          </span>
        </label>

        {err && (
          <div style={{ color: "#ff8c8c", fontSize: 12, background: "rgba(255,140,140,0.10)", border: "1px solid rgba(255,140,140,0.30)", borderRadius: 8, padding: "8px 10px" }}>
            {err}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            onClick={onClose}
            disabled={busy}
            className="ghost-btn"
            style={{ height: 38, padding: "0 14px" }}
          >Cancel</button>
          <div style={{ flex: 1 }} />
          <button
            onClick={onCreate}
            disabled={busy || !name.trim() || !team}
            style={{
              height: 38, padding: "0 22px",
              border: "none", borderRadius: 9,
              background: busy || !name.trim() || !team ? "rgba(var(--accent-rgb),0.30)" : "var(--accent)",
              color: busy || !name.trim() || !team ? "var(--fg-muted)" : "var(--accent-fg)",
              fontWeight: 700, fontSize: 14,
              cursor: busy || !name.trim() || !team ? "not-allowed" : "pointer",
            }}
          >{busy ? "Creating…" : "Create project"}</button>
        </div>
      </div>
    </div>
  );
}
