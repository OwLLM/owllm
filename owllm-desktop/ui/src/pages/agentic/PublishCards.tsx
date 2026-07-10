// PublishCards — release controls that live at the bottom of the Code page's
// left file-tree rail. Commit, Push, Merge and Publish live here so the header
// stays clean. Backed by host-side release.rs / fleet.rs commands.
import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseProjectCard, type ProjectCard } from "./cardLint";

type ReadyCheck = { id: string; label: string; ok: boolean; detail: string };
type ReleaseVisibility = "publish" | "draft" | "dry-run";
type PublishMode = "host" | "ci";

type SignCfg = {
  thumbprint: string;
  subject: string;
  tsa: string;
};

type PublishSettings = {
  visibility: ReleaseVisibility;
  mode: PublishMode;
  sign: SignCfg;
};

type WtFinalize =
  | { status: "committed"; commitSha: string; filesChanged: number; files: string[] }
  | { status: "noChanges" }
  | { status: "error"; message: string };

type WtMerge =
  | { status: "merged"; commitSha: string; filesChanged: number }
  | { status: "conflict"; files: string[] }
  | { status: "noChanges" }
  | { status: "error"; message: string };

const SETTINGS_KEY = "publishCards:settings:v1";

const defaultSettings = (): PublishSettings => ({
  visibility: "publish",
  mode: "host",
  sign: { thumbprint: "", subject: "", tsa: "http://time.certum.pl" },
});

const loadSettings = (): PublishSettings => {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<PublishSettings>;
    return {
      visibility: (parsed.visibility as ReleaseVisibility) ?? base.visibility,
      mode: (parsed.mode as PublishMode) ?? base.mode,
      sign: { ...base.sign, ...(parsed.sign ?? {}) },
    };
  } catch {
    return base;
  }
};

const saveSettings = (s: PublishSettings) => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* quota — non-fatal */ }
};

const hasLocalSettings = () => {
  try { return !!localStorage.getItem(SETTINGS_KEY); }
  catch { return false; }
};

/** Merge project-card release defaults into local settings. Card values are used only
 *  when the user has NOT saved a local override (so per-machine certs can still differ). */
function mergeCardDefaults(base: PublishSettings, card: ProjectCard | null): PublishSettings {
  if (!card?.release) return base;
  const next = { ...base };
  if (!hasLocalSettings()) {
    if (card.release.mode === "host" || card.release.mode === "ci") next.mode = card.release.mode;
    if (card.release.sign) {
      const s = card.release.sign;
      if (s.thumbprint !== undefined) next.sign = { ...next.sign, thumbprint: s.thumbprint };
      if (s.subject !== undefined) next.sign = { ...next.sign, subject: s.subject };
      if (s.tsa !== undefined) next.sign = { ...next.sign, tsa: s.tsa };
    }
  }
  return next;
}

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
  const [settings, setSettings] = useState<PublishSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const mergeTarget = "main";
  const mounted = useRef(true);

  const updateSettings = (patch: Partial<PublishSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch, sign: { ...prev.sign, ...(patch.sign ?? {}) } };
      saveSettings(next);
      return next;
    });
  };

  const refresh = useCallback(() => {
    if (!repoDir) { setReady(null); return; }
    invoke<ReadyCheck[]>("publish_readiness", {
      repoDir,
      mode: settings.mode,
      sign: (settings.sign.thumbprint.trim() || settings.sign.subject.trim()) ? settings.sign : null,
    })
      .then((r) => { if (mounted.current) setReady(r); })
      .catch(() => { if (mounted.current) setReady(null); });
  }, [repoDir, settings.mode, settings.sign]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const id = window.setInterval(refresh, 8000);
    return () => { mounted.current = false; window.clearInterval(id); };
  }, [refresh]);

  // Seed mode + signing from the committed Project Card when there is no local override.
  // This keeps the project's release rules in sync across machines and teammates.
  useEffect(() => {
    if (!repoDir || hasLocalSettings()) return;
    let live = true;
    (async () => {
      try {
        const txt = await invoke<string>("tool_read_file", { path: ".owllm/project.json", cwd: repoDir });
        const card = parseProjectCard(txt);
        if (live && card?.release) {
          setSettings(prev => mergeCardDefaults(prev, card));
        }
      } catch { /* no card or malformed — keep defaults */ }
    })();
    return () => { live = false; };
  }, [repoDir]);

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

  const signPayload = settings.sign.thumbprint.trim() || settings.sign.subject.trim()
    ? {
        thumbprint: settings.sign.thumbprint.trim() || null,
        subject: settings.sign.subject.trim() || null,
        tsa: settings.sign.tsa.trim() || null,
      }
    : null;

  const doPublish = () => run(async () => {
    const visibility = settings.visibility;
    if (visibility === "publish") {
      const signed = !!(settings.sign.thumbprint.trim() || settings.sign.subject.trim());
      const modeLabel = settings.mode === "host" ? "HOST mode" : "CI mode";
      if (!window.confirm(
        `Publish a new release? (${modeLabel})\n\n` +
        (settings.mode === "host"
          ? `This bumps the version, commits, tags, pushes, and runs the host build → ${signed ? "code-signs" : "does NOT code-sign"} → publishes a public release to GitHub.`
          : `This bumps the version, commits, tags, and pushes. The repository's GitHub Actions workflow will build and publish a public release.`) +
        (settings.mode === "host" && !signed ? "\n\nNo signing certificate is configured, so this build will be UNSIGNED." : "")
      )) return "Cancelled.";
      return invoke("finish_and_publish", {
        repoDir,
        notes: pubNotes,
        mode: settings.mode,
        sign: signPayload,
      });
    }
    return invoke("publish_release", {
      repoDir,
      notes: pubNotes,
      dryRun: visibility === "dry-run",
      draft: visibility === "draft",
      sign: signPayload,
    });
  });

  const isRepo = ready?.find((c) => c.id === "repo")?.ok ?? false;
  const hasRemote = ready?.find((c) => c.id === "remote")?.ok ?? false;
  const hasPublishScript = ready?.find((c) => c.id === "script")?.ok ?? false;

  const showCommit = isRepo;
  const showPush = isRepo && hasRemote;
  const showMerge = isRepo && hasRemote;
  const showPublish = isRepo && hasPublishScript;
  const canPublish = ready?.every((c) => c.ok) ?? false;
  const publishFailReason = ready?.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join("\n");
  if (!showCommit && !showPush && !showMerge && !showPublish) return null;

  const modeLabel = settings.visibility === "dry-run" ? "Dry run" : settings.visibility === "draft" ? "Draft" : "Publish";
  const modeColor = settings.visibility === "publish" ? "#7ff0c5" : settings.visibility === "draft" ? "#7aa2ff" : "#ffd97a";
  const signed = !!(settings.sign.thumbprint.trim() || settings.sign.subject.trim());

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
                onClick={() => { setCommitMsg(commitMsg.trim() || "Checkpoint from Publisher card"); setCommitOpen(true); }}
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
                disabled={disabled || loading || !canPublish}
                title={canPublish
                  ? `${modeLabel} release (${settings.mode})${signed ? "" : ", unsigned"}`
                  : (publishFailReason || "Readiness check running…")}
                style={{ ...chipBtn, flex: 1, background: modeColor, color: "#06080d", border: "none", opacity: canPublish ? 1 : 0.5 }}
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
          {showPublish && (
            <div style={{ display: "flex", gap: 6, fontSize: 10, color: "var(--fg-muted)", justifyContent: "space-between" }}>
              <span>{settings.mode === "host" ? "Host build" : "CI / GitHub Actions"}</span>
              <span>{signed ? "Signed" : "Unsigned"}</span>
            </div>
          )}
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
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)" }}>Release visibility</label>
              <select
                value={settings.visibility}
                onChange={(e) => updateSettings({ visibility: e.target.value as ReleaseVisibility })}
                disabled={disabled || loading}
                style={{ ...inputBase, height: 28 }}
              >
                <option value="dry-run">Dry run</option>
                <option value="draft">Draft release</option>
                <option value="publish">Publish public release</option>
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)" }}>Publish mode</label>
              <select
                value={settings.mode}
                onChange={(e) => updateSettings({ mode: e.target.value as PublishMode })}
                disabled={disabled || loading}
                style={{ ...inputBase, height: 28 }}
              >
                <option value="host">Host — build + sign + publish on this machine</option>
                <option value="ci">CI / GitHub Actions — push tag, let workflow build</option>
              </select>
              <div style={{ fontSize: 10, color: "var(--fg-subtle)", lineHeight: 1.4 }}>
                Host mode publishes immediately from this machine. CI mode relies on GitHub Actions runners, which are currently unavailable due to billing limits.
              </div>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-strong)" }}>Code signing (Windows)</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)" }}>Cert thumbprint (SHA-1)</label>
              <input
                value={settings.sign.thumbprint}
                onChange={(e) => updateSettings({ sign: { ...settings.sign, thumbprint: e.target.value } })}
                placeholder="empty = unsigned"
                disabled={disabled || loading}
                style={{ ...inputBase, height: 28 }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)" }}>…or cert subject (CN)</label>
              <input
                value={settings.sign.subject}
                onChange={(e) => updateSettings({ sign: { ...settings.sign, subject: e.target.value } })}
                placeholder="e.g. Your Company Ltd"
                disabled={disabled || loading}
                style={{ ...inputBase, height: 28 }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-muted)" }}>Timestamp URL (RFC3161)</label>
              <input
                value={settings.sign.tsa}
                onChange={(e) => updateSettings({ sign: { ...settings.sign, tsa: e.target.value } })}
                placeholder="http://time.certum.pl"
                disabled={disabled || loading}
                style={{ ...inputBase, height: 28 }}
              />
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
