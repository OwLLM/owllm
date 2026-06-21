// TeamWorkbenchModal — opens the full Team Workbench as a popup over any page
// (the project / Orchestrated Workflow page chip uses this). Self-loading: it
// fetches the team template + role defs + skill packs itself, so the host page
// only has to know the team's NAME plus the models/accounts it already holds.
//
// The Workbench edits the team TEMPLATE (save_team_template). That's the single
// source of truth the dispatch engine reads (roles + edges) — see
// project_hierarchical_team_leader. Saving here updates the template the active
// project is built from; the host should reload the team after onSaved.

import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TeamWorkbench, { type WorkbenchRole, type SkillPackBackend, type TeamTemplateBackend } from "./TeamWorkbench";
import { type ModelInfo, type AccountsStatusLite } from "./ModelPicker";

type AgentRoleBackend = { id: string; path: string; built_in: boolean; data: any };

// minimal role mapping (a structural subset of StudioPage's toAgentDef — kept
// local so this modal has no dependency on StudioPage's internals).
function roleToWorkbench(r: AgentRoleBackend): WorkbenchRole {
  const d = r.data ?? {};
  const tools = Array.isArray(d.tool_allowlist) ? d.tool_allowlist : (d.tool_allowlist === undefined ? null : []);
  const mcp = Array.isArray(d.mcp_allowlist) ? d.mcp_allowlist : (d.mcp_allowlist === undefined ? null : []);
  return {
    name: d.name ?? r.id,
    icon: d.icon ?? "owl:owl_asssitant",
    description: d.description ?? "",
    tools, mcpTools: mcp,
    systemPrompt: typeof d.system_prompt === "string" ? d.system_prompt : undefined,
    temperature: typeof d.default_temperature === "number" ? d.default_temperature : undefined,
    canDispatch: d.can_dispatch === true,
    isSkill: false,
    builtIn: r.built_in,
  };
}
function skillToWorkbench(s: SkillPackBackend): WorkbenchRole {
  const fm = s.frontmatter ?? {};
  return {
    name: (typeof fm.name === "string" && fm.name) || s.id,
    icon: typeof fm.icon === "string" && fm.icon.length > 0 ? fm.icon : "owl:owl_asssitant",
    description: (typeof fm.description === "string" && fm.description) || "",
    tools: Array.isArray(fm.tools) ? fm.tools.map(String) : [],
    mcpTools: Array.isArray(fm.mcp_tools) ? fm.mcp_tools.map(String) : [],
    systemPrompt: s.body,
    temperature: typeof fm.temperature === "number" ? fm.temperature : undefined,
    canDispatch: fm.leader === true,
    isSkill: true,
    builtIn: false,
  };
}

export default function TeamWorkbenchModal({
  teamName, models, accountsStatus, onClose, onSaved,
}: {
  teamName: string;
  models: ModelInfo[];
  accountsStatus: AccountsStatusLite | null;
  onClose: () => void;
  onSaved?: (newName: string) => void;
}) {
  const [backend, setBackend] = useState<TeamTemplateBackend | null>(null);
  const [roleDefs, setRoleDefs] = useState<WorkbenchRole[]>([]);
  const [skillPacks, setSkillPacks] = useState<SkillPackBackend[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [teams, roles, skills] = await Promise.all([
          invoke<TeamTemplateBackend[]>("list_team_templates"),
          invoke<AgentRoleBackend[]>("list_agent_roles"),
          invoke<SkillPackBackend[]>("list_skill_packs"),
        ]);
        if (dead) return;
        const want = teamName.trim().toLowerCase();
        const found =
          teams.find(t => String(t.data?.name ?? t.id).toLowerCase() === want) ??
          teams.find(t => String(t.data?.display_name ?? "").toLowerCase() === want) ??
          teams.find(t => String(t.id).toLowerCase() === want) ??
          null;
        setBackend(found);
        setRoleDefs([...roles.map(roleToWorkbench), ...skills.map(skillToWorkbench)]);
        setSkillPacks(skills);
        if (!found) setErr(`Team "${teamName}" not found in the template library.`);
      } catch (e) {
        if (!dead) setErr(String(e));
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => { dead = true; };
  }, [teamName]);

  // Esc closes the popup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(4,6,12,0.62)", backdropFilter: "blur(3px)",
        display: "flex", alignItems: "stretch", justifyContent: "center", padding: "26px 28px",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          flex: 1, maxWidth: 1480, display: "flex", flexDirection: "column", minHeight: 0,
          background: "var(--bg-panel)", border: "1px solid var(--border-strong)",
          borderRadius: 14, boxShadow: "0 24px 80px rgba(0,0,0,0.55)", padding: 14,
        }}
      >
        {loading ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-muted)", fontSize: 13 }}>
            Loading the team workbench…
          </div>
        ) : err || !backend ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
            <div style={{ color: "var(--fg-muted)", fontSize: 13, maxWidth: 420, textAlign: "center" }}>{err ?? "Could not open the workbench."}</div>
            <button onClick={onClose}
              style={{ background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", color: "var(--fg)", borderRadius: 8, height: 32, padding: "0 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              Close
            </button>
          </div>
        ) : (
          <TeamWorkbench
            backend={backend}
            roleDefs={roleDefs}
            skillPacks={skillPacks}
            models={models}
            accountsStatus={accountsStatus}
            onClose={onClose}
            onSaved={(newName) => { onSaved?.(newName); onClose(); }}
            onOpenSkillLibrary={onClose}
          />
        )}
      </div>
    </div>
  );
}
