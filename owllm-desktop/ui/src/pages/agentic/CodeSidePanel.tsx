// CodeSidePanel — the Code page's right column (user spec 2026-07-04):
// a RESIZABLE column (drag its left edge; default 15% of the window, min
// 300px) with TWO pages on a tab strip (the same tab pattern as
// TeamMemoryModal) and a utility container docked at the BOTTOM:
//   • ⚡ Super User page — the SHARED RulesEditor (the exact rules UI the
//     agentic team's Rules tab renders — one component, never forked).
//     When the folder matches an agentic project the rules are stored
//     under that project's id, so the team page and the Code page edit
//     ONE rule set.
//   • 📓 Notebook page — the shared RunNotebook rendered INLINE (passed in
//     as `notebook` by CodePage so all its wiring stays in one place).
//   • bottom container: USAGE on top (VS Code-style — provider quota bars
//     where a quota API exists + the app's own recorded traffic for EVERY
//     model), then the agent MODE (plan / auto / chat) + Browser toggle.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Directive } from "./dispatch";
import RulesEditor from "./RulesEditor";

export type CodeAgentMode = "plan" | "auto" | "chat";

const WIDTH_KEY = "owllm:code:sidew";
const TAB_KEY = "owllm:code:sidetab";
// The inline Notebook contains multi-line working notes and step editors.
// At 300px their usable typing width fell below 250px after card padding.
const MIN_W = 420;

export type CodeSidePanelTab = "super" | "notebook";

/// Choose which page the right column shows the next time it mounts. The
/// collapsed rail uses this so its 📓 / ⚡ icons land on the page they name —
/// the panel unmounts while shrunk, so its stored preference IS the handover.
export function selectCodeSidePanelTab(tab: CodeSidePanelTab): void {
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* keeps the last choice */ }
}

type UsageWindow = { label: string; usedPct: number; resetsAt?: string | null };
type UsageStat = { label: string; turns: number; tokensEst: number };
type AccountUsage = { available: boolean; provider: string; note: string; windows: UsageWindow[]; stats: UsageStat[]; balance?: string | null };

/// "34k" / "1.2M" for the tokens-estimate stat.
function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/// "Resets in 3h" from an ISO timestamp — coarse on purpose (like VS Code).
function resetsIn(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return `Resets in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `Resets in ${h}h`;
  return `Resets in ${Math.round(h / 24)}d`;
}

type Props = {
  /// Directives + notebook scope: the matching agentic project id when the
  /// folder is a team project, else a stable per-folder key.
  scopeId: string;
  /// True when scopeId IS an agentic project (rules/notebook shared with the team).
  sharedWithTeam: boolean;
  directives: Directive[];
  onDirectivesChanged: () => void | Promise<void>;
  /// Agent mode — drives what the composer's primary button does.
  mode: CodeAgentMode;
  onModeChange: (m: CodeAgentMode) => void;
  /// Agent Browser popup (owned by CodePage; the button here just toggles it).
  browserOpen: boolean;
  onToggleBrowser: () => void;
  /// providerFor(modelId) for the active model — drives the usage fetch.
  usageProvider: string;
  /// The inline RunNotebook (CodePage owns its props/wiring).
  notebook: ReactNode;
  /// Collapse this outer column to its arrow rail. CodePage owns/persists state.
  onCollapse: () => void;
};

export default function CodeSidePanel({ scopeId, sharedWithTeam, directives, onDirectivesChanged, mode, onModeChange, browserOpen, onToggleBrowser, usageProvider, notebook, onCollapse }: Props) {
  // ---- Resizable width: make the Notebook comfortably writable by default. ----
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = parseInt(localStorage.getItem(WIDTH_KEY) || "", 10);
      if (Number.isFinite(saved) && saved >= MIN_W) return saved;
    } catch { /* default below */ }
    return Math.max(MIN_W, Math.round(window.innerWidth * 0.28));
  });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const w = Math.min(Math.round(window.innerWidth * 0.6), Math.max(MIN_W, d.startW + (d.startX - ev.clientX)));
      setWidth(w);
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setWidth((w) => { try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { } return w; });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // ---- Tabs (same strip pattern as TeamMemoryModal Facts/Worklog) ----
  const [tab, setTab] = useState<CodeSidePanelTab>(() => {
    try { return localStorage.getItem(TAB_KEY) === "notebook" ? "notebook" : "super"; } catch { return "super"; }
  });
  const pickTab = (t: CodeSidePanelTab) => { setTab(t); selectCodeSidePanelTab(t); };

  // ---- Account usage (VS Code-style) — refreshed on provider change + every 5 min ----
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      invoke<AccountUsage>("account_usage", { provider: usageProvider || "" })
        .then((u) => { if (alive) setUsage(u); })
        .catch(() => { if (alive) setUsage(null); });
    };
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [usageProvider]);

  const sectionTitle: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: "var(--fg-muted)", textTransform: "uppercase" };

  const MODES: Array<{ id: CodeAgentMode; label: string; hint: string }> = [
    { id: "plan", label: "📋 Plan", hint: "Break the goal into ordered Kanban steps, then build them one by one." },
    { id: "auto", label: "⚡ Auto", hint: "Act directly — read, edit, create files and run commands to do the task." },
    { id: "chat", label: "💬 Chat", hint: "Discuss/review only — read-only tools, no edits, no state-changing commands." },
  ];

  const tabBtn = (t: "super" | "notebook", label: string) => (
    <button
      key={t}
      onClick={() => pickTab(t)}
      style={{
        height: 28, padding: "0 12px", cursor: "pointer", fontSize: 12, fontWeight: 600,
        border: "1px solid " + (tab === t ? "rgba(var(--accent-rgb),0.4)" : "var(--border)"),
        borderBottom: "none", borderRadius: "8px 8px 0 0",
        background: tab === t ? "rgba(var(--accent-rgb),0.12)" : "transparent",
        color: tab === t ? "var(--accent-ink)" : "var(--fg-muted)",
      }}
    >{label}</button>
  );

  return (
    <div data-ui="CodeSidePanel" style={{ position: "relative", width, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 6, background: "linear-gradient(135deg, rgba(38,30,10,0.55) 0%, rgba(18,14,4,0.55) 100%)", border: "1px solid rgba(255,200,80,0.3)", borderRadius: 8, padding: "8px 10px 8px 12px" }}>
      {/* Drag handle — resize by dragging the column's left edge. */}
      <div
        onMouseDown={onDragStart}
        title="Drag to resize"
        style={{ position: "absolute", left: -2, top: 0, bottom: 0, width: 7, cursor: "col-resize", zIndex: 2 }}
      />

      {/* ---- Tab strip: ⚡ Super User | 📓 Notebook (two PAGES) ---- */}
      <div style={{ display: "flex", gap: 4, alignItems: "flex-end", borderBottom: "1px solid var(--border)", paddingTop: 2 }}>
        <button
          data-ui="CodeUtilityPanelCollapse"
          onClick={onCollapse}
          aria-label="Shrink right utility column"
          title="Shrink right column"
          style={{ height: 28, width: 28, padding: 0, flexShrink: 0, cursor: "pointer", fontSize: 18, lineHeight: 1, border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-surface)", color: "var(--fg-muted)" }}
        >›</button>
        {tabBtn("super", "⚡ Super User")}
        {tabBtn("notebook", "📓 Notebook")}
        {sharedWithTeam && (
          <span title="This folder is also an agentic project — rules and notebook are SHARED with the team pages." style={{ marginLeft: "auto", marginBottom: 4, fontSize: 10, color: "var(--fg-muted)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap" }}>shared with team</span>
        )}
      </div>

      {/* ---- Page: Notebook (kept mounted so notes/digest survive tab flips) ---- */}
      <div style={{ flex: 1, minHeight: 0, display: tab === "notebook" ? "flex" : "none", flexDirection: "column" }}>
        {notebook}
      </div>

      {/* ---- Page: Super User (project rules) — the SHARED RulesEditor ---- */}
      {tab === "super" && (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", background: "var(--bg-input)" }}>
          <RulesEditor
            projectId={scopeId}
            directives={directives}
            onChanged={onDirectivesChanged}
            scopeNote={sharedWithTeam
              ? "Applied to every coder turn AND every agent on this project's team — one shared rule set."
              : "Applied to every coder turn in this workspace."}
          />
        </div>
      )}

      {/* ---- Bottom utility container: USAGE on top, then mode + browser. ---- */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border-strong)", borderRadius: 8, padding: "8px 10px", background: "var(--bg-input)", flexShrink: 0 }}>
        {/* USAGE — like VS Code: provider quota bars when the account
            reports them, plus the app's own recorded traffic for EVERY
            model (local, API keys, CLIs — model-agnostic by design). */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ ...sectionTitle, fontSize: 10 }}>Usage</span>
          {usage?.available && usage.windows.map((w, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ display: "flex", alignItems: "baseline", fontSize: 11.5, color: "var(--fg)" }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.label}</span>
                <span style={{ fontWeight: 700 }}>{Math.round(w.usedPct)}%</span>
              </div>
              {/* Track: theme-agnostic translucent grey — var(--bg-surface) vanishes on black themes. */}
              <div style={{ height: 4, borderRadius: 2, background: "rgba(148,158,178,0.30)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(100, Math.max(0, w.usedPct))}%`, borderRadius: 2, background: w.usedPct >= 90 ? "#ff8c8c" : w.usedPct >= 70 ? "#ffd27a" : "var(--accent)" }} />
              </div>
              {resetsIn(w.resetsAt) && <span style={{ fontSize: 10, color: "var(--fg-muted)" }}>{resetsIn(w.resetsAt)}</span>}
            </div>
          ))}
          {/* Prepaid providers (Moonshot, DeepSeek…) report a balance, not quota windows. */}
          {usage?.balance && (
            <div style={{ fontSize: 11, color: "var(--fg)" }}>{usage.balance}</div>
          )}
          {(usage?.stats?.length ?? 0) > 0 && usage!.stats.map((s, i) => (
            <div key={`s${i}`} style={{ display: "flex", alignItems: "baseline", fontSize: 11, color: "var(--fg)" }} title="This app's recorded traffic for this provider — token count is an estimate (~4 chars/token).">
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-muted)" }}>{s.label}</span>
              <span>{s.turns} turns · ~{compactNum(s.tokensEst)} tok</span>
            </div>
          ))}
          {usage && !usage.available && !usage.balance && (usage.stats?.length ?? 0) === 0 && (
            <span style={{ fontSize: 10.5, color: "var(--fg-muted)" }} title={usage.note || ""}>
              no traffic recorded yet for this account
            </span>
          )}
          {!usage && <span style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>…</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
          <div style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: 7, overflow: "hidden" }}>
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => onModeChange(m.id)}
                title={m.hint}
                style={{
                  height: 26, padding: "0 9px", fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none",
                  background: mode === m.id ? "rgba(var(--accent-rgb),0.22)" : "transparent",
                  color: mode === m.id ? "var(--accent-ink)" : "var(--fg-muted)",
                }}
              >{m.label}</button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <button
            className="btn"
            onClick={onToggleBrowser}
            title="View + drive the agents' shared web browser (browser_* tools) — see the live page, open URLs, stop the daemon."
            style={{ fontSize: 11, padding: "3px 10px", ...(browserOpen ? { borderColor: "var(--accent)", color: "var(--accent-ink)" } : {}) }}
          >🌐 Browser</button>
        </div>
      </div>
    </div>
  );
}
