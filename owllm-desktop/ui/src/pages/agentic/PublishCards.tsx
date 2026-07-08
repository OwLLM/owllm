// PublishCards — rule-based commit / merge / push / publish controls that live
// in the Code page's left file-tree rail. Each card appears only when its rule
// is satisfied (git repo, non-main branch, remote configured, publish script
// present, …). Backed by the host-side release.rs commands so the actions run
// with the host's git credentials and signing cert, not inside a sandbox.
import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

type ReadyCheck = { id: string; label: string; ok: boolean; detail: string };
type PublishMode = "publish" | "draft" | "dry-run";

const btnBase: React.CSSProperties = {
  height: 26, padding: "0 10px", borderRadius: 6,
  border: "1px solid var(--border-strong)", background: "var(--bg-surface)",
  color: "var(--fg)", fontSize: 12, fontWeight: 600, cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: "var(--fg-muted)",
  textTransform: "uppercase", letterSpacing: 0.5,
};

export default function PublishCards({
  repoDir,
  branch,
  disabled,
  onStatus,
}: {
  repoDir: string;
  branch?: string;
  disabled?: boolean;
  onStatus?: (msg: string) => void;
}) {
  const [ready, setReady] = useState<ReadyCheck[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [mergeTarget, setMergeTarget] = useState("main");
  const [pubNotes, setPubNotes] = useState("");
  const [pubMode, setPubMode] = useState<PublishMode>("dry-run");
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

  const doCommit = () => run(() => invoke("repo_commit", { repoDir, message: commitMsg, scope: "" }));
  const doMerge = () => run(() => invoke("repo_merge", { repoDir, target: mergeTarget }));
  const doPush = () => run(() => invoke("repo_push", { repoDir }));
  const doPublish = () => run(() => {
    if (pubMode === "publish") {
      return invoke("finish_and_publish", { repoDir, notes: pubNotes });
    }
    return invoke("publish_release", { repoDir, notes: pubNotes, dryRun: pubMode === "dry-run", draft: pubMode === "draft" });
  });

  const isRepo = ready?.find((c) => c.id === "repo")?.ok ?? false;
  const hasRemote = ready?.find((c) => c.id === "remote")?.ok ?? false;
  const hasPublishScript = ready?.find((c) => c.id === "script")?.ok ?? false;
  const onMain = branch === "main" || branch === "master";

  if (!isRepo) return null;

  const card: React.CSSProperties = {
    background: "var(--bg-surface)", border: "1px solid var(--border-strong)",
    borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 6,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
      {/* COMMIT — any git repo */}
      <div style={card}>
        <div style={sectionLabel}>Commit</div>
        <input
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && commitMsg.trim()) doCommit(); }}
          placeholder="message…"
          disabled={disabled || loading}
          style={{ height: 28, padding: "0 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 12 }}
        />
        <button
          onClick={doCommit}
          disabled={disabled || loading || !commitMsg.trim()}
          style={{ ...btnBase, background: "var(--accent)", color: "#06080d", border: "none", opacity: commitMsg.trim() ? 1 : 0.5 }}
        >
          {loading ? "⏳" : "➥"} Commit all
        </button>
      </div>

      {/* MERGE — only when not on main (FF push to target) */}
      {!onMain && hasRemote && (
        <div style={card}>
          <div style={sectionLabel}>Merge to target</div>
          <input
            value={mergeTarget}
            onChange={(e) => setMergeTarget(e.target.value)}
            placeholder="main"
            disabled={disabled || loading}
            style={{ height: 28, padding: "0 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 12 }}
          />
          <button
            onClick={doMerge}
            disabled={disabled || loading}
            style={{ ...btnBase, color: "#7ff0c5", borderColor: "#7ff0c555" }}
          >
            {loading ? "⏳" : "⤴"} Merge → {mergeTarget || "main"}
          </button>
        </div>
      )}

      {/* PUSH — any repo with a remote */}
      {hasRemote && (
        <div style={card}>
          <div style={sectionLabel}>Push</div>
          <button
            onClick={doPush}
            disabled={disabled || loading}
            style={{ ...btnBase }}
          >
            {loading ? "⏳" : "↑"} Push {branch || "current"}
          </button>
        </div>
      )}

      {/* PUBLISH — only when the OwLLM publish script is present */}
      {hasPublishScript && (
        <div style={card}>
          <div style={sectionLabel}>Publish</div>
          <textarea
            value={pubNotes}
            onChange={(e) => setPubNotes(e.target.value)}
            placeholder="Release notes (optional)…"
            rows={2}
            disabled={disabled || loading}
            style={{ resize: "vertical", minHeight: 40, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 12, padding: 6, fontFamily: "inherit" }}
          />
          <select
            value={pubMode}
            onChange={(e) => setPubMode(e.target.value as PublishMode)}
            disabled={disabled || loading}
            style={{ height: 26, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--fg)", fontSize: 12 }}
          >
            <option value="dry-run">Dry run</option>
            <option value="draft">Draft release</option>
            <option value="publish">Publish release</option>
          </select>
          <button
            onClick={doPublish}
            disabled={disabled || loading}
            style={{ ...btnBase, background: pubMode === "publish" ? "#7ff0c5" : pubMode === "draft" ? "#7aa2ff" : "#ffd97a", color: "#06080d", border: "none" }}
          >
            {loading ? "⏳" : "🚀"} {pubMode === "dry-run" ? "Dry run" : pubMode === "draft" ? "Draft" : "Publish"}
          </button>
        </div>
      )}
    </div>
  );
}
