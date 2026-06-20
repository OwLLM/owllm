// StudioPage — ported from LLM/desktop_app/pages/agent_studio_page.py
// (AgentStudioPage._build_ui, line 1010) and LLM/desktop_app/widgets/
// team_grid_view.py (TeamGridView + TeamDetailPanel).
//
// Two views toggled at the top:
//
//   🧩 Teams (default)        🤖 Agents
//   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€         â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//   Gallery grid of team       Gallery grid of agent definitions
//   templates from             from agent_definitions.list_all_definitions
//   LLM/core/agents/teams/*.json
//
// Team metadata is loaded at mount from the native list_team_templates /
// list_agent_roles Tauri commands — those walk LLM/core/agents/teams/
// (built-in JSONs) and LLM/core/agents/roles/ (built-in YAMLs) plus the
// user-saved overrides under LLM/data/. No more baked arrays.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import SkillLibraryDialog from "./SkillLibraryDialog";
import TeamWorkbench from "./TeamWorkbench";
import { type ModelInfo, type AccountsStatusLite } from "./ModelPicker";
import IconPickerDialog, {
  setStudioAgentIconOverride,
  loadStudioOverrides,
} from "./IconPickerDialog";

const ICONS = "/Page_icons";
const AGENT_ICON_DIR = `${ICONS}/Agents`;

// owl:<basename> resolves to /Page_icons/Agents/<basename>.png for
// agent owls. A handful of team-level owls (owl_agentic, owl_server,
// owl_studio_square, …) live one level up at /Page_icons/<basename>.png
// instead — keep them in a whitelist so the resolver picks the right
// directory.
const TOPLEVEL_OWLS = new Set([
  "owl_agentic", "owl_AgenticTeam", "owl_FineTuning", "owl_FineTuning2",
  "owl_Gamifier", "owl_Gamify", "owl_chat", "owl_chat2", "owl_chat3",
  "owl_coding", "owl_coding2", "owl_defence", "owl_download",
  "owl_llm_studio_transparent", "owl_models", "owl_ready", "owl_server",
  "owl_sleeping", "owl_startup", "owl_startup1", "owl_studio_square",
  "owl_studio_square1", "owl_thunder", "owl_tools", "owl_training",
]);
export function owlSrc(iconRef: string): string {
  if (iconRef.startsWith("owl:")) {
    const name = iconRef.slice(4);
    if (TOPLEVEL_OWLS.has(name)) return `${ICONS}/${name}.png`;
    return `${AGENT_ICON_DIR}/${name}.png`;
  }
  return iconRef;
}

// agent_canvas._display_label / agent_studio_page._display_label —
// "product_studio.product_owner" → "Product Owner". Acronyms uppercased.
const _ACRONYMS = new Set(["ux","ui","api","mcp","gpu","be","fe","qa","cli","sql","db"]);
export function displayLabel(fullName: string): string {
  const short = fullName.includes(".") ? fullName.split(".").pop()! : fullName;
  if (!short) return fullName;
  const words: string[] = [];
  for (const raw of short.replace(/-/g, "_").split("_")) {
    const w = raw.trim();
    if (!w) continue;
    words.push(_ACRONYMS.has(w.toLowerCase())
      ? w.toUpperCase()
      : w[0].toUpperCase() + w.slice(1));
  }
  return words.join(" ") || fullName;
}

// Category accent strip colours — verbatim from
// team_grid_view.py:49 (_CATEGORY_ACCENT).
const CATEGORY_ACCENT: Record<string, string> = {
  Personal:  "#74a4ff",
  Knowledge: "#c08aff",
  Software:  "var(--accent)",
  Ops:       "#ffb56a",
  Other:     "#9aa0a6",
  Custom:    "#ff7ed1",
};
// Base-role → default owl icon. Mirrors what apply_to_label falls back
// to when an agent spec has no explicit `icon` (the base role's icon
// from builtin_roles()). Hand-tabulated from the team JSONs + the owl
// PNGs actually on disk in icons/Page_icons/Agents/.
const BASE_OWL: Record<string, string> = {
  orchestrator:  "owl:owl_orchestrator1",
  coder:         "owl:owl_coder",
  critic:        "owl:owl_critic",
  researcher:    "owl:owl_researcher",
  operator:      "owl:owl_operator",
  documentation: "owl:owl_documentation",
  devops:        "owl:owl_SSH",         // devops role → SSH owl asset
  webapp:        "owl:owl_webapp",
  assistant:     "owl:owl_asssitant",
};
export function resolveAgentIcon(icon: string | null | undefined, base: string | null | undefined): string {
  if (icon) return icon;
  if (base && BASE_OWL[base]) return BASE_OWL[base];
  return "owl:owl_asssitant";
}

// ---------------------------------------------------------------------
// Data — baked from LLM/core/agents/teams/*.json (17 templates).
// ---------------------------------------------------------------------
type AgentSpec = { name: string; base: string; icon?: string | null };
type TeamVisibility = "recommended" | "more" | "examples" | "legacy" | "custom";
type McpPackServer = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
};
type McpPack = {
  summary: string;
  risk: "read_only" | "approval_required" | "dangerous";
  servers: McpPackServer[];
  approvalRequired: string[];
};
type McpPackInstallResult = {
  added: string[];
  updated: string[];
  uvInstalled: boolean;
  configPath: string;
};
type Team = {
  name: string;
  display: string;
  category: string;
  icon: string;
  description: string;
  agents: AgentSpec[];
  edges: { source: string; target: string }[];
  requiredMcp: string[];
  visibility: TeamVisibility;
  workflowRank: number;
  mcpPack: McpPack | null;
  builtIn: boolean;
};

const TEAMS_FALLBACK: Team[] = [];   // populated at mount from list_team_templates
const RECOMMENDED_TEAM_RANK: Record<string, number> = {
  code_artisan: 10,
  product_studio: 20,
  research_lab: 30,
  secretary: 40,
  n8n_workflow_builder: 50,
  data_analyst: 60,
  writers_room: 70,
};
const TEAM_SECTION_ORDER = ["recommended", "more", "examples", "legacy", "custom"] as const;
const TEAM_SECTION_LABEL: Record<TeamVisibility, string> = {
  recommended: "Recommended workflows",
  more: "More workflows",
  examples: "Examples / needs connectors",
  legacy: "Legacy templates",
  custom: "Custom",
};
const TEAM_SECTION_ACCENT: Record<TeamVisibility, string> = {
  recommended: "var(--accent)",
  more: "#74a4ff",
  examples: "#9aa0a6",
  legacy: "#7a8a9c",
  custom: "#ff7ed1",
};
function normalizeVisibility(value: unknown, builtIn: boolean, teamName: string): TeamVisibility {
  if (!builtIn) return "custom";
  if (value === "recommended" || value === "more" || value === "examples" || value === "legacy") return value;
  return RECOMMENDED_TEAM_RANK[teamName] ? "recommended" : "examples";
}
function normalizeMcpPack(value: unknown): McpPack | null {
  const raw = value as any;
  if (!raw || !Array.isArray(raw.servers) || raw.servers.length === 0) return null;
  return {
    summary: typeof raw.summary === "string" ? raw.summary : "Install the MCP servers this workflow expects.",
    risk: raw.risk === "dangerous" || raw.risk === "approval_required" ? raw.risk : "read_only",
    servers: raw.servers
      .filter((s: any) => typeof s?.name === "string" && typeof s?.command === "string")
      .map((s: any) => ({
        name: s.name,
        command: s.command,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: s.env && typeof s.env === "object" ? s.env : {},
        enabled: s.enabled !== false,
      })),
    approvalRequired: Array.isArray(raw.approval_required) ? raw.approval_required.map(String) : [],
  };
}

// Built-in agent definitions (mirrors core/agents/agent_definitions.py
// list_all_definitions). Real metadata will arrive via
// /v1/agents/definitions later.
type AgentDef = {
  name: string;
  icon: string;
  description: string;
  builtIn: boolean;
  isSkill?: boolean;
  canDispatch?: boolean;
  /// Built-in tools the agent is allowed to call. `null` (or absent)
  /// in the role yaml means "all builtins"; we map that to undefined
  /// so the UI can render "All builtins".
  tools?: string[] | null;
  /// MCP tools (post-namespacing). Same null semantics as `tools`.
  mcpTools?: string[] | null;
  systemPrompt?: string;
  temperature?: number;
  defaultModelId?: string;
  /// SKILL.md pack ids associated with this agent (Studio agent card →
  /// Skills). Persisted on the role JSON as `extra_skills`; the dispatch
  /// merges them into the agent's effective skills (RoleData.skillAllowlist).
  extraSkills?: string[];
  /// For SKILL.md packs: path on disk to the SKILL.md file so the
  /// Studio "Reveal in Finder" affordance can resolve it.
  path?: string;
};
const AGENTS_FALLBACK: AgentDef[] = [];   // populated at mount from list_agent_roles

// ---------------------------------------------------------------------
// Visual building blocks
// ---------------------------------------------------------------------

// Toggle — mirrors _VIEW_TAB_LEFT_STYLE / _RIGHT_STYLE in
// agent_studio_page.py:1551-1580. Checked state is #28406b on #fff
// with #3a5fa0 border, idle is rgba(255,255,255,0.04).
type StudioView = "teams" | "agents" | "skills";
function ViewToggle({ view, onChange }: {
  view: StudioView; onChange: (v: StudioView) => void;
}) {
  const base: React.CSSProperties = {
    minHeight: 36,
    padding: "0 22px",
    fontSize: 12,
    fontWeight: 600,
    background: "var(--bg-surface)",
    color: "var(--fg-muted)",
    border: "1px solid var(--border)",
    cursor: "pointer",
    letterSpacing: 0.3,
  };
  // Agents and Skills are DIFFERENT things and now live in separate tabs:
  // Agents = roles you build teams from; Skills = SKILL.md capability packs
  // you equip onto an agent.
  const tabs: { id: StudioView; label: string }[] = [
    { id: "teams",  label: "🧩 Teams" },
    { id: "agents", label: "🤖 Agents" },
    { id: "skills", label: "📚 Skills" },
  ];
  return (
    <div style={{ display: "flex", gap: 0, padding: "4px 0" }}>
      {tabs.map((t, i) => {
        const on = view === t.id;
        const first = i === 0, last = i === tabs.length - 1;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              ...base,
              marginLeft: first ? 0 : -1,           // overlap so borders don't double
              position: "relative",
              zIndex: on ? 1 : 0,
              borderTopLeftRadius: first ? 9 : 0, borderBottomLeftRadius: first ? 9 : 0,
              borderTopRightRadius: last ? 9 : 0, borderBottomRightRadius: last ? 9 : 0,
              background: on ? "#28406b" : base.background,
              color:      on ? "#fff" : base.color,
              borderColor: on ? "#3a5fa0" : "var(--border)",
            }}
          >{t.label}</button>
        );
      })}
    </div>
  );
}

function OnboardingBanner({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <div style={{
      background: "linear-gradient(90deg, #2a3a6a 0%, #1f2a4a 100%)",
      borderRadius: 10,
      padding: "10px 8px 10px 14px",
      display: "flex",
      alignItems: "center",
      gap: 10,
    }}>
      <span style={{ color: "#dde3ff", fontSize: 12, flex: 1 }}>
        👋 <b>New here?</b> Install Anthropic's official skill pack
        (PDF, Excel, Word helpers — drop-in compatible) to give your
        agents pro-grade capabilities out of the box.
      </span>
      <button
        onClick={onOpen}
        style={{
          background: "var(--accent)", color: "var(--fg-strong)", border: "none",
          borderRadius: 8, padding: "6px 14px", fontWeight: 600,
          fontSize: 12, cursor: "pointer",
        }}
      >Open Skill Library</button>
      <button
        onClick={onDismiss}
        title="Don't show again"
        style={{
          background: "transparent", color: "#dde3ff",
          border: "none", fontSize: 14, cursor: "pointer",
          width: 28, height: 28,
        }}
      >✕</button>
    </div>
  );
}

// SearchBar — Qt's Studio doesn't ship one explicitly, but the
// gallery's _wrappable() helper and the user-facing "filter the
// catalogue" need is what's missing in the React port. Lightweight
// client-side string match on display name + description + category.
function SearchBar({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1,
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          color: "var(--fg)",
          borderRadius: 8,
          padding: "8px 12px",
          fontSize: 13,
          outline: "none",
        }}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          title="Clear"
          style={{
            background: "transparent", color: "var(--fg-muted)",
            border: "1px solid var(--border)",
            borderRadius: 8, padding: "6px 10px", cursor: "pointer",
          }}
        >✕</button>
      )}
    </div>
  );
}

// TeamCard — mirrors team_grid_view.py:64 TeamCard. Category-coloured
// accent strip on the left, agent mini-avatars row, MCP chips, CUSTOM
// tag in the corner for non-built-ins, selected-state outline.
function TeamCard({
  team, selected, onClick,
}: {
  team: Team; selected: boolean; onClick: () => void;
}) {
  const accent = CATEGORY_ACCENT[team.category] ?? "#74a4ff";
  const border = selected ? "rgba(124,150,255,0.95)" : "var(--bg-surface)";
  return (
    <div
      onClick={onClick}
      style={{
        minHeight: 180,
        maxHeight: 220,
        cursor: "pointer",
        background: "linear-gradient(135deg, #1c2236 0%, #0d1019 100%)",
        // 3px accent strip on the left — category colour. (Qt sets the
        // hover border-color to the accent; we hint it via boxShadow.)
        borderLeft: `3px solid ${accent}`,
        border: `1px solid ${border}`,
        borderRadius: 14,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: selected
          ? `0 0 0 1px ${accent}88, 0 4px 12px rgba(0,0,0,0.5)`
          : "0 4px 18px rgba(0,0,0,0.43)",
        transition: "border-color 0.12s",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <img src={owlSrc(team.icon)} style={{ width: 48, height: 48, objectFit: "contain", flexShrink: 0 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--fg-strong)", fontWeight: 700, fontSize: 13 }}>{team.display}</div>
          <div style={{ fontSize: 10, letterSpacing: 0.6 }}>
            <span style={{ color: accent }}>{team.category.toUpperCase()}</span>
            <span style={{ color: "var(--fg-muted)" }}>  ·  {team.agents.length} agents</span>
          </div>
        </div>
        {!team.builtIn && (
          <span style={{
            color: "#ff7ed1", background: "rgba(255,126,209,0.10)",
            borderRadius: 5, padding: "2px 6px",
            fontSize: 9, letterSpacing: 0.8,
          }}>CUSTOM</span>
        )}
        {team.builtIn && team.visibility === "recommended" && (
          <span style={{
            color: "#a8b8ff", background: "rgba(116,164,255,0.12)",
            borderRadius: 5, padding: "2px 6px",
            fontSize: 9, letterSpacing: 0.8,
          }}>CORE</span>
        )}
      </div>

      <div style={{
        color: "var(--fg-muted)", fontSize: 11, lineHeight: 1.45,
        maxHeight: 48,
        display: "-webkit-box",
        WebkitLineClamp: 3,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}>{team.description}</div>

      {/* Agent mini-avatars row — first 6 + "+N" overflow */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {team.agents.slice(0, 6).map(a => (
          <img
            key={a.name}
            src={owlSrc(resolveAgentIcon(a.icon, a.base))}
            title={displayLabel(a.name)}
            style={{ width: 24, height: 24, objectFit: "contain" }}
          />
        ))}
        {team.agents.length > 6 && (
          <span style={{ color: "var(--fg-muted)", fontSize: 10 }}>
            +{team.agents.length - 6}
          </span>
        )}
      </div>

      {/* MCP needs chips — first 4 + "+N" overflow */}
      {team.requiredMcp.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          {team.mcpPack && (
            <span style={{
              color: "#a8f0d0",
              background: "rgba(95,210,160,0.10)",
              borderRadius: 4, padding: "1px 6px",
              fontSize: 9,
            }}>pack</span>
          )}
          {team.requiredMcp.slice(0, 4).map(m => (
            <span key={m} style={{
              color: "var(--fg-muted)",
              background: "var(--bg-surface)",
              borderRadius: 4, padding: "1px 6px",
              fontSize: 9,
            }}>{m.replace(/^mcp\./, "")}</span>
          ))}
          {team.requiredMcp.length > 4 && (
            <span style={{ color: "var(--fg-muted)", fontSize: 9 }}>
              +{team.requiredMcp.length - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// "Create your own team" tile — team_grid_view.py:230 _build_create_inner.
// Dashed border, centred ＋ + title + sub.
function CreateTeamCard({ onClick }: { onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        minHeight: 180,
        cursor: "pointer",
        background: "rgba(124,150,255,0.06)",
        border: "2px dashed rgba(124,150,255,0.55)",
        borderRadius: 14,
        padding: 20,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        textAlign: "center",
      }}
    >
      <div style={{ color: "#a8b8ff", fontSize: 36, fontWeight: 700, lineHeight: 1 }}>＋</div>
      <div style={{ color: "#dde3ff", fontSize: 12, fontWeight: 700 }}>Create your own team</div>
      <div style={{ color: "var(--fg-muted)", fontSize: 11 }}>Pick agents, name it, save it as a template.</div>
    </div>
  );
}

// TeamsGrid — groups teams by product workflow tier so the default view
// starts with the useful, curated paths instead of every demo template.
// The "Build your own" section always renders last.
function TeamsGrid({ teams, selected, onSelect, onCreate, showExamples, onToggleExamples }: {
  teams: Team[];
  selected: string | null;
  onSelect: (name: string) => void;
  onCreate: () => void;
  showExamples: boolean;
  onToggleExamples: () => void;
}) {
  const groups = useMemo(() => {
    const g: Partial<Record<TeamVisibility, Team[]>> = {};
    for (const t of teams) {
      const section = t.builtIn ? t.visibility : "custom";
      (g[section] ??= []).push(t);
    }
    for (const k in g) {
      g[k as TeamVisibility]!.sort((a, b) =>
        (a.workflowRank - b.workflowRank) ||
        a.display.toLowerCase().localeCompare(b.display.toLowerCase())
      );
    }
    return g;
  }, [teams]);

  const exampleCount = groups.examples?.length ?? 0;
  const orderedSections = TEAM_SECTION_ORDER.filter(section => {
    if ((groups[section]?.length ?? 0) === 0) return false;
    return showExamples || section !== "examples";
  });

  return (
    <div style={{
      flex: 1, overflow: "auto", paddingRight: 8, paddingBottom: 12,
      display: "flex", flexDirection: "column", gap: 18,
    }}>
      {orderedSections.map(section => {
        const accent = TEAM_SECTION_ACCENT[section];
        const sectionTeams = groups[section] ?? [];
        return (
          <div key={section}>
            <div style={{
              fontSize: 10, color: accent, textTransform: "uppercase",
              letterSpacing: 1.2, marginBottom: 8, fontWeight: 700,
              padding: "0 2px",
            }}>{TEAM_SECTION_LABEL[section]}</div>
            <div style={{
              display: "grid",
              // Qt _COLS = 3 — but we still let the grid wrap on
              // narrow viewports via auto-fill.
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 12,
            }}>
              {sectionTeams.map(t => (
                <TeamCard
                  key={t.name}
                  team={t}
                  selected={selected === t.name}
                  onClick={() => onSelect(t.name)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {!showExamples && exampleCount > 0 && (
        <div>
          <div style={{
            fontSize: 10, color: TEAM_SECTION_ACCENT.examples, textTransform: "uppercase",
            letterSpacing: 1.2, marginBottom: 8, fontWeight: 700,
            padding: "0 2px",
          }}>{TEAM_SECTION_LABEL.examples}</div>
          <button
            onClick={onToggleExamples}
            style={{
              width: "100%",
              minHeight: 46,
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-muted)",
              border: "1px dashed rgba(168,184,255,0.35)",
              borderRadius: 10,
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
              padding: "0 14px",
            }}
          >
            Show {exampleCount} example templates for specialized connectors
          </button>
        </div>
      )}

      {/* BUILD YOUR OWN — always last, mirrors _build_create_section. */}
      <div>
        <div style={{
          fontSize: 10, color: "#a8b8ff", textTransform: "uppercase",
          letterSpacing: 1.2, marginBottom: 8, fontWeight: 700,
          padding: "0 2px",
        }}>Build your own</div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
        }}>
          <CreateTeamCard onClick={onCreate} />
        </div>
      </div>
    </div>
  );
}

// Mini agent card inside the detail panel — team_grid_view.py:432
// _AgentMiniCard. Card-wide icon tile, centered name, LEADER ribbon
// for orchestrator/can_dispatch.
function AgentMiniCard({ spec }: { spec: AgentSpec }) {
  const isLeader = spec.base === "orchestrator";
  const accent = isLeader ? "#ffc060" : "var(--bg-surface)";
  return (
    <div style={{
      position: "relative",
      background: "linear-gradient(135deg, #161b29 0%, #0c0f17 100%)",
      border: `1px solid ${accent}`,
      borderRadius: 10,
      padding: 10,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{
        height: 110,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <img
          src={owlSrc(resolveAgentIcon(spec.icon, spec.base))}
          style={{ maxWidth: "82%", maxHeight: "82%", objectFit: "contain" }}
        />
      </div>
      <div style={{
        color: "#dde3ff", fontSize: 11, fontWeight: 700,
        textAlign: "center",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }} title={spec.name}>
        {(() => {
          const d = displayLabel(spec.name);
          return d.length > 22 ? d.slice(0, 21) + "…" : d;
        })()}
      </div>
      {isLeader && (
        <span style={{
          position: "absolute", top: 8, right: 8,
          color: "#ffc060", background: "rgba(40,30,8,0.85)",
          border: "1px solid rgba(255,192,96,0.6)",
          borderRadius: 4, padding: "1px 6px",
          fontSize: 8, letterSpacing: 0.6,
        }}>LEADER</span>
      )}
    </div>
  );
}

// Detail panel — team_grid_view.py:632 TeamDetailPanel. Header
// (icon + title + category·N agents·M connections·BUILT-IN/CUSTOM
// chip), description, AGENTS grid, ROUTING list, MCP NEEDED chips,
// Delete (custom only) + primary CTA.
function TeamDetailPanel({
  team, onCreateProject, onOpenWorkbench, onDuplicateTemplate, onDeleteTemplate,
  onInstallMcpPack, mcpInstallStatus, installingMcpPack,
}: {
  team: Team | null;
  onCreateProject: (name: string) => void;
  onOpenWorkbench: (name: string) => void;
  onDuplicateTemplate: (name: string) => void;
  onDeleteTemplate: (name: string) => void;
  onInstallMcpPack: (team: Team) => void;
  mcpInstallStatus: string | null;
  installingMcpPack: boolean;
}) {
  if (!team) {
    return (
      <div style={{
        flex: 1,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: 12, padding: 24,
        color: "var(--fg-subtle)", fontSize: 12,
        display: "flex", alignItems: "center", justifyContent: "center",
        textAlign: "center",
      }}>
        Pick a team from the grid to see the agents it ships with,<br />
        how they're wired together, and which MCP servers it needs.
      </div>
    );
  }

  const accent = CATEGORY_ACCENT[team.category] ?? "#9aa0a6";

  return (
    <div style={{
      flex: 1,
      background: "var(--bg-elevated)",
      border: "1px solid var(--border)",
      borderRadius: 12, padding: 20,
      display: "flex", flexDirection: "column", gap: 12,
      overflow: "auto",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{
          width: 72, height: 72,
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <img src={owlSrc(team.icon)} style={{ width: 64, height: 64, objectFit: "contain" }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "var(--fg-strong)" }}>{team.display}</div>
          <div style={{ fontSize: 10, letterSpacing: 0.6 }}>
            <span style={{ color: accent }}>{team.category.toUpperCase()}</span>
            <span style={{ color: "var(--fg-muted)" }}>
              {"  ·  "}{team.agents.length} agents
              {"  ·  "}{team.edges.length} connections
              {"  ·  "}
            </span>
            <span style={{ color: team.builtIn ? "#9aa0a6" : "#ff7ed1" }}>
              {team.builtIn ? "BUILT-IN" : "CUSTOM"}
            </span>
          </div>
        </div>
      </div>

      {/* Description */}
      {team.description && (
        <div style={{ color: "var(--fg)", fontSize: 12, lineHeight: 1.6 }}>
          {team.description}
        </div>
      )}

      {/* AGENTS */}
      <div style={{
        color: "var(--fg-muted)", fontSize: 10, letterSpacing: 1,
        paddingTop: 6, fontWeight: 700,
      }}>AGENTS</div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gap: 10,
      }}>
        {team.agents.map(a => <AgentMiniCard key={a.name} spec={a} />)}
      </div>

      {/* ROUTING — src → dst lines, monospace */}
      {team.edges.length > 0 && (
        <>
          <div style={{
            color: "var(--fg-muted)", fontSize: 10, letterSpacing: 1,
            paddingTop: 6, fontWeight: 700,
          }}>ROUTING</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {team.edges.map((e, i) => (
              <div key={i} style={{
                color: "var(--fg-muted)",
                fontFamily: "'Consolas','JetBrains Mono',monospace",
                fontSize: 11,
              }}>
                {e.source}  →  {e.target}
              </div>
            ))}
          </div>
        </>
      )}

      {/* MCP NEEDED */}
      {team.requiredMcp.length > 0 && (
        <>
          <div style={{
            color: "var(--fg-muted)", fontSize: 10, letterSpacing: 1,
            paddingTop: 6, fontWeight: 700,
          }}>MCP NEEDED</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {team.requiredMcp.map(m => (
              <span key={m} style={{
                color: "#dde3ff", background: "rgba(116,164,255,0.12)",
                borderRadius: 6, padding: "3px 8px", fontSize: 11,
              }}>{m.replace(/^mcp\./, "")}</span>
            ))}
          </div>
        </>
      )}

      {team.mcpPack && (
        <div style={{
          border: "1px solid rgba(116,164,255,0.28)",
          background: "rgba(116,164,255,0.08)",
          borderRadius: 10,
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}>
          <div style={{
            color: "#a8b8ff", fontSize: 10, letterSpacing: 1,
            fontWeight: 700, textTransform: "uppercase",
          }}>MCP PACK</div>
          <div style={{ color: "var(--fg)", fontSize: 12, lineHeight: 1.5 }}>
            {team.mcpPack.summary}
          </div>
          {team.mcpPack.approvalRequired.length > 0 && (
            <div style={{ color: "#ffcf9a", fontSize: 11, lineHeight: 1.4 }}>
              Approval gated: {team.mcpPack.approvalRequired.join(", ")}
            </div>
          )}
          {mcpInstallStatus && (
            <div style={{ color: "var(--fg-muted)", fontSize: 11, lineHeight: 1.4 }}>
              {mcpInstallStatus}
            </div>
          )}
          <div>
            <button
              onClick={() => onInstallMcpPack(team)}
              disabled={installingMcpPack}
              style={{
                minHeight: 32,
                background: installingMcpPack ? "var(--bg-surface)" : "rgba(116,164,255,0.18)",
                color: "#dde3ff",
                border: "1px solid rgba(116,164,255,0.35)",
                borderRadius: 8,
                padding: "0 12px",
                cursor: installingMcpPack ? "default" : "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >{installingMcpPack ? "Installing..." : "Install MCP pack"}</button>
          </div>
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Actions — Edit / Duplicate / Delete (custom only) on the left,
          primary "+ New project from <name>" on the right. Qt only
          shows Edit/Delete for non-built-ins; Duplicate is a Studio
          affordance the user asked us to add. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* Open Workbench — the 3-pane editor (roster · graph · inspector).
            Works for every team: a built-in opens read-to-customise and Save
            lands a custom copy, so the user can tune any starting point. */}
        <button
          onClick={() => onOpenWorkbench(team.name)}
          title={team.builtIn ? "Open the team workbench — editing a built-in saves a custom copy" : "Open the team workbench"}
          style={{
            minHeight: 34,
            background: "rgba(var(--accent-rgb),0.16)", color: "var(--fg-strong)",
            border: "1px solid rgba(var(--accent-rgb),0.45)", borderRadius: 8, padding: "0 14px",
            cursor: "pointer", fontSize: 12, fontWeight: 700,
          }}
        >⚙ Open Workbench</button>
        <button
          onClick={() => onDuplicateTemplate(team.name)}
          style={{
            minHeight: 34,
            background: "var(--bg-surface)", color: "var(--fg)",
            border: "none", borderRadius: 8, padding: "0 14px",
            cursor: "pointer", fontSize: 12,
          }}
        >Duplicate</button>
        {!team.builtIn && (
          <button
            onClick={() => onDeleteTemplate(team.name)}
            style={{
              minHeight: 34,
              background: "rgba(255,140,140,0.12)", color: "#ff8c8c",
              border: "none", borderRadius: 8, padding: "0 14px",
              cursor: "pointer", fontSize: 12,
            }}
          >Delete</button>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => onCreateProject(team.name)}
          style={{
            minHeight: 38,
            background: "var(--accent)", color: "var(--fg-strong)",
            border: "none", borderRadius: 9, padding: "0 16px",
            fontWeight: 600, fontSize: 12, cursor: "pointer",
          }}
        >+ New project from {team.display}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Agents view — gallery + detail mirror of agent_studio_page.py:1257
// ---------------------------------------------------------------------

// Agent gallery card — mirrors agent_studio_page.py:172 _GalleryCard.
// Fixed 140px height, accent-coloured left border (var(--accent) for
// built-ins/skills, #7a8a9c for plain custom), badges row (BUILT-IN,
// SKILL, LEADER).
function AgentCard({
  agent, selected, onClick,
}: {
  agent: AgentDef; selected: boolean; onClick: () => void;
}) {
  const accent = (agent.builtIn || agent.isSkill) ? "var(--accent)" : "#7a8a9c";
  return (
    <div
      onClick={onClick}
      style={{
        height: 140,
        cursor: "pointer",
        background: selected
          ? "linear-gradient(180deg, #2a3142 0%, #1d212a 100%)"
          : "linear-gradient(180deg, #1a1d27 0%, #14171f 100%)",
        borderLeft: `3px solid ${accent}`,
        borderRadius: 12,
        padding: "12px 16px",
        display: "flex",
        gap: 14,
        boxShadow: selected
          ? "0 4px 12px rgba(var(--accent-rgb),0.18)"
          : "0 2px 6px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{
        width: 56, height: 56, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <img src={owlSrc(agent.icon)} style={{ width: 52, height: 52, objectFit: "contain" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{
            color: "var(--fg-strong)", fontSize: 14, fontWeight: 700,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{displayLabel(agent.name)}</div>
          {agent.builtIn && (
            <span style={{
              color: "#7989ff", background: "rgba(121,137,255,0.15)",
              borderRadius: 6, padding: "2px 8px",
              fontSize: 10, fontWeight: 600, letterSpacing: 0.6,
            }}>BUILT-IN</span>
          )}
          {agent.isSkill && !agent.builtIn && (
            <span style={{
              color: "#7ad3ff", background: "rgba(122,211,255,0.15)",
              borderRadius: 6, padding: "2px 8px",
              fontSize: 10, fontWeight: 600, letterSpacing: 0.6,
            }}>SKILL</span>
          )}
          {agent.canDispatch && (
            <span style={{
              color: "#ffd080", background: "rgba(255,208,128,0.15)",
              borderRadius: 6, padding: "2px 8px",
              fontSize: 10, fontWeight: 600, letterSpacing: 0.6,
            }}>LEADER</span>
          )}
        </div>
        <div style={{
          color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.4,
          maxHeight: 40,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>{agent.description}</div>
      </div>
    </div>
  );
}

// Skill categories — the Skills tab groups packs into colour-coded "containers"
// by purpose (orchestration, design, coding, …) instead of one flat green wall.
// Keyword match on name+description; FIRST match wins, so order = priority.
// Each category carries an accent colour so cards in different containers read
// as visibly different. Unmatched → Other.
const SKILL_CATEGORIES: { key: string; label: string; color: string; match: RegExp }[] = [
  { key: "orchestration", label: "🧭 Orchestration & Planning", color: "#a78bfa", match: /plan|dispatch|orchestrat|brainstorm|subagent|superpower|coordinat|delegat|workflow/i },
  { key: "design",        label: "🎨 Design & Visual",          color: "#f472b6", match: /design|art|brand|canvas|theme|visual|frontend|\bui\b|\bux\b|gif|web.?artifact|colou?r|logo/i },
  { key: "coding",        label: "💻 Coding & Engineering",     color: "#60a5fa", match: /cod(e|ing)|debug|test|\bgit\b|build|review|develop|deploy|lint|refactor|worktree|\bapi\b|mcp|skill/i },
  { key: "docs",          label: "📄 Documents & Content",      color: "#fbbf24", match: /\bdocx?\b|pdf|pptx|xlsx|word|excel|powerpoint|spreadsheet|writ|content|comms|slack|report|markdown|co-?author/i },
  { key: "execution",     label: "⚙ Execution & Verification",  color: "#34d399", match: /execut|verif|finish|complete|ship|release/i },
];
const SKILL_CATEGORY_OTHER = { key: "other", label: "📦 Other", color: "#94a3b8" };
function categorizeSkill(name: string, description: string): string {
  const hay = `${name} ${description}`.toLowerCase();
  for (const c of SKILL_CATEGORIES) if (c.match.test(hay)) return c.key;
  return SKILL_CATEGORY_OTHER.key;
}
function categoryAccent(key: string): string {
  return SKILL_CATEGORIES.find(c => c.key === key)?.color ?? SKILL_CATEGORY_OTHER.color;
}
/// "#rrggbb" → "r,g,b" for rgba() tints.
function rgbOf(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

// SkillCard — a SKILL.md pack rendered as a PACK, deliberately distinct from
// an AgentCard. Tinted with its CATEGORY accent (left rail + icon tile + label
// + selected glow) so packs in different containers read as visibly different
// instead of one flat green wall. Shows context cost + tools granted.
function SkillCard({ skill, selected, onClick, accent }: {
  skill: AgentDef; selected: boolean; onClick: () => void; accent: string;
}) {
  const ctxK = Math.max(1, Math.round((skill.systemPrompt?.length ?? 0) / 4 / 1000));
  const tools = Array.isArray(skill.tools) ? skill.tools : [];
  const rgb = rgbOf(accent);
  return (
    <div
      onClick={onClick}
      style={{
        cursor: "pointer",
        position: "relative",
        background: selected
          ? `linear-gradient(135deg, rgba(${rgb},0.20) 0%, rgba(${rgb},0.06) 100%)`
          : `linear-gradient(135deg, rgba(${rgb},0.08) 0%, var(--bg-surface) 70%)`,
        border: `1px solid ${selected ? accent : `rgba(${rgb},0.35)`}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: 12, padding: "12px 14px",
        display: "flex", flexDirection: "column", gap: 8,
        boxShadow: selected ? `0 6px 18px rgba(${rgb},0.30)` : "0 2px 6px rgba(0,0,0,0.35)",
        transition: "box-shadow 0.15s, border-color 0.15s, transform 0.1s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 40, height: 40, flexShrink: 0, fontSize: 21,
          display: "flex", alignItems: "center", justifyContent: "center",
          borderRadius: 10, background: `rgba(${rgb},0.16)`, border: `1px solid rgba(${rgb},0.45)`,
        }}>📚</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--fg-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{skill.name}</div>
          <div style={{ fontSize: 10, color: accent, letterSpacing: 0.6, fontWeight: 700 }}>SKILL PACK · ~{ctxK}k ctx</div>
        </div>
      </div>
      <div style={{
        fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.4, minHeight: 34,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
      }}>{skill.description || "—"}</div>
      {tools.length > 0 && (
        <div style={{ fontSize: 10.5, color: "var(--fg-subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          grants {tools.length} tool{tools.length > 1 ? "s" : ""}: {tools.slice(0, 4).join(", ")}{tools.length > 4 ? "…" : ""}
        </div>
      )}
    </div>
  );
}

// SkillDetailPanel — the RIGHT pane when a SKILL is selected. Shows the skill's
// OWN info (what it does, the tools it grants, its SKILL.md instructions, source)
// — NOT the agent editor (a skill has no model / temperature / can-dispatch).
function SkillDetailPanel({ skill }: { skill: AgentDef | null }) {
  if (!skill) {
    return (
      <div style={{
        flex: 1, background: "var(--bg-elevated)", border: "1px solid var(--border)",
        borderRadius: 12, padding: 24, color: "var(--fg-subtle)", fontSize: 12,
        display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center",
      }}>
        Click a skill on the left to see what it does,<br />the tools it grants, and its instructions.
      </div>
    );
  }
  const accent = categoryAccent(categorizeSkill(skill.name, skill.description ?? ""));
  const rgb = rgbOf(accent);
  const body = skill.systemPrompt ?? "";
  const ctxK = Math.max(1, Math.round(body.length / 4 / 1000));
  const tools = Array.isArray(skill.tools) ? skill.tools : [];
  const mcp = Array.isArray(skill.mcpTools) ? skill.mcpTools : [];
  const lbl: React.CSSProperties = { fontSize: 10, color: "var(--fg-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 };
  const chip: React.CSSProperties = { fontSize: 11, background: `rgba(${rgb},0.12)`, border: `1px solid rgba(${rgb},0.32)`, borderRadius: 6, padding: "2px 8px", color: "var(--fg)" };
  return (
    <div style={{
      flex: 1, background: "var(--bg-elevated)", border: `1px solid rgba(${rgb},0.4)`,
      borderRadius: 12, padding: 18, display: "flex", flexDirection: "column", gap: 14, overflow: "auto",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 52, height: 52, fontSize: 28, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, background: `rgba(${rgb},0.16)`, border: `1px solid rgba(${rgb},0.45)` }}>📚</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "var(--fg-strong)" }}>{skill.name}</div>
          <div style={{ fontSize: 11, color: accent, fontWeight: 700, letterSpacing: 0.5 }}>SKILL PACK · ~{ctxK}k ctx</div>
        </div>
      </div>

      <div>
        <div style={lbl}>What it does</div>
        <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.55, marginTop: 5 }}>{skill.description || "No description provided."}</div>
      </div>

      {(tools.length > 0 || mcp.length > 0) && (
        <div>
          <div style={lbl}>Grants these tools</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
            {tools.map(t => <span key={t} style={chip}>⚙ {t}</span>)}
            {mcp.map(t => <span key={`m-${t}`} style={chip}>🔌 {t}</span>)}
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, color: "var(--fg)", background: `rgba(${rgb},0.08)`, border: `1px solid rgba(${rgb},0.25)`, borderRadius: 8, padding: "9px 11px", lineHeight: 1.55 }}>
        To use this skill: <b>Agents → pick an agent → 📚 Skills</b> (or a team's Workbench) and tick it.
        At runtime the agent loads these instructions only when a task needs them.
      </div>

      <div style={{ minHeight: 0 }}>
        <div style={lbl}>Instructions · SKILL.md body ({body.length.toLocaleString()} chars)</div>
        <pre style={{
          marginTop: 6, fontSize: 11.5, color: "var(--fg)", background: "var(--bg-surface)",
          border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px",
          whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 360, overflow: "auto",
          fontFamily: "inherit", lineHeight: 1.55,
        }}>{body || "(no body)"}</pre>
      </div>

      {skill.path && <div style={{ fontSize: 10, color: "var(--fg-subtle)", wordBreak: "break-all" }}>📁 {skill.path}</div>}
    </div>
  );
}

// Helpers for AgentDetailPanel — chip row + small stat tile.

type ChipState =
  | { kind: "all" }    // unrestricted (allowlist is null)
  | { kind: "empty" }  // explicit []  (nothing granted)
  | { kind: "list"; items: string[] };

function chipsFromAllowlist(list: string[] | null | undefined): ChipState {
  if (list === null || list === undefined) return { kind: "all" };
  if (list.length === 0) return { kind: "empty" };
  return { kind: "list", items: list };
}

function ChipRow({ chips, empty, allText, accent }: {
  chips: ChipState;
  empty: string;
  allText: string;
  accent: string;
}) {
  const text = (s: string, c: string) => ({
    background: `rgba(${hexToRgb(accent)},0.10)`,
    color: c,
    border: `1px solid rgba(${hexToRgb(accent)},0.30)`,
    borderRadius: 999,
    padding: "3px 10px",
    fontSize: 11, fontWeight: 600,
    fontFamily: "Consolas, monospace",
    display: "inline-flex", alignItems: "center", gap: 4,
  });
  if (chips.kind === "all") {
    return <div style={{ fontSize: 12, color: "var(--fg-muted)", fontStyle: "italic" }}>{allText}</div>;
  }
  if (chips.kind === "empty") {
    return <div style={{ fontSize: 12, color: "var(--fg-muted)", fontStyle: "italic" }}>{empty}</div>;
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {chips.items.map(t => (
        <span key={t} style={text(t, accent)}>{t}</span>
      ))}
    </div>
  );
}

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r},${g},${b}`;
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      background: "var(--bg-surface)",
      border: "1px solid var(--border)",
      borderRadius: 8, padding: "8px 10px",
      minWidth: 0,
    }}>
      <div style={{ fontSize: 10, color: "var(--fg-muted)", letterSpacing: 0.6, textTransform: "uppercase" }}>{label}</div>
      <div style={{
        fontSize: 12, color: "var(--fg)", marginTop: 4,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{value}</div>
    </div>
  );
}

// AgentDetailPanel — mirrors agent_studio_page.py:426 _EditorPanel
// at a stub level. The full editor (name/desc/system-prompt/tools/
// voice/MCP) needs /v1/agents endpoints to be useful; for now we
// surface the read-only summary + the action buttons (Save / Duplicate /
// Delete) so the UI matches Qt's affordances.
// Aggregated MCP tool from a running server, mirrors the Rust struct.
type AggregatedMcpTool = {
  qualifiedName: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: unknown;
};

function AgentDetailPanel({
  agent,
  availableSkills,
  onSave,
  onDuplicate,
  onDelete,
  onPickIcon,
}: {
  agent: AgentDef | null;
  /// Installed SKILL.md packs (cheap metadata) for the per-agent Skills
  /// checklist — the "open an agent → tick the skills it gets" control.
  availableSkills: { id: string; name: string; description: string; ctx: number }[];
  // onSave receives the edited fields the user has changed. Parent
  // calls the Rust save_agent_definition with the merged JSON.
  onSave: (edits: {
    mcpAllowlist: string[] | null;
    canDispatch: boolean;
    temperature: number | null;
    defaultModelId: string;
    extraSkills: string[];
  }) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  // Avatar click — opens the IconPickerDialog for this agent. Lives on
  // the detail panel (right column) instead of the gallery card so it
  // doesn't fight the card's select-on-click.
  onPickIcon: (agentName: string) => void;
}) {
  // Available MCP tools across every running MCP server. Re-fetched
  // whenever the panel mounts or the user clicks a different agent so
  // newly-started servers appear without a manual refresh.
  const [availableMcp, setAvailableMcp] = useState<AggregatedMcpTool[]>([]);
  // Draft mcp allowlist — initialised from the agent's persisted set.
  // null = "all available MCP tools (no restriction)", which is the
  // role yaml convention. [] = explicitly no MCP tools.
  const [draftMcp, setDraftMcp] = useState<string[] | null>(agent?.mcpTools ?? null);
  // Editable behavioural settings — Can dispatch / Temperature /
  // Default model. Round-tripped through onSave; null/empty means
  // "use the runtime default" (omitted from the JSON entirely).
  const [draftCanDispatch, setDraftCanDispatch] = useState<boolean>(agent?.canDispatch ?? false);
  const [draftTemperature, setDraftTemperature] = useState<string>(
    agent?.temperature != null ? String(agent.temperature) : ""
  );
  const [draftModelId, setDraftModelId] = useState<string>(agent?.defaultModelId ?? "");
  // Draft per-agent skills (SKILL.md pack ids). Persisted to the role JSON's
  // `extra_skills`; the dispatch merges them into the agent's effective skills.
  const [draftSkills, setDraftSkills] = useState<string[]>(agent?.extraSkills ?? []);
  // Re-seed every editable field when the user clicks a different card.
  useEffect(() => {
    setDraftMcp(agent?.mcpTools ?? null);
    setDraftCanDispatch(agent?.canDispatch ?? false);
    setDraftTemperature(agent?.temperature != null ? String(agent.temperature) : "");
    setDraftModelId(agent?.defaultModelId ?? "");
    setDraftSkills(agent?.extraSkills ?? []);
  }, [agent?.name]);
  useEffect(() => {
    invoke<AggregatedMcpTool[]>("mcp_list_all_tools")
      .then(setAvailableMcp)
      .catch(() => setAvailableMcp([]));
  }, [agent?.name]);
  const parsedTemp = draftTemperature.trim() === "" ? null : parseFloat(draftTemperature);
  const tempValid = parsedTemp === null || (Number.isFinite(parsedTemp) && parsedTemp >= 0 && parsedTemp <= 2);
  const mcpDirty   = JSON.stringify(draftMcp) !== JSON.stringify(agent?.mcpTools ?? null);
  const cdDirty    = draftCanDispatch !== (agent?.canDispatch ?? false);
  const tempDirty  = (parsedTemp ?? null) !== (agent?.temperature ?? null);
  const modelDirty = draftModelId !== (agent?.defaultModelId ?? "");
  const skillsDirty = JSON.stringify([...draftSkills].sort()) !== JSON.stringify([...(agent?.extraSkills ?? [])].sort());
  const dirty = mcpDirty || cdDirty || tempDirty || modelDirty || skillsDirty;
  if (!agent) {
    return (
      <div style={{
        flex: 1,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: 12, padding: 24,
        color: "var(--fg-subtle)", fontSize: 12,
        display: "flex", alignItems: "center", justifyContent: "center",
        textAlign: "center",
      }}>
        Click an agent on the left to inspect or edit it.
      </div>
    );
  }
  const editable = !agent.builtIn;
  return (
    <div style={{
      flex: 1,
      background: "var(--bg-elevated)",
      border: "1px solid var(--border)",
      borderRadius: 12, padding: 20,
      display: "flex", flexDirection: "column", gap: 14,
      overflow: "auto",
    }}>
      {/* Big avatar + name field. Qt uses a 240Ã—240 button (line 477).
          Avatar doubles as the icon-picker trigger — click it to open
          IconPickerDialog. Hover ring + caption hints that it's a button. */}
      <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
        <button
          onClick={() => onPickIcon(agent.name)}
          title="Click to pick a different icon for this agent"
          style={{
            width: 200, height: 200, flexShrink: 0,
            background: "var(--bg-surface-hover)",
            border: "1px solid var(--border-strong)",
            borderRadius: 18,
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            cursor: "pointer", padding: 0,
            position: "relative",
            transition: "box-shadow 120ms, border-color 120ms",
          }}
          onMouseEnter={e => {
            e.currentTarget.style.boxShadow = "0 0 0 2px rgba(140,180,255,0.55)";
            e.currentTarget.style.borderColor = "rgba(140,180,255,0.65)";
          }}
          onMouseLeave={e => {
            e.currentTarget.style.boxShadow = "none";
            e.currentTarget.style.borderColor = "var(--border-strong)";
          }}
        >
          <img src={owlSrc(agent.icon)} style={{ width: 170, height: 170, objectFit: "contain", pointerEvents: "none" }} />
          <span style={{
            position: "absolute", bottom: 8, left: 0, right: 0,
            color: "var(--fg-subtle)", fontSize: 10, fontWeight: 600,
            letterSpacing: 0.6, textTransform: "uppercase",
            pointerEvents: "none",
          }}>Click to change icon</span>
        </button>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div style={{ color: "var(--fg-muted)", fontSize: 13 }}>Name</div>
          <input
            // key={agent.name} forces React to REMOUNT the input when
            // the user clicks a different agent card. Without this the
            // uncontrolled <input> keeps the FIRST name forever (showed
            // up as "every card has the same name — John Operation").
            key={agent.name}
            defaultValue={displayLabel(agent.name)}
            disabled={!editable}
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              color: editable ? "#fff" : "#888",
              borderRadius: 8, padding: "0 12px",
              minHeight: 40, fontSize: 15,
            }}
          />
          <div style={{ color: "var(--fg-muted)", fontSize: 13, marginTop: 4 }}>Default model</div>
          <div style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            color: "var(--fg)",
            borderRadius: 8, padding: "10px 12px", fontSize: 13,
          }}>Auto (per-task selection)</div>
        </div>
      </div>

      {agent.builtIn && (
        <div style={{
          color: "#c5cdff",
          background: "rgba(var(--accent-rgb),0.10)",
          borderRadius: 8, padding: "8px 12px", fontSize: 13,
        }}>
          🔒  Built-in role from LLM/core/agents/roles/. Click <b>Duplicate</b> first to make your own copy.
        </div>
      )}
      {agent.isSkill && (
        <div style={{
          color: "#a0e88a",
          background: "rgba(76,175,80,0.10)",
          borderRadius: 8, padding: "8px 12px", fontSize: 13,
        }}>
          📚  SKILL.md pack from LLM/data/skills/. Body becomes the system prompt at runtime.
        </div>
      )}

      <div style={{
        color: "var(--fg-muted)", fontSize: 13, fontWeight: 600,
        letterSpacing: 0.6, textTransform: "uppercase", marginTop: 4,
      }}>Job description</div>
      <div style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        color: "var(--fg)",
        borderRadius: 8, padding: "10px 12px", fontSize: 13,
      }}>{agent.description || "(no description)"}</div>

      {/* Skills row — tool_allowlist + mcp_allowlist. The Qt source
          paints these as chip rows under the "Permissions" section
          of the editor (agent_studio_page.py ~line 1280). */}
      <div style={{
        color: "var(--fg-muted)", fontSize: 13, fontWeight: 600,
        letterSpacing: 0.6, textTransform: "uppercase", marginTop: 4,
      }}>Built-in tools</div>
      <ChipRow
        chips={chipsFromAllowlist(agent.tools)}
        empty="No built-in tools assigned."
        allText="All built-in tools (no restriction)."
        accent="var(--accent)"
      />

      <div style={{
        display: "flex", alignItems: "baseline", gap: 10,
        color: "var(--fg-muted)", fontSize: 13, fontWeight: 600,
        letterSpacing: 0.6, textTransform: "uppercase", marginTop: 4,
      }}>
        <span>MCP tools</span>
        <span style={{ color: "var(--fg-subtle)", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
          {availableMcp.length === 0
            ? "(no MCP servers running — start them on the MCP page)"
            : `${availableMcp.length} available across running servers`}
        </span>
        {dirty && (
          <span style={{
            color: "#ffd97a", fontWeight: 700, fontSize: 11,
            background: "rgba(255,217,122,0.12)",
            padding: "2px 8px", borderRadius: 4,
            textTransform: "uppercase",
          }}>unsaved</span>
        )}
      </div>
      {availableMcp.length === 0 ? (
        <ChipRow
          chips={chipsFromAllowlist(draftMcp)}
          empty="No MCP tools assigned (start an MCP server first)."
          allText="All available MCP tools (no restriction)."
          accent="#a0e88a"
        />
      ) : (
        <div style={{
          display: "flex", flexDirection: "column", gap: 8,
          background: "rgba(20,25,40,0.4)",
          border: "1px solid rgba(160,232,138,0.20)",
          borderRadius: 8, padding: 10,
        }}>
          <label style={{
            display: "flex", alignItems: "center", gap: 8,
            fontSize: 12, color: "var(--fg)", cursor: editable ? "pointer" : "not-allowed",
            opacity: editable ? 1 : 0.6,
          }}>
            <input
              type="checkbox"
              checked={draftMcp === null}
              disabled={!editable}
              onChange={e => setDraftMcp(e.target.checked ? null : [])}
            />
            <span>Allow all MCP tools (no restriction)</span>
          </label>
          {draftMcp !== null && (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 6,
            }}>
              {availableMcp.map(t => {
                const selected = draftMcp.includes(t.qualifiedName);
                return (
                  <label
                    key={t.qualifiedName}
                    title={t.description}
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 8,
                      padding: "6px 8px", borderRadius: 6,
                      fontSize: 12, color: "var(--fg)",
                      background: selected ? "rgba(160,232,138,0.12)" : "rgba(0,0,0,0.2)",
                      border: selected
                        ? "1px solid rgba(160,232,138,0.55)"
                        : "1px solid rgba(255,255,255,0.05)",
                      cursor: editable ? "pointer" : "not-allowed",
                      opacity: editable ? 1 : 0.65,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={!editable}
                      onChange={e => {
                        if (draftMcp === null) return;
                        if (e.target.checked) setDraftMcp([...draftMcp, t.qualifiedName]);
                        else setDraftMcp(draftMcp.filter(n => n !== t.qualifiedName));
                      }}
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                      <code style={{
                        color: "#a0e88a", fontSize: 11, fontWeight: 600,
                        fontFamily: "Consolas, monospace",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>{t.qualifiedName}</code>
                      <div style={{
                        color: "var(--fg-subtle)", fontSize: 10, lineHeight: 1.4,
                        overflow: "hidden", textOverflow: "ellipsis",
                        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                      }}>{t.description}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SKILLS — associate SKILL.md packs with THIS agent. Tick the ones it
          should have; they persist on the agent (role JSON `extra_skills`) and
          the runtime merges them into its skills in every team (loading only
          what a task needs). Distinct from tools. Hidden for skill packs
          themselves (a skill can't have skills). */}
      {!agent.isSkill && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 10, color: "var(--fg-muted)", letterSpacing: 0.6, textTransform: "uppercase" }}>📚 Skills</div>
            {draftSkills.length > 0 && (() => {
              const ctx = draftSkills.reduce((s, id) => s + (availableSkills.find(a => a.id === id)?.ctx ?? 0), 0);
              return <span style={{ fontSize: 9.5, color: ctx > 6000 ? "#ffd97a" : "var(--fg-subtle)" }}>{draftSkills.length} on · ~{Math.max(1, Math.round(ctx / 1000))}k ctx</span>;
            })()}
          </div>
          {!editable ? (
            <span style={{ fontSize: 10.5, color: "var(--fg-subtle)", fontStyle: "italic" }}>Built-in agent — Duplicate it first to give your copy skills.</span>
          ) : availableSkills.length === 0 ? (
            <span style={{ fontSize: 10.5, color: "var(--fg-subtle)", fontStyle: "italic" }}>No skills installed yet — add them in the 📚 Skills tab, then tick them here.</span>
          ) : (
            <>
              <div style={{ maxHeight: 176, overflow: "auto", borderRadius: 8, border: `1px solid ${skillsDirty ? "#f0a832" : "var(--border)"}`, background: "var(--bg-surface)" }}>
                {availableSkills.map((s, i) => {
                  const on = draftSkills.includes(s.id);
                  return (
                    <button key={s.id} type="button"
                      onClick={() => setDraftSkills(prev => on ? prev.filter(x => x !== s.id) : [...prev, s.id])}
                      title={s.description || s.name}
                      style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, padding: "6px 9px",
                        background: on ? "rgba(160,232,138,0.10)" : "transparent", border: "none",
                        borderTop: i === 0 ? "none" : "1px solid var(--border)", cursor: "pointer" }}>
                      <span style={{ width: 15, height: 15, borderRadius: 4, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                        border: `1.5px solid ${on ? "#6cd28e" : "var(--border-strong)"}`, background: on ? "#6cd28e" : "transparent", color: "#11231a", fontSize: 10, fontWeight: 900 }}>{on ? "✓" : ""}</span>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-strong)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
                        {s.description && <span style={{ display: "block", fontSize: 10, color: "var(--fg-subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.description}</span>}
                      </span>
                      <span style={{ fontSize: 9, color: "var(--fg-subtle)", flexShrink: 0 }}>~{Math.max(1, Math.round(s.ctx / 1000))}k</span>
                    </button>
                  );
                })}
              </div>
              <span style={{ fontSize: 9.5, color: "var(--fg-subtle)" }}>Tick the skills this agent should have in every team — only the ones a task needs get loaded. Click <b>Save</b> below to keep them.</span>
            </>
          )}
        </div>
      )}

      {/* Behaviour fields — Can dispatch / Temperature / Default model.
          Editable when the agent isn't a built-in. Native browser
          tooltips via the title attribute explain what each setting
          does on mouse-hover. */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        gap: 10, marginTop: 4,
      }}>
        {/* Can dispatch */}
        <label
          title="Can this agent dispatch sub-tasks to OTHER agents? Orchestrators (and Team Leaders) need this on. Specialists usually leave it off so they focus on their own job and don't fan out work."
          style={{
            background: "var(--bg-surface)",
            border: `1px solid ${cdDirty ? "#f0a832" : "var(--border)"}`,
            borderRadius: 8, padding: "8px 10px",
            display: "flex", flexDirection: "column", gap: 6,
            cursor: editable ? "pointer" : "default",
            opacity: editable ? 1 : 0.7,
          }}
        >
          <div style={{ fontSize: 10, color: "var(--fg-muted)", letterSpacing: 0.6, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 4 }}>
            Can dispatch <span style={{ opacity: 0.5 }}>ⓘ</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={draftCanDispatch}
              disabled={!editable}
              onChange={e => setDraftCanDispatch(e.target.checked)}
            />
            <span style={{ fontSize: 12, color: "var(--fg)" }}>{draftCanDispatch ? "Yes" : "No"}</span>
          </div>
        </label>

        {/* Temperature */}
        <label
          title="Sampling temperature for this agent's model calls. 0.0 = deterministic (good for code, math, planning). 0.7 = balanced. 1.2 = creative / brainstormy. Leave empty for the per-task default (about 0.4 for orchestrators, 0.7 for prose)."
          style={{
            background: "var(--bg-surface)",
            border: `1px solid ${tempDirty ? "#f0a832" : (tempValid ? "var(--border)" : "#ff8c8c")}`,
            borderRadius: 8, padding: "8px 10px",
            display: "flex", flexDirection: "column", gap: 6,
            opacity: editable ? 1 : 0.7,
          }}
        >
          <div style={{ fontSize: 10, color: "var(--fg-muted)", letterSpacing: 0.6, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 4 }}>
            Temperature <span style={{ opacity: 0.5 }}>ⓘ</span>
          </div>
          <input
            type="number"
            min={0}
            max={2}
            step={0.05}
            value={draftTemperature}
            disabled={!editable}
            placeholder="auto"
            onChange={e => setDraftTemperature(e.target.value)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fg)", fontSize: 12,
              padding: 0, outline: "none",
              width: "100%",
            }}
          />
        </label>

        {/* Default model */}
        <label
          title="Force this agent to a specific model id (e.g. 'claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-5'). Leave empty to inherit from the team default → server fallback. Useful for pinning a critic to a cheap fast model while the orchestrator runs on Opus."
          style={{
            background: "var(--bg-surface)",
            border: `1px solid ${modelDirty ? "#f0a832" : "var(--border)"}`,
            borderRadius: 8, padding: "8px 10px",
            display: "flex", flexDirection: "column", gap: 6,
            opacity: editable ? 1 : 0.7,
          }}
        >
          <div style={{ fontSize: 10, color: "var(--fg-muted)", letterSpacing: 0.6, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 4 }}>
            Default model <span style={{ opacity: 0.5 }}>ⓘ</span>
          </div>
          <input
            type="text"
            value={draftModelId}
            disabled={!editable}
            placeholder="auto"
            onChange={e => setDraftModelId(e.target.value)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--fg)", fontSize: 12,
              padding: 0, outline: "none",
              width: "100%",
              fontFamily: "Consolas, monospace",
            }}
          />
        </label>
      </div>

      {agent.systemPrompt ? (
        <details style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid var(--border)",
          borderRadius: 8, padding: "8px 12px",
        }}>
          <summary style={{
            cursor: "pointer", fontSize: 12, fontWeight: 600,
            color: "var(--fg-muted)", letterSpacing: 0.6, textTransform: "uppercase",
          }}>System prompt ({agent.systemPrompt.length.toLocaleString()} chars)</summary>
          <pre style={{
            margin: "8px 0 0", whiteSpace: "pre-wrap",
            fontFamily: "Consolas, monospace", fontSize: 11,
            color: "var(--fg)", maxHeight: 280, overflow: "auto",
            lineHeight: 1.5,
          }}>{agent.systemPrompt}</pre>
        </details>
      ) : null}

      {agent.path ? (
        <div style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "Consolas, monospace", wordBreak: "break-all" }}>
          📁 {agent.path}
        </div>
      ) : null}

      <div style={{ flex: 1 }} />

      {/* Action row — Save (primary) / Duplicate (ghost) / Delete (destructive). */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => onSave({
            mcpAllowlist: draftMcp,
            canDispatch: draftCanDispatch,
            temperature: parsedTemp,
            defaultModelId: draftModelId,
            extraSkills: draftSkills,
          })}
          disabled={!editable || !tempValid}
          style={{
            flex: 1, minHeight: 42,
            background: editable
              ? (dirty ? "#f0a832" : "var(--accent)")
              : "#2c313c",
            color: editable ? "#fff" : "#777",
            border: "none", borderRadius: 8, padding: "0 20px",
            fontWeight: 600, cursor: editable ? "pointer" : "default",
          }}
        >{dirty ? "Save changes" : "Save"}</button>
        <button
          onClick={onDuplicate}
          style={{
            minHeight: 42,
            background: "var(--bg-surface)", color: "var(--fg)",
            border: "none", borderRadius: 8, padding: "0 14px",
            cursor: "pointer",
          }}
        >Duplicate</button>
        <button
          onClick={onDelete}
          disabled={!editable}
          style={{
            minHeight: 42,
            background: editable ? "rgba(255,140,140,0.12)" : "transparent",
            color: editable ? "#ff8c8c" : "#555",
            border: "none", borderRadius: 8, padding: "0 14px",
            cursor: editable ? "pointer" : "default",
          }}
        >Delete</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
// Backend shapes — match Rust agents::TeamTemplate / AgentRole / SkillPack.
type TeamTemplateBackend = { id: string; path: string; built_in: boolean; data: any };
type AgentRoleBackend     = { id: string; path: string; built_in: boolean; data: any };
type SkillPackBackend     = { id: string; path: string; dir: string; frontmatter: any; body: string };

function toTeam(t: TeamTemplateBackend): Team {
  const d = t.data ?? {};
  const agents: AgentSpec[] = Array.isArray(d.agents)
    ? d.agents.map((a: any) => ({ name: a.name, base: a.base, icon: a.icon ?? null }))
    : [];
  const edges = Array.isArray(d.graph?.edges) ? d.graph.edges : [];
  const name = d.name ?? t.id;
  const mcpPack = normalizeMcpPack(d.mcp_pack);
  return {
    name,
    display: d.display_name ?? t.id,
    category: d.category ?? "Other",
    icon: d.icon ?? "owl:owl_asssitant",
    description: d.description ?? "",
    agents,
    edges,
    requiredMcp: Array.isArray(d.required_mcp) ? d.required_mcp : [],
    visibility: normalizeVisibility(d.visibility, t.built_in, name),
    workflowRank: typeof d.workflow_rank === "number" ? d.workflow_rank : (RECOMMENDED_TEAM_RANK[name] ?? 999),
    mcpPack,
    builtIn: t.built_in,
  };
}
function toAgentDef(r: AgentRoleBackend): AgentDef {
  const d = r.data ?? {};
  // tool_allowlist / mcp_allowlist are arrays in the yaml; absent
  // means "no restriction". My yaml_lite parser leaves the field out
  // entirely when the source yaml omits it, so we preserve `null`
  // (= unrestricted) vs `[]` (= no tools).
  const tools = Array.isArray(d.tool_allowlist) ? d.tool_allowlist : (d.tool_allowlist === undefined ? null : []);
  const mcp   = Array.isArray(d.mcp_allowlist)  ? d.mcp_allowlist  : (d.mcp_allowlist  === undefined ? null : []);
  return {
    name: d.name ?? r.id,
    icon: d.icon ?? "owl:owl_asssitant",
    description: d.description ?? "",
    builtIn: r.built_in,
    canDispatch: d.can_dispatch === true,
    tools,
    mcpTools: mcp,
    systemPrompt: typeof d.system_prompt === "string" ? d.system_prompt : undefined,
    temperature: typeof d.default_temperature === "number" ? d.default_temperature : undefined,
    defaultModelId: typeof d.default_model_id === "string" ? d.default_model_id : undefined,
    extraSkills: (Array.isArray(d.extra_skills) ? d.extra_skills : Array.isArray(d.skills) ? d.skills : [])
      .filter((x: unknown): x is string => typeof x === "string"),
    path: r.path,
  };
}

function skillToAgentDef(s: SkillPackBackend): AgentDef {
  const fm = s.frontmatter ?? {};
  // SKILL.md "tools:" is an Anthropic-style list (CamelCase). We
  // surface them as-is — the runtime alias map (skill_sources.py)
  // happens server-side.
  const tools = Array.isArray(fm.tools) ? fm.tools.map(String) : [];
  const mcp   = Array.isArray(fm.mcp_tools) ? fm.mcp_tools.map(String) : [];
  // No iconography in SKILL.md frontmatter usually; fall back to the
  // generic skill emoji rendered inline if no owl: ref is present.
  const icon = typeof fm.icon === "string" && fm.icon.length > 0 ? fm.icon : "owl:owl_asssitant";
  return {
    name: fm.name ?? s.id,
    icon,
    description: fm.description ?? "",
    builtIn: false,         // skills live in user-writable data/
    isSkill: true,
    canDispatch: fm.leader === true,
    tools,
    mcpTools: mcp,
    systemPrompt: s.body,   // the markdown body IS the system prompt
    temperature: typeof fm.temperature === "number" ? fm.temperature : undefined,
    defaultModelId: typeof fm.model === "string" ? fm.model : undefined,
    path: s.path,
  };
}

// ---------------------------------------------------------------------
// TeamEditorDialog — in-app team template CRUD (P0-3). Create a team from
// scratch or edit a CUSTOM one: display name, category, description, and
// the agent roster (name, base role, description, extra prompt). Saves
// through save_team_template; unknown fields in an existing template are
// preserved (we patch a clone of the raw JSON, never rebuild it).
// ---------------------------------------------------------------------
type EditorAgentRow = {
  name: string;
  base: string;
  description: string;
  extraPrompt: string;
  /// Original JSON object when this row came from an existing template —
  /// preserved so unknown per-agent fields (icon, model hints…) survive.
  orig: any | null;
};

function TeamEditorDialog({
  open, original, roles, onClose, onSaved,
}: {
  open: boolean;
  /// Raw backend record when editing; null when creating from scratch.
  original: TeamTemplateBackend | null;
  /// Available base roles for the per-agent dropdown.
  roles: string[];
  onClose: () => void;
  onSaved: (newName: string) => void;
}) {
  const [display, setDisplay] = useState("");
  const [category, setCategory] = useState("Custom");
  const [description, setDescription] = useState("");
  const [rows, setRows] = useState<EditorAgentRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    if (original) {
      const d = original.data ?? {};
      setDisplay(d.display_name ?? original.id);
      setCategory(d.category ?? "Custom");
      setDescription(d.description ?? "");
      setRows((Array.isArray(d.agents) ? d.agents : []).map((a: any) => ({
        name: a?.name ?? "",
        base: a?.base ?? (roles[0] ?? "coder"),
        description: a?.description ?? "",
        extraPrompt: a?.extra_prompt ?? "",
        orig: a,
      })));
    } else {
      setDisplay("");
      setCategory("Custom");
      setDescription("");
      // Sensible starter roster: an orchestrator + one specialist.
      const orch = roles.includes("orchestrator") ? "orchestrator" : (roles[0] ?? "orchestrator");
      const spec = roles.find(r => r !== orch) ?? orch;
      setRows([
        { name: "orchestrator", base: orch, description: "Plans the work and dispatches the specialists.", extraPrompt: "", orig: null },
        { name: "specialist", base: spec, description: "Does the work the orchestrator dispatches.", extraPrompt: "", orig: null },
      ]);
    }
  }, [open, original, roles]);

  if (!open) return null;

  const setRow = (i: number, patch: Partial<EditorAgentRow>) =>
    setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    const dn = display.trim();
    if (!dn) { setErr("Give the team a name."); return; }
    const cleanRows = rows.filter(r => r.name.trim());
    if (cleanRows.length === 0) { setErr("A team needs at least one agent."); return; }
    const names = cleanRows.map(r => r.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) { setErr("Agent names must be unique."); return; }
    setSaving(true);
    setErr(null);
    try {
      // Patch a clone of the original JSON (preserves unknown fields like
      // icon / mcp_pack / graph); start fresh only for brand-new teams.
      const data: any = original ? JSON.parse(JSON.stringify(original.data ?? {})) : {};
      data.display_name = dn;
      data.category = category.trim() || "Custom";
      data.description = description.trim();
      data.agents = cleanRows.map(r => ({
        ...(r.orig ?? {}),
        name: r.name.trim(),
        base: r.base,
        description: r.description.trim(),
        ...(r.extraPrompt.trim() ? { extra_prompt: r.extraPrompt } : {}),
      }));
      if (!original) data.icon = data.icon ?? "owl:owl_asssitant";
      // Editing keeps the file stem (the id); creating derives it from the
      // display name (Rust sanitizes + enforces data.name == stem).
      const saved = await invoke<TeamTemplateBackend>("save_team_template", {
        fileStem: original ? original.id : dn,
        data,
      });
      // Custom teams ride the vault like other non-secret state.
      invoke("vault_sync_teams").catch(() => {});
      onSaved((saved.data?.name ?? saved.id) as string);
      onClose();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const input: React.CSSProperties = {
    width: "100%", height: 30, borderRadius: 7, padding: "0 10px", fontSize: 12.5,
    background: "var(--bg-input)", color: "var(--fg-strong)", border: "1px solid var(--border)",
  };
  const label: React.CSSProperties = { fontSize: 11, color: "var(--fg-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 9550, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{
        width: "min(680px, 94%)", maxHeight: "88%", overflow: "auto",
        background: "var(--bg-panel)", border: "2px solid rgba(var(--accent-rgb),0.78)",
        borderRadius: 14, boxShadow: "0 24px 64px rgba(0,0,0,0.55)", padding: 18,
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: "var(--fg-strong)" }}>
          {original ? `Edit team — ${original.data?.display_name ?? original.id}` : "Create your own team"}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <div>
            <div style={label}>Team name</div>
            <input style={input} value={display} onChange={e => setDisplay(e.target.value)} placeholder="My Research Crew" />
          </div>
          <div>
            <div style={label}>Category</div>
            <input style={input} value={category} onChange={e => setCategory(e.target.value)} placeholder="Custom" />
          </div>
        </div>
        <div>
          <div style={label}>Description</div>
          <input style={input} value={description} onChange={e => setDescription(e.target.value)} placeholder="What this team is for" />
        </div>

        <div style={{ ...label, marginTop: 4 }}>Agents</div>
        {rows.map((r, i) => (
          <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "end" }}>
              <div>
                <div style={label}>Name</div>
                <input style={input} value={r.name} onChange={e => setRow(i, { name: e.target.value })} placeholder="researcher" />
              </div>
              <div>
                <div style={label}>Base role</div>
                <select style={{ ...input, height: 32 }} value={r.base} onChange={e => setRow(i, { base: e.target.value })}>
                  {roles.map(role => <option key={role} value={role}>{role}</option>)}
                  {!roles.includes(r.base) && <option value={r.base}>{r.base}</option>}
                </select>
              </div>
              <button
                onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}
                title="Remove this agent"
                style={{ height: 30, padding: "0 10px", borderRadius: 7, border: "none", background: "rgba(255,140,140,0.12)", color: "#ff8c8c", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
              >Remove</button>
            </div>
            <div>
              <div style={label}>Description</div>
              <input style={input} value={r.description} onChange={e => setRow(i, { description: e.target.value })} placeholder="What this agent does on the team" />
            </div>
            <div>
              <div style={label}>Extra prompt (optional — appended to the base role's prompt)</div>
              <textarea
                value={r.extraPrompt}
                onChange={e => setRow(i, { extraPrompt: e.target.value })}
                rows={3}
                style={{ ...input, height: "auto", padding: "8px 10px", fontFamily: "inherit", resize: "vertical" }}
              />
            </div>
          </div>
        ))}
        <button
          onClick={() => setRows(rs => [...rs, { name: "", base: roles[0] ?? "coder", description: "", extraPrompt: "", orig: null }])}
          style={{ alignSelf: "flex-start", height: 30, padding: "0 12px", borderRadius: 7, border: "1px dashed var(--border-strong)", background: "transparent", color: "var(--fg)", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}
        >+ Add agent</button>

        {err && <div style={{ color: "#ff8c8c", fontSize: 12.5 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ height: 32, padding: "0 14px", borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", color: "var(--fg)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            style={{ height: 32, padding: "0 16px", borderRadius: 8, border: "none", background: "linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent))", color: "var(--accent-fg)", fontSize: 13, fontWeight: 800, cursor: saving ? "wait" : "pointer" }}
          >{saving ? "Saving…" : original ? "Save changes" : "Create team"}</button>
        </div>
      </div>
    </div>
  );
}

export default function StudioPage() {
  const [view, setView] = useState<StudioView>("teams");
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [bannerVisible, setBannerVisible] = useState(true);
  const [teamQuery, setTeamQuery] = useState("");
  const [agentQuery, setAgentQuery] = useState("");
  const [showExampleTeams, setShowExampleTeams] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [teams, setTeams] = useState<Team[]>(TEAMS_FALLBACK);
  const [agents, setAgents] = useState<AgentDef[]>(AGENTS_FALLBACK);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Global studio-scope icon overrides (one map for all agent defs,
  // not per-project — agent definitions are global). Hydrated from
  // localStorage on mount and merged onto every agent's icon at render.
  const [iconOverrides, setIconOverrides] = useState<Record<string, string>>(() => loadStudioOverrides());
  const [iconPickerAgent, setIconPickerAgent] = useState<string | null>(null);
  const [mcpInstallingTeam, setMcpInstallingTeam] = useState<string | null>(null);
  const [mcpInstallStatusByTeam, setMcpInstallStatusByTeam] = useState<Record<string, string>>({});
  // Team editor dialog (P0-3): null original = create from scratch.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorOriginal, setEditorOriginal] = useState<TeamTemplateBackend | null>(null);
  // Team Workbench — the 3-pane "Outfitter Inspector" editor. Non-null = open,
  // editing this raw template backend.
  const [workbenchTeam, setWorkbenchTeam] = useState<TeamTemplateBackend | null>(null);
  const [skillBackends, setSkillBackends] = useState<SkillPackBackend[]>([]);
  // Loaded for the Workbench's per-agent ModelPicker (shared picker + list_models).
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [accountsStatus, setAccountsStatus] = useState<AccountsStatusLite | null>(null);
  useEffect(() => {
    invoke<ModelInfo[]>("list_models").then(setModels).catch(() => {});
    invoke<AccountsStatusLite>("accounts_status").then(setAccountsStatus).catch(() => {});
  }, []);

  // Layer overrides on top of backend-loaded agent icons. Cheap pass
  // over the list whenever either dataset changes.
  const agentsWithIcons = useMemo(
    () => agents.map(a => iconOverrides[a.name] ? { ...a, icon: iconOverrides[a.name] } : a),
    [agents, iconOverrides],
  );

  // Cheap skill metadata for the per-agent Skills checklist (name + desc +
  // a labelled context estimate). Derived from the installed SKILL.md packs.
  const availableSkillMeta = useMemo(
    () => skillBackends.map(p => ({
      id: p.id,
      name: (typeof p.frontmatter?.name === "string" && p.frontmatter.name) || p.id,
      description: (typeof p.frontmatter?.description === "string" && p.frontmatter.description) || "",
      ctx: Math.round((p.body?.length ?? 0) / 4),
    })),
    [skillBackends],
  );

  // Raw backend records (path + full JSON), keyed by the UI name — the
  // CRUD handlers need them for faithful duplicate/edit/delete round-trips
  // (the mapped Team/AgentDef shapes drop unknown fields on purpose).
  const teamBackendsRef = useRef<Map<string, TeamTemplateBackend>>(new Map());
  const agentBackendsRef = useRef<Map<string, AgentRoleBackend>>(new Map());

  const loadAll = async () => {
    try {
      const [rawTeams, rawAgents, rawSkills] = await Promise.all([
        invoke<TeamTemplateBackend[]>("list_team_templates"),
        invoke<AgentRoleBackend[]>("list_agent_roles"),
        invoke<SkillPackBackend[]>("list_skill_packs"),
      ]);
      teamBackendsRef.current = new Map(rawTeams.map(t => [(t.data?.name ?? t.id) as string, t]));
      agentBackendsRef.current = new Map(rawAgents.map(r => [(r.data?.name ?? r.id) as string, r]));
      setTeams(rawTeams.map(toTeam));
      // Roles + SKILL.md packs both surface as agent cards. Roles
      // come first (built-in identities), skills follow (user-
      // installed capabilities). Each carries its own provenance
      // flags so the AgentDetailPanel can label them.
      setAgents([
        ...rawAgents.map(toAgentDef),
        ...rawSkills.map(skillToAgentDef),
      ]);
      setSkillBackends(rawSkills);   // raw packs power the Workbench catalog
    } catch (e) {
      setLoadError(String(e));
    }
  };
  useEffect(() => {
    let dead = false;
    (async () => { if (!dead) await loadAll(); })();
    return () => { dead = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredTeams = useMemo(() => {
    const q = teamQuery.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter(t =>
      t.display.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q) ||
      t.requiredMcp.some(m => m.toLowerCase().includes(q)) ||
      (t.mcpPack?.servers.some(s => s.name.toLowerCase().includes(q)) ?? false) ||
      t.agents.some(a => a.name.toLowerCase().includes(q))
    );
  }, [teamQuery, teams]);

  const visibleTeams = useMemo(() => {
    if (teamQuery.trim()) return filteredTeams;
    if (showExampleTeams) return filteredTeams;
    return filteredTeams.filter(t => !t.builtIn || t.visibility !== "examples");
  }, [filteredTeams, showExampleTeams, teamQuery]);

  // Agents (roles) and Skills (SKILL.md packs) are different things and now
  // live in separate tabs — never mixed in one grid.
  const filteredAgents = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    let base = agentsWithIcons.filter(a => (view === "skills" ? a.isSkill : !a.isSkill));
    if (q) base = base.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q)
    );
    return base;
  }, [agentQuery, agentsWithIcons, view]);

  // Skills grouped into purpose "containers" for the Skills tab, deduped by
  // display name (a pack present in both the new + legacy/_remote skill homes
  // would otherwise show twice). Empty categories are dropped; Other goes last.
  const skillSections = useMemo(() => {
    if (view !== "skills") return [] as { key: string; label: string; skills: AgentDef[] }[];
    const seen = new Set<string>();
    const deduped = filteredAgents.filter(a => {
      const k = a.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const byCat = new Map<string, AgentDef[]>();
    for (const a of deduped) {
      const cat = categorizeSkill(a.name, a.description);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(a);
    }
    const out: { key: string; label: string; skills: AgentDef[] }[] = [];
    for (const c of SKILL_CATEGORIES) {
      const s = byCat.get(c.key);
      if (s && s.length) out.push({ key: c.key, label: c.label, skills: s });
    }
    const other = byCat.get(SKILL_CATEGORY_OTHER.key);
    if (other && other.length) out.push({ key: SKILL_CATEGORY_OTHER.key, label: SKILL_CATEGORY_OTHER.label, skills: other });
    return out;
  }, [view, filteredAgents]);

  const team = teams.find(t => t.name === selectedTeam) ?? null;
  const agent = agentsWithIcons.find(a => a.name === selectedAgent) ?? null;
  const skill = agentsWithIcons.find(a => a.name === selectedSkill && a.isSkill) ?? null;

  // Sub-label text per view.
  const subLabel = view === "teams"
    ? "Pick a workflow: Code Operator, Product Studio, Research Lab, Chief of Staff, n8n Workflow Builder, Data Room, or Content Studio. MCP packs configure the tools those workflows need."
    : view === "skills"
      ? "Skills are SKILL.md capability packs (Anthropic-style). They're NOT agents — you equip a skill onto an agent (in a Team's Workbench, or per-agent on the Agents page) and the runtime loads it only when a task needs it. Install more from the library."
      : "Design individual agents — pick an avatar, a job, the tools they get to use. Built-ins ship with OWLLM and can't be edited; click Duplicate on any built-in to make your own copy.";

  // Navigate to another top-level tab. AppShell listens for this
  // CustomEvent on the window and swaps activeKey accordingly.
  const navTo = (key: string) => {
    window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key } }));
  };

  const handleCreateProjectFromTeam = (name: string) => {
    // The Agents tab owns project creation (project strip → + New).
    // For now, dropping the template name into sessionStorage lets a
    // future hook on AgentsPage pre-populate the team picker.
    sessionStorage.setItem("owllm:agents:pending-team", name);
    navTo("agents");
  };
  const handleInstallMcpPack = async (team: Team) => {
    if (!team.mcpPack) return;
    setMcpInstallingTeam(team.name);
    setMcpInstallStatusByTeam(prev => ({ ...prev, [team.name]: "Installing runtime helpers and merging MCP server config..." }));
    try {
      const result = await invoke<McpPackInstallResult>("mcp_install_pack", {
        servers: team.mcpPack.servers,
      });
      const changes = [
        result.added.length ? `added ${result.added.join(", ")}` : "",
        result.updated.length ? `updated ${result.updated.join(", ")}` : "",
        result.uvInstalled ? "uv ready" : "",
      ].filter(Boolean).join("; ");
      setMcpInstallStatusByTeam(prev => ({
        ...prev,
        [team.name]: changes ? `Pack installed: ${changes}.` : "Pack installed.",
      }));
    } catch (e: any) {
      setMcpInstallStatusByTeam(prev => ({
        ...prev,
        [team.name]: `Install failed: ${String(e?.message ?? e)}`,
      }));
    } finally {
      setMcpInstallingTeam(null);
    }
  };
  // ---- Team/agent CRUD (P0-3): real in-app operations, no manual JSON ----
  // Open the 3-pane Workbench on a team (built-in or custom). The Workbench
  // itself handles the built-in → save-as-copy flow, so no "duplicate first"
  // gate here — any team is a valid starting point to customise.
  const handleOpenWorkbench = (name: string) => {
    const backend = teamBackendsRef.current.get(name);
    if (!backend) { alert("Couldn't load this template from disk — refresh and try again."); return; }
    setWorkbenchTeam(backend);
  };
  const handleDuplicateTemplate = async (name: string) => {
    const t = teams.find(x => x.name === name);
    const backend = teamBackendsRef.current.get(name);
    if (!t || !backend) return;
    const suggested = `${t.display} copy`;
    const newName = window.prompt(`Name for your copy of '${t.display}':`, suggested);
    if (!newName?.trim()) return;
    try {
      const data = JSON.parse(JSON.stringify(backend.data ?? {}));
      data.display_name = newName.trim();
      delete data.visibility;     // customs always show in the CUSTOM section
      delete data.workflow_rank;
      const saved = await invoke<TeamTemplateBackend>("save_team_template", {
        fileStem: newName,
        data,
      });
      invoke("vault_sync_teams").catch(() => {});
      await loadAll();
      setSelectedTeam((saved.data?.name ?? saved.id) as string);
    } catch (e: any) {
      alert(`Duplicate failed: ${String(e?.message ?? e)}`);
    }
  };
  const handleDeleteTemplate = async (name: string) => {
    const t = teams.find(x => x.name === name);
    if (!t) return;
    if (t.builtIn) {
      alert(`'${t.display}' is a built-in template — built-ins can't be deleted.`);
      return;
    }
    const backend = teamBackendsRef.current.get(name);
    if (!backend) return;
    if (!confirm(`Delete the team template '${t.display}'?\nExisting projects spawned from it stay intact.`)) return;
    try {
      await invoke("delete_team_template", { path: backend.path });
      invoke("vault_sync_teams").catch(() => {});
      setSelectedTeam(null);
      await loadAll();
    } catch (e: any) {
      alert(`Delete failed: ${String(e?.message ?? e)}`);
    }
  };
  const handleCreateTeam = () => {
    setEditorOriginal(null);
    setEditorOpen(true);
  };
  const handleNewAgent = async () => {
    const name = window.prompt("Name for your new agent (e.g. data_wrangler):", "");
    if (!name?.trim()) return;
    try {
      const created = await invoke<AgentRoleBackend>("create_agent_definition", {
        fileStem: name,
        data: {
          description: "Describe what this agent does.",
          icon: "owl:owl_asssitant",
          default_temperature: 0.3,
          system_prompt: "You are a helpful specialist. Stay in your role and answer concisely.",
        },
      });
      invoke("vault_sync_teams").catch(() => {});
      await loadAll();
      setView("agents");
      setSelectedAgent((created.data?.name ?? created.id) as string);
    } catch (e: any) {
      alert(`Create failed: ${String(e?.message ?? e)}`);
    }
  };
  const handleDuplicateAgent = async (agentName: string | undefined) => {
    if (!agentName) return;
    const a = agentsWithIcons.find(x => x.name === agentName);
    if (!a) return;
    const newName = window.prompt(`Name for your copy of '${agentName}':`, `${agentName}_custom`);
    if (!newName?.trim()) return;
    try {
      // Roles: clone the raw backend JSON (preserves unknown fields).
      // Skills: synthesize a role JSON from the visible fields (the
      // SKILL.md body is the system prompt).
      const backend = agentBackendsRef.current.get(agentName);
      const data: any = backend
        ? JSON.parse(JSON.stringify(backend.data ?? {}))
        : {
            description: a.description,
            icon: a.icon,
            ...(a.temperature !== undefined ? { default_temperature: a.temperature } : {}),
            ...(a.tools ? { tool_allowlist: a.tools } : {}),
            ...(a.mcpTools ? { mcp_allowlist: a.mcpTools } : {}),
            ...(a.systemPrompt ? { system_prompt: a.systemPrompt } : {}),
            ...(a.canDispatch ? { can_dispatch: true } : {}),
          };
      const created = await invoke<AgentRoleBackend>("create_agent_definition", {
        fileStem: newName,
        data,
      });
      invoke("vault_sync_teams").catch(() => {});
      await loadAll();
      setSelectedAgent((created.data?.name ?? created.id) as string);
    } catch (e: any) {
      alert(`Duplicate failed: ${String(e?.message ?? e)}`);
    }
  };
  const handleDeleteAgent = async (agentName: string | undefined) => {
    if (!agentName) return;
    const a = agentsWithIcons.find(x => x.name === agentName);
    if (!a || a.builtIn) return;
    if (a.isSkill) {
      alert("Skill packs are managed in the 📚 Skill Library — open it to remove this one.");
      return;
    }
    if (!a.path) return;
    if (!confirm(`Delete custom agent '${agentName}'?\nTeams referencing it keep working off their own copies.`)) return;
    try {
      await invoke("delete_agent_definition", { path: a.path });
      invoke("vault_sync_teams").catch(() => {});
      setSelectedAgent(null);
      await loadAll();
    } catch (e: any) {
      alert(`Delete failed: ${String(e?.message ?? e)}`);
    }
  };
  const handleOpenSkillLibrary = () => {
    // Open the modal port of widgets/skill_library_dialog.py — git-
    // clones a curated source, walks for SKILL.md, lets the user
    // install with Anthropic→OWLLM tool-name aliasing applied.
    setLibraryOpen(true);
  };

  return (
    <div style={{
      padding: "16px 20px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 12,
      overflow: "hidden",
      background: "var(--bg-panel)",  // page background per style notes
    }}>
      {!workbenchTeam && <div style={{ fontSize: 22, fontWeight: 800, color: "var(--fg-strong)" }}>Studio</div>}
      {!workbenchTeam && <ViewToggle view={view} onChange={setView} />}
      {!workbenchTeam && <div style={{ color: "var(--fg-muted)", fontSize: 12 }} dangerouslySetInnerHTML={{ __html: subLabel }} />}
      {!workbenchTeam && bannerVisible && (
        <OnboardingBanner
          onOpen={handleOpenSkillLibrary}
          onDismiss={() => setBannerVisible(false)}
        />
      )}

      {workbenchTeam ? (
        <TeamWorkbench
          backend={workbenchTeam}
          roleDefs={agentsWithIcons}
          skillPacks={skillBackends}
          models={models}
          accountsStatus={accountsStatus}
          onClose={() => setWorkbenchTeam(null)}
          onSaved={async (newName) => { setWorkbenchTeam(null); await loadAll(); setSelectedTeam(newName); }}
          onOpenSkillLibrary={() => setLibraryOpen(true)}
        />
      ) : view === "teams" ? (
        <>
          {/* Search + (no top-level "+ New Team" — the dashed
              CreateTeamCard at the bottom of the grid is Qt's
              actual CTA, see team_grid_view.py:340.) */}
          <SearchBar
            value={teamQuery}
            onChange={setTeamQuery}
            placeholder="Filter teams by name, description, category, or agent…"
          />
          <div style={{ flex: 1, display: "flex", gap: 12, minHeight: 0 }}>
            <div style={{ flex: 6, display: "flex", flexDirection: "column", minWidth: 0 }}>
              <TeamsGrid
                teams={visibleTeams}
                selected={selectedTeam}
                onSelect={setSelectedTeam}
                onCreate={handleCreateTeam}
                showExamples={showExampleTeams || teamQuery.trim().length > 0}
                onToggleExamples={() => setShowExampleTeams(v => !v)}
              />
            </div>
            <div style={{ flex: 4, display: "flex", minWidth: 0 }}>
              <TeamDetailPanel
                team={team}
                onCreateProject={handleCreateProjectFromTeam}
                onOpenWorkbench={handleOpenWorkbench}
                onDuplicateTemplate={handleDuplicateTemplate}
                onDeleteTemplate={handleDeleteTemplate}
                onInstallMcpPack={handleInstallMcpPack}
                mcpInstallStatus={team ? (mcpInstallStatusByTeam[team.name] ?? null) : null}
                installingMcpPack={team ? mcpInstallingTeam === team.name : false}
              />
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Action row — Agents (build roles) vs Skills (install packs). */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {view === "agents" ? (
              <button
                onClick={handleNewAgent}
                style={{
                  minHeight: 34,
                  background: "var(--accent)", color: "var(--fg-strong)",
                  border: "none", borderRadius: 8, padding: "0 16px",
                  fontWeight: 600, cursor: "pointer", fontSize: 12,
                }}
              >+ New custom agent</button>
            ) : (
              <button
                onClick={handleOpenSkillLibrary}
                title="Install SKILL.md packs from a curated source (Anthropic, obra/superpowers) or a git URL"
                style={{
                  minHeight: 34,
                  background: "rgba(160,232,138,0.16)", color: "#9ee6b0",
                  border: "1px solid rgba(160,232,138,0.4)",
                  borderRadius: 8, padding: "0 16px",
                  fontWeight: 700, cursor: "pointer", fontSize: 12,
                }}
              >📚 Install skills…</button>
            )}
            <div style={{ flex: 1 }} />
            <SearchBar
              value={agentQuery}
              onChange={setAgentQuery}
              placeholder={view === "skills" ? "Filter skills…" : "Filter agents…"}
            />
          </div>
          <div style={{ flex: 1, display: "flex", gap: 12, minHeight: 0 }}>
            <div style={{
              flex: 6,
              display: "flex", flexDirection: "column", gap: 16,
              overflow: "auto",
              paddingRight: 8,
              paddingBottom: 12,
              minWidth: 0,
            }}>
              {view === "skills" ? (
                skillSections.length === 0 ? (
                  <div style={{ color: "var(--fg-subtle)", fontSize: 12.5, lineHeight: 1.6, padding: "8px 2px" }}>
                    No skills installed yet. Click <b>📚 Install skills…</b> to add Anthropic-style SKILL.md packs,
                    then give them to your agents (Agents tab → an agent → 📚 Skills).
                  </div>
                ) : (
                  // Grouped into purpose "containers" (Orchestration / Design /
                  // Coding / …) so the library is scannable, not one flat wall.
                  skillSections.map(sec => {
                    const accent = categoryAccent(sec.key);
                    return (
                    <div key={sec.key} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11.5, fontWeight: 800, color: accent, letterSpacing: 0.4 }}>{sec.label}</span>
                        <span style={{ fontSize: 10, color: "var(--bg-panel)", fontWeight: 800, background: accent, borderRadius: 999, padding: "1px 7px" }}>{sec.skills.length}</span>
                        <div style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${accent}55, transparent)` }} />
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gridAutoRows: "min-content", gap: 12, alignContent: "flex-start" }}>
                        {sec.skills.map(a => (
                          <SkillCard key={a.name} skill={a} selected={selectedSkill === a.name} onClick={() => setSelectedSkill(a.name)} accent={accent} />
                        ))}
                      </div>
                    </div>
                    );
                  })
                )
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gridAutoRows: "min-content", gap: 12, alignContent: "flex-start" }}>
                  {filteredAgents.map(a => (
                    <AgentCard key={a.name} agent={a} selected={selectedAgent === a.name} onClick={() => setSelectedAgent(a.name)} />
                  ))}
                </div>
              )}
            </div>
            <div style={{ flex: 4, display: "flex", minWidth: 0 }}>
              {view === "skills" ? (
                <SkillDetailPanel skill={skill} />
              ) : (
              <AgentDetailPanel
                agent={agent}
                availableSkills={availableSkillMeta}
                onSave={async (edits) => {
                  const target = agent;
                  if (target?.isSkill) {
                    alert("A skill is defined by its SKILL.md file and managed in the library — it isn't edited here. Equip the skill onto an agent instead.");
                    return;
                  }
                  if (!target || !target.path) {
                    alert("Can't save: no path on disk (built-in role or unloaded). Click Duplicate first.");
                    return;
                  }
                  // Find the raw backend row so we keep every field
                  // the JSON had — we only override what the user
                  // edited. Otherwise unmodified keys (system_prompt,
                  // description, etc.) would be silently lost.
                  try {
                    const allRoles = await invoke<AgentRoleBackend[]>("list_agent_roles");
                    const row = allRoles.find(r => r.path === target.path);
                    const original: any = (row?.data && typeof row.data === "object") ? { ...row.data } : {};
                    if (edits.mcpAllowlist === null) {
                      delete original.mcp_allowlist;
                    } else {
                      original.mcp_allowlist = edits.mcpAllowlist;
                    }
                    original.can_dispatch = edits.canDispatch;
                    if (edits.temperature == null) {
                      delete original.default_temperature;
                    } else {
                      original.default_temperature = edits.temperature;
                    }
                    if (!edits.defaultModelId || !edits.defaultModelId.trim()) {
                      delete original.default_model_id;
                    } else {
                      original.default_model_id = edits.defaultModelId.trim();
                    }
                    // Per-agent skills → role JSON `extra_skills` (the dispatch
                    // merges these into the agent's effective skills everywhere).
                    if (edits.extraSkills.length) {
                      original.extra_skills = edits.extraSkills;
                    } else {
                      delete original.extra_skills;
                    }
                    await invoke("save_agent_definition", { path: target.path, data: original });
                    await loadAll();   // reload so the UI shows the persisted state
                  } catch (e: any) {
                    alert(`Save failed: ${String(e?.message ?? e)}`);
                  }
                }}
                onDuplicate={() => handleDuplicateAgent(agent?.name)}
                onDelete={() => handleDeleteAgent(agent?.name)}
                onPickIcon={(name) => setIconPickerAgent(name)}
              />
              )}
            </div>
          </div>
        </>
      )}

      {/* Modal port of widgets/skill_library_dialog.py — git-clones
          curated sources (Anthropic, obra/superpowers, custom URL),
          discovers SKILL.md, installs with alias rewriting. */}
      <SkillLibraryDialog
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onChange={() => loadAll()}
      />
      {/* Team CRUD editor (P0-3) — create-from-scratch or edit-a-custom. */}
      <TeamEditorDialog
        open={editorOpen}
        original={editorOriginal}
        roles={agentsWithIcons.filter(a => !a.isSkill).map(a => a.name)}
        onClose={() => setEditorOpen(false)}
        onSaved={async (newName) => {
          await loadAll();
          setSelectedTeam(newName);
        }}
      />
      <IconPickerDialog
        open={iconPickerAgent != null}
        agentName={iconPickerAgent ?? ""}
        currentRef={iconPickerAgent
          ? (agentsWithIcons.find(a => a.name === iconPickerAgent)?.icon ?? "")
          : ""}
        onCancel={() => setIconPickerAgent(null)}
        onPick={(ref) => {
          if (!iconPickerAgent) { setIconPickerAgent(null); return; }
          setStudioAgentIconOverride(iconPickerAgent, ref);
          setIconOverrides(prev => ({ ...prev, [iconPickerAgent]: ref }));
          setIconPickerAgent(null);
        }}
        onReset={() => {
          if (!iconPickerAgent) { setIconPickerAgent(null); return; }
          setStudioAgentIconOverride(iconPickerAgent, null);
          setIconOverrides(prev => {
            const next = { ...prev };
            delete next[iconPickerAgent];
            return next;
          });
          setIconPickerAgent(null);
        }}
      />
    </div>
  );
}
