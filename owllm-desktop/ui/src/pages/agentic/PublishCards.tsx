// PublishCards — release controls that live at the bottom of the Code page's
// left file-tree rail. Commit, Push, Merge and Publish live here so the header
// stays clean. Backed by host-side release.rs / fleet.rs commands.
import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseProjectCard, type ProjectCard } from "./cardLint";

type ReadyCheck = { id: string; label: string; ok: boolean; detail: string };
// Compact `git status --porcelain -b` summary from git.rs — cheap and local,
// unlike publish_readiness which probes the network (ls-remote / gh).
type GitStatusInfo = {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  total: number;
  nuisanceFiles: string[];
};
type ReleaseVisibility = "publish" | "draft" | "dry-run";
type PublishMode = "host" | "ci";

const HOST_IS_WINDOWS = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

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

type WtSync =
  | { status: "synced"; pageSha: string; projectSha: string; remote: boolean; detail: string }
  | { status: "noChanges"; projectSha: string; remote: boolean; detail: string }
  | { status: "conflict"; files: string[] }
  | { status: "error"; message: string };

// v1 was ONE GLOBAL blob — editing publish settings on any project silently
// applied them to every project AND permanently stopped the committed Project
// Card from seeding this surface anywhere. v2 keys by project so settings can't
// bleed across projects; the old global blob seeds a project once (migration).
const LEGACY_SETTINGS_KEY = "publishCards:settings:v1";
const settingsKey = (repoDir: string) => `publishCards:settings:v2:${repoDir}`;

const defaultSettings = (): PublishSettings => ({
  visibility: "publish",
  mode: "host",
  sign: { thumbprint: "", subject: "", tsa: "http://time.certum.pl" },
});

const loadSettings = (repoDir: string): PublishSettings => {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(settingsKey(repoDir)) ?? localStorage.getItem(LEGACY_SETTINGS_KEY);
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

const saveSettings = (repoDir: string, s: PublishSettings) => {
  try { localStorage.setItem(settingsKey(repoDir), JSON.stringify(s)); } catch { /* quota — non-fatal */ }
};

const hasLocalSettings = (repoDir: string) => {
  try { return !!localStorage.getItem(settingsKey(repoDir)); }
  catch { return false; }
};

// The shared status line below the chatbox is a single ambient line — send it a
// one-line summary; the full multi-line output lives in the output modal.
const firstLine = (s: string) => { const i = s.indexOf("\n"); return i === -1 ? s : s.slice(0, i); };
// Backend release errors open with a CONSTANT header ("finish_and_publish did
// not complete:") and carry the real cause on the lines below it. Summarising
// those with firstLine() made every failed release render the same reasonless
// line — and Publish deliberately does not auto-open the output modal, so the
// cause was invisible unless the user went looking for it. Prefer the script's
// own PUBLISH_FAILED line, else the first line that actually says something.
const errorSummary = (s: string) => {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.includes("PUBLISH_FAILED:"))
    ?? lines.find((l) => !/did not complete:?$/.test(l))
    ?? firstLine(s);
};
const elapsedClock = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Merge project-card release defaults into local settings. Card values are used only
 *  when the user has NOT saved a local override (so per-machine certs can still differ). */
function mergeCardDefaults(base: PublishSettings, card: ProjectCard | null, repoDir: string): PublishSettings {
  if (!card?.release) return base;
  const next = { ...base };
  if (!hasLocalSettings(repoDir)) {
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
  onFixIssues,
}: {
  repoDir: string;
  gitDir: string;
  branch?: string;
  projectRoot?: string;
  isolated?: boolean;
  disabled?: boolean;
  /** Hands a ready-made "diagnose and fix this" task to the page's coder agent
   *  (queued as a steer if a run is in flight). Renders the Fix-with-agent
   *  button only when provided AND there is a failure to act on. Returns what
   *  actually happened so the card can tell the truth — send() has guards
   *  (no model picked, no workspace) that otherwise drop the task silently
   *  while the card claims the agent is on it. */
  onFixIssues?: (task: string) => "sent" | "queued" | "no-model" | "no-workspace" | void;
}) {
  const [ready, setReady] = useState<ReadyCheck[] | null>(null);
  const [git, setGit] = useState<GitStatusInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Inline, right-by-the-buttons progress. The shared `status` line lives in the
  // center column, far from this left-rail card, so an action there felt dead:
  // no acknowledgement on click, only a result at the very end. This shows
  // ⏳ running / ✓ done / ✗ error in place.
  const [activity, setActivity] = useState<{ kind: "run" | "ok" | "err"; msg: string } | null>(null);
  // Full command output (Commit/Push/Merge/Publish) — the possibly multi-line
  // result or error. It used to expand the shared status line below the chatbox
  // into a tall, undismissable block; now it lives in a closable modal so long
  // build/publish logs and errors can be read then dismissed. `outputOpen`
  // controls visibility so a dismissed log can be reopened from the rail chip.
  const [output, setOutput] = useState<{ kind: "run" | "ok" | "err"; title: string; body: string } | null>(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const [pubNotes, setPubNotes] = useState("");
  const [settings, setSettings] = useState<PublishSettings>(() => loadSettings(repoDir));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const mergeTarget = "main";
  const mounted = useRef(true);
  // State disables the button on the next render. This synchronous latch
  // closes the double-click window before that render happens.
  const runningRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The Code page stays mounted (keep-alive, hidden via display:none) — skip
  // polling while it isn't visible so background pages don't probe forever.
  const pageHidden = () => !!rootRef.current && rootRef.current.offsetParent === null;

  // Settings are per-project — swap them when the project does.
  useEffect(() => { setSettings(loadSettings(repoDir)); }, [repoDir]);

  const updateSettings = (patch: Partial<PublishSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch, sign: { ...prev.sign, ...(patch.sign ?? {}) } };
      saveSettings(repoDir, next);
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
      // Transient IPC/probe failure: keep the last known checks. Nulling here
      // used to make the WHOLE container vanish from the rail (all buttons are
      // gated on `ready`) every time one probe hiccuped or the net dropped.
      .catch(() => {});
  }, [repoDir, settings.mode, settings.sign]);

  // Local repo facts (branch / ahead / behind / dirty count) — pure-local git,
  // fast and offline-safe. This is what decides whether the container shows at
  // all, so Commit/Merge don't wait on (or die with) the network probes.
  const fetchGit = useCallback(() => {
    if (!gitDir) { setGit(null); return; }
    invoke<GitStatusInfo>("git_status", { dir: gitDir })
      .then((g) => { if (mounted.current) setGit(g); })
      .catch(() => { /* keep last known */ });
  }, [gitDir]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    // Readiness re-probes hit the network (ls-remote, gh) — 30s is plenty; it
    // also re-runs after every action and whenever the settings change.
    const id = window.setInterval(() => { if (!pageHidden()) refresh(); }, 30000);
    return () => { mounted.current = false; window.clearInterval(id); };
  }, [refresh]);

  useEffect(() => {
    fetchGit();
    const id = window.setInterval(() => { if (!pageHidden()) fetchGit(); }, 5000);
    return () => window.clearInterval(id);
  }, [fetchGit]);

  // A host Rust build can legitimately take several minutes. Keep a cheap
  // elapsed clock moving in the card so "working" cannot look like "frozen".
  useEffect(() => {
    if (!loading) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const id = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [loading]);

  // Seed mode + signing from the committed Project Card when there is no local override.
  // This keeps the project's release rules in sync across machines and teammates.
  useEffect(() => {
    if (!repoDir || hasLocalSettings(repoDir)) return;
    let live = true;
    (async () => {
      try {
        const txt = await invoke<string>("tool_read_file", { path: ".owllm/project.json", cwd: repoDir });
        const card = parseProjectCard(txt);
        if (live && card?.release) {
          setSettings(prev => mergeCardDefaults(prev, card, repoDir));
        }
      } catch { /* no card or malformed — keep defaults */ }
    })();
    return () => { live = false; };
  }, [repoDir]);

  const run = async (
    label: string,
    fn: () => Promise<unknown>,
    { openOutput = true }: { openOutput?: boolean } = {},
  ) => {
    if (runningRef.current) {
      setActivity({ kind: "err", msg: "An action is already running for this project." });
      return;
    }
    runningRef.current = true;
    setLoading(true);
    // The Publisher card owns its progress/result. Do not copy Git status into
    // the composer toolbar: that cross-column coupling is what kept moving
    // "Up to date" beside unrelated chat controls.
    setActivity({ kind: "run", msg: `${label}…` });
    setOutput({ kind: "run", title: label, body: `${label}…` });
    // Host publishing takes minutes. Do not place a full-screen modal over the
    // app for that whole period; its output remains available from the rail.
    setOutputOpen(openOutput);
    try {
      const out = await fn();
      const msg = String(out ?? "Done.");
      setActivity({ kind: "ok", msg: firstLine(msg) });
      setOutput({ kind: "ok", title: label, body: msg });
      refresh();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setActivity({ kind: "err", msg: errorSummary(msg) });
      setOutput({ kind: "err", title: label, body: msg });
      // A FAILED action has nothing left to run, so the reason why we keep the
      // modal closed during a release (minutes of build behind a full-screen
      // overlay) no longer applies. Show the full output instead of leaving the
      // user with a one-line card and no way to know what broke.
      setOutputOpen(true);
    } finally {
      runningRef.current = false;
      setLoading(false);
      fetchGit();
    }
  };

  const doCommit = () => run("Committing changes", async () => {
    const out = await invoke<string>("repo_commit", { repoDir: gitDir, message: commitMsg });
    setCommitMsg("");
    setCommitOpen(false);
    return out;
  });

  // Merge writes an isolated page's squash commit into the real project
  // checkout. Push that checkout, not the page branch again. The old routing
  // let Commit + Merge + Push all report success while origin/main never moved.
  const pushDir = isolated && projectRoot ? projectRoot : gitDir;
  // repo_push and repo_sync both run the cross-PC sync transaction in the
  // backend: diverged histories (↑N ↓M) integrate on a temporary worktree via a
  // plain three-way merge instead of dead-ending on "not a fast-forward".
  const doPush = () => run("Syncing with origin", () => invoke("repo_push", { repoDir: pushDir }));

  const doMerge = () => run(isolated ? "Syncing page" : `Syncing with ${mergeTarget}`, async () => {
    if (isolated && projectRoot && branch && gitDir) {
      const sync = await invoke<WtSync>("fleet_worktree_sync", {
        worktreePath: gitDir, projectCwd: projectRoot, agentName: "code", branch,
      });
      if (sync.status === "synced") return `Synced page and project at ${sync.projectSha.slice(0, 8)}. ${sync.detail}`;
      if (sync.status === "noChanges") return `Already synchronized at ${sync.projectSha.slice(0, 8)}. ${sync.detail}`;
      if (sync.status === "conflict") throw new Error(
        `Real overlapping edits — nothing was auto-dropped. Both sides are preserved ` +
        `(the page branch keeps its commits). Resolve these files, then Sync again:\n` +
        sync.files.map((f) => `  - ${f}`).join("\n"));
      throw new Error(sync.message);
    }
    return invoke<string>("repo_sync", { repoDir: gitDir, target: mergeTarget });
  });

  const signPayload = HOST_IS_WINDOWS && (settings.sign.thumbprint.trim() || settings.sign.subject.trim())
    ? {
        thumbprint: settings.sign.thumbprint.trim() || null,
        subject: settings.sign.subject.trim() || null,
        tsa: settings.sign.tsa.trim() || null,
      }
    : null;

  const doPublish = () => run(`${modeLabel} release`, async () => {
    const visibility = settings.visibility;
    if (visibility === "publish") {
      const signed = HOST_IS_WINDOWS && !!(settings.sign.thumbprint.trim() || settings.sign.subject.trim());
      const modeLabel = settings.mode === "host" ? "HOST mode" : "CI mode";
      if (!window.confirm(
        `Publish a new release? (${modeLabel})\n\n` +
        (settings.mode === "host"
          ? HOST_IS_WINDOWS
            ? `This bumps the version, commits, tags, pushes, and runs the host build → ${signed ? "code-signs" : "does NOT code-sign"} → publishes a public release to GitHub.`
            : "This bumps the version, commits, tags, pushes, builds this platform's packages, and publishes a public release to GitHub."
          : `This bumps the version, commits, tags, and pushes. The repository's GitHub Actions workflow will build and publish a public release.`) +
        (HOST_IS_WINDOWS && settings.mode === "host" && !signed ? "\n\nNo signing certificate is configured, so this build will be UNSIGNED." : "")
      )) return "Cancelled.";
      // Publish rides on the same sync transaction first: a diverged origin
      // integrates (or stops on a real conflict) BEFORE the long build, instead
      // of failing mid-release or building a stale checkout.
      if (hasRemote) {
        await invoke("repo_sync", { repoDir, target: "main" });
      }
      return invoke("finish_and_publish", {
        repoDir,
        notes: pubNotes,
        // Explicit mode only when this machine saved an override; null lets
        // the script resolve the committed card (arg > card > host default).
        mode: hasLocalSettings(repoDir) ? settings.mode : null,
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
  }, { openOutput: false });

  // The local git_status answers "is this a repo" instantly and offline; the
  // readiness probe (network) only gates the remote-dependent buttons.
  const isRepo = git ? git.isRepo : (ready?.find((c) => c.id === "repo")?.ok ?? false);
  const hasRemote = ready?.find((c) => c.id === "remote")?.ok ?? false;
  const hasPublishScript = ready?.find((c) => c.id === "script")?.ok ?? false;

  const showCommit = isRepo;
  const showPush = isRepo && !isolated && hasRemote;
  // Isolated pages use one backend-owned Sync transaction that integrates the
  // worktree and reconciles origin while the canonical lock is held.
  const showMerge = isRepo && ((isolated && !!projectRoot && !!branch) || hasRemote);
  const showPublish = isRepo && hasPublishScript;
  // Dirtiness is NOT a hard block here — the authoritative check lives in the
  // publish script (it fails fast, BEFORE any build, if real work under the
  // stage path is uncommitted, and it ignores generated churn like Cargo.lock).
  // Gating the button on the whole-repo dirty count (untracked files, lockfile
  // version churn, changes outside the stage path) made Publish look dead even
  // when the release could proceed. Keep it clickable; the "● N" pending badge
  // above already signals uncommitted work, and clicking surfaces the script's
  // precise "commit these first" message instead of a silent grey button.
  const canPublish = ready?.every((c) => c.ok) ?? false;
  const readyFails = ready?.filter((c) => !c.ok) ?? [];
  const publishFailReason = readyFails.map((c) => `${c.label}: ${c.detail}`).join("\n");
  if (!showCommit && !showPush && !showMerge && !showPublish) return null;

  const modeLabel = settings.visibility === "dry-run" ? "Dry run" : settings.visibility === "draft" ? "Draft" : "Publish";
  const modeColor = settings.visibility === "publish" ? "#7ff0c5" : settings.visibility === "draft" ? "#7aa2ff" : "#ffd97a";
  const signed = HOST_IS_WINDOWS && !!(settings.sign.thumbprint.trim() || settings.sign.subject.trim());

  // One click hands the failure to the coder agent instead of making the user
  // copy-paste PUBLISH_FAILED output into the chat. Carries BOTH the last
  // failed action's full output and any unmet readiness checks.
  const nuisanceFiles = git?.nuisanceFiles ?? [];
  const hasFixableIssue = activity?.kind === "err" || readyFails.length > 0 || nuisanceFiles.length > 0;
  const fixWithAgent = () => {
    if (!onFixIssues) return;
    const parts: string[] = [];
    if (activity?.kind === "err") {
      const failedOutput = output?.kind === "err" ? output.body : activity.msg;
      parts.push(`The last release action failed with this output:\n\n${failedOutput}`);
    }
    if (readyFails.length > 0) {
      parts.push(`Publish readiness checks currently failing:\n${readyFails.map((c) => `- ${c.label}: ${c.detail}`).join("\n")}`);
    }
    if (nuisanceFiles.length > 0) {
      parts.push(
        "OWLLM detected app-generated runtime files that are still tracked by Git and can repeatedly dirty or block Commit / Merge / Push:\n" +
        nuisanceFiles.map((path) => `- ${path}`).join("\n") +
        "\n\nClean them safely: add precise ignore rules and remove only these runtime paths from Git tracking while preserving their working-tree copies. " +
        "Do not delete or ignore durable project data such as .owllm/project.json, .owllm/verify.json, .owllm/skills/, .owllm/assets/, or user source files. " +
        "Verify the resulting Git status and the rule-based release workflow.",
      );
    }
    const outcome = onFixIssues(
      "The rule-based release buttons (Commit / Merge / Push / Publish) hit a problem in this repository. " +
      "Diagnose the root cause, fix it, and verify the fix — do not just describe it.\n\n" +
      parts.join("\n\n"),
    ) ?? "sent";
    if (outcome === "no-model") {
      setActivity({ kind: "err", msg: "Can't start the fix — no model is selected in the Coder pane. Pick a model above the chat, then press 🛠 Fix with agent again." });
    } else if (outcome === "no-workspace") {
      setActivity({ kind: "err", msg: "Can't start the fix — no workspace is connected on this page." });
    } else if (outcome === "queued") {
      setActivity({ kind: "run", msg: "Coder is mid-run — the fix task is queued as a ⚡ steer and will run next." });
    } else {
      setActivity({ kind: "run", msg: "Sent to the coder agent — watch the chat for the fix." });
    }
  };

  // The escape hatch for when the buttons themselves keep failing: hand the
  // WHOLE release job to the coder agent — not "fix the buttons' code", but
  // "do the commit/merge/push/publish end-to-end yourself and verify the
  // public release". Same dispatch channel as Fix with agent (steer-safe).
  const finishWithAgent = () => {
    if (!onFixIssues) return;
    const parts: string[] = [];
    if (activity?.kind === "err") {
      const failedOutput = output?.kind === "err" ? output.body : activity.msg;
      parts.push(`Last failed action output:\n\n${failedOutput}`);
    }
    if (readyFails.length > 0) {
      parts.push(`Readiness checks currently failing:\n${readyFails.map((c) => `- ${c.label}: ${c.detail}`).join("\n")}`);
    }
    const outcome = onFixIssues(
      "The rule-based release buttons (Commit / Merge / Push / Publish) are failing in this repository. " +
      "Do NOT spend this run fixing or debugging the buttons' own code. Instead, COMPLETE the release yourself, end-to-end:\n" +
      "1. Audit the working tree(s); commit pending project work (never sweep runtime/scratch files or another session's WIP).\n" +
      "2. Merge the page branch into main, resolving conflicts safely — preserve both sides' work, never drop definitions or imports.\n" +
      "3. Push, then run the repository's real publish pipeline (finish_and_publish / scripts/finish-and-publish.sh) from the checkout that holds the signing key.\n" +
      "4. Do not stop at 'command launched' — follow it to a terminal result and VERIFY the new version is actually live as the Latest public release before reporting done.\n" +
      "If a step genuinely cannot proceed, stop and report the exact blocker with evidence.\n\n" +
      parts.join("\n\n"),
    ) ?? "sent";
    if (outcome === "no-model") {
      setActivity({ kind: "err", msg: "Can't hand off — no model is selected in the Coder pane. Pick a model above the chat, then press 🚀 Finish release with agent again." });
    } else if (outcome === "no-workspace") {
      setActivity({ kind: "err", msg: "Can't hand off — no workspace is connected on this page." });
    } else if (outcome === "queued") {
      setActivity({ kind: "run", msg: "Coder is mid-run — the release handoff is queued as a ⚡ steer and will run next." });
    } else {
      setActivity({ kind: "run", msg: "Release handed to the coder agent — it will commit, merge, push and publish end-to-end, then verify the live release." });
    }
  };

  return (
    <>
      <div ref={rootRef} style={{ marginTop: "auto", padding: 6 }}>
        <div
          data-ui="GitPublisherContainer"
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
          {/* Workspace path — the "Coding in <folder>" identity. Lives here
              (top of the release container, above the branch line) so the
              composer's status row can stay focused on live run messages
              instead of repeating the workspace path every turn. */}
          {gitDir && (
            <div
              title={gitDir}
              style={{
                fontSize: 10.5,
                color: "var(--fg-muted)",
                padding: "0 2px",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                direction: "rtl",
                textAlign: "left",
              }}
            >
              {/* direction:rtl keeps the tail of the path visible when it
                  overflows the 220px rail — the folder name stays readable,
                  the drive/prefix truncates instead. */}
              <bdi style={{ direction: "ltr", unicodeBidi: "plaintext" }}>📁 Coding in {gitDir}</bdi>
            </div>
          )}
          {/* Publisher result belongs above the first Git row. */}
          {activity && (
            <div
              data-ui="PublisherActivity"
              style={{
                display: "flex", gap: 5, alignItems: "flex-start", padding: "0 2px",
                fontSize: 10.5, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word",
                color: activity.kind === "err" ? "#ff8c8c" : activity.kind === "ok" ? "#7ff0c5" : "var(--fg-muted)",
              }}
            >
              <span style={{ flexShrink: 0 }}>{activity.kind === "run" ? "⏳" : activity.kind === "ok" ? "✓" : "✗"}</span>
              <span style={{ minWidth: 0 }}>{activity.msg}</span>
              {activity.kind === "run" && (
                <span aria-label={`Elapsed ${elapsedClock(elapsedSeconds)}`} style={{ flexShrink: 0, color: "var(--accent)", fontVariantNumeric: "tabular-nums" }}>
                  · {elapsedClock(elapsedSeconds)}
                </span>
              )}
              {output && !outputOpen && (
                <button
                  onClick={() => setOutputOpen(true)}
                  title="Show full output"
                  style={{ marginLeft: "auto", flexShrink: 0, background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: 10.5, textDecoration: "underline", fontFamily: "inherit" }}
                >⤢</button>
              )}
            </div>
          )}
          {/* Live repo facts — branch, ahead/behind upstream, uncommitted count */}
          {git?.isRepo && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--fg-muted)", padding: "0 2px", minWidth: 0 }}>
              <span title={git.branch || "detached HEAD"} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                ⎇ {git.branch || "(detached)"}
              </span>
              {git.ahead > 0 && (
                <span title={`${git.ahead} commit(s) ahead of upstream — Push sends them`} style={{ color: "#7ff0c5", flexShrink: 0 }}>↑{git.ahead}</span>
              )}
              {git.behind > 0 && (
                <span title={`${git.behind} commit(s) behind upstream`} style={{ color: "#ffd97a", flexShrink: 0 }}>↓{git.behind}</span>
              )}
              <span
                title={git.total > 0 ? `${git.total} uncommitted change(s) — Commit captures them` : "Working tree clean"}
                style={{ color: git.total > 0 ? "#ffd97a" : "var(--fg-muted)", flexShrink: 0 }}
              >
                {git.total > 0 ? `● ${git.total}` : "✓ clean"}
              </span>
            </div>
          )}
          {nuisanceFiles.length > 0 && (
            <div style={{ padding: "3px 5px", borderRadius: 5, background: "rgba(255,217,122,0.1)", color: "#ffd97a", fontSize: 10.5, lineHeight: 1.4 }}>
              {nuisanceFiles.length} tracked OWLLM runtime file{nuisanceFiles.length === 1 ? "" : "s"} can keep Git dirty. Use Fix with agent to safely de-track them.
            </div>
          )}
          <div style={{ display: "flex", gap: 6, width: "100%" }}>
            {showCommit && (
              <button
                onClick={() => { setCommitMsg(commitMsg.trim() || "Checkpoint from Publisher card"); setCommitOpen(true); }}
                disabled={disabled || loading}
                title={git && git.total > 0 ? `Commit ${git.total} change(s) in this workspace` : "Commit all changes in this workspace"}
                style={{ ...chipBtn, flex: 1 }}
              >
                {loading ? "⏳" : "●"} Commit{git && git.total > 0 ? ` (${git.total})` : ""}
              </button>
            )}
            {showMerge && (
              <button
                onClick={doMerge}
                disabled={disabled || loading}
                title={isolated
                  ? `Synchronize this page with ${projectRoot ? projectRoot.replace(/^.*[\\/]/, "") : "main"}`
                  : `Synchronize with origin/${mergeTarget}: pushes when ahead, fast-forwards when behind, and safely merges diverged histories — never force-pushes, never drops either side`}
                style={{ ...chipBtn, flex: 1, color: "#7ff0c5" }}
              >
                {loading ? "⏳" : "⇅"} Sync
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, width: "100%" }}>
            {showPush && (
              <button
                onClick={doPush}
                disabled={disabled || loading}
                title={isolated && projectRoot
                  ? `Sync the merged project checkout (${projectRoot.replace(/^.*[\\/]/, "")}) with origin — handles ahead, behind, and diverged histories`
                  : git && git.ahead > 0
                    ? `Sync ${git.ahead} commit(s) on ${git.branch || branch || "current"} with origin — a diverged remote integrates safely instead of failing`
                    : `Sync ${git?.branch || branch || "current"} with origin`}
                style={{ ...chipBtn, flex: 1 }}
              >
                {loading ? "⏳" : "↑"} Push
              </button>
            )}
            {showPublish && (
              <button
                // Stay clickable when not ready: a disabled button swallows the
                // click silently ("does nothing"). Instead, surface WHY inline
                // and open the checks — only run the real publish when ready.
                onClick={() => {
                  if (canPublish) { doPublish(); return; }
                  setChecksOpen(true);
                  refresh();
                  setActivity({
                    kind: "err",
                    msg: ready
                      ? `Can't publish yet — ${readyFails.length} unmet check${readyFails.length > 1 ? "s" : ""}:\n${publishFailReason}`
                      : "Checking release readiness…",
                  });
                }}
                disabled={disabled || loading}
                title={canPublish
                  ? `${modeLabel} release (${settings.mode})${HOST_IS_WINDOWS ? (signed ? "" : ", unsigned") : ""}`
                  : (publishFailReason || "Readiness check running… — click to see what's missing")}
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
          {/* Fix with agent — hands failed-action output + unmet readiness
              checks to the page's coder as a real task (steer-safe mid-run). */}
          {onFixIssues && hasFixableIssue && (
            <button
              onClick={fixWithAgent}
              disabled={disabled}
              title="Send these failures to the coder agent to diagnose and fix"
              style={{ ...chipBtn, width: "100%", color: "#ffd97a", borderColor: "rgba(255,217,122,0.45)" }}
            >
              🛠 Fix with agent
            </button>
          )}
          {/* Finish release with agent — when the rule-based buttons keep
              failing, hand the WHOLE job (commit→merge→push→publish→verify)
              to the coder instead of asking it to repair the buttons. */}
          {onFixIssues && hasFixableIssue && (
            <button
              onClick={finishWithAgent}
              disabled={disabled}
              title="Hand the whole release to the coder agent: it commits, merges, pushes, publishes and verifies the live release itself"
              style={{ ...chipBtn, width: "100%", color: "#7ff0c5", borderColor: "rgba(127,240,197,0.45)" }}
            >
              🚀 Finish release with agent
            </button>
          )}
          {/* Readiness summary — click to expand the per-check list, so "why
              is Publish greyed out" is readable in place, not just a tooltip
              on a disabled button. */}
          {ready && (
            <button
              onClick={() => { setChecksOpen((v) => !v); if (!checksOpen) refresh(); }}
              title={checksOpen ? "Hide readiness checks" : "Show readiness checks"}
              style={{
                display: "flex", gap: 6, alignItems: "center", width: "100%",
                background: "transparent", border: "none", padding: "0 2px",
                fontSize: 10, color: "var(--fg-muted)", cursor: "pointer", fontFamily: "inherit",
              }}
            >
              {showPublish && <span>{settings.mode === "host" ? "Host build" : "CI / GitHub Actions"}</span>}
              {showPublish && HOST_IS_WINDOWS && <span>· {signed ? "Signed" : "Unsigned"}</span>}
              <span style={{ flex: 1 }} />
              <span style={{ color: readyFails.length === 0 ? "#7ff0c5" : "#ffd97a", fontWeight: 700 }}>
                {readyFails.length === 0 ? "READY" : `${readyFails.length} issue${readyFails.length > 1 ? "s" : ""}`}
              </span>
              <span>{checksOpen ? "▾" : "▸"}</span>
            </button>
          )}
          {checksOpen && ready && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "0 2px 2px" }}>
              {ready.map((c) => (
                <div key={c.id} style={{ display: "flex", gap: 5, fontSize: 10.5, lineHeight: 1.45 }}>
                  <span style={{ color: c.ok ? "#7ff0c5" : "#ff8c8c", flexShrink: 0 }}>{c.ok ? "✓" : "✗"}</span>
                  <div style={{ minWidth: 0 }}>
                    <div title={c.detail} style={{ color: "var(--fg)" }}>{c.label}</div>
                    {!c.ok && <div style={{ color: "var(--fg-muted)", wordBreak: "break-word" }}>{c.detail}</div>}
                  </div>
                </div>
              ))}
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
              style={{ ...chipBtn, justifyContent: "center", background: "var(--accent)", color: "var(--accent-fg)", border: "none", opacity: commitMsg.trim() ? 1 : 0.5 }}
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
                <option value="host">Host — build + publish on this machine</option>
                <option value="ci">CI / GitHub Actions — push tag, let workflow build</option>
              </select>
              <div style={{ fontSize: 10, color: "var(--fg-subtle)", lineHeight: 1.4 }}>
                Host mode publishes immediately from this machine. CI mode relies on GitHub Actions runners, which are currently unavailable due to billing limits.
              </div>
            </div>

            {HOST_IS_WINDOWS && (<>
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
            </>)}

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

      {/* Command-output popup — Commit/Push/Merge/Publish output (and errors)
          used to expand the shared status line below the chatbox into a tall,
          undismissable block. Now the full, possibly multi-line output lives
          here: click-outside or ✕ to dismiss; reopen from the rail chip's ⤢. */}
      {outputOpen && output && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOutputOpen(false); }}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(0,0,0,0.45)", display: "flex",
            alignItems: "center", justifyContent: "center", padding: 24,
          }}
        >
          <div
            style={{
              width: "min(640px, 94vw)", maxHeight: "80vh", background: "var(--bg-panel)",
              border: "1px solid var(--border-strong)", borderRadius: 10,
              padding: 12, display: "flex", flexDirection: "column", gap: 10,
              boxShadow: "0 10px 32px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ flexShrink: 0, fontSize: 14 }}>
                {output.kind === "run" ? "⏳" : output.kind === "ok" ? "✓" : "✗"}
              </span>
              <span style={{
                fontWeight: 700, fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                color: output.kind === "err" ? "#ff8c8c" : output.kind === "ok" ? "#7ff0c5" : "var(--fg-strong)",
              }}>{output.title}</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setOutputOpen(false)} title="Dismiss" style={{ ...chipBtn, width: 24, padding: 0 }}>✕</button>
            </div>
            <pre style={{
              margin: 0, flex: 1, minHeight: 0, overflow: "auto",
              background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8,
              padding: 10, fontSize: 11.5, lineHeight: 1.5, fontFamily: "var(--font-mono, monospace)",
              whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--fg)",
            }}>{output.body}</pre>
          </div>
        </div>
      )}
    </>
  );
}
