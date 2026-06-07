// GitBar — git controls for the Code page header.
//
// Self-contained: polls git_status for the open workspace and renders a branch
// chip ("⎇ main · 3●") that opens a popover with branch switch / new branch,
// commit-all, and a diff viewer. Renders nothing when the folder isn't a git
// repo, so it's safe to mount unconditionally. Backed by the git.rs commands.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type GitFile = { code: string; path: string };
type GitStatus = { isRepo: boolean; branch: string; ahead: number; behind: number; files: GitFile[] };
type GitBranches = { current: string; branches: string[] };

const chip: React.CSSProperties = {
  height: 30, padding: "0 10px", borderRadius: 6,
  border: "1px solid var(--border-strong)", background: "var(--bg-surface)",
  color: "var(--fg)", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
};

export default function GitBar({ workspace, busy }: { workspace: string; busy: boolean }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [diff, setDiff] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string>("");
  const popRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    if (!workspace) { setSt(null); return; }
    invoke<GitStatus>("git_status", { dir: workspace })
      .then((s) => setSt(s))
      .catch(() => setSt(null));
  }, [workspace]);

  // Poll status while a workspace is open (cheap; CREATE_NO_WINDOW on Rust side).
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 4000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!st || !st.isRepo) return null;

  const dirty = st.files.length;
  const openPopover = () => {
    setErr("");
    setOpen((v) => !v);
    if (!open) {
      invoke<GitBranches>("git_branches", { dir: workspace }).then(setBranches).catch(() => setBranches(null));
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    setWorking(true); setErr("");
    try { await fn(); refresh(); }
    catch (e) { setErr(String((e as any) ?? e)); }
    finally { setWorking(false); }
  };

  const switchBranch = (b: string) => {
    if (!b || b === st.branch) return;
    run(() => invoke("git_checkout", { dir: workspace, branch: b, create: false }));
  };
  const createBranch = () => {
    const b = newBranch.trim();
    if (!b) return;
    run(async () => {
      await invoke("git_checkout", { dir: workspace, branch: b, create: true });
      setNewBranch("");
      const br = await invoke<GitBranches>("git_branches", { dir: workspace });
      setBranches(br);
    });
  };
  const commitAll = () => {
    const m = commitMsg.trim();
    if (!m) { setErr("Enter a commit message."); return; }
    run(async () => {
      await invoke("git_commit", { dir: workspace, message: m, all: true });
      setCommitMsg("");
    });
  };
  const viewDiff = () => {
    run(async () => {
      const d = await invoke<string>("git_diff", { dir: workspace });
      setDiff(d || "(no uncommitted changes)");
    });
  };

  return (
    <div style={{ position: "relative" }} ref={popRef}>
      <button
        onClick={openPopover}
        disabled={busy}
        title={`Branch: ${st.branch}${dirty ? ` · ${dirty} uncommitted` : " · clean"}${st.ahead ? ` · ↑${st.ahead}` : ""}${st.behind ? ` · ↓${st.behind}` : ""}`}
        style={{ ...chip, color: dirty ? "#ffd97a" : "var(--fg)", borderColor: dirty ? "#ffd97a55" : "var(--border-strong)" }}
      >
        ⎇ {st.branch || "(detached)"}{dirty ? ` · ${dirty}●` : ""}{st.ahead ? ` ↑${st.ahead}` : ""}{st.behind ? ` ↓${st.behind}` : ""}
      </button>

      {open && (
        <div style={{
          position: "absolute", top: 36, left: 0, zIndex: 50, width: 320,
          background: "var(--bg-panel)", border: "1px solid var(--border-strong)", borderRadius: 10,
          boxShadow: "0 8px 28px rgba(0,0,0,0.5)", padding: 12, display: "flex", flexDirection: "column", gap: 10,
        }}>
          {/* Branch switch */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>Branch</div>
            <select
              value={st.branch}
              onChange={(e) => switchBranch(e.target.value)}
              disabled={working}
              style={{ height: 30, borderRadius: 6, border: "1px solid var(--border-strong)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 12, padding: "0 8px" }}
            >
              {(branches?.branches ?? [st.branch]).map((b) => (<option key={b} value={b}>{b}</option>))}
            </select>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createBranch(); }}
                placeholder="new-branch-name"
                style={{ flex: 1, height: 28, borderRadius: 6, border: "1px solid var(--border-strong)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 12, padding: "0 8px" }}
              />
              <button onClick={createBranch} disabled={working || !newBranch.trim()} style={{ ...chip, height: 28 }}>+ New</button>
            </div>
          </div>

          {/* Commit */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>
              Commit {dirty ? `(${dirty} changed)` : "(nothing to commit)"}
            </div>
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="Commit message…"
              rows={2}
              style={{ resize: "vertical", minHeight: 40, borderRadius: 6, border: "1px solid var(--border-strong)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 12, padding: 8, fontFamily: "inherit" }}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={commitAll} disabled={working || !dirty} style={{ ...chip, flex: 1, justifyContent: "center", background: "var(--accent)", color: "#06080d", border: "none", opacity: dirty ? 1 : 0.5 }}>
                Commit all
              </button>
              <button onClick={viewDiff} disabled={working} style={{ ...chip }}>View diff</button>
            </div>
          </div>

          {err && <div style={{ fontSize: 11, color: "#ff8c8c", whiteSpace: "pre-wrap", maxHeight: 80, overflow: "auto" }}>{err}</div>}
        </div>
      )}

      {/* Diff modal */}
      {diff !== null && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setDiff(null); }}
          style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
        >
          <div style={{ width: "min(900px, 92vw)", height: "min(80vh, 700px)", background: "var(--bg-panel)", border: "1px solid var(--border-strong)", borderRadius: 12, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border-strong)" }}>
              <span style={{ fontWeight: 700, color: "var(--fg-strong)" }}>Uncommitted changes vs HEAD</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setDiff(null)} style={{ ...chip }}>Close</button>
            </div>
            <pre style={{ flex: 1, margin: 0, overflow: "auto", padding: 12, fontSize: 12, lineHeight: 1.45, fontFamily: "ui-monospace, Consolas, monospace", color: "var(--fg)", whiteSpace: "pre" }}>
              {diff.split("\n").map((l, i) => (
                <div key={i} style={{ color: l.startsWith("+") && !l.startsWith("+++") ? "#7ff0c5" : l.startsWith("-") && !l.startsWith("---") ? "#ff8c8c" : l.startsWith("@@") ? "#7aa2ff" : "var(--fg)" }}>{l || " "}</div>
              ))}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
