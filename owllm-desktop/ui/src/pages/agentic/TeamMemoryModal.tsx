// Team Memory viewer — the visible window onto the shared, project-wide "brain"
// that agents read and write through the memory_* tools. Opens on the
// `owllm:open-team-memory` window event (dispatched by the 🧠 Memory button in
// the flow toolbar) so it needs no prop threading through the toolbar.
//
// Scope: the STABLE project ID (same key the dispatch loop sets via
// setTeamMemoryScope), so what you see here is exactly what the agents see — and
// what syncs across your PCs through the GitHub vault.

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ModelPicker, { type AccountsStatusLite, type ModelInfo } from "./ModelPicker";
import { CURATOR_OFF, getCuratorModel, setCuratorModel } from "./memoryCurator";

// The 3D graph pulls in three.js — lazy-load it so the WebGL bundle only loads
// when the user opens the Graph view (still bundled, so it works offline).
const TeamMemoryGraph = lazy(() => import("./TeamMemoryGraph"));

type Entry = {
  id: number;
  key: string;
  content: string;
  tags: string;
  author: string;
  ts: number;
  kind: string; // 'fact' (durable, synced) | 'worklog' (auto-captured, local)
};

/// Compact "how long ago" for row footers ("just now", "5m", "3h", "2d").
/// Exported so the Coding hub's conversation list stamps times identically.
export function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function splitTags(s: string): string[] {
  return (s || "").split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
}

export default function TeamMemoryModal({
  projectId,
  projectName,
  active = true,
  openEvent = "owllm:open-team-memory",
}: {
  projectId: string | null | undefined;
  projectName?: string;
  /// With multiple agentic tabs mounted at once, every instance hears the
  /// window-level open event — only the visible tab's modal should open.
  active?: boolean;
  /// Window event that opens this modal. Defaults to the Agents-page toolbar
  /// event; the Code page passes its own scoped name so its 🧠 Memory button
  /// opens ONLY the code modal (the keep-alive Agents modal, mounted+hidden,
  /// must not open behind it).
  openEvent?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"list" | "graph">("list");
  const [tab, setTab] = useState<"facts" | "worklog">("facts");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // New-note composer.
  const [newContent, setNewContent] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newTags, setNewTags] = useState("");
  // Post-run Memory Curator setting for this project: "" = default (Auto ·
  // Cheapest), "off" = disabled, else the picked model id. Stored per scope in
  // localStorage (memoryCurator.ts) — the run loops read it at run end.
  const [curatorRaw, setCuratorRaw] = useState("");
  // Model list + account availability for the shared ModelPicker; loaded once
  // per open so the modal stays instant when the picker is never touched.
  const [pickerModels, setPickerModels] = useState<ModelInfo[]>([]);
  const [pickerAccounts, setPickerAccounts] = useState<AccountsStatusLite | null>(null);
  // Pin the exact durable project id supplied by the opener. Coding resolves
  // its folder asynchronously, so reading only its render-time prop could
  // briefly query the raw folder/fallback scope while Agents queried the real
  // project id. The event detail makes both pages open the same database scope.
  const [openedScope, setOpenedScope] = useState("");

  const propScope = (projectId ?? "").trim();
  const propScopeRef = useRef(propScope);
  propScopeRef.current = propScope;
  const scope = open ? openedScope : propScope;

  const reload = useCallback(async () => {
    if (!scope) { setEntries([]); return; }
    setBusy(true);
    setErr(null);
    try {
      const rows = await invoke<Entry[]>("team_memory_search", {
        scope, query: query.trim(), limit: 300,
      });
      setEntries(rows);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [scope, query]);

  // Open on the toolbar event; load fresh each time it opens.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const onOpen = (event: Event) => {
      if (!activeRef.current) return;
      const detail = event instanceof CustomEvent ? event.detail : null;
      const requested = typeof detail?.projectId === "string" ? detail.projectId.trim() : "";
      setOpenedScope(requested || propScopeRef.current);
      setQuery("");
      setTagFilter(null);
      setEntries([]);
      setErr(null);
      setOpen(true);
    };
    window.addEventListener(openEvent, onOpen as EventListener);
    return () => window.removeEventListener(openEvent, onOpen as EventListener);
  }, [openEvent]);
  useEffect(() => { if (open) void reload(); }, [open, reload]);
  // Curator setting follows the opened scope; picker data loads once per open.
  useEffect(() => { if (open) setCuratorRaw(getCuratorModel(scope)); }, [open, scope]);
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const [m, a] = await Promise.all([
        invoke<ModelInfo[]>("list_models").catch(() => [] as ModelInfo[]),
        invoke<AccountsStatusLite>("accounts_status").catch(() => null),
      ]);
      setPickerModels(m);
      setPickerAccounts(a);
    })();
  }, [open]);

  if (!open) return null;

  const curatorEnabled = curatorRaw !== CURATOR_OFF;
  const applyCurator = (val: string) => {
    setCuratorModel(scope, val);
    setCuratorRaw(val);
  };

  const add = async () => {
    const content = newContent.trim();
    if (!content || !scope) return;
    setBusy(true);
    try {
      await invoke<number>("team_memory_write", {
        scope, content, key: newKey.trim(), tags: newTags.trim(), author: "you",
      });
      window.dispatchEvent(new CustomEvent("owllm:memory:changed"));
      setNewContent(""); setNewKey(""); setNewTags("");
      await reload();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    if (!scope) return;
    setBusy(true);
    try {
      await invoke<number>("team_memory_delete", { scope, id });
      window.dispatchEvent(new CustomEvent("owllm:memory:changed"));
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // Promote a worklog row into a durable fact (kind='fact', synced via vault).
  const promote = async (id: number) => {
    if (!scope) return;
    setBusy(true);
    try {
      await invoke<number>("team_memory_promote", { scope, id });
      window.dispatchEvent(new CustomEvent("owllm:memory:changed"));
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, kind: "fact", tags: "" } : e)));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const facts = entries.filter((e) => e.kind !== "worklog");
  const worklog = entries.filter((e) => e.kind === "worklog");
  // Tag chips over the facts (worklog rows all carry the same synthetic tag).
  const tagCounts = new Map<string, number>();
  for (const e of facts) for (const t of splitTags(e.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tagChips = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const shown = (tab === "facts" ? facts : worklog).filter(
    (e) => tab !== "facts" || !tagFilter || splitTags(e.tags).includes(tagFilter),
  );

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed", inset: 0, zIndex: 4000, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: view === "graph" ? "min(1100px, 96vw)" : "min(720px, 94vw)",
          height: view === "graph" ? "90vh" : undefined,
          maxHeight: "92vh", display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border-strong)",
          borderRadius: 12, boxShadow: "0 20px 60px rgba(0,0,0,0.5)", overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 18 }}>🧠</span>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--fg-strong)" }}>Team Memory</div>
            <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
              Shared knowledge your agents read &amp; write{projectName ? ` · ${projectName}` : ""} · facts sync across your PCs, worklog stays local
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {/* List / Graph view toggle */}
          <div style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: 7, overflow: "hidden", marginRight: 4 }}>
            {(["list", "graph"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                title={v === "graph" ? "3D knowledge graph of the team memory" : "List view"}
                style={{
                  height: 28, padding: "0 11px", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                  background: view === v ? "rgba(var(--accent-rgb),0.18)" : "transparent",
                  color: view === v ? "var(--accent-ink)" : "var(--fg-muted)",
                }}
              >{v === "graph" ? "🌐 Graph" : "☰ List"}</button>
            ))}
          </div>
          <button onClick={() => setOpen(false)} title="Close" style={{ width: 26, height: 26, padding: 0, border: "none", borderRadius: 6, background: "rgba(255,255,255,0.06)", color: "var(--fg)", fontSize: 13, cursor: "pointer" }}>✕</button>
        </div>

        {/* Search */}
        <div style={{ display: "flex", gap: 6, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void reload(); }}
            placeholder="Search memory (keywords) — empty shows most recent"
            style={{ flex: 1, height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--bg-surface)", color: "var(--fg)", fontSize: 12 }}
          />
          <button onClick={() => void reload()} disabled={busy} className="ghost-btn" style={{ height: 32, padding: "0 12px", fontSize: 12 }}>Search</button>
        </div>

        {/* Facts / Worklog tabs + tag chips (list view only) */}
        {view === "list" && (
          <div style={{ padding: "8px 14px 0 14px" }}>
            <div style={{ display: "flex", gap: 4 }}>
              {([["facts", `📌 Facts (${facts.length})`], ["worklog", `📋 Worklog (${worklog.length})`]] as const).map(([t, label]) => (
                <button
                  key={t}
                  onClick={() => { setTab(t); setTagFilter(null); }}
                  title={t === "facts" ? "Durable knowledge — synced across your PCs via the vault" : "Auto-captured record of recent agent work — local to this PC, capped"}
                  style={{
                    height: 28, padding: "0 12px", cursor: "pointer", fontSize: 12, fontWeight: 600,
                    border: "1px solid " + (tab === t ? "rgba(var(--accent-rgb),0.4)" : "var(--border)"),
                    borderBottom: "none", borderRadius: "8px 8px 0 0",
                    background: tab === t ? "rgba(var(--accent-rgb),0.12)" : "transparent",
                    color: tab === t ? "var(--accent-ink)" : "var(--fg-muted)",
                  }}
                >{label}</button>
              ))}
            </div>
            {tab === "facts" && tagChips.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "8px 0 2px 0", borderTop: "1px solid var(--border)" }}>
                {tagChips.map(([t, n]) => (
                  <button
                    key={t}
                    onClick={() => setTagFilter(tagFilter === t ? null : t)}
                    style={{
                      height: 22, padding: "0 9px", borderRadius: 11, cursor: "pointer", fontSize: 10.5, fontWeight: 600,
                      border: "1px solid " + (tagFilter === t ? "rgba(var(--accent-rgb),0.5)" : "var(--border-strong)"),
                      background: tagFilter === t ? "rgba(var(--accent-rgb),0.16)" : "var(--bg-surface)",
                      color: tagFilter === t ? "var(--accent-ink)" : "var(--fg-muted)",
                    }}
                  >🏷 {t} <span style={{ opacity: 0.65 }}>{n}</span></button>
                ))}
                {tagFilter && (
                  <button onClick={() => setTagFilter(null)} style={{ height: 22, padding: "0 8px", borderRadius: 11, cursor: "pointer", fontSize: 10.5, border: "none", background: "transparent", color: "var(--fg-muted)" }}>✕ clear</button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Graph view — 3D knowledge graph of the brain (lazy-loaded). */}
        {view === "graph" && (
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
            <Suspense fallback={<div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--fg-muted)", fontSize: 13 }}>Loading 3D graph…</div>}>
              <TeamMemoryGraph entries={entries} />
            </Suspense>
          </div>
        )}

        {/* List */}
        {view === "list" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 14px" }}>
          {err && <div style={{ color: "#ff8c8c", fontSize: 12, padding: "6px 0" }}>{err}</div>}
          {!scope && <div style={{ color: "var(--fg-muted)", fontSize: 12, padding: "10px 0" }}>Open a project to see its team memory.</div>}
          {scope && shown.length === 0 && !busy && (
            <div style={{ color: "var(--fg-muted)", fontSize: 12, padding: "16px 0", textAlign: "center" }}>
              {tab === "facts"
                ? "No facts yet. Agents save durable knowledge here as they work — or add one below."
                : "No worklog yet. Recent agent turns are auto-recorded here during a run."}
            </div>
          )}
          {shown.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {e.key && <span style={{ display: "inline-block", fontSize: 10, fontWeight: 700, color: "var(--accent-ink)", background: "rgba(var(--accent-rgb),0.12)", borderRadius: 5, padding: "1px 6px", marginRight: 6 }}>{e.key}</span>}
                <span style={{ fontSize: 12.5, color: tab === "worklog" ? "var(--fg-muted)" : "var(--fg)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{e.content}</span>
                <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 3, opacity: 0.85 }}>
                  {tab === "facts" && e.tags ? `🏷 ${e.tags}  ·  ` : ""}
                  {e.author ? `✍ ${e.author}  ·  ` : ""}
                  {e.ts ? fmtAgo(e.ts) : ""}
                </div>
              </div>
              {tab === "worklog" && (
                <button onClick={() => void promote(e.id)} title="Promote to a durable fact (kept forever, synced across your PCs)" style={{ width: 24, height: 24, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: "var(--accent-ink)", fontSize: 12, cursor: "pointer", flexShrink: 0 }}>📌</button>
              )}
              <button onClick={() => void remove(e.id)} title="Delete this memory" style={{ width: 24, height: 24, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: "#ff8c8c", fontSize: 12, cursor: "pointer", flexShrink: 0 }}>🗑</button>
            </div>
          ))}
        </div>
        )}

        {/* Memory Curator — post-run fact extraction: on/off + which model
            does it. Per-project, so a cheap (ideally local) model can curate
            without adding to the team's own token spend. */}
        {view === "list" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderTop: "1px solid var(--border)" }}>
            <label
              title="After each run, one small pass on the model picked here extracts up to 2 durable, novel facts from the outcome into this list. Off = facts are only written when an agent explicitly saves one."
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, color: "var(--fg-muted)", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              <input
                type="checkbox"
                checked={curatorEnabled}
                onChange={(e) => applyCurator(e.target.checked ? "" : CURATOR_OFF)}
                style={{ accentColor: "var(--accent-ink)" }}
              />
              🧠 Curator — save up to 2 facts after each run
            </label>
            <div style={{ flex: 1 }} />
            <div style={{ width: "min(300px, 45%)", opacity: curatorEnabled ? 1 : 0.45 }}>
              <ModelPicker
                value={curatorEnabled ? curatorRaw : ""}
                onChange={(id) => applyCurator(id)}
                models={pickerModels}
                status={pickerAccounts}
                disabled={!curatorEnabled}
                fallbackLabel="Auto · Cheapest (default)"
                placement="top"
              />
            </div>
          </div>
        )}

        {/* Add note */}
        {view === "list" && (
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-surface)" }}>
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="Add a note for the team (a decision, a build command, where something lives…)"
            rows={2}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--bg-panel)", color: "var(--fg)", fontSize: 12, resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="key (optional, e.g. build_command)" style={{ flex: 1, height: 30, padding: "0 9px", borderRadius: 7, border: "1px solid var(--border-strong)", background: "var(--bg-panel)", color: "var(--fg)", fontSize: 11 }} />
            <input value={newTags} onChange={(e) => setNewTags(e.target.value)} placeholder="tags (optional)" style={{ flex: 1, height: 30, padding: "0 9px", borderRadius: 7, border: "1px solid var(--border-strong)", background: "var(--bg-panel)", color: "var(--fg)", fontSize: 11 }} />
            <button onClick={() => void add()} disabled={busy || !newContent.trim() || !scope} className="ghost-btn" style={{ height: 30, padding: "0 14px", fontSize: 12, opacity: (busy || !newContent.trim() || !scope) ? 0.5 : 1 }}>+ Add</button>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
