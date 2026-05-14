// StudioPage â€” ported from LLM/desktop_app/pages/agent_studio_page.py
// (AgentStudioPage._build_ui, line 1010) and LLM/desktop_app/widgets/
// team_grid_view.py (TeamGridView + TeamDetailPanel).
//
// Two views toggled at the top:
//
//   ðŸ§© Teams (default)        ðŸ¤– Agents
//   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€         â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//   Gallery grid of team       Gallery grid of agent definitions
//   templates from             from agent_definitions.list_all_definitions
//   LLM/core/agents/teams/*.json
//
// Team metadata is loaded at mount from the native list_team_templates /
// list_agent_roles Tauri commands â€” those walk LLM/core/agents/teams/
// (built-in JSONs) and LLM/core/agents/roles/ (built-in YAMLs) plus the
// user-saved overrides under LLM/data/. No more baked arrays.
import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const ICONS = "/Page_icons";
const AGENT_ICON_DIR = `${ICONS}/Agents`;

// owl:<basename> â†’ /Page_icons/Agents/<basename>.png  (mirrors
// desktop_app/widgets/agent_icons.py:owl_pixmap on the web side).
function owlSrc(iconRef: string): string {
  if (iconRef.startsWith("owl:")) {
    return `${AGENT_ICON_DIR}/${iconRef.slice(4)}.png`;
  }
  return iconRef;
}

// agent_canvas._display_label / agent_studio_page._display_label â€”
// "product_studio.product_owner" â†’ "Product Owner". Acronyms uppercased.
const _ACRONYMS = new Set(["ux","ui","api","mcp","gpu","be","fe","qa","cli","sql","db"]);
function displayLabel(fullName: string): string {
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

// Category accent strip colours â€” verbatim from
// team_grid_view.py:49 (_CATEGORY_ACCENT).
const CATEGORY_ACCENT: Record<string, string> = {
  Personal:  "#74a4ff",
  Knowledge: "#c08aff",
  Software:  "#5cf0ff",
  Ops:       "#ffb56a",
  Other:     "#9aa0a6",
  Custom:    "#ff7ed1",
};
// team_grid_view.py:48 â€” fixed display order for category sections.
const CATEGORY_ORDER = ["Personal", "Knowledge", "Software", "Ops", "Other", "Custom"];

// Base-role â†’ default owl icon. Mirrors what apply_to_label falls back
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
  devops:        "owl:owl_SSH",         // devops role â†’ SSH owl asset
  webapp:        "owl:owl_webapp",
  assistant:     "owl:owl_asssitant",
};
function resolveAgentIcon(icon: string | null | undefined, base: string | null | undefined): string {
  if (icon) return icon;
  if (base && BASE_OWL[base]) return BASE_OWL[base];
  return "owl:owl_asssitant";
}

// ---------------------------------------------------------------------
// Data â€” baked from LLM/core/agents/teams/*.json (17 templates).
// ---------------------------------------------------------------------
type AgentSpec = { name: string; base: string; icon?: string | null };
type Team = {
  name: string;
  display: string;
  category: string;
  icon: string;
  description: string;
  agents: AgentSpec[];
  edges: { source: string; target: string }[];
  requiredMcp: string[];
  builtIn: boolean;
};

const TEAMS_FALLBACK: Team[] = [];   // populated at mount from list_team_templates

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
};
const AGENTS_FALLBACK: AgentDef[] = [];   // populated at mount from list_agent_roles

// ---------------------------------------------------------------------
// Visual building blocks
// ---------------------------------------------------------------------

// Toggle â€” mirrors _VIEW_TAB_LEFT_STYLE / _RIGHT_STYLE in
// agent_studio_page.py:1551-1580. Checked state is #28406b on #fff
// with #3a5fa0 border, idle is rgba(255,255,255,0.04).
function ViewToggle({ view, onChange }: {
  view: "teams" | "agents"; onChange: (v: "teams" | "agents") => void;
}) {
  const base: React.CSSProperties = {
    minHeight: 36,
    padding: "0 22px",
    fontSize: 12,
    fontWeight: 600,
    background: "rgba(255,255,255,0.04)",
    color: "#9aa0a6",
    border: "1px solid rgba(255,255,255,0.06)",
    cursor: "pointer",
    letterSpacing: 0.3,
  };
  return (
    <div style={{ display: "flex", gap: 0, padding: "4px 0" }}>
      <button
        onClick={() => onChange("teams")}
        style={{
          ...base,
          borderTopLeftRadius: 9, borderBottomLeftRadius: 9,
          borderTopRightRadius: 0, borderBottomRightRadius: 0,
          borderRight: "none",
          background: view === "teams" ? "#28406b" : base.background,
          color:      view === "teams" ? "#fff" : base.color,
          borderColor: view === "teams" ? "#3a5fa0" : "rgba(255,255,255,0.06)",
        }}
      >ðŸ§© Teams</button>
      <button
        onClick={() => onChange("agents")}
        style={{
          ...base,
          borderTopRightRadius: 9, borderBottomRightRadius: 9,
          borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
          background: view === "agents" ? "#28406b" : base.background,
          color:      view === "agents" ? "#fff" : base.color,
          borderColor: view === "agents" ? "#3a5fa0" : "rgba(255,255,255,0.06)",
        }}
      >ðŸ¤– Agents</button>
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
        ðŸ‘‹ <b>New here?</b> Install Anthropic's official skill pack
        (PDF, Excel, Word helpers â€” drop-in compatible) to give your
        agents pro-grade capabilities out of the box.
      </span>
      <button
        onClick={onOpen}
        style={{
          background: "#4a6cff", color: "#fff", border: "none",
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
      >âœ•</button>
    </div>
  );
}

// SearchBar â€” Qt's Studio doesn't ship one explicitly, but the
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
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.06)",
          color: "#dadcdf",
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
            background: "transparent", color: "#9aa0a6",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 8, padding: "6px 10px", cursor: "pointer",
          }}
        >âœ•</button>
      )}
    </div>
  );
}

// TeamCard â€” mirrors team_grid_view.py:64 TeamCard. Category-coloured
// accent strip on the left, agent mini-avatars row, MCP chips, CUSTOM
// tag in the corner for non-built-ins, selected-state outline.
function TeamCard({
  team, selected, onClick,
}: {
  team: Team; selected: boolean; onClick: () => void;
}) {
  const accent = CATEGORY_ACCENT[team.category] ?? "#74a4ff";
  const border = selected ? "rgba(124,150,255,0.95)" : "rgba(255,255,255,0.06)";
  return (
    <div
      onClick={onClick}
      style={{
        minHeight: 180,
        maxHeight: 220,
        cursor: "pointer",
        background: "linear-gradient(135deg, #1c2236 0%, #0d1019 100%)",
        // 3px accent strip on the left â€” category colour. (Qt sets the
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
          <div style={{ color: "#fff", fontWeight: 700, fontSize: 13 }}>{team.display}</div>
          <div style={{ fontSize: 10, letterSpacing: 0.6 }}>
            <span style={{ color: accent }}>{team.category.toUpperCase()}</span>
            <span style={{ color: "#9aa0a6" }}>  Â·  {team.agents.length} agents</span>
          </div>
        </div>
        {!team.builtIn && (
          <span style={{
            color: "#ff7ed1", background: "rgba(255,126,209,0.10)",
            borderRadius: 5, padding: "2px 6px",
            fontSize: 9, letterSpacing: 0.8,
          }}>CUSTOM</span>
        )}
      </div>

      <div style={{
        color: "#bbc1cc", fontSize: 11, lineHeight: 1.45,
        maxHeight: 48,
        display: "-webkit-box",
        WebkitLineClamp: 3,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}>{team.description}</div>

      {/* Agent mini-avatars row â€” first 6 + "+N" overflow */}
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
          <span style={{ color: "#9aa0a6", fontSize: 10 }}>
            +{team.agents.length - 6}
          </span>
        )}
      </div>

      {/* MCP needs chips â€” first 4 + "+N" overflow */}
      {team.requiredMcp.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          {team.requiredMcp.slice(0, 4).map(m => (
            <span key={m} style={{
              color: "#9aa0a6",
              background: "rgba(255,255,255,0.05)",
              borderRadius: 4, padding: "1px 6px",
              fontSize: 9,
            }}>{m.replace(/^mcp\./, "")}</span>
          ))}
          {team.requiredMcp.length > 4 && (
            <span style={{ color: "#9aa0a6", fontSize: 9 }}>
              +{team.requiredMcp.length - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// "Create your own team" tile â€” team_grid_view.py:230 _build_create_inner.
// Dashed border, centred ï¼‹ + title + sub.
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
      <div style={{ color: "#a8b8ff", fontSize: 36, fontWeight: 700, lineHeight: 1 }}>ï¼‹</div>
      <div style={{ color: "#dde3ff", fontSize: 12, fontWeight: 700 }}>Create your own team</div>
      <div style={{ color: "#9aa0a6", fontSize: 11 }}>Pick agents, name it, save it as a template.</div>
    </div>
  );
}

// TeamsGrid â€” groups teams by category in CATEGORY_ORDER, each section
// header coloured by its category accent. The "Build your own" section
// always renders last with the dashed CreateTeamCard. Mirrors
// team_grid_view.py:280 TeamGridView.set_templates.
function TeamsGrid({ teams, selected, onSelect, onCreate }: {
  teams: Team[];
  selected: string | null;
  onSelect: (name: string) => void;
  onCreate: () => void;
}) {
  // Group by category (CUSTOM section for non-built-ins; mirrors
  // team_grid_view.py:323).
  const groups = useMemo(() => {
    const g: Record<string, Team[]> = {};
    for (const t of teams) {
      const cat = t.builtIn ? t.category : "Custom";
      (g[cat] ??= []).push(t);
    }
    for (const k in g) {
      g[k].sort((a, b) => a.display.toLowerCase().localeCompare(b.display.toLowerCase()));
    }
    return g;
  }, [teams]);

  const orderedCats = [
    ...CATEGORY_ORDER.filter(c => c in groups),
    ...Object.keys(groups).filter(c => !CATEGORY_ORDER.includes(c)).sort(),
  ];

  return (
    <div style={{
      flex: 1, overflow: "auto", paddingRight: 8, paddingBottom: 12,
      display: "flex", flexDirection: "column", gap: 18,
    }}>
      {orderedCats.map(cat => {
        const accent = CATEGORY_ACCENT[cat] ?? "#9aa0a6";
        return (
          <div key={cat}>
            <div style={{
              fontSize: 10, color: accent, textTransform: "uppercase",
              letterSpacing: 1.2, marginBottom: 8, fontWeight: 700,
              padding: "0 2px",
            }}>{cat}</div>
            <div style={{
              display: "grid",
              // Qt _COLS = 3 â€” but we still let the grid wrap on
              // narrow viewports via auto-fill.
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 12,
            }}>
              {groups[cat].map(t => (
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

      {/* BUILD YOUR OWN â€” always last, mirrors _build_create_section. */}
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

// Mini agent card inside the detail panel â€” team_grid_view.py:432
// _AgentMiniCard. Card-wide icon tile, centered name, LEADER ribbon
// for orchestrator/can_dispatch.
function AgentMiniCard({ spec }: { spec: AgentSpec }) {
  const isLeader = spec.base === "orchestrator";
  const accent = isLeader ? "#ffc060" : "rgba(255,255,255,0.06)";
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
        border: "1px solid rgba(255,255,255,0.04)",
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
          return d.length > 22 ? d.slice(0, 21) + "â€¦" : d;
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

// Detail panel â€” team_grid_view.py:632 TeamDetailPanel. Header
// (icon + title + categoryÂ·N agentsÂ·M connectionsÂ·BUILT-IN/CUSTOM
// chip), description, AGENTS grid, ROUTING list, MCP NEEDED chips,
// Delete (custom only) + primary CTA.
function TeamDetailPanel({
  team, onCreateProject, onEditTemplate, onDuplicateTemplate, onDeleteTemplate,
}: {
  team: Team | null;
  onCreateProject: (name: string) => void;
  onEditTemplate: (name: string) => void;
  onDuplicateTemplate: (name: string) => void;
  onDeleteTemplate: (name: string) => void;
}) {
  if (!team) {
    return (
      <div style={{
        flex: 1,
        background: "#0f1218",
        border: "1px solid rgba(255,255,255,0.04)",
        borderRadius: 12, padding: 24,
        color: "#6c7280", fontSize: 12,
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
      background: "#0f1218",
      border: "1px solid rgba(255,255,255,0.04)",
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
          <div style={{ fontSize: 18, fontWeight: 800, color: "#fff" }}>{team.display}</div>
          <div style={{ fontSize: 10, letterSpacing: 0.6 }}>
            <span style={{ color: accent }}>{team.category.toUpperCase()}</span>
            <span style={{ color: "#9aa0a6" }}>
              {"  Â·  "}{team.agents.length} agents
              {"  Â·  "}{team.edges.length} connections
              {"  Â·  "}
            </span>
            <span style={{ color: team.builtIn ? "#9aa0a6" : "#ff7ed1" }}>
              {team.builtIn ? "BUILT-IN" : "CUSTOM"}
            </span>
          </div>
        </div>
      </div>

      {/* Description */}
      {team.description && (
        <div style={{ color: "#cbd2e0", fontSize: 12, lineHeight: 1.6 }}>
          {team.description}
        </div>
      )}

      {/* AGENTS */}
      <div style={{
        color: "#9aa0a6", fontSize: 10, letterSpacing: 1,
        paddingTop: 6, fontWeight: 700,
      }}>AGENTS</div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gap: 10,
      }}>
        {team.agents.map(a => <AgentMiniCard key={a.name} spec={a} />)}
      </div>

      {/* ROUTING â€” src â†’ dst lines, monospace */}
      {team.edges.length > 0 && (
        <>
          <div style={{
            color: "#9aa0a6", fontSize: 10, letterSpacing: 1,
            paddingTop: 6, fontWeight: 700,
          }}>ROUTING</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {team.edges.map((e, i) => (
              <div key={i} style={{
                color: "#bbc1cc",
                fontFamily: "'Consolas','JetBrains Mono',monospace",
                fontSize: 11,
              }}>
                {e.source}  â†’  {e.target}
              </div>
            ))}
          </div>
        </>
      )}

      {/* MCP NEEDED */}
      {team.requiredMcp.length > 0 && (
        <>
          <div style={{
            color: "#9aa0a6", fontSize: 10, letterSpacing: 1,
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

      <div style={{ flex: 1 }} />

      {/* Actions â€” Edit / Duplicate / Delete (custom only) on the left,
          primary "+ New project from <name>" on the right. Qt only
          shows Edit/Delete for non-built-ins; Duplicate is a Studio
          affordance the user asked us to add. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {!team.builtIn && (
          <>
            <button
              onClick={() => onEditTemplate(team.name)}
              style={{
                minHeight: 34,
                background: "rgba(255,255,255,0.05)", color: "#dadcdf",
                border: "none", borderRadius: 8, padding: "0 14px",
                cursor: "pointer", fontSize: 12,
              }}
            >Edit</button>
            <button
              onClick={() => onDuplicateTemplate(team.name)}
              style={{
                minHeight: 34,
                background: "rgba(255,255,255,0.05)", color: "#dadcdf",
                border: "none", borderRadius: 8, padding: "0 14px",
                cursor: "pointer", fontSize: 12,
              }}
            >Duplicate</button>
            <button
              onClick={() => onDeleteTemplate(team.name)}
              style={{
                minHeight: 34,
                background: "rgba(255,140,140,0.12)", color: "#ff8c8c",
                border: "none", borderRadius: 8, padding: "0 14px",
                cursor: "pointer", fontSize: 12,
              }}
            >Delete</button>
          </>
        )}
        {team.builtIn && (
          // Built-ins can only be duplicated.
          <button
            onClick={() => onDuplicateTemplate(team.name)}
            style={{
              minHeight: 34,
              background: "rgba(255,255,255,0.05)", color: "#dadcdf",
              border: "none", borderRadius: 8, padding: "0 14px",
              cursor: "pointer", fontSize: 12,
            }}
          >Duplicate</button>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => onCreateProject(team.name)}
          style={{
            minHeight: 38,
            background: "#4a6cff", color: "#fff",
            border: "none", borderRadius: 9, padding: "0 16px",
            fontWeight: 600, fontSize: 12, cursor: "pointer",
          }}
        >+ New project from {team.display}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Agents view â€” gallery + detail mirror of agent_studio_page.py:1257
// ---------------------------------------------------------------------

// Agent gallery card â€” mirrors agent_studio_page.py:172 _GalleryCard.
// Fixed 140px height, accent-coloured left border (#4a6cff for
// built-ins/skills, #7a8a9c for plain custom), badges row (BUILT-IN,
// SKILL, LEADER).
function AgentCard({
  agent, selected, onClick,
}: {
  agent: AgentDef; selected: boolean; onClick: () => void;
}) {
  const accent = (agent.builtIn || agent.isSkill) ? "#4a6cff" : "#7a8a9c";
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
          ? "0 4px 12px rgba(127,223,255,0.18)"
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
            color: "#fff", fontSize: 14, fontWeight: 700,
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
          color: "#9aa0a6", fontSize: 12, lineHeight: 1.4,
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

// AgentDetailPanel â€” mirrors agent_studio_page.py:426 _EditorPanel
// at a stub level. The full editor (name/desc/system-prompt/tools/
// voice/MCP) needs /v1/agents endpoints to be useful; for now we
// surface the read-only summary + the action buttons (Save / Duplicate /
// Delete) so the UI matches Qt's affordances.
function AgentDetailPanel({
  agent,
  onSave,
  onDuplicate,
  onDelete,
}: {
  agent: AgentDef | null;
  onSave: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  if (!agent) {
    return (
      <div style={{
        flex: 1,
        background: "#0f1218",
        border: "1px solid rgba(255,255,255,0.04)",
        borderRadius: 12, padding: 24,
        color: "#6c7280", fontSize: 12,
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
      background: "#0f1218",
      border: "1px solid rgba(255,255,255,0.04)",
      borderRadius: 12, padding: 20,
      display: "flex", flexDirection: "column", gap: 14,
      overflow: "auto",
    }}>
      {/* Big avatar + name field. Qt uses a 240Ã—240 button (line 477). */}
      <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
        <div style={{
          width: 200, height: 200, flexShrink: 0,
          background: "rgba(255,255,255,0.10)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 18,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <img src={owlSrc(agent.icon)} style={{ width: 180, height: 180, objectFit: "contain" }} />
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div style={{ color: "#9aa0a6", fontSize: 13 }}>Name</div>
          <input
            defaultValue={displayLabel(agent.name)}
            disabled={!editable}
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.06)",
              color: editable ? "#fff" : "#888",
              borderRadius: 8, padding: "0 12px",
              minHeight: 40, fontSize: 15,
            }}
          />
          <div style={{ color: "#9aa0a6", fontSize: 13, marginTop: 4 }}>Default model</div>
          <div style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.06)",
            color: "#dadcdf",
            borderRadius: 8, padding: "10px 12px", fontSize: 13,
          }}>Auto (per-task selection)</div>
        </div>
      </div>

      {agent.builtIn && (
        <div style={{
          color: "#c5cdff",
          background: "rgba(74,108,255,0.10)",
          borderRadius: 8, padding: "8px 12px", fontSize: 13,
        }}>
          ðŸ”’  This is a built-in agent. To modify it, click <b>Duplicate</b> first.
        </div>
      )}

      <div style={{
        color: "#9aa0a6", fontSize: 13, fontWeight: 600,
        letterSpacing: 0.6, textTransform: "uppercase", marginTop: 4,
      }}>Job description</div>
      <div style={{
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.06)",
        color: "#dadcdf",
        borderRadius: 8, padding: "10px 12px", fontSize: 13,
      }}>{agent.description}</div>

      <div style={{ flex: 1 }} />

      {/* Action row â€” Save (primary) / Duplicate (ghost) / Delete (destructive). */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onSave}
          disabled={!editable}
          style={{
            flex: 1, minHeight: 42,
            background: editable ? "#4a6cff" : "#2c313c",
            color: editable ? "#fff" : "#777",
            border: "none", borderRadius: 8, padding: "0 20px",
            fontWeight: 600, cursor: editable ? "pointer" : "default",
          }}
        >Save</button>
        <button
          onClick={onDuplicate}
          style={{
            minHeight: 42,
            background: "rgba(255,255,255,0.05)", color: "#dadcdf",
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
// Backend shapes — match Rust agents::TeamTemplate / AgentRole.
type TeamTemplateBackend = { id: string; path: string; built_in: boolean; data: any };
type AgentRoleBackend     = { id: string; path: string; built_in: boolean; data: any };

function toTeam(t: TeamTemplateBackend): Team {
  const d = t.data ?? {};
  const agents: AgentSpec[] = Array.isArray(d.agents)
    ? d.agents.map((a: any) => ({ name: a.name, base: a.base, icon: a.icon ?? null }))
    : [];
  const edges = Array.isArray(d.graph?.edges) ? d.graph.edges : [];
  return {
    name: d.name ?? t.id,
    display: d.display_name ?? t.id,
    category: d.category ?? "Other",
    icon: d.icon ?? "owl:owl_asssitant",
    description: d.description ?? "",
    agents,
    edges,
    requiredMcp: Array.isArray(d.required_mcp) ? d.required_mcp : [],
    builtIn: t.built_in,
  };
}
function toAgentDef(r: AgentRoleBackend): AgentDef {
  const d = r.data ?? {};
  return {
    name: d.name ?? r.id,
    icon: d.icon ?? "owl:owl_asssitant",
    description: d.description ?? "",
    builtIn: r.built_in,
    canDispatch: d.can_dispatch === true,
  };
}

export default function StudioPage() {
  const [view, setView] = useState<"teams" | "agents">("teams");
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [bannerVisible, setBannerVisible] = useState(true);
  const [teamQuery, setTeamQuery] = useState("");
  const [agentQuery, setAgentQuery] = useState("");
  const [teams, setTeams] = useState<Team[]>(TEAMS_FALLBACK);
  const [agents, setAgents] = useState<AgentDef[]>(AGENTS_FALLBACK);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [rawTeams, rawAgents] = await Promise.all([
          invoke<TeamTemplateBackend[]>("list_team_templates"),
          invoke<AgentRoleBackend[]>("list_agent_roles"),
        ]);
        if (dead) return;
        setTeams(rawTeams.map(toTeam));
        setAgents(rawAgents.map(toAgentDef));
      } catch (e) {
        if (!dead) setLoadError(String(e));
      }
    })();
    return () => { dead = true; };
  }, []);

  const filteredTeams = useMemo(() => {
    const q = teamQuery.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter(t =>
      t.display.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q) ||
      t.agents.some(a => a.name.toLowerCase().includes(q))
    );
  }, [teamQuery, teams]);

  const filteredAgents = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q)
    );
  }, [agentQuery, agents]);

  const team = teams.find(t => t.name === selectedTeam) ?? null;
  const agent = agents.find(a => a.name === selectedAgent) ?? null;

  // Sub-label text per view â€” verbatim from agent_studio_page.py:1126-1136.
  const subLabel = view === "teams"
    ? "Pick a team template â€” pre-built collections of agents wired to do a kind of work (Secretary, Bug Hunter, Research Lab, â€¦). One click spawns a project with the team ready to run."
    : "Design individual agents â€” pick an avatar, a job, the tools they get to use. Built-ins ship with OWLLM and can't be edited; click Duplicate on any built-in to make your own copy.";

  // Handler stubs â€” Tauri commands will land here once the
  // /v1/teams + /v1/agents/definitions endpoints exist.
  const handleCreateProjectFromTeam = (name: string) => {
    // TODO: invoke('create_project_from_template', { template: name })
    console.log("[Studio] create project from", name);
  };
  const handleEditTemplate = (name: string) => {
    console.log("[Studio] edit template", name);
  };
  const handleDuplicateTemplate = (name: string) => {
    console.log("[Studio] duplicate template", name);
  };
  const handleDeleteTemplate = (name: string) => {
    if (confirm(`Delete the team template '${name}'?\nExisting projects spawned from it stay intact.`)) {
      console.log("[Studio] delete template", name);
    }
  };
  const handleCreateTeam = () => {
    // TODO: open TeamBuilderDialog equivalent.
    console.log("[Studio] new team");
  };
  const handleNewAgent = () => {
    console.log("[Studio] new custom agent");
  };
  const handleOpenSkillLibrary = () => {
    console.log("[Studio] open skill library");
  };

  return (
    <div style={{
      padding: "16px 20px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 12,
      overflow: "hidden",
      background: "#0e1117",  // page background per style notes
    }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>Studio</div>
      <ViewToggle view={view} onChange={setView} />
      <div style={{ color: "#9aa0a6", fontSize: 12 }} dangerouslySetInnerHTML={{ __html: subLabel }} />
      {bannerVisible && (
        <OnboardingBanner
          onOpen={handleOpenSkillLibrary}
          onDismiss={() => setBannerVisible(false)}
        />
      )}

      {view === "teams" ? (
        <>
          {/* Search + (no top-level "+ New Team" â€” the dashed
              CreateTeamCard at the bottom of the grid is Qt's
              actual CTA, see team_grid_view.py:340.) */}
          <SearchBar
            value={teamQuery}
            onChange={setTeamQuery}
            placeholder="Filter teams by name, description, category, or agentâ€¦"
          />
          <div style={{ flex: 1, display: "flex", gap: 12, minHeight: 0 }}>
            <div style={{ flex: 6, display: "flex", flexDirection: "column", minWidth: 0 }}>
              <TeamsGrid
                teams={filteredTeams}
                selected={selectedTeam}
                onSelect={setSelectedTeam}
                onCreate={handleCreateTeam}
              />
            </div>
            <div style={{ flex: 4, display: "flex", minWidth: 0 }}>
              <TeamDetailPanel
                team={team}
                onCreateProject={handleCreateProjectFromTeam}
                onEditTemplate={handleEditTemplate}
                onDuplicateTemplate={handleDuplicateTemplate}
                onDeleteTemplate={handleDeleteTemplate}
              />
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Agents action row â€” mirrors agent_studio_page.py:1265
              ("+ New custom agent", "ðŸ“š Skill Library", refresh). */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={handleNewAgent}
              style={{
                minHeight: 34,
                background: "#4a6cff", color: "#fff",
                border: "none", borderRadius: 8, padding: "0 16px",
                fontWeight: 600, cursor: "pointer", fontSize: 12,
              }}
            >+ New custom agent</button>
            <button
              onClick={handleOpenSkillLibrary}
              title="Browse and install community SKILL.md packs (Anthropic skills, etc.)"
              style={{
                minHeight: 34,
                background: "rgba(255,255,255,0.05)", color: "#dadcdf",
                border: "none", borderRadius: 8, padding: "0 14px",
                cursor: "pointer", fontSize: 12,
              }}
            >ðŸ“š Skill Library</button>
            <div style={{ flex: 1 }} />
            <SearchBar
              value={agentQuery}
              onChange={setAgentQuery}
              placeholder="Filter agentsâ€¦"
            />
          </div>
          <div style={{ flex: 1, display: "flex", gap: 12, minHeight: 0 }}>
            <div style={{
              flex: 6,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))",
              gridAutoRows: "min-content",
              gap: 12,
              overflow: "auto",
              alignContent: "flex-start",
              paddingRight: 8,
              paddingBottom: 12,
              minWidth: 0,
            }}>
              {filteredAgents.map(a => (
                <AgentCard
                  key={a.name}
                  agent={a}
                  selected={selectedAgent === a.name}
                  onClick={() => setSelectedAgent(a.name)}
                />
              ))}
            </div>
            <div style={{ flex: 4, display: "flex", minWidth: 0 }}>
              <AgentDetailPanel
                agent={agent}
                onSave={() => console.log("[Studio] save agent", agent?.name)}
                onDuplicate={() => console.log("[Studio] duplicate agent", agent?.name)}
                onDelete={() => {
                  if (agent && confirm(`Delete custom agent '${displayLabel(agent.name)}'?`)) {
                    console.log("[Studio] delete agent", agent.name);
                  }
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
