// ProjectSettingsDialog — ONE popup that is both "⚙ Project settings" (edit the
// current project) and "+ New project" (create one). It absorbs everything that
// used to crowd the inline project strip: folder/Browse, the trust + isolation +
// full-access + Verify/Isolate cluster, the Bridge shortcut, the team template
// picker, Rename, and a double-approval Delete. The toolbar keeps only a project
// dropdown + a ⚙ button that opens this.
//
// Edit-mode field changes reuse the parent's existing callbacks (onChangeLocation
// / onToggleTrustWrites …), which already persist to the project row via the
// AgentsPage effects — so this dialog adds NO new persistence path for those.

import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isolationBadge } from "./isolationBadge";
import { isWslPath } from "./wslIsolation";
import { sandboxSyncLogins, sandboxConvertProject, sandboxHarden } from "./isolation";
import { parseVerifyConfig } from "./gate";
import { parseProjectCard, renderCardFindings, type CardFinding, type ProjectCard } from "./cardLint";
import { runCardLint } from "./localTools";

type Team = {
  id: string; name: string; display: string; category: string;
  description: string; icon: string;
  agents: { name: string; base: string; icon?: string | null }[];
  edges: { source: string; target: string }[];
  visibility?: "recommended" | "more" | "examples" | "legacy" | "custom";
  workflowRank?: number; requiredMcp?: string[];
};
type ProjectRow = {
  id: string; name: string; description: string; location: string;
  trust_writes: boolean; auto_approve_all: boolean;
  team: string[]; team_default_model_id: string; graph_json: string;
  chat_json: string; agent_logs_json: string; updated_at: string;
};

export type ProjectSettingsDialogProps = {
  open: boolean;
  mode: "new" | "edit";
  onClose: () => void;
  teams: Team[];
  pickedTeamId: string | null;
  onPickTeam: (id: string | null) => void;
  /// The team template this project actually runs (resolved from its roster
  /// when no template is explicitly picked) — shown read-only in EDIT mode so
  /// the card always names the team, not "(use project roster)".
  resolvedTeamLabel?: string | null;
  // NEW mode
  defaultTeamName?: string | null;
  onCreated: (row: ProjectRow) => void;
  // EDIT mode — the live project + the parent callbacks that already persist.
  project: ProjectRow | null;
  location: string;
  effectiveCwd: string;
  onChangeLocation: (v: string) => void;
  trustWrites: boolean;
  onToggleTrustWrites: () => void;
  fullAccess: boolean;
  onToggleFullAccess: () => void;
  bridgeOn: boolean;
  isolationRequested: boolean;
  onAfterRename: () => void;
  onAfterDelete: () => void;
  /// Re-derive this project's roster + wiring from its built-in team template
  /// (picks up template fixes like renamed/repurposed agents). Shown only when
  /// the project maps to a template (resolvedTeamLabel set). Parent persists +
  /// reloads. Returns a status string to show inline.
  onResetTeam?: () => Promise<string>;
};

const LBL: React.CSSProperties = { fontSize: 11, color: "var(--fg-muted)", letterSpacing: 0.5, textTransform: "uppercase" };
const INPUT: React.CSSProperties = { height: 38, padding: "0 12px", borderRadius: 8, background: "var(--bg-input)", color: "var(--fg)", border: "1px solid var(--border)", fontSize: 14 };

// ---- New-project onboarding: intent cards with precooked setups ----
// Each card maps "what the user wants to make" to a bundled team template
// (first name in `teams` that exists wins), plus seeds for the form. The
// grid replaces the raw template <select> as the FIRST step of creation;
// the old controls stay reachable under Advanced / the Custom card.
type ProjectKind = {
  key: string; icon: string; title: string; blurb: string;
  /// Preferred team template `name`s, in order; first available wins.
  teams: string[];
  namePh: string;
  /// Seeds the (editable) description — one line of context the team starts with.
  descSeed: string;
};
const PROJECT_KINDS: ProjectKind[] = [
  { key: "web", icon: "🌐", title: "Website / Web app", blurb: "Design, build and preview a site or web app — a Browser agent checks it live on localhost.", teams: ["dev_squad"], namePh: "e.g. my-site, shop-frontend", descSeed: "Build a website / web app. Run it on a localhost dev server and verify pages render in the browser before calling anything done." },
  { key: "mobile", icon: "📱", title: "Mobile app", blurb: "Build a mobile app — the Browser agent previews it with phone-sized viewports.", teams: ["dev_squad"], namePh: "e.g. fitness-app, todo-mobile", descSeed: "Build a mobile app. Preview web builds with a phone-sized viewport in the browser; keep layouts responsive and touch-friendly." },
  { key: "software", icon: "🛠", title: "Software / tool", blurb: "General coding: CLIs, backends, libraries — plan, implement, review, verify.", teams: ["owllm_team", "dev_squad"], namePh: "e.g. esp-flash, csv-tool", descSeed: "Build software in this folder. Verify every change (build/tests) before reporting done." },
  { key: "assistant", icon: "🤖", title: "Personal assistant", blurb: "A secretary team for daily work: notes, plans, mail drafts, reminders, files.", teams: ["secretary", "concierge"], namePh: "e.g. my-desk, daily-ops", descSeed: "Act as my personal assistant: organize notes and files, draft messages, plan tasks and keep track of follow-ups." },
  { key: "bugfix", icon: "🐛", title: "Fix bugs", blurb: "Point it at an existing repo — hunts, reproduces and fixes bugs at the root.", teams: ["bug_hunter"], namePh: "e.g. fix-login, crash-hunt", descSeed: "Find, reproduce and fix bugs in this codebase. Always verify the fix with a build/test before reporting done." },
  { key: "review", icon: "🧐", title: "Code review", blurb: "Multi-axis review of a repo or PR: correctness, security, performance, style.", teams: ["code_reviewer"], namePh: "e.g. review-pr42", descSeed: "Review the code in this folder: correctness, security, performance and maintainability. Report concrete findings with file:line references." },
  { key: "research", icon: "🔬", title: "Research", blurb: "Deep research with sources: compare options, verify claims, write it up.", teams: ["research_lab"], namePh: "e.g. market-scan, paper-notes", descSeed: "Research the topic thoroughly, verify claims across sources, and produce a written summary with references." },
  { key: "writing", icon: "✍️", title: "Writing & content", blurb: "Articles, docs, scripts, books — drafted, critiqued and polished by a writers room.", teams: ["writers_room"], namePh: "e.g. blog-q3, user-guide", descSeed: "Write and refine content in this folder. Keep a consistent voice; critique and polish drafts before final." },
  { key: "data", icon: "📊", title: "Data analysis", blurb: "Explore datasets, crunch numbers, chart findings and explain what they mean.", teams: ["data_analyst"], namePh: "e.g. sales-analysis", descSeed: "Analyze the data in this folder: clean it, extract insights, and present findings clearly." },
  { key: "social", icon: "📣", title: "Social media", blurb: "Plan and draft posts, threads and campaigns across your channels.", teams: ["social_desk"], namePh: "e.g. launch-campaign", descSeed: "Plan and draft social media content. Match each platform's tone and format; prepare a posting schedule." },
  { key: "product", icon: "🚀", title: "New product", blurb: "From idea to plan: brainstorm, spec, design and an execution roadmap.", teams: ["product_studio"], namePh: "e.g. saas-idea", descSeed: "Take this product idea from concept to an actionable plan: positioning, spec, milestones." },
  { key: "custom", icon: "⚙️", title: "Custom…", blurb: "Pick any team template yourself and configure every setting by hand.", teams: [], namePh: "e.g. esp-flash, cleanup-pr, paper-draft", descSeed: "" },
];
/// First bundled template (by `name`) this kind prefers that actually exists.
function kindTeam(kind: ProjectKind, teams: Team[]): Team | null {
  for (const n of kind.teams) { const t = teams.find(x => x.name === n); if (t) return t; }
  return null;
}

export default function ProjectSettingsDialog(props: ProjectSettingsDialogProps) {
  const {
    open, mode, onClose, teams, pickedTeamId, onPickTeam, onResetTeam,
    resolvedTeamLabel, defaultTeamName, onCreated,
    project, location, effectiveCwd, onChangeLocation,
    trustWrites, onToggleTrustWrites, fullAccess, onToggleFullAccess,
    bridgeOn, isolationRequested, onAfterRename, onAfterDelete,
  } = props;

  // --- new-project form state ---
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [newLocation, setNewLocation] = useState("");
  // Selected team by ID (NOT name) — two teams can share a display/name, and
  // resolving the create by name returned the FIRST match ("always the first
  // team"). The <select> options carry the id; create resolves the id.
  const [teamId, setTeamId] = useState("");
  const [newTrust, setNewTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Visual onboarding: step 1 = "what do you want to make?" card grid,
  // step 2 = details form pre-seeded by the chosen card.
  const [step, setStep] = useState<"kind" | "form">("kind");
  const [kindKey, setKindKey] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Backdrop-dismiss guard: remember whether a mouse press BEGAN on the overlay.
  // Without this, selecting text in a field and releasing the mouse outside the
  // dialog bubbles a click to the backdrop and nukes the whole half-filled form.
  const downOnBackdrop = useRef(false);

  // --- edit-project local state ---
  const [renameVal, setRenameVal] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actBusy, setActBusy] = useState<string | null>(null);
  const [actMsg, setActMsg] = useState<string | null>(null);
  // --- Project Card (.owllm/project.json) — the one committed file holding this
  // project's goal / verify / release / mode, edited right here so it's visible.
  const [cardRaw, setCardRaw] = useState<ProjectCard | null>(null);   // parsed card (preserves unknown fields on save)
  const [cardExists, setCardExists] = useState(false);
  const [cardGoal, setCardGoal] = useState("");
  const [cardVerify, setCardVerify] = useState("");                  // verify.command
  const [cardMode, setCardMode] = useState("");                      // "", "solo", "team"
  const [relVersionFile, setRelVersionFile] = useState("");
  const [relStagePath, setRelStagePath] = useState("");
  const [relCommand, setRelCommand] = useState("");
  const [relRepo, setRelRepo] = useState("");                        // release.repo — gh target "owner/name"
  const [relMode, setRelMode] = useState<"host" | "ci">("host");
  const [relSignThumb, setRelSignThumb] = useState("");
  const [relSignSubject, setRelSignSubject] = useState("");
  const [relSignTsa, setRelSignTsa] = useState("http://time.certum.pl");
  const [showRelease, setShowRelease] = useState(false);
  const [legacyVerifyJson, setLegacyVerifyJson] = useState(false);   // a separate .owllm/verify.json exists (takes precedence)
  const [cardBusy, setCardBusy] = useState<string | null>(null);
  const [cardMsg, setCardMsg] = useState<string | null>(null);
  const [findings, setFindings] = useState<CardFinding[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null); setActMsg(null); setActBusy(null); setConfirmDelete(false);
    if (mode === "new") {
      setName(""); setDescription(""); setNewLocation(""); setNewTrust(false);
      // A template explicitly handed in (e.g. "use this team" from the teams
      // page) skips the card grid — the user already chose their setup.
      const preset = defaultTeamName ? teams.find(t => t.name === defaultTeamName) : null;
      if (preset) {
        setTeamId(preset.id); setKindKey("custom"); setStep("form"); setShowAdvanced(true);
      } else {
        setTeamId(teams[0]?.id ?? ""); setKindKey(""); setStep("kind"); setShowAdvanced(false);
      }
    } else {
      setRenameVal(project?.name ?? "");
    }
  // Seed the form ONLY when the dialog opens (or mode/project changes) —
  // deliberately NOT when `teams` or `defaultTeamName` change underneath. Those
  // were in the deps before, so any background change reset the team picker back
  // to teams[0] mid-dialog → "a new project always gets the first team" even
  // after the user picked a different one. Reading them here is fine: the effect
  // runs on the open transition, when they already hold their current value.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, project?.id]);

  // Load the Project Card (.owllm/project.json) into the editor fields. Falls back
  // to a legacy .owllm/verify.json for the verify command (and flags it, since that
  // file takes precedence over the card in the gate). Blank everywhere → no card yet.
  useEffect(() => {
    if (!open || mode === "new") return;
    const cwd = effectiveCwd || location;
    setCardRaw(null); setCardExists(false); setCardGoal(""); setCardVerify("");
    setCardMode(""); setRelVersionFile(""); setRelStagePath(""); setRelCommand(""); setRelRepo(""); setRelMode("host");
    setRelSignThumb(""); setRelSignSubject(""); setRelSignTsa("http://time.certum.pl");
    setShowRelease(false); setLegacyVerifyJson(false); setCardMsg(null); setFindings(null);
    if (!cwd) return;
    let live = true;
    (async () => {
      let card: ProjectCard | null = null;
      try {
        const txt = await invoke<string>("tool_read_file", { path: ".owllm/project.json", cwd });
        card = parseProjectCard(txt);
      } catch { /* no card yet */ }
      let legacyCmd = "";
      try {
        const vtxt = await invoke<string>("tool_read_file", { path: ".owllm/verify.json", cwd });
        legacyCmd = parseVerifyConfig(vtxt)?.command ?? "";
      } catch { /* no legacy verify.json */ }
      if (!live) return;
      if (card) {
        setCardRaw(card); setCardExists(true);
        setCardGoal(card.goal ?? "");
        setCardVerify(card.verify?.command ?? legacyCmd);
        setCardMode(card.mode ? String(card.mode) : "");
        setRelVersionFile(card.release?.versionFile ?? "");
        setRelStagePath(card.release?.stagePath ?? "");
        setRelCommand(card.release?.command ?? "");
        setRelRepo(card.release?.repo ?? "");
        setRelMode(card.release?.mode === "ci" ? "ci" : "host");
        setRelSignThumb(card.release?.sign?.thumbprint ?? "");
        setRelSignSubject(card.release?.sign?.subject ?? "");
        setRelSignTsa(card.release?.sign?.tsa ?? "http://time.certum.pl");
        if (card.release && (card.release.versionFile || card.release.command || card.release.mode || card.release.sign)) setShowRelease(true);
      } else {
        setCardVerify(legacyCmd);
      }
      setLegacyVerifyJson(!!legacyCmd);
    })();
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, project?.id, effectiveCwd]);

  if (!open) return null;

  const team = teams.find(t => t.id === teamId) ?? null;

  // ---- shared actions ----
  const browse = async (set: (v: string) => void) => {
    try {
      const picked = await invoke<string | null>("pick_folder", { title: "Pick a project folder" });
      if (picked) set(picked);
    } catch (e: any) { setErr(`Folder pick failed: ${e?.message ?? e}`); }
  };

  const onCreate = async () => {
    if (!name.trim()) { setErr("Project name is required."); return; }
    if (!team) { setErr("Pick a team template."); return; }
    setBusy(true); setErr(null);
    try {
      const row = await invoke<ProjectRow>("create_project", {
        input: {
          name: name.trim(), description: description.trim(), location: newLocation.trim(),
          team: team.agents.map(a => a.name),
          // Persist the roster's roles (base) alongside the edges so a renamed
          // agent keeps its role on reload (the `team` field is names only).
          graph_json: JSON.stringify({
            edges: team.edges,
            roster: team.agents.map(a => ({ name: a.name, base: a.base })),
          }),
          team_default_model_id: "", trust_writes: newTrust, auto_approve_all: false,
        },
      });
      onCreated(row); onClose();
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };

  const doRename = async () => {
    if (!project) return;
    const next = renameVal.trim();
    if (!next || next === project.name) return;
    try {
      await invoke("update_project", { input: { id: project.id, name: next } });
      onAfterRename();
    } catch (e: any) { setActMsg(`Rename failed: ${e?.message ?? e}`); }
  };

  const doDelete = async () => {
    if (!project) return;
    setActBusy("delete");
    try {
      await invoke("delete_project", { id: project.id });
      onAfterDelete(); onClose();
    } catch (e: any) { setActMsg(`Delete failed: ${e?.message ?? e}`); }
    finally { setActBusy(null); }
  };

  // Persist the Project Card to <project>/.owllm/project.json. Merges the edited
  // fields into the existing card object so unknown keys (name, _note, verify.lanes…)
  // survive. Empty sections are omitted so the card stays clean.
  const saveCard = async () => {
    const cwd = effectiveCwd || location;
    if (!cwd) { setCardMsg("Pick a project folder first."); return; }
    setCardBusy("save"); setCardMsg(null);
    try {
      const card: ProjectCard = { ...(cardRaw ?? {}) };
      const goal = cardGoal.trim();
      if (goal) card.goal = goal; else delete card.goal;
      if (cardMode) card.mode = cardMode; else delete card.mode;

      const vc = cardVerify.trim();
      if (vc) card.verify = { ...(card.verify ?? {}), command: vc };
      else if (card.verify) { delete card.verify.command; if (!card.verify.lanes || !Object.keys(card.verify.lanes).length) delete card.verify; }

      const vf = relVersionFile.trim(), sp = relStagePath.trim(), rc = relCommand.trim(), rr = relRepo.trim();
      const st = relSignThumb.trim(), ss = relSignSubject.trim(), stsa = relSignTsa.trim();
      const hasSign = st || ss;
      if (vf || sp || rc || rr || relMode !== "host" || hasSign) {
        card.release = { ...(card.release ?? {}) };
        if (vf) card.release.versionFile = vf; else delete card.release.versionFile;
        if (sp) card.release.stagePath = sp; else delete card.release.stagePath;
        if (rc) card.release.command = rc; else delete card.release.command;
        if (rr) card.release.repo = rr; else delete card.release.repo;
        if (relMode === "ci") card.release.mode = "ci"; else delete card.release.mode;
        if (hasSign) {
          card.release.sign = {
            ...(st ? { thumbprint: st } : {}),
            ...(ss ? { subject: ss } : {}),
            ...(stsa ? { tsa: stsa } : {}),
          };
        } else {
          delete card.release.sign;
        }
        if (!Object.keys(card.release).length) delete card.release;
      } else { delete card.release; }

      const content = JSON.stringify(card, null, 2) + "\n";
      await invoke("tool_write_file", { path: ".owllm/project.json", content, cwd });
      setCardRaw(card); setCardExists(true);
      setCardMsg(legacyVerifyJson && vc
        ? "✓ Card saved. NOTE: a legacy .owllm/verify.json also exists and TAKES PRECEDENCE for verify — delete it to let the card's verify apply."
        : "✓ Project Card saved to .owllm/project.json — it's committed with the repo and used on every machine.");
    } catch (e: any) { setCardMsg(`Save failed: ${e?.message ?? e}`); }
    finally { setCardBusy(null); }
  };

  // Run the Steward's deterministic lint against the saved card + repo and show the
  // findings inline (the same check that runs at the start of a team run).
  const reviewCard = async () => {
    const cwd = effectiveCwd || location;
    if (!cwd) { setCardMsg("Pick a project folder first."); return; }
    setCardBusy("review"); setCardMsg(null); setFindings(null);
    try {
      const { findings } = await runCardLint(cwd);
      setFindings(findings);
    } catch (e: any) { setCardMsg(`Review failed: ${e?.message ?? e}`); }
    finally { setCardBusy(null); }
  };

  // ---- isolation actions (moved here off the toolbar) ----
  const probeIsolation = async () => {
    const r = await invoke<{ stdout: string; stderr: string; exitCode: number }>("tool_shell_exec", {
      command: 'uname -a; echo "PWD=$(pwd)"; echo "USER=$(whoami)"; echo "CDRIVE=$(ls /mnt/c/Windows >/dev/null 2>&1 && echo VISIBLE || echo HIDDEN)"',
      cwd: effectiveCwd || undefined,
    });
    const out = `${r.stdout}\n${r.stderr}`.trim();
    const inWsl = /microsoft-standard-WSL2/i.test(out) || (/\bLinux\b/.test(r.stdout) && !/PWD=[A-Za-z]:\\/.test(out));
    const confined = /CDRIVE=HIDDEN/.test(out);
    return { out, inWsl, confined };
  };
  const verifyIsolation = async () => {
    if (actBusy) return;
    setActBusy("verify"); setActMsg("🔍 Running the probe through an agent's own shell…");
    try {
      let { out, inWsl, confined } = await probeIsolation();
      if (inWsl && !confined) {
        setActMsg("🛡 Runs in WSL — sealing it to ONLY this folder (installing bubblewrap, ~10–20s)…");
        try { await sandboxHarden(null); ({ out, inWsl, confined } = await probeIsolation()); }
        catch (e) {
          setActMsg("✅ Runs in WSL (Linux), but couldn't seal it to just this folder: " + String(e) +
            "\n\nAgents still run isolated in WSL — they just also see the rest of /mnt (C: drive). " +
            "Open the WSL distro and run: sudo apt-get install -y bubblewrap");
          return;
        }
      }
      const verdict = !inWsl
        ? "⚠️ NOT ISOLATED — agents run on the Windows host. Press 🛡 Isolate to move the project into the sandbox."
        : confined
          ? "✅ FULLY ISOLATED — agents run in WSL (Linux) AND are sealed to ONLY this folder: they can't see the rest of your C: drive."
          : "✅ ISOLATED in WSL (Linux), but NOT folder-sealed — agents can still see the rest of /mnt. Install bubblewrap in the distro to seal it.";
      setActMsg(verdict + "\n\nProbe output:\n" + (out || "(no output)"));
    } catch (e) { setActMsg("Verify failed: " + String(e)); }
    finally { setActBusy(null); }
  };
  const mirrorLogins = async (): Promise<string> => {
    const r = await sandboxSyncLogins(null);
    return r.synced.length ? `logins synced into the sandbox: ${r.synced.join(", ")}`
      : r.found_on_host.length ? `found on Windows (${r.found_on_host.join(", ")}) but none landed in the sandbox`
      : "no logins to mirror yet (connect GitHub on Home, or a CLI on Accounts)";
  };
  const isolate = async () => {
    if (actBusy) return;
    if (isWslPath(location)) { setActMsg("Already isolated — this project lives inside WSL."); return; }
    if (!location.trim()) { setActMsg("Pick a project folder first (Browse…)."); return; }
    if (!window.confirm("Copy this project INTO the Linux sandbox and switch to the copy?\n\nThe original folder stays where it is. A large repo can take a minute.")) return;
    setActBusy("isolate"); setActMsg("🛡 Copying the project into the Linux sandbox… this can take a minute. The app stays responsive.");
    try {
      const p = await sandboxConvertProject(location);
      onChangeLocation(p.path);
      setActMsg("🔑 Isolated. Mirroring your GitHub / CLI logins into the sandbox…");
      let syncMsg: string;
      try { syncMsg = await mirrorLogins(); } catch (e) { syncMsg = "login mirror skipped: " + String(e); }
      setActMsg(`✅ Isolated + ${syncMsg}.\nNow working in: ${p.path}\nAgents run in WSL — press 🔍 Verify to confirm.`);
    } catch (e) { setActMsg("Convert failed: " + String(e)); }
    finally { setActBusy(null); }
  };

  const teamSelect = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={e => onChange(e.target.value)} style={INPUT}>
      {teams.length === 0 ? <option value="">(no templates available)</option>
        : teams.map(t => (
            <option key={t.id} value={t.id}>
              {t.visibility === "recommended" ? "Core: " : ""}{t.display} ({t.agents.length} agents)
            </option>
          ))}
    </select>
  );

  const iso = isolationBadge(effectiveCwd, isolationRequested);
  const aBtn = (label: string, onClick: () => void, key: string) => (
    <button type="button" onClick={onClick} disabled={!!actBusy}
      style={{ height: 34, padding: "0 12px", borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--bg-elevated)", color: "var(--fg-strong)", fontSize: 12.5, fontWeight: 700, cursor: actBusy ? "wait" : "pointer", opacity: actBusy ? 0.6 : 1 }}
    >{actBusy === key ? "⏳ Working…" : label}</button>
  );

  return (
    <div
      onMouseDown={e => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => {
        // Dismiss only when BOTH the press and release landed on the backdrop
        // itself — never on a click that bubbled from inside, and never on a
        // text-selection drag that began in a field and released out here.
        if (e.target !== e.currentTarget || !downOnBackdrop.current) return;
        downOnBackdrop.current = false;
        if (mode === "new" && (name.trim() || description.trim() || newLocation.trim())
            && !window.confirm("Discard this new project and close?")) return;
        onClose();
      }}
      style={{ position: "fixed", inset: 0, background: "var(--bg-overlay)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: mode === "new" && step === "kind" ? "min(760px, 94vw)" : "min(640px, 92vw)", maxHeight: "92vh", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14, padding: 22, display: "flex", flexDirection: "column", gap: 14, boxShadow: "var(--shadow-lg)", overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--fg-strong)", flex: 1 }}>
            {mode === "new" ? "+ New project" : `⚙ Project settings${project ? ` — ${project.name}` : ""}`}
          </div>
          <button onClick={onClose} title="Close" style={{ width: 32, height: 32, border: "none", background: "var(--bg-surface)", color: "var(--fg)", borderRadius: 8, fontSize: 16, cursor: "pointer" }}>✕</button>
        </div>

        {mode === "new" ? (
          step === "kind" ? (
            <>
              {/* STEP 1 — visual onboarding: what do you want to make? */}
              <div style={{ color: "var(--fg-muted)", fontSize: 12.5, lineHeight: 1.5 }}>
                What do you want to make? Pick a card — the right team of agents and
                settings are prepared for you. You can adjust everything afterwards.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: 10 }}>
                {PROJECT_KINDS.map(k => {
                  const t = k.key === "custom" ? null : kindTeam(k, teams);
                  const disabled = k.key !== "custom" && !t;
                  return (
                    <button
                      key={k.key}
                      type="button"
                      disabled={disabled}
                      title={disabled ? "Template not installed" : (t ? `Team: ${t.display} (${t.agents.length} agents)` : "Configure everything yourself")}
                      onClick={() => {
                        setKindKey(k.key);
                        if (t) setTeamId(t.id);
                        setDescription(k.descSeed);
                        setShowAdvanced(k.key === "custom");
                        setStep("form");
                      }}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6,
                        padding: "12px 12px 10px", minHeight: 118, textAlign: "left",
                        background: "var(--bg-elevated)", border: "1px solid var(--border)",
                        borderRadius: 12, cursor: disabled ? "not-allowed" : "pointer",
                        opacity: disabled ? 0.45 : 1,
                        transition: "border-color 120ms, background 120ms, transform 120ms",
                      }}
                      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.borderColor = "rgba(var(--accent-rgb),0.65)"; e.currentTarget.style.background = "rgba(var(--accent-rgb),0.08)"; } }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-elevated)"; }}
                    >
                      <span style={{ fontSize: 24, lineHeight: 1 }}>{k.icon}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-strong)" }}>{k.title}</span>
                      <span style={{ fontSize: 10.5, color: "var(--fg-muted)", lineHeight: 1.45, flex: 1 }}>{k.blurb}</span>
                      <span style={{ fontSize: 10, color: t ? "rgba(var(--accent-rgb),0.9)" : "var(--fg-subtle)", fontWeight: 700 }}>
                        {t ? `👥 ${t.display} · ${t.agents.length} agents` : (k.key === "custom" ? "all templates" : "not installed")}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {/* STEP 2 — details, pre-seeded by the chosen card. */}
              {(() => {
                const kind = PROJECT_KINDS.find(k => k.key === kindKey) ?? null;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", background: "rgba(var(--accent-rgb),0.12)", border: "1px solid rgba(var(--accent-rgb),0.4)", borderRadius: 8, fontSize: 12.5, fontWeight: 700, color: "var(--fg-strong)" }}>
                      {kind ? `${kind.icon} ${kind.title}` : "⚙️ Custom"}
                    </span>
                    <button type="button" className="ghost-btn" style={{ height: 26, padding: "0 10px", fontSize: 11.5 }}
                      onClick={() => setStep("kind")}>← Change</button>
                  </div>
                );
              })()}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={LBL}>Name</label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)}
                  placeholder={(PROJECT_KINDS.find(k => k.key === kindKey)?.namePh) ?? "e.g. esp-flash, cleanup-pr, paper-draft"} style={INPUT} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={LBL}>Folder / location</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={newLocation} onChange={e => setNewLocation(e.target.value)} placeholder="/path/to/repo or any project folder — new or existing" style={{ ...INPUT, flex: 1 }} />
                  <button onClick={() => browse(setNewLocation)} className="ghost-btn" style={{ height: 38, padding: "0 14px" }}>Browse…</button>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={LBL}>Context for the team <span style={{ opacity: 0.6, textTransform: "none", letterSpacing: 0 }}>— editable, seeded by your pick</span></label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="One line of context for the team to start with." rows={2} style={{ ...INPUT, height: "auto", padding: "8px 12px", resize: "vertical", minHeight: 40 }} />
              </div>
              {/* What you get — the precooked setup, stated honestly. */}
              {team && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 12, borderRadius: 10, background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                  <label style={LBL}>What you get</label>
                  <div style={{ fontSize: 12.5, color: "var(--fg-strong)", fontWeight: 700 }}>👥 {team.display} <span style={{ color: "var(--fg-muted)", fontWeight: 400 }}>— {team.agents.length} agents, wired and ready</span></div>
                  <div style={{ color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.5 }}>{team.description}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {team.agents.map(a => (
                      <span key={a.name} style={{ background: "var(--bg-surface)", color: "var(--fg-muted)", fontSize: 10, fontFamily: "Consolas, monospace", borderRadius: 4, padding: "2px 6px" }}>{a.name}</span>
                    ))}
                  </div>
                  {(team.requiredMcp?.length ?? 0) > 0 && (
                    <div style={{ color: "#a8b8ff", fontSize: 11, lineHeight: 1.4 }}>Uses MCP: {team.requiredMcp!.map(m => m.replace(/^mcp\./, "")).join(", ")}.</div>
                  )}
                  <div style={{ color: "var(--fg-subtle)", fontSize: 10.5, lineHeight: 1.4 }}>
                    Agents run sandboxed by default — security, folder and team can all be changed later in ⚙ Project settings.
                  </div>
                </div>
              )}
              {/* Advanced — the raw controls (template picker + trust). */}
              <button type="button" onClick={() => setShowAdvanced(v => !v)}
                style={{ alignSelf: "flex-start", background: "none", border: "none", color: "var(--fg-muted)", fontSize: 12, cursor: "pointer", padding: 0 }}>
                {showAdvanced ? "▾" : "▸"} Advanced — team template & permissions
              </button>
              {showAdvanced && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingLeft: 12, borderLeft: "2px solid var(--border)" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <label style={LBL}>Team template</label>
                    {teamSelect(teamId, setTeamId)}
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: newTrust ? "#ffb56a" : "var(--fg)" }}>
                    <input type="checkbox" checked={newTrust} onChange={() => setNewTrust(v => !v)} style={{ width: 14, height: 14, accentColor: "var(--accent)" }} />
                    <span>Trust writes — let the team edit files directly without the sandbox guard.</span>
                  </label>
                </div>
              )}
            </>
          )
        ) : (
          <>
            {/* Name + rename */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={LBL}>Name</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={renameVal} onChange={e => setRenameVal(e.target.value)} style={{ ...INPUT, flex: 1 }} />
                <button onClick={doRename} className="ghost-btn" disabled={!renameVal.trim() || renameVal.trim() === project?.name} style={{ height: 38, padding: "0 14px" }}>Rename</button>
              </div>
            </div>
            {/* Folder */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={LBL}>Folder / location</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={location} onChange={e => onChangeLocation(e.target.value)} placeholder="/path/to/repo · github.com/me/x" style={{ ...INPUT, flex: 1 }} />
                <button onClick={() => browse(onChangeLocation)} className="ghost-btn" style={{ height: 38, padding: "0 14px" }}>Browse…</button>
              </div>
            </div>
            {/* Security */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 10, background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
              <label style={LBL}>Security</label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: trustWrites ? "#ffb56a" : "var(--fg)" }}>
                <input type="checkbox" checked={trustWrites} onChange={onToggleTrustWrites} style={{ width: 14, height: 14, accentColor: "var(--accent)" }} />
                <span>Trust writes — agents edit files directly (skip the write guard).</span>
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                {fullAccess
                  ? <button type="button" onClick={onToggleFullAccess} title="Agents run OUTSIDE the sandbox — full access to your PC. Click to turn back off." style={{ height: 24, padding: "2px 8px", background: "#3a1416", color: "#ff8c8c", border: "1px solid #ff5a5a", borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: "pointer" }}>⚠ HOST ACCESS — sandbox OFF</button>
                  : <span title={iso.title} style={{ height: 24, display: "inline-flex", alignItems: "center", padding: "2px 8px", background: iso.bg, color: iso.color, border: `1px solid ${iso.border}`, borderRadius: 6, fontSize: 11, fontWeight: iso.hostFallback ? 800 : 600 }}>{iso.text}</span>}
                {aBtn("🔍 Verify", verifyIsolation, "verify")}
                {!isWslPath(effectiveCwd) && aBtn("🛡 Isolate", isolate, "isolate")}
                {!fullAccess && <button type="button" onClick={onToggleFullAccess} title="Let this project's agents run OUTSIDE the sandbox. Use only for projects you trust." style={{ height: 24, padding: "2px 8px", background: "var(--bg-elevated)", color: "var(--fg-muted)", border: "1px solid var(--border-strong)", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>🔓 Full access…</button>}
              </div>
            </div>
            {/* 📇 Project Card — .owllm/project.json: the one committed file holding
                this project's goal / verify / release / mode. Edited here so it's
                visible, and reviewed by the Steward's deterministic lint. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 10, background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ ...LBL, flex: 1 }}>📇 Project Card <span style={{ opacity: 0.6, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>— the rules that travel with this repo (<code>.owllm/project.json</code>)</span></label>
                {cardExists
                  ? <span style={{ fontSize: 10.5, color: "#7fd17f", fontWeight: 700 }}>● committed</span>
                  : <span style={{ fontSize: 10.5, color: "var(--fg-muted)", fontWeight: 700 }}>○ not created yet</span>}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={LBL}>Goal</label>
                <textarea value={cardGoal} onChange={e => setCardGoal(e.target.value)} rows={2}
                  placeholder="What this project is, in one or two lines — the team reads this."
                  style={{ ...INPUT, height: "auto", padding: "8px 12px", resize: "vertical", minHeight: 40 }} />
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "2 1 240px" }}>
                  <label style={LBL}>Verify command <span style={{ opacity: 0.6, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>— proves a change is “done”</span></label>
                  <input value={cardVerify} onChange={e => setCardVerify(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") saveCard(); }}
                    placeholder="auto-detected — e.g. npm run build · cargo check · pytest -q"
                    style={{ ...INPUT, flex: 1 }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 120px" }}>
                  <label style={LBL}>Default mode</label>
                  <select value={cardMode} onChange={e => setCardMode(e.target.value)} style={INPUT}>
                    <option value="">(unset)</option>
                    <option value="team">👥 Team</option>
                    <option value="solo">⚡ Solo</option>
                  </select>
                </div>
              </div>

              {/* Release (publishing) — power-user, collapsed by default */}
              <button type="button" onClick={() => setShowRelease(v => !v)}
                style={{ alignSelf: "flex-start", background: "none", border: "none", color: "var(--fg-muted)", fontSize: 12, cursor: "pointer", padding: 0 }}>
                {showRelease ? "▾" : "▸"} Release (rule-based publish)
              </button>
              {showRelease && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 12, borderLeft: "2px solid var(--border)" }}>
                  <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                    When a goal says “publish”, the release runs by rule: bump → commit → tag → push, then either build locally or let GitHub Actions finish it.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={LBL}>Release repo <span style={{ opacity: 0.6, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>— GitHub repo releases publish TO (may differ from origin)</span></label>
                    <input value={relRepo} onChange={e => setRelRepo(e.target.value)} placeholder='e.g. your-org/your-app — empty = the publish script&apos;s default' style={INPUT} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={LBL}>Version file</label>
                    <input value={relVersionFile} onChange={e => setRelVersionFile(e.target.value)} placeholder="e.g. package.json · src-tauri/tauri.conf.json" style={INPUT} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={LBL}>Stage path <span style={{ opacity: 0.6, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>— dir to commit for the release</span></label>
                    <input value={relStagePath} onChange={e => setRelStagePath(e.target.value)} placeholder="e.g. . · owllm-desktop" style={INPUT} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={LBL}>Publish command</label>
                    <input value={relCommand} onChange={e => setRelCommand(e.target.value)} placeholder='e.g. bash scripts/publish.sh --notes "$OWLLM_RELEASE_NOTES"' style={INPUT} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={LBL}>Build mode</label>
                    <select value={relMode} onChange={e => setRelMode(e.target.value as "host" | "ci")} style={INPUT}>
                      <option value="host">Host — build + sign + publish on this machine</option>
                      <option value="ci">CI / GitHub Actions — push tag, let workflow build</option>
                    </select>
                    <div style={{ fontSize: 10, color: "var(--fg-muted)", lineHeight: 1.4 }}>
                      Host needs the build toolchain and signing cert on this computer. CI needs a working GitHub Actions workflow and billing.
                    </div>
                  </div>

                  <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-strong)" }}>Code signing (Windows)</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={LBL}>Cert thumbprint (SHA-1)</label>
                    <input value={relSignThumb} onChange={e => setRelSignThumb(e.target.value)} placeholder="empty = unsigned" style={INPUT} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={LBL}>…or cert subject (CN)</label>
                    <input value={relSignSubject} onChange={e => setRelSignSubject(e.target.value)} placeholder="e.g. Your Company Ltd" style={INPUT} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={LBL}>Timestamp URL (RFC3161)</label>
                    <input value={relSignTsa} onChange={e => setRelSignTsa(e.target.value)} placeholder="http://time.certum.pl" style={INPUT} />
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={saveCard} disabled={!!cardBusy} className="ghost-btn" style={{ height: 36, padding: "0 16px", fontWeight: 700 }}>{cardBusy === "save" ? "Saving…" : (cardExists ? "Save card" : "Create card")}</button>
                <button onClick={reviewCard} disabled={!!cardBusy} className="ghost-btn" style={{ height: 36, padding: "0 14px" }} title="Run the Steward's deterministic lint against the card + repo">{cardBusy === "review" ? "Reviewing…" : "🔍 Review"}</button>
              </div>

              <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                Stored as <code>.owllm/project.json</code> and committed with the repo, so every machine and teammate uses the same rules. Leave verify blank to auto-detect from the project.
              </div>
              {cardMsg && <div style={{ fontSize: 12, color: cardMsg.startsWith("✓") ? "#7fd17f" : "#ff8c8c", whiteSpace: "pre-wrap" }}>{cardMsg}</div>}

              {findings && (
                <div style={{ fontSize: 12, color: "var(--fg)", whiteSpace: "pre-wrap", lineHeight: 1.5, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px" }}>
                  {findings.filter(f => f.severity !== "info").length === 0
                    ? "✓ Project Card looks congruent with the repo."
                    : renderCardFindings(findings.filter(f => f.severity !== "info"))}
                </div>
              )}
            </div>
            {/* Team template (canvas) + Bridge */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={LBL}>Team</label>
              {/* Always name the team this project runs — resolved from the
                  roster when no template is explicitly pinned. */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--fg-strong)", padding: "6px 10px", background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8 }}>
                <span>👥</span>
                <b style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {(pickedTeamId ? teams.find(t => t.id === pickedTeamId)?.display : null) ?? resolvedTeamLabel ?? "Custom roster"}
                </b>
                <button type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent("owllm:open-workbench"))}
                  className="ghost-btn" style={{ height: 28, padding: "0 10px", fontSize: 12 }}>⚙ Edit team</button>
                {onResetTeam && resolvedTeamLabel && (
                  <button type="button"
                    title={`Re-derive this team's agents + wiring from the built-in ${resolvedTeamLabel} template (picks up renamed/repurposed agents). Keeps your per-agent model picks.`}
                    onClick={async () => {
                      setActBusy("reset"); setActMsg(null);
                      try { setActMsg(await onResetTeam()); }
                      catch (e: any) { setActMsg(`Reset failed: ${e?.message ?? e}`); }
                      finally { setActBusy(null); }
                    }}
                    disabled={!!actBusy}
                    className="ghost-btn" style={{ height: 28, padding: "0 10px", fontSize: 12 }}>{actBusy === "reset" ? "Resetting…" : "↺ Reset to template"}</button>
                )}
              </div>
              <label style={{ ...LBL, marginTop: 4 }}>Override the canvas team</label>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={pickedTeamId ?? ""} onChange={e => onPickTeam(e.target.value || null)} style={{ ...INPUT, flex: 1 }}>
                  <option value="">(use project roster{resolvedTeamLabel ? ` — ${resolvedTeamLabel}` : ""})</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.display} ({t.agents.length} agents)</option>)}
                </select>
                <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("owllm:navigate", { detail: { key: "bridges" } }))} className="ghost-btn" style={{ height: 38, padding: "0 14px" }}>{bridgeOn ? "📱 Bridge: ON" : "📱 Bridge: OFF"}</button>
              </div>
            </div>
            {/* Danger zone — double approval */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 10, background: "rgba(255,90,90,0.06)", border: "1px solid rgba(255,90,90,0.35)" }}>
              <label style={{ ...LBL, color: "#ff8c8c" }}>Danger zone</label>
              {!confirmDelete ? (
                <button type="button" onClick={() => setConfirmDelete(true)} disabled={!project} style={{ alignSelf: "flex-start", height: 34, padding: "0 14px", borderRadius: 8, border: "1px solid rgba(255,140,140,0.5)", background: "rgba(255,140,140,0.10)", color: "#ff8c8c", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>🗑 Delete project…</button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12.5, color: "var(--fg)", lineHeight: 1.5 }}>
                    Permanently delete <b>{project?.name}</b>?{" "}
                    {isWslPath(project?.location ?? "") && (project?.location ?? "").toLowerCase().includes("/owllm/") && !(project?.location ?? "").toLowerCase().includes("/mnt/")
                      ? "This also removes its sandbox copy inside WSL (frees that disk space). Your original folder, if any, stays put."
                      : "This only removes the project; your folder on disk stays."}{" "}
                    This cannot be undone.
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={() => setConfirmDelete(false)} className="ghost-btn" style={{ height: 34, padding: "0 14px" }}>Cancel</button>
                    <button type="button" onClick={doDelete} disabled={!!actBusy} style={{ height: 34, padding: "0 16px", borderRadius: 8, border: "none", background: "#e0433f", color: "white", fontSize: 13, fontWeight: 800, cursor: actBusy ? "wait" : "pointer" }}>{actBusy === "delete" ? "Deleting…" : "Yes, permanently delete"}</button>
                  </div>
                </div>
              )}
            </div>
            {actMsg && (
              <div style={{ fontSize: 12.5, color: "var(--fg)", whiteSpace: "pre-wrap", lineHeight: 1.5, background: "var(--bg-elevated)", border: "1px solid rgba(var(--accent-rgb),0.4)", borderRadius: 8, padding: "8px 10px" }}>{actMsg}</div>
            )}
          </>
        )}

        {err && (
          <div style={{ color: "#ff8c8c", fontSize: 12, background: "rgba(255,140,140,0.10)", border: "1px solid rgba(255,140,140,0.30)", borderRadius: 8, padding: "8px 10px" }}>{err}</div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={onClose} disabled={busy} className="ghost-btn" style={{ height: 38, padding: "0 14px" }}>{mode === "new" ? "Cancel" : "Done"}</button>
          <div style={{ flex: 1 }} />
          {mode === "new" && step === "form" && (
            <button onClick={onCreate} disabled={busy || !name.trim() || !team}
              style={{ height: 38, padding: "0 22px", border: "none", borderRadius: 9, background: busy || !name.trim() || !team ? "rgba(var(--accent-rgb),0.30)" : "var(--accent)", color: busy || !name.trim() || !team ? "var(--fg-muted)" : "var(--accent-fg)", fontWeight: 700, fontSize: 14, cursor: busy || !name.trim() || !team ? "not-allowed" : "pointer" }}
            >{busy ? "Creating…" : "Create project"}</button>
          )}
        </div>
      </div>
    </div>
  );
}
