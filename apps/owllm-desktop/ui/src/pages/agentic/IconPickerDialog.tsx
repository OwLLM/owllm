// IconPickerDialog — modal grid of available owl avatars, click to pick.
//
// Selections are persisted per-project per-agent in localStorage:
//
//   owllm:agent-icon:<projectId>:<agentName> → "owl:owl_critic"
//
// AgentsPage hydrates these on project switch and passes the per-agent
// override into AgentInfoCard (and eventually the canvas nodes) so the
// picked avatar takes precedence over the role yaml default.
//
// No backend changes — pure client-side preference, survives reload via
// localStorage, no DB migration. Matches the model-picker pattern that
// stores per-agent model overrides the same way.

import React, { useMemo, useState } from "react";

const ICONS = "/Page_icons";

// Owl avatars stored under /Page_icons/Agents/. Discovered by listing
// the dir at build time (see ls C:/1_Git/LocaLLM/icons/Page_icons/Agents/).
// When a new owl is added there, add it here too.
const AGENT_OWLS: string[] = [
  "owl_SSH",
  "owl_SupOrch",
  "owl_asssitant",
  "owl_coder",
  "owl_critic",
  "owl_documentation",
  "owl_operator",
  "owl_orchestrator1",
  "owl_orchestrator2",
  "owl_researcher",
  "owl_webapp",
];

// Toplevel owls — same set AgentsPage.tsx::TOPLEVEL_OWLS uses for the
// `owl:` URL resolver. These live at /Page_icons/<name>.png and are
// repurposable as agent avatars when the role doesn't have a dedicated
// one (or the user wants something more whimsical).
const TOPLEVEL_OWLS: string[] = [
  "owl_agentic",
  "owl_AgenticTeam",
  "owl_FineTuning",
  "owl_FineTuning2",
  "owl_Gamifier",
  "owl_Gamify",
  "owl_chat",
  "owl_chat2",
  "owl_chat3",
  "owl_coding",
  "owl_coding2",
  "owl_defence",
  "owl_download",
  "owl_llm_studio_transparent",
  "owl_models",
  "owl_ready",
  "owl_server",
  "owl_sleeping",
  "owl_startup",
  "owl_startup1",
  "owl_studio_square",
  "owl_studio_square1",
  "owl_thunder",
  "owl_tools",
  "owl_training",
];

// Combined catalogue with grouping for the dialog. "owl:" scheme is
// resolved by owlSrc on the AgentsPage side.
type IconEntry = { ref: string; src: string; section: string };

const CATALOGUE: IconEntry[] = [
  ...AGENT_OWLS.map(n => ({
    ref: `owl:${n}`,
    src: `${ICONS}/Agents/${n}.png`,
    section: "Agent owls",
  })),
  ...TOPLEVEL_OWLS.map(n => ({
    ref: `owl:${n}`,
    src: `${ICONS}/${n}.png`,
    section: "Toplevel owls",
  })),
];

const SECTION_ORDER: string[] = ["Agent owls", "Toplevel owls"];

// ----- Storage -----

function storageKey(projectId: string, agentName: string): string {
  return `owllm:agent-icon:${projectId}:${agentName}`;
}

/// Read the override for one agent. Returns null when nothing's saved
/// or localStorage is unavailable (private mode).
export function getAgentIconOverride(projectId: string, agentName: string): string | null {
  if (!projectId || !agentName) return null;
  try {
    return localStorage.getItem(storageKey(projectId, agentName));
  } catch { return null; }
}

/// Write the override. Passing null/empty removes it (restore default).
export function setAgentIconOverride(projectId: string, agentName: string, ref: string | null): void {
  if (!projectId || !agentName) return;
  try {
    if (!ref) {
      localStorage.removeItem(storageKey(projectId, agentName));
    } else {
      localStorage.setItem(storageKey(projectId, agentName), ref);
    }
  } catch { /* private mode — silent */ }
}

/// Build the per-project override map from localStorage in one pass.
/// Called by AgentsPage on project switch to populate state. Returns
/// {} when storage is unavailable.
export function loadOverridesForProject(projectId: string): Record<string, string> {
  if (!projectId) return {};
  const out: Record<string, string> = {};
  const prefix = `owllm:agent-icon:${projectId}:`;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const agentName = k.slice(prefix.length);
      const v = localStorage.getItem(k);
      if (v) out[agentName] = v;
    }
  } catch { /* private mode */ }
  return out;
}

// ----- Dialog -----

export default function IconPickerDialog({
  open, agentName, currentRef, onCancel, onPick, onReset,
}: {
  open: boolean;
  /// Which agent we're editing. Shown in the dialog header so the user
  /// knows what they're picking for.
  agentName: string;
  /// Current icon ref (override OR resolved default) — used to mark
  /// the matching tile as selected with a highlighted border.
  currentRef: string;
  onCancel: () => void;
  onPick: (ref: string) => void;
  /// "Restore default" — removes the per-agent override so resolution
  /// falls back to spec.icon → role.icon → BASE_OWL.
  onReset: () => void;
}) {
  const [filter, setFilter] = useState("");
  const grouped = useMemo(() => {
    const out: Record<string, IconEntry[]> = {};
    for (const e of CATALOGUE) {
      if (filter && !e.ref.toLowerCase().includes(filter.toLowerCase())) continue;
      (out[e.section] ??= []).push(e);
    }
    return out;
  }, [filter]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9100,
        background: "rgba(8, 10, 18, 0.78)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{
        width: "min(820px, 95vw)",
        maxHeight: "85vh",
        display: "flex", flexDirection: "column",
        background: "rgba(20, 24, 36, 0.98)",
        border: "1px solid rgba(140, 160, 220, 0.35)",
        borderRadius: 12,
        boxShadow: "0 18px 60px rgba(0, 0, 0, 0.6)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "14px 18px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>
              Pick an icon for <span style={{ color: "#ffd97a" }}>{agentName}</span>
            </div>
            <div style={{ color: "#aab2c8", fontSize: 11, marginTop: 2 }}>
              Override is saved per-project. Click 🔄 Reset to restore the role's default.
            </div>
          </div>
          <input
            type="text"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="filter…"
            style={{
              width: 180,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(10,14,22,0.8)",
              color: "#e6ebf7",
              fontSize: 12,
            }}
          />
          <button
            onClick={onReset}
            style={{
              padding: "6px 12px", fontSize: 12,
              background: "rgba(255,179,0,0.18)", color: "#ffcc80",
              border: "1px solid rgba(255,179,0,0.40)", borderRadius: 6,
              cursor: "pointer",
            }}
          >🔄 Reset</button>
          <button
            onClick={onCancel}
            style={{
              padding: "6px 12px", fontSize: 12,
              background: "transparent", color: "#cfd4e1",
              border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6,
              cursor: "pointer",
            }}
          >Cancel</button>
        </div>

        {/* Grid */}
        <div style={{
          flex: 1, overflowY: "auto",
          padding: 16,
          display: "flex", flexDirection: "column", gap: 16,
        }}>
          {SECTION_ORDER.map(section => {
            const items = grouped[section];
            if (!items || items.length === 0) return null;
            return (
              <div key={section}>
                <div style={{
                  color: "var(--fg-subtle)", fontSize: 11,
                  fontWeight: 700, letterSpacing: 1, textTransform: "uppercase",
                  marginBottom: 8,
                }}>{section}</div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
                  gap: 8,
                }}>
                  {items.map(item => {
                    const selected = item.ref === currentRef;
                    return (
                      <button
                        key={item.ref}
                        onClick={() => onPick(item.ref)}
                        title={item.ref}
                        style={{
                          padding: 8,
                          background: selected
                            ? "linear-gradient(180deg, rgba(120,160,255,0.25), rgba(60,100,200,0.15))"
                            : "rgba(20,25,40,0.55)",
                          border: selected
                            ? "2px solid rgba(140,180,255,0.85)"
                            : "1px solid rgba(255,255,255,0.10)",
                          borderRadius: 10,
                          cursor: "pointer",
                          display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                        }}
                      >
                        <img
                          src={item.src}
                          alt={item.ref}
                          style={{
                            width: 56, height: 56, objectFit: "contain",
                            background: "rgba(30,36,52,0.85)",
                            borderRadius: "50%",
                            padding: 4,
                          }}
                        />
                        <div style={{
                          color: selected ? "#cfdfff" : "var(--fg-subtle)",
                          fontSize: 10, fontWeight: selected ? 700 : 400,
                          maxWidth: 80, overflow: "hidden",
                          textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {item.ref.replace(/^owl:owl_/, "").replace(/_/g, " ")}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
