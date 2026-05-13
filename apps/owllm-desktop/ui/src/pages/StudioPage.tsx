// StudioPage — ported from LLM/desktop_app/pages/agent_studio_page.py
// (AgentStudioPage._build_ui, line 1010). Two views toggled at the
// top:
//
//   🧩 Teams (default)        🤖 Agents
//   ─────────────────         ───────────
//   Gallery grid of team       Gallery grid of agent definitions
//   templates from
//   LLM/core/agents/teams/*.json
//   + detail panel on the
//   right when one is picked
//
// Team metadata is baked in here from the JSON files at commit time —
// later this will be a /v1/teams engine call. Same for agents (will
// be /v1/agents/definitions). For now this is the visual port + a
// representative data set so the user can navigate the catalogue.
import React, { useState } from "react";

const ICONS = "/Page_icons";
const AGENT_ICON_DIR = `${ICONS}/Agents`;

// owl:<basename> → /Page_icons/Agents/<basename>.png  (same resolver
// path as desktop_app/widgets/agent_icons.py:owl_pixmap, just on the
// web side).
function owlSrc(iconRef: string): string {
  if (iconRef.startsWith("owl:")) {
    return `${AGENT_ICON_DIR}/${iconRef.slice(4)}.png`;
  }
  return iconRef;
}

type Team = {
  name: string;
  display: string;
  category: string;
  icon: string;
  description: string;
  agents: number;
};

// Baked from LLM/core/agents/teams/*.json (17 teams). Will become a
// /v1/teams endpoint once the backend exposes one.
const TEAMS: Team[] = [
  { name: "bug_hunter",       display: "Bug Hunter",        category: "Software",  icon: "owl:owl_critic",        description: "Reproduce, bisect, root-cause, patch, and add a regression test.",                                         agents: 6 },
  { name: "code_artisan",     display: "Code Artisan",      category: "Software",  icon: "owl:owl_coder",         description: "Quality-first coding team. Design before coding, tests alongside the implementation, refactor before review.", agents: 6 },
  { name: "code_reviewer",    display: "Code Reviewer",     category: "Software",  icon: "owl:owl_critic",        description: "Multi-axis code review: security, performance, style. Read-only.",                                        agents: 5 },
  { name: "concierge",        display: "Concierge",         category: "Personal",  icon: "owl:owl_operator",      description: "Books, orders, reserves. Compares options, fills out forms, files the receipts.",                          agents: 4 },
  { name: "customer_support", display: "Customer Support",  category: "Ops",       icon: "owl:owl_operator",      description: "Triages tickets, answers from the KB, escalates the rest, writes post-mortems.",                           agents: 5 },
  { name: "data_analyst",     display: "Data Analyst",      category: "Software",  icon: "owl:owl_coder",         description: "SQL writer, notebook runner, visualizer, narrator. Turns a question into a chart + a paragraph.",          agents: 5 },
  { name: "dev_squad",        display: "Dev Squad",         category: "Software",  icon: "owl:owl_coder",         description: "Solo-dev squad: orchestrator, coder, critic, devops, docs. The canonical software-build team.",            agents: 5 },
  { name: "finance",          display: "Finance Steward",   category: "Personal",  icon: "owl:owl_documentation", description: "Classifies transactions, watches the budget, tracks tax lots, drafts invoices.",                           agents: 5 },
  { name: "health_coach",     display: "Health & Habits",   category: "Personal",  icon: "owl:owl_documentation", description: "Logs habits, plans the week, critiques nutrition, runs the weekly review.",                                agents: 5 },
  { name: "learning_tutor",   display: "Learning Tutor",    category: "Knowledge", icon: "owl:owl_documentation", description: "Builds curricula, explains concepts, runs quizzes, schedules spaced-repetition reviews.",                  agents: 5 },
  { name: "product_studio",   display: "Product Studio",    category: "Software",  icon: "owl:owl_researcher",    description: "Design-first team for greenfield products. Two phases: Design (whitepaper) then Build (FE+BE in parallel).", agents: 10 },
  { name: "research_lab",     display: "Research Lab",      category: "Knowledge", icon: "owl:owl_researcher",    description: "Deep-research team. Gathers sources, reads them carefully, synthesises, fact-checks, cites.",              agents: 6 },
  { name: "sales_outreach",   display: "Sales Outreach",    category: "Ops",       icon: "owl:owl_documentation", description: "Researches prospects, drafts personalised outreach, tracks replies, qualifies leads.",                     agents: 5 },
  { name: "secretary",        display: "Secretary",         category: "Personal",  icon: "owl:owl_orchestrator1", description: "Handles email, calendar, contacts, and reminders. The personal-assistant team.",                            agents: 4 },
  { name: "smart_home",       display: "Smart Home",        category: "Ops",       icon: "owl:owl_operator",      description: "Polls devices, runs routines, watches automations, surfaces anomalies.",                                   agents: 4 },
  { name: "social_desk",      display: "Social Desk",       category: "Knowledge", icon: "owl:owl_operator",      description: "Drafts posts, schedules across platforms, monitors engagement, summarises top threads.",                   agents: 4 },
  { name: "writers_room",     display: "Writers' Room",     category: "Knowledge", icon: "owl:owl_documentation", description: "Outlines, drafts, edits, copy-edits, fact-checks. The long-form-writing team.",                            agents: 5 },
];

type AgentDef = { name: string; icon: string; description: string; builtIn: boolean };

// Representative agent definitions matching the icons in Agents/.
// Full agent metadata will come from /v1/agents/definitions.
const AGENTS: AgentDef[] = [
  { name: "orchestrator", icon: "owl:owl_orchestrator1", description: "Plans the work, dispatches one task at a time, integrates results, decides when the team is done.",  builtIn: true },
  { name: "coder",        icon: "owl:owl_coder",         description: "Reads/edits files, runs shell commands, writes code. The doer.",                                       builtIn: true },
  { name: "critic",       icon: "owl:owl_critic",        description: "Reviews code/output for correctness, safety, completeness. Returns APPROVE / REVISE / REJECT.",        builtIn: true },
  { name: "researcher",   icon: "owl:owl_researcher",    description: "Finds sources, extracts claims with citations, synthesises. The library-card carrier of the team.",   builtIn: true },
  { name: "operator",     icon: "owl:owl_operator",      description: "Operates external systems: browser, files, shell, ssh. The hands of the team.",                       builtIn: true },
  { name: "documentation",icon: "owl:owl_documentation", description: "Writes/updates docs, runbooks, READMEs, changelogs. Synthesises long-form narrative.",                builtIn: true },
  { name: "webapp",       icon: "owl:owl_webapp",        description: "Builds web frontends. React + plain HTML + design-system aware.",                                      builtIn: true },
  { name: "SSH",          icon: "owl:owl_SSH",           description: "Connects to remote hosts via SSH, inspects production, deploys updates.",                              builtIn: true },
  { name: "assistant",    icon: "owl:owl_asssitant",     description: "General-purpose helper. The generalist agent for one-shot tasks that don't need a specialist.",       builtIn: true },
];

// ---------------------------------------------------------------------
// Visual building blocks
// ---------------------------------------------------------------------
function ViewToggle({ view, onChange }: {
  view: "teams" | "agents"; onChange: (v: "teams" | "agents") => void;
}) {
  const base: React.CSSProperties = {
    minHeight: 36,
    padding: "0 18px",
    fontSize: 13,
    fontWeight: 700,
    background: "rgba(255,255,255,0.04)",
    color: "#9aa0a6",
    border: "1px solid rgba(255,255,255,0.10)",
    cursor: "pointer",
  };
  return (
    <div style={{ display: "flex", gap: 0, padding: "4px 0" }}>
      <button
        onClick={() => onChange("teams")}
        style={{
          ...base,
          borderTopLeftRadius: 8, borderBottomLeftRadius: 8,
          borderRight: "none",
          background: view === "teams" ? "rgba(127,223,255,0.20)" : base.background,
          color:      view === "teams" ? "#7fdfff" : base.color,
          borderColor: view === "teams" ? "rgba(127,223,255,0.50)" : base.border as string,
        }}
      >🧩 Teams</button>
      <button
        onClick={() => onChange("agents")}
        style={{
          ...base,
          borderTopRightRadius: 8, borderBottomRightRadius: 8,
          background: view === "agents" ? "rgba(127,223,255,0.20)" : base.background,
          color:      view === "agents" ? "#7fdfff" : base.color,
          borderColor: view === "agents" ? "rgba(127,223,255,0.50)" : base.border as string,
        }}
      >🤖 Agents</button>
    </div>
  );
}

function OnboardingBanner({ onDismiss }: { onDismiss: () => void }) {
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
      >✕</button>
    </div>
  );
}

function GalleryCard({
  icon, name, description, badges, selected, onClick,
}: {
  icon: string; name: string; description: string;
  badges: { text: string; color: string; bg: string }[];
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        height: 140,
        cursor: "pointer",
        background: selected
          ? "linear-gradient(180deg, #2a3142 0%, #1d212a 100%)"
          : "linear-gradient(180deg, rgba(45,52,68,0.85) 0%, rgba(30,35,46,0.85) 100%)",
        borderLeft: badges.some(b => b.text === "BUILT-IN" || b.text === "SKILL")
                      ? "3px solid #4a6cff"
                      : "3px solid #7a8a9c",
        borderRadius: 12,
        padding: "12px 16px",
        display: "flex",
        gap: 14,
        boxShadow: selected
          ? "0 4px 12px rgba(127,223,255,0.18)"
          : "0 2px 6px rgba(0,0,0,0.4)",
        transition: "background 0.12s",
      }}
    >
      <img src={owlSrc(icon)} style={{ width: 56, height: 56, flexShrink: 0, objectFit: "contain" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            color: "#fff", fontSize: 14, fontWeight: 700,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{name}</div>
          {badges.map(b => (
            <span key={b.text} style={{
              color: b.color, background: b.bg,
              borderRadius: 6, padding: "2px 8px",
              fontSize: 10, fontWeight: 600, letterSpacing: 0.6,
              flexShrink: 0,
            }}>{b.text}</span>
          ))}
        </div>
        <div style={{
          color: "#9aa0a6", fontSize: 12, lineHeight: 1.4,
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>{description}</div>
      </div>
    </div>
  );
}

function TeamsGrid({ selected, onSelect }: {
  selected: string | null; onSelect: (name: string) => void;
}) {
  // Group by category like the PySide6 TeamGridView does.
  const categories = Array.from(new Set(TEAMS.map(t => t.category)));
  return (
    <div style={{
      flex: 1, overflow: "auto", paddingRight: 8, paddingBottom: 12,
      display: "flex", flexDirection: "column", gap: 16,
    }}>
      {categories.map(cat => (
        <div key={cat}>
          <div style={{
            fontSize: 11, color: "#7fdfff", textTransform: "uppercase",
            letterSpacing: 0.8, marginBottom: 8, fontWeight: 700,
          }}>{cat}</div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))",
            gap: 12,
          }}>
            {TEAMS.filter(t => t.category === cat).map(t => (
              <GalleryCard
                key={t.name}
                icon={t.icon}
                name={t.display}
                description={t.description}
                badges={[
                  { text: `${t.agents} AGENTS`, color: "#9aa0a6", bg: "rgba(154,160,166,0.15)" },
                ]}
                selected={selected === t.name}
                onClick={() => onSelect(t.name)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TeamDetailPanel({ team }: { team: Team | null }) {
  if (!team) {
    return (
      <div style={{
        flex: 1,
        background: "rgba(255,255,255,0.02)",
        borderRadius: 12, padding: 24,
        color: "#7888a8", fontSize: 13,
        display: "flex", alignItems: "center", justifyContent: "center",
        textAlign: "center",
      }}>
        Pick a team on the left to see its agents and<br />create a project from it.
      </div>
    );
  }
  return (
    <div style={{
      flex: 1,
      background: "linear-gradient(180deg, rgba(60,60,80,0.4), rgba(40,40,60,0.4))",
      borderRadius: 12, padding: 24,
      display: "flex", flexDirection: "column", gap: 14,
      overflow: "auto",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <img src={owlSrc(team.icon)} style={{ width: 80, height: 80, objectFit: "contain" }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>{team.display}</div>
          <div style={{ fontSize: 11, color: "#7fdfff", textTransform: "uppercase", letterSpacing: 0.8 }}>
            {team.category} · {team.agents} agents
          </div>
        </div>
      </div>
      <div style={{ color: "#dadcdf", fontSize: 13, lineHeight: 1.6 }}>{team.description}</div>
      <div style={{ flex: 1 }} />
      <button style={{
        height: 42, padding: "0 18px", borderRadius: 8,
        border: "none",
        background: "linear-gradient(180deg, #4a6cff, #3a55cc)",
        color: "#fff", fontSize: 14, fontWeight: 700,
        cursor: "pointer", alignSelf: "flex-start",
      }}>
        + Create project from "{team.display}"
      </button>
    </div>
  );
}

function AgentsGrid() {
  return (
    <div style={{
      flex: 1, overflow: "auto", paddingRight: 8, paddingBottom: 12,
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))",
      gap: 12,
    }}>
      {AGENTS.map(a => (
        <GalleryCard
          key={a.name}
          icon={a.icon}
          name={a.name}
          description={a.description}
          badges={a.builtIn
            ? [{ text: "BUILT-IN", color: "#7989ff", bg: "rgba(121,137,255,0.15)" }]
            : []
          }
          selected={false}
          onClick={() => {}}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
export default function StudioPage() {
  const [view, setView] = useState<"teams" | "agents">("teams");
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [bannerVisible, setBannerVisible] = useState(true);

  const team = TEAMS.find(t => t.name === selectedTeam) ?? null;
  const subLabel = view === "teams"
    ? "Pick a team template — pre-built collections of agents wired to do a kind of work (Secretary, Bug Hunter, Research Lab, …). One click spawns a project with the team ready to run."
    : "Browse the agent roster. Built-ins ship with OWLLM; custom agents are saved per machine. Click any card to inspect or edit.";

  return (
    <div style={{ padding: "16px 20px", height: "100%", display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff" }}>Studio</div>
      <ViewToggle view={view} onChange={setView} />
      <div style={{ color: "#9aa0a6", fontSize: 12 }}>{subLabel}</div>
      {bannerVisible && <OnboardingBanner onDismiss={() => setBannerVisible(false)} />}

      {view === "teams" ? (
        <div style={{ flex: 1, display: "flex", gap: 12, minHeight: 0 }}>
          <div style={{ flex: 6, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <TeamsGrid selected={selectedTeam} onSelect={setSelectedTeam} />
          </div>
          <div style={{ flex: 4, display: "flex", minWidth: 0 }}>
            <TeamDetailPanel team={team} />
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <AgentsGrid />
        </div>
      )}
    </div>
  );
}
