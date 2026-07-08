// PublishCards — compact release controls that live at the bottom of the
// Code page's left file-tree rail. Only Push and Publish remain here;
// Commit/Merge already live in the top header (GitBar and Merge to main).
// Backed by the host-side release.rs commands so actions run with the host's
// git credentials and signing cert.
import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

type ReadyCheck = { id: string; label: string; ok: boolean; detail: string };
type PublishMode = "publish" | "draft" | "dry-run";

const chipBtn: React.CSSProperties = {
  height: 24,
  padding: "0 8px",
  borderRadius: 6,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-surface)",
  color: "var(--fg)",
  fontSize: 11,
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
  const [pubNotes, setPubNotes] = useState("");
  const [pubMode, setPubMode] = useState<PublishMode>("dry-run");
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const showPush = isRepo && hasRemote;
  const showPublish = isRepo && hasPublishScript;
  if (!showPush && !showPublish) return null;

  const modeLabel = pubMode === "dry-run" ? "Dry run" : pubMode === "draft" ? "Draft" : "Publish";
  const modeColor = pubMode === "publish" ? "#7ff0c5" : pubMode === "draft" ? "#7aa2ff" : "#ffd97a";

  return (
    <>
      <div style={{ marginTop: "auto", padding: "4px" }}>
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            padding: 5,
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          {showPush && (
            <button
              onClick={doPush}
              disabled={disabled || loading}
              title={`Push ${branch || "current"} to origin`}
              style={{ ...chipBtn }}
            >
              {loading ? "⏳" : "↑"} Push
            </button>
          )}
          {showPublish && (
            <button
              onClick={doPublish}
              disabled={disabled || loading}
              title={`${modeLabel} release (${pubMode})`}
              style={{ ...chipBtn, background: modeColor, color: "#06080d", border: "none" }}
            >
              {loading ? "⏳" : "🚀"} {modeLabel}
            </button>
          )}
          {showPublish && (
            <button
              onClick={() => setSettingsOpen((v) => !v)}
              title="Publish settings"
              disabled={disabled || loading}
              style={{ ...chipBtn, width: 24, padding: 0, color: "var(--fg-muted)", marginLeft: "auto" }}
            >
              ⚙
            </button>
          )}
        </div>
      </div>

      {settingsOpen && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            style={{
              width: "min(360px, 92vw)",
              background: "var(--bg-panel)",
              border: "1px solid var(--border-strong)",
              borderRadius: 10,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
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
