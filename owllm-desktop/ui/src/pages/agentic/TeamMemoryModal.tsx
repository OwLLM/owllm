// Team Memory viewer — the visible window onto the shared, project-wide "brain"
// that agents read and write through the memory_* tools. Opens on the
// `owllm:open-team-memory` window event (dispatched by the 🧠 Memory button in
// the flow toolbar) so it needs no prop threading through the toolbar.
//
// Scope: the STABLE project ID (same key the dispatch loop sets via
// setTeamMemoryScope), so what you see here is exactly what the agents see — and
// what syncs across your PCs through the GitHub vault.

import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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
};

export default function TeamMemoryModal({
  projectId,
  projectName,
}: {
  projectId: string | null | undefined;
  projectName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"list" | "graph">("list");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // New-note composer.
  const [newContent, setNewContent] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newTags, setNewTags] = useState("");

  const scope = (projectId ?? "").trim();

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
  useEffect(() => {
    const onOpen = () => { setOpen(true); };
    window.addEventListener("owllm:open-team-memory", onOpen as EventListener);
    return () => window.removeEventListener("owllm:open-team-memory", onOpen as EventListener);
  }, []);
  useEffect(() => { if (open) void reload(); }, [open, reload]);

  if (!open) return null;

  const add = async () => {
    const content = newContent.trim();
    if (!content || !scope) return;
    setBusy(true);
    try {
      await invoke<number>("team_memory_write", {
        scope, content, key: newKey.trim(), tags: newTags.trim(), author: "you",
      });
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
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

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
              Shared knowledge your agents read &amp; write{projectName ? ` · ${projectName}` : ""} · syncs across your PCs
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
                  color: view === v ? "var(--accent)" : "var(--fg-muted)",
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
          {scope && entries.length === 0 && !busy && (
            <div style={{ color: "var(--fg-muted)", fontSize: 12, padding: "16px 0", textAlign: "center" }}>
              No memory yet. Agents save facts here as they work — or add one below.
            </div>
          )}
          {entries.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {e.key && <span style={{ display: "inline-block", fontSize: 10, fontWeight: 700, color: "var(--accent)", background: "rgba(var(--accent-rgb),0.12)", borderRadius: 5, padding: "1px 6px", marginRight: 6 }}>{e.key}</span>}
                <span style={{ fontSize: 12.5, color: "var(--fg)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{e.content}</span>
                {(e.tags || e.author) && (
                  <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 3 }}>
                    {e.tags ? `🏷 ${e.tags}` : ""}{e.tags && e.author ? "  ·  " : ""}{e.author ? `✍ ${e.author}` : ""}
                  </div>
                )}
              </div>
              <button onClick={() => void remove(e.id)} title="Delete this memory" style={{ width: 24, height: 24, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: "#ff8c8c", fontSize: 12, cursor: "pointer", flexShrink: 0 }}>🗑</button>
            </div>
          ))}
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
