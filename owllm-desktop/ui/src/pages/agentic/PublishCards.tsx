// PublishCards — release controls that live at the bottom of the Code page's
// left file-tree rail. Commit, Push, Merge and Publish live here so the header
// stays clean. Backed by host-side release.rs / fleet.rs commands.
import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

type ReadyCheck = { id: string; label: string; ok: boolean; detail: string };
type PublishMode = "publish" | "draft" | "dry-run";

type WtFinalize =
  | { status: "committed"; commitSha: string; filesChanged: number; files: string[] }
  | { status: "noChanges" }
  | { status: "error"; message: string };

type WtMerge =
  | { status: "merged"; commitSha: string; filesChanged: number }
  | { status: "conflict"; files: string[] }
  | { status: "noChanges" }
  | { status: "error"; message: string };

const chipBtn: React.CSSProperties = {
  height: 26,
  padding: "0 9px",
  borderRadius: 6,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-surface)",
  color: "var(--fg)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  whiteSpace: "nowrap",
};

const inputBase: React.CSSProperties = {
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-input)",
  color: "var(--fg)",
  fontSize: 12,
  padding: "0 8px",
  fontFamily: "inherit",
};

export default function PublishCards({
  repoDir,
  gitDir,
  branch,
  projectRoot,
  isolated,
  disabled,
  onStatus,
}: {
  repoDir: string;
  gitDir: string;
  branch?: string;
  projectRoot?: string;
  isolated?: boolean;
  disabled?: boolean;
  onStatus?: (msg: string) => void;
}) {
  const [ready, setReady] = useState<ReadyCheck[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [pubNotes, setPubNotes] = useState("");
  const [pubMode, setPubMode] = useState<PublishMode>("publish");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const mergeTarget = "main";
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    if (!repoDir) { setReady(null); return; }
    invoke<ReadyCheck[]>("publish_readiness", { repoDir })
      .then((r) => { if (mounted.current) setReady(r); })
      .catch(() => { if (mounted.current) setReady(null); });
  }, [repoDir]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const id = window.setInterval(refresh, 8000);
    return () => { mounted.current = false; window.clearInterval(id); };
  }, [refresh]);

  const status = (msg: string) => { if (onStatus) onStatus(msg); };

  const run = async (fn: () => Promise<unknown>) => {
    setLoading(true);
    try {
      const out = await fn();
      status(String(out ?? "Done."));
      refresh();
    } catch (e) {
      status(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const doCommit = () => run(async () => {
    const out = await invoke<string>("repo_commit", { repoDir: gitDir, message: commitMsg });
    setCommitMsg("");
    setCommitOpen(false);
    return out;
  });

  const doPush = () => run(() => invoke("repo_push", { repoDir: gitDir }));

  const doMerge = () => run(async () => {
    if (isolated && projectRoot && branch && gitDir) {
      const fin = await invoke<WtFinalize>("fleet_worktree_finalize", {
        worktreePath: gitDir, agentName: "code", summary: "Code page session",
      });
      if (fin.status === "error") throw new Error(`commit failed: ${fin.message}`);
      const mg = await invoke<WtMerge>("fleet_worktree_merge", {
        projectCwd: projectRoot, agentName: "code", branch,
      });
      if (mg.status === "merged") return `Merged ${mg.filesChanged} file(s) into ${projectRoot.replace(/^.*[\\/]/, "")}`;
      if (mg.status === "noChanges") return "Nothing new to merge — already up to date.";
      if (mg.status === "conflict") throw new Error(`conflict in: ${mg.files.join(", ")}`);
      throw new Error(mg.message);
    }
    return invoke<string>("repo_merge", { repoDir: gitDir, target: mergeTarget });
  });

  const doPublish = () => run(() => {
    if (pubMode === "publish") {
      return invoke("finish_and_publish", { repoDir, notes: pubNotes });
    }
    return invoke("publish_release", { repoDir, notes: pubNotes, dryRun: pubMode === "dry-run", draft: pubMode === "draft" });
  });

  const isRepo = ready?.find((c) => c.id === "repo")?.ok ?? false;
  const hasRemote = ready?.find((c) => c.id === "remote")?.ok ?? false;
  const hasPublishScript = ready?.find((c) => c.id === "script")?.ok ?? false;

  const showCommit = isRepo;
  const showPush = isRepo && hasRemote;
  const showMerge = isRepo && hasRemote;
  const showPublish = isRepo && hasPublishScript;
  if (!showCommit && !showPush && !showMerge && !showPublish) return null;

  const modeLabel = pubMode === "dry-run" ? "Dry run" : pubMode === "draft" ? "Draft" : "Publish";
  const modeColor = pubMode === "publish" ? "#7ff0c5" : pubMode === "draft" ? "#7aa2ff" : "#ffd97a";

  return (
    <>
      <div style={{ marginTop: "auto", padding: 6 }}>
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div style={{ display: "flex", gap: 6, width: "100%" }}>
            {showCommit && (
              <button
                onClick={() => setCommitOpen(true)}
                disabled={disabled || loading}
                title="Commit all changes in this workspace"
                style={{ ...chipBtn, flex: 1 }}
              >
                {loading ? "⏳" : "●"} Commit
              </button>
            )}
            {showMerge && (
              <button
                onClick={doMerge}
                disabled={disabled || loading}
                title={isolated
                  ? `Merge this page's worktree back into ${projectRoot ? projectRoot.replace(/^.*[\\/]/, "") : "main"}`
                  : `Fast-forward ${mergeTarget} to HEAD on origin`}
                style={{ ...chipBtn, flex: 1, color: "#7ff0c5" }}
              >
                {loading ? "⏳" : "⤴"} Merge
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, width: "100%" }}>
            {showPush && (
              <button
                onClick={doPush}
                disabled={disabled || loading}
                title={`Push ${branch || "current"} to origin`}
                style={{ ...chipBtn, flex: 1 }}
              >
                {loading ? "⏳" : "↑"} Push
              </button>
            )}
            {showPublish && (
              <button
                onClick={doPublish}
                disabled={disabled || loading}
                title={`${modeLabel} release (${pubMode})`}
                style={{ ...chipBtn, flex: 1, background: modeColor, color: "#06080d", border: "none" }}
              >
                {loading ? "⏳" : "🚀"} {modeLabel}
              </button>
            )}
            {showPublish && (
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                title="Publish settings"
                disabled={disabled || loading}
                style={{ ...chipBtn, width: 26, padding: 0, color: "var(--fg-muted)" }}
              >
                ⚙
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Commit popup */}
      {commitOpen && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setCommitOpen(false); }}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(0,0,0,0.45)", display: "flex",
            alignItems: "center", justifyContent: "center", padding: 24,
          }}
        >
          <div
            style={{
              width: "min(360px, 92vw)", background: "var(--bg-panel)",
              border: "1px solid var(--border-strong)", borderRadius: 10,
              padding: 12, display: "flex", flexDirection: "column", gap: 10,
              boxShadow: "0 10px 32px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700, color: "var(--fg-strong)", fontSize: 13 }}>Commit</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setCommitOpen(false)} style={{ ...chipBtn, width: 24, padding: 0 }}>✕</button>
            </div>
            <textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="Commit message…"
              rows={3}
              disabled={disabled || loading}
              style={{ ...inputBase, resize: "vertical", minHeight: 56, padding: 6 }}
            />
            <button
              onClick={doCommit}
              disabled={disabled || loading || !commitMsg.trim()}
              style={{ ...chipBtn, justifyContent: "center", background: "var(--accent)", color: "#06080d", border: "none", opacity: commitMsg.trim() ? 1 : 0.5 }}
            >
              Commit all
            </button>
          </div>
        </div>
      )}

      {/* Publish settings popup */}
      {settingsOpen && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(0,0,0,0.45)", display: "flex",
            alignItems: "center", justifyContent: "center", padding: 24,
          }}
        >
          <div
            style={{
              width: "min(360px, 92vw)", background: "var(--bg-panel)",
              border: "1px solid var(--border-strong)", borderRadius: 10,
              padding: 12, display: "flex", flexDirection: "column", gap: 10,
              boxShadow: "0 10px 32px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 700, color: "var(--fg-strong)", fontSize: 13 }}>Publish settings</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setSettingsOpen(false)} style={{ ...chipBtn, width: 24, padding: 0 }}>✕</button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)" }}>Mode</label>
              <select
                value={pubMode}
                onChange={(e) => setPubMode(e.target.value as PublishMode)}
                disabled={disabled || loading}
                style={{ ...inputBase, height: 28 }}
              >
                <option value="dry-run">Dry run</option>
                <option value="draft">Draft release</option>
                <option value="publish">Publish release</option>
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)" }}>Release notes</label>
              <textarea
                value={pubNotes}
                onChange={(e) => setPubNotes(e.target.value)}
                placeholder="Optional notes…"
                rows={3}
                disabled={disabled || loading}
                style={{ ...inputBase, resize: "vertical", minHeight: 56, padding: 6 }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
