import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ModelPicker, { type AccountsStatusLite, type ModelInfo } from "./ModelPicker";
import { LOCAL_TOOL_SPECS } from "./localTools";
import { parseAgentPrompt, serializeAgentPrompt, type AgentPromptSections } from "./agentPrompt";
import PersonalAgentTeamsPanel from "./PersonalAgentTeamsPanel";
import {
  emptyAgentProfile,
  emptyPersonalSkill,
  emptyProjectAgentConfig,
  emptyRuleCard,
  expectedRevisionForSave,
  activePersonalSkills,
  normalizeEffectiveAgentConfig,
  personalSkillForSave,
  personalSkillFromTemplate,
  permissionIntersection,
  profileForSave,
  profileSkillCompatibilityErrors,
  revisionConflictMessage,
  ruleCardForSave,
  validatePersonalSkillDraft,
  visiblePersonalSkills,
  visibleRuleCards,
  type AgentProfileDoc,
  type BackendEffectiveAgentConfig,
  type EffectiveAgentConfig,
  type MemoryScope,
  type PersonalSkillDoc,
  type PersonalSkillStatus,
  type PersonalSkillTemplateId,
  type PersonalSkillValidationResult,
  type ProfileOverride,
  type ProjectAgentConfigDoc,
  type RuleCardDoc,
  type RuleCardKind,
} from "./personalAgentConfig";

type SkillMeta = { id: string; name: string; description: string; ctx: number };
type ImportResult = {
  profiles?: number;
  ruleCards?: number;
  personalSkills?: number;
  skills?: number;
  projectConfigs?: number;
  validationErrors?: string[];
};
type Tab = "profiles" | "skills" | "rules" | "project" | "teams" | "transfer";

const KINDS: RuleCardKind[] = ["fact", "preference", "constraint", "workflow", "conditional"];
const KIND_COLOR: Record<RuleCardKind, string> = {
  fact: "#7fd4ff",
  preference: "#c08aff",
  constraint: "#ff9a73",
  workflow: "#9ee6b0",
  conditional: "#ffd97a",
};
const panel: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--bg-panel)",
  padding: 14,
};
const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-surface)",
  color: "var(--fg)",
  padding: "8px 10px",
  font: "inherit",
  fontSize: 12,
};
const label: React.CSSProperties = {
  display: "block",
  fontSize: 10.5,
  fontWeight: 800,
  letterSpacing: 0.45,
  color: "var(--fg-muted)",
  marginBottom: 5,
  textTransform: "uppercase",
};
const button: React.CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-surface)",
  color: "var(--fg)",
  borderRadius: 8,
  padding: "7px 11px",
  cursor: "pointer",
  fontSize: 11.5,
  fontWeight: 700,
};

function providerForModel(modelId?: string): string | undefined {
  if (!modelId) return undefined;
  if (modelId.startsWith("sub/") || modelId.startsWith("api/")) {
    const bare = modelId.split("/")[1]?.toLowerCase() ?? "";
    if (bare.includes("claude")) return "anthropic";
    if (bare.includes("kimi") || bare.includes("moonshot")) return "moonshot";
    if (bare.includes("gemini")) return "google";
    return "openai";
  }
  return modelId.includes("/") ? modelId.split("/")[0] : "local";
}

function toggle(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter(x => x !== id) : [...values, id];
}

function RefChecklist({
  rows, selected, onChange, empty,
}: {
  rows: { id: string; title: string; detail?: string; revision?: number; disabled?: boolean }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  empty: string;
}) {
  if (!rows.length) return <div style={{ color: "var(--fg-subtle)", fontSize: 11.5 }}>{empty}</div>;
  return (
    <div style={{ display: "grid", gap: 6, maxHeight: 180, overflow: "auto" }}>
      {rows.map(row => (
        <label key={row.id} style={{
          display: "grid", gridTemplateColumns: "18px 1fr auto", gap: 7, alignItems: "start",
          padding: "7px 8px", border: "1px solid var(--border)", borderRadius: 8,
          opacity: row.disabled ? 0.5 : 1, cursor: row.disabled ? "not-allowed" : "pointer",
        }}>
          <input
            type="checkbox"
            disabled={row.disabled}
            checked={selected.includes(row.id)}
            onChange={() => onChange(toggle(selected, row.id))}
          />
          <span>
            <b style={{ fontSize: 11.5 }}>{row.title}</b>
            {row.detail ? <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 10.5 }}>{row.detail}</span> : null}
          </span>
          {row.revision != null ? <span style={{ color: "var(--fg-subtle)", fontSize: 10 }}>r{row.revision}</span> : null}
        </label>
      ))}
    </div>
  );
}

function PromptEditor({
  value, onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const sections = useMemo(() => parseAgentPrompt(value), [value]);
  const patch = (key: keyof AgentPromptSections, next: string) => onChange(serializeAgentPrompt({ ...sections, [key]: next }));
  const rows: { key: keyof AgentPromptSections; title: string; hint: string }[] = [
    { key: "general", title: "General", hint: "Identity, voice, operating posture." },
    { key: "mission", title: "Mission", hint: "The outcomes this agent owns." },
    { key: "rules", title: "Rules", hint: "Stable behavioral constraints. Project facts belong in rule cards." },
    { key: "dod", title: "Definition of Done", hint: "What evidence is required before completion." },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      {rows.map(row => (
        <label key={row.key}>
          <span style={label}>{row.title}</span>
          <textarea
            value={sections[row.key]}
            onChange={e => patch(row.key, e.target.value)}
            placeholder={row.hint}
            rows={4}
            style={{ ...input, resize: "vertical", lineHeight: 1.45 }}
          />
        </label>
      ))}
    </div>
  );
}

export default function PersonalAgentsDialog({
  open, onClose, models, accountsStatus, skills,
}: {
  open: boolean;
  onClose: () => void;
  models: ModelInfo[];
  accountsStatus: AccountsStatusLite | null;
  skills: SkillMeta[];
}) {
  const [tab, setTab] = useState<Tab>("profiles");
  const [profiles, setProfiles] = useState<AgentProfileDoc[]>([]);
  const [cards, setCards] = useState<RuleCardDoc[]>([]);
  const [personalSkills, setPersonalSkills] = useState<PersonalSkillDoc[]>([]);
  const [profileId, setProfileId] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [profileDraft, setProfileDraft] = useState<AgentProfileDoc | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleCardDoc | null>(null);
  const [skillDraft, setSkillDraft] = useState<PersonalSkillDoc | null>(null);
  const [skillValidation, setSkillValidation] = useState<PersonalSkillValidationResult | null>(null);
  const [projectId, setProjectId] = useState("");
  const [projectDraft, setProjectDraft] = useState<ProjectAgentConfigDoc | null>(null);
  const [projectPersisted, setProjectPersisted] = useState(false);
  const [effective, setEffective] = useState<EffectiveAgentConfig | null>(null);
  const [effectiveProfileId, setEffectiveProfileId] = useState("");
  const [includePrivate, setIncludePrivate] = useState(false);
  const [transferPayload, setTransferPayload] = useState("");
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const visibleCards = useMemo(() => visibleRuleCards(cards, projectId), [cards, projectId]);
  const visibleSkills = useMemo(
    () => visiblePersonalSkills(personalSkills, projectId),
    [personalSkills, projectId],
  );
  const activeSkills = useMemo(
    () => activePersonalSkills(personalSkills, projectId),
    [personalSkills, projectId],
  );
  const activeGlobalSkills = useMemo(
    () => personalSkills.filter(skill =>
      skill.status === "active" && skill.scope === "global" && !skill.private),
    [personalSkills],
  );
  const toolNames = useMemo(() => [...new Set(LOCAL_TOOL_SPECS.map(t => t.name))].sort(), []);

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const [nextProfiles, nextCards, nextSkills] = await Promise.all([
        invoke<AgentProfileDoc[]>("personal_agent_list_profiles", {}),
        invoke<RuleCardDoc[]>("personal_agent_list_rule_cards", {
          projectId: projectId || undefined,
          // Private cards are manageable only when the user has explicitly
          // selected their owning project. The backend still enforces scope.
          includePrivate: !!projectId,
        }),
        invoke<PersonalSkillDoc[]>("personal_agent_list_skills", {
          projectId: projectId || undefined,
          includePrivate: !!projectId,
        }),
      ]);
      setProfiles(nextProfiles);
      setCards(nextCards);
      setPersonalSkills(nextSkills);
      if (!profileId && nextProfiles[0]) setProfileId(nextProfiles[0].id);
      if (!ruleId && nextCards[0]) setRuleId(nextCards[0].id);
      if (!skillId && nextSkills[0]) setSkillId(nextSkills[0].id);
    } catch (e) {
      setError(`Couldn't load personal-agent configuration: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !profileId) { setProfileDraft(null); return; }
    // A freshly-created draft is not in the repository yet; do not replace it
    // with a guaranteed get-profile failure before its first save.
    if (!profiles.some(profile => profile.id === profileId)) return;
    let dead = false;
    invoke<AgentProfileDoc>("personal_agent_get_profile", { id: profileId })
      .then(doc => { if (!dead) setProfileDraft({ ...doc, personalSkillRefs: doc.personalSkillRefs ?? [] }); })
      .catch(e => { if (!dead) setError(`Couldn't open profile ${profileId}: ${String(e)}`); });
    return () => { dead = true; };
  }, [open, profileId, profiles]);

  useEffect(() => {
    if (!open || !ruleId) { setRuleDraft(null); return; }
    if (!cards.some(card => card.id === ruleId)) return;
    let dead = false;
    invoke<RuleCardDoc>("personal_agent_get_rule_card", { id: ruleId, projectId: projectId.trim() })
      .then(doc => { if (!dead) setRuleDraft(doc); })
      .catch(e => { if (!dead) setError(`Couldn't open rule ${ruleId}: ${String(e)}`); });
    return () => { dead = true; };
  }, [open, ruleId, cards, projectId]);

  useEffect(() => {
    if (!open || !skillId) { setSkillDraft(null); setSkillValidation(null); return; }
    const listed = personalSkills.find(skill => skill.id === skillId);
    if (!listed) return;
    let dead = false;
    invoke<PersonalSkillDoc>("personal_agent_get_skill", {
      id: skillId,
      revision: listed.revision,
      projectId: projectId.trim(),
    })
      .then(doc => {
        if (dead) return;
        setSkillDraft(doc);
        setSkillValidation(null);
      })
      .catch(e => { if (!dead) setError(`Couldn't open skill ${skillId}: ${String(e)}`); });
    return () => { dead = true; };
  }, [open, skillId, personalSkills, projectId]);

  if (!open) return null;

  const saveProfile = async () => {
    if (!profileDraft) return;
    const doc = profileForSave(profileDraft);
    const compatibilityErrors = profileSkillCompatibilityErrors(doc, personalSkills);
    if (compatibilityErrors.length) {
      setError(compatibilityErrors.join(" "));
      return;
    }
    setBusy(true); setError(""); setStatus("");
    try {
      const saved = await invoke<AgentProfileDoc>("personal_agent_save_profile", {
        doc,
        expectedRevision: expectedRevisionForSave(profiles.some(p => p.id === profileDraft.id), profileDraft.revision),
      });
      setProfileDraft(saved);
      setProfileId(saved.id);
      setProfiles(prev => [...prev.filter(p => p.id !== saved.id), saved].sort((a, b) => a.displayName.localeCompare(b.displayName)));
      setStatus(`Saved ${saved.displayName} at revision ${saved.revision}.`);
    } catch (e) {
      setError(revisionConflictMessage("profile", doc.id, e));
    } finally { setBusy(false); }
  };

  const saveRule = async () => {
    if (!ruleDraft) return;
    setBusy(true); setError(""); setStatus("");
    const doc = ruleCardForSave(ruleDraft);
    try {
      const saved = await invoke<RuleCardDoc>("personal_agent_save_rule_card", {
        doc,
        expectedRevision: expectedRevisionForSave(cards.some(r => r.id === ruleDraft.id), ruleDraft.revision),
      });
      setRuleDraft(saved);
      setRuleId(saved.id);
      setCards(prev => [...prev.filter(r => r.id !== saved.id), saved].sort((a, b) => a.title.localeCompare(b.title)));
      setStatus(`Saved ${saved.title} at revision ${saved.revision}.`);
    } catch (e) {
      setError(revisionConflictMessage("rule", doc.id, e));
    } finally { setBusy(false); }
  };

  const validateSkill = async (doc: PersonalSkillDoc): Promise<PersonalSkillValidationResult> => {
    const localErrors = validatePersonalSkillDraft(doc, toolNames);
    if (localErrors.length) {
      const result = { valid: false, errors: localErrors };
      setSkillValidation(result);
      return result;
    }
    const result = await invoke<PersonalSkillValidationResult>("personal_agent_validate_skill", {
      doc,
      projectId: doc.projectId || projectId.trim() || undefined,
    });
    setSkillValidation(result);
    return result;
  };

  const saveSkill = async () => {
    if (!skillDraft) return;
    setBusy(true); setError(""); setStatus("");
    const doc = personalSkillForSave(skillDraft);
    try {
      if (
        personalSkills.find(skill => skill.id === skillDraft.id)?.status === "quarantined" &&
        doc.status === "active"
      ) {
        throw new Error("Quarantined skills must first be saved as a reviewed draft before activation.");
      }
      const validation = await validateSkill(doc);
      if (!validation.valid || validation.errors.length) {
        setError(`Skill validation failed: ${validation.errors.join(" ")}`);
        return;
      }
      const saved = await invoke<PersonalSkillDoc>("personal_agent_save_skill", {
        doc,
        expectedRevision: expectedRevisionForSave(
          personalSkills.some(skill => skill.id === skillDraft.id),
          skillDraft.revision,
        ),
      });
      setSkillDraft(saved);
      setSkillId(saved.id);
      setPersonalSkills(prev => [
        ...prev.filter(skill => skill.id !== saved.id),
        saved,
      ].sort((a, b) => a.name.localeCompare(b.name)));
      setStatus(`Saved ${saved.name} at revision ${saved.revision} (${saved.status}).`);
    } catch (e) {
      setError(revisionConflictMessage("skill", doc.id, e));
    } finally {
      setBusy(false);
    }
  };

  const loadProject = async () => {
    const id = projectId.trim();
    if (!id) { setError("Enter a project id before loading project configuration."); return; }
    setBusy(true); setError(""); setStatus("");
    try {
      setProjectId(id);
      const doc = await invoke<ProjectAgentConfigDoc | null>("personal_agent_get_project_config", { projectId: id });
      setProjectDraft(doc ?? emptyProjectAgentConfig(id));
      setProjectPersisted(!!doc);
      const nextCards = await invoke<RuleCardDoc[]>("personal_agent_list_rule_cards", {
        projectId: id,
        includePrivate: true,
      });
      setCards(nextCards);
      const nextSkills = await invoke<PersonalSkillDoc[]>("personal_agent_list_skills", {
        projectId: id,
        includePrivate: true,
      });
      setPersonalSkills(nextSkills);
      setStatus(doc ? `Loaded ${id} revision ${doc.revision}.` : `No saved config for ${id}; using safe defaults.`);
    } catch (e) {
      setError(`Couldn't load project ${id}: ${String(e)}`);
    } finally { setBusy(false); }
  };

  const saveProject = async () => {
    if (!projectDraft) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const saved = await invoke<ProjectAgentConfigDoc>("personal_agent_save_project_config", {
        doc: projectDraft,
        expectedRevision: expectedRevisionForSave(projectPersisted, projectDraft.revision),
      });
      setProjectDraft(saved);
      setProjectPersisted(true);
      setStatus(`Saved project ${saved.projectId} at revision ${saved.revision}.`);
    } catch (e) {
      setError(revisionConflictMessage("project", projectDraft.projectId, e));
    } finally { setBusy(false); }
  };

  const resolveEffective = async () => {
    const pid = projectId.trim();
    const aid = effectiveProfileId || profileId;
    if (!pid || !aid) { setError("Choose both a project and profile for Effective Preview."); return; }
    setBusy(true); setError(""); setStatus("");
    try {
      const raw = await invoke<BackendEffectiveAgentConfig>("personal_agent_resolve", {
        projectId: pid,
        profileId: aid,
      });
      const resolved = normalizeEffectiveAgentConfig(raw);
      // Backend is authoritative; UI additionally refuses to render another
      // project's private body even if a buggy response contains one.
      setEffective({
        ...resolved,
        attachedRules: visibleRuleCards(resolved.attachedRules ?? [], pid),
        attachedSkills: visiblePersonalSkills(resolved.attachedSkills ?? [], pid),
      });
    } catch (e) {
      setError(`Couldn't resolve effective configuration: ${String(e)}`);
    } finally { setBusy(false); }
  };

  const doExport = async () => {
    setBusy(true); setError(""); setStatus("");
    try {
      const payload = await invoke<string>("personal_agent_export", {
        projectId: projectId || undefined,
        includePrivate,
      });
      setTransferPayload(payload);
      setStatus(includePrivate
        ? "Export ready with private rule content. Memory and secrets are never exported."
        : "Safe export ready. Private rules, memory, and secrets were excluded.");
    } catch (e) {
      // The backend owns project scoping and private-rule filtering. Never
      // relabel cached UI data as a different project's export.
      setTransferPayload("");
      setError(`Backend export failed; no export was created. ${String(e)}`);
    } finally { setBusy(false); }
  };

  const doImport = async (preview: boolean) => {
    setBusy(true); setError(""); setStatus("");
    try {
      JSON.parse(transferPayload);
      const result = await invoke<ImportResult>("personal_agent_import", {
        payload: transferPayload,
        projectId: projectId || undefined,
        preview,
      });
      setImportPreview(result);
      if (!preview) {
        setStatus("Import saved atomically.");
        await refresh();
      }
    } catch (e) {
      setError(`Import ${preview ? "preview" : "save"} failed: ${String(e)}`);
    } finally { setBusy(false); }
  };

  const nav = (next: Tab, title: string) => (
    <button
      key={next}
      onClick={() => setTab(next)}
      aria-pressed={tab === next}
      style={{
        ...button,
        background: tab === next ? "rgba(127,212,255,0.16)" : "var(--bg-surface)",
        borderColor: tab === next ? "rgba(127,212,255,0.55)" : "var(--border)",
        color: tab === next ? "#7fd4ff" : "var(--fg-muted)",
      }}
    >{title}</button>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Personal agents configuration"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 10050,
        background: "rgba(3,8,16,0.76)", backdropFilter: "blur(5px)",
        display: "grid", placeItems: "center", padding: 18,
      }}
    >
      <div style={{
        width: "min(1240px, 96vw)", height: "min(850px, 94vh)",
        border: "1px solid rgba(127,212,255,0.35)", borderRadius: 16,
        background: "var(--bg)", boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
          borderBottom: "1px solid var(--border)", background: "var(--bg-panel)",
        }}>
          <div>
            <div style={{ fontWeight: 850, fontSize: 15 }}>🧬 Personal agents</div>
            <div style={{ color: "var(--fg-muted)", fontSize: 10.5 }}>
              Versioned profiles + reusable rule cards. Effective permissions always resolve by fail-closed intersection.
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, marginLeft: 16 }}>
            {nav("profiles", "Profiles")}
            {nav("skills", "Skills")}
            {nav("rules", "Rule cards")}
            {nav("project", "Project config + preview")}
            {nav("teams", "Teams + runs")}
            {nav("transfer", "Import / export")}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={() => void refresh()} disabled={busy} style={button}>↻ Refresh</button>
          <button onClick={onClose} aria-label="Close personal agents" style={button}>✕</button>
        </div>

        {(error || status) ? (
          <div role={error ? "alert" : "status"} style={{
            padding: "8px 14px", fontSize: 11.5,
            color: error ? "#ff9a8a" : "#9ee6b0",
            background: error ? "rgba(255,80,70,0.08)" : "rgba(80,220,130,0.07)",
            borderBottom: "1px solid var(--border)",
          }}>{error || status}</div>
        ) : null}

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 14 }}>
          {tab === "profiles" ? (
            <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", gap: 12, minHeight: "100%" }}>
              <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 8 }}>
                <button onClick={() => { const p = emptyAgentProfile(); setProfileDraft(p); setProfileId(p.id); }} style={{ ...button, color: "#9ee6b0" }}>+ New profile</button>
                <div style={{ overflow: "auto", display: "grid", gap: 6 }}>
                  {profiles.map(p => (
                    <button key={p.id} onClick={() => setProfileId(p.id)} style={{
                      ...button, textAlign: "left",
                      borderColor: profileId === p.id ? (p.identity.color || "#7fd4ff") : "var(--border)",
                    }}>
                      <span style={{ fontSize: 15, marginRight: 7 }}>{p.identity.avatar || "🦉"}</span>
                      {p.displayName}
                      <small style={{ display: "block", marginLeft: 23, color: "var(--fg-subtle)" }}>{p.role} · r{p.revision}</small>
                    </button>
                  ))}
                  {!profiles.length && !busy ? <div style={{ color: "var(--fg-subtle)", fontSize: 11.5 }}>No personal profiles yet.</div> : null}
                </div>
              </div>

              {profileDraft ? (
                <div style={{ ...panel, display: "grid", gap: 12 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr .7fr .7fr", gap: 8 }}>
                    <label><span style={label}>Display name</span><input style={input} value={profileDraft.displayName} onChange={e => setProfileDraft({ ...profileDraft, displayName: e.target.value })} /></label>
                    <label><span style={label}>Identity name</span><input style={input} value={profileDraft.identity.name} onChange={e => setProfileDraft({ ...profileDraft, identity: { ...profileDraft.identity, name: e.target.value } })} /></label>
                    <label><span style={label}>Avatar</span><input style={input} value={profileDraft.identity.avatar ?? ""} placeholder="🦉 or owl:…" onChange={e => setProfileDraft({ ...profileDraft, identity: { ...profileDraft.identity, avatar: e.target.value } })} /></label>
                    <label><span style={label}>Card color</span><input type="color" style={{ ...input, height: 35, padding: 3 }} value={profileDraft.identity.color ?? "#7fd4ff"} onChange={e => setProfileDraft({ ...profileDraft, identity: { ...profileDraft.identity, color: e.target.value } })} /></label>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 1fr", gap: 8 }}>
                    <label><span style={label}>Role</span><input style={input} value={profileDraft.role} onChange={e => setProfileDraft({ ...profileDraft, role: e.target.value })} /></label>
                    <label><span style={label}>Model</span><ModelPicker value={profileDraft.model.modelId ?? ""} onChange={modelId => setProfileDraft({ ...profileDraft, model: { modelId, provider: providerForModel(modelId) } })} models={models} status={accountsStatus} fallbackLabel="(Project / team default)" /></label>
                    <label><span style={label}>Memory scope</span>
                      <select style={input} value={profileDraft.memoryScope} onChange={e => setProfileDraft({ ...profileDraft, memoryScope: e.target.value as MemoryScope })}>
                        <option value="none">None</option>
                        <option value="project">Project only</option>
                        <option value="global">Global</option>
                      </select>
                    </label>
                  </div>

                  <div><span style={label}>Structured system instructions</span><PromptEditor value={profileDraft.systemInstructions} onChange={systemInstructions => setProfileDraft({ ...profileDraft, systemInstructions })} /></div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                    <div><span style={label}>Allowed tools ({profileDraft.allowedTools.length})</span>
                      <RefChecklist rows={toolNames.map(id => ({ id, title: id }))} selected={profileDraft.allowedTools} onChange={allowedTools => setProfileDraft({ ...profileDraft, allowedTools })} empty="No tools registered." />
                    </div>
                    <div><span style={label}>Installed skills ({profileDraft.skillIds.length})</span>
                      <RefChecklist rows={skills.map(s => ({ id: s.id, title: s.name, detail: `${s.description || "Installed skill"} · ~${s.ctx} ctx` }))} selected={profileDraft.skillIds} onChange={skillIds => setProfileDraft({ ...profileDraft, skillIds })} empty="No installed skills. Install them from Studio → Skills." />
                    </div>
                    <div><span style={label}>Attached rule cards ({profileDraft.ruleCardRefs.length})</span>
                      <RefChecklist
                        rows={visibleCards.map(r => ({ id: r.id, title: r.title, detail: `${r.kind} · ${r.scope}${r.private ? " · private" : ""}`, revision: r.revision }))}
                        selected={profileDraft.ruleCardRefs.map(r => r.id)}
                        onChange={ids => setProfileDraft({ ...profileDraft, ruleCardRefs: ids.map(id => ({ id, revision: visibleCards.find(r => r.id === id)?.revision ?? 0 })) })}
                        empty="No visible rule cards."
                      />
                    </div>
                  </div>
                  <div>
                    <span style={label}>Attached personal skills ({profileDraft.personalSkillRefs?.length ?? 0})</span>
                    <RefChecklist
                      rows={activeGlobalSkills.map(skill => ({
                        id: skill.id,
                        title: skill.name,
                        detail: `${skill.purpose} · ${skill.requiredTools.length ? `tools: ${skill.requiredTools.join(", ")}` : "tool-free"}`,
                        revision: skill.revision,
                        disabled:
                          !profileDraft.personalSkillRefs?.some(ref => ref.id === skill.id) &&
                          skill.requiredTools.some(tool => !profileDraft.allowedTools.includes(tool)),
                      }))}
                      selected={(profileDraft.personalSkillRefs ?? []).map(ref => ref.id)}
                      onChange={ids => setProfileDraft({
                        ...profileDraft,
                        personalSkillRefs: ids.map(id => ({
                          id,
                          revision: activeGlobalSkills.find(skill => skill.id === id)?.revision ?? 0,
                        })),
                      })}
                      empty="No active global personal skills. Project-scoped skills attach through Project config → Personal-skill override."
                    />
                    <div style={{ color: "var(--fg-subtle)", fontSize: 10 }}>
                      Base profiles accept active global skills only. Project-private skills belong in the current project's override. Tool-requiring skills stay disabled until this profile allows every required tool.
                    </div>
                    {(profileDraft.personalSkillRefs ?? []).some(ref => !activeGlobalSkills.some(skill => skill.id === ref.id && skill.revision === ref.revision)) ? (
                      <div role="alert" style={{ color: "#ffb56a", fontSize: 10.5, marginTop: 5 }}>
                        This profile contains a project-scoped, inactive, or stale personal-skill attachment.
                        {" "}
                        <button
                          type="button"
                          style={{ ...button, padding: "3px 6px", color: "#ffb56a" }}
                          onClick={() => setProfileDraft({
                            ...profileDraft,
                            personalSkillRefs: (profileDraft.personalSkillRefs ?? []).filter(ref =>
                              activeGlobalSkills.some(skill => skill.id === ref.id && skill.revision === ref.revision)),
                          })}
                        >
                          Remove invalid base attachments
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div style={{ ...panel, padding: 10 }}>
                    <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                      <input type="checkbox" checked={profileDraft.delegation.enabled} onChange={e => setProfileDraft({ ...profileDraft, delegation: { ...profileDraft.delegation, enabled: e.target.checked } })} />
                      <b style={{ fontSize: 12 }}>May delegate</b>
                      <span style={{ color: "var(--fg-muted)", fontSize: 10.5 }}>Targets remain an allowlist; project config can only narrow it.</span>
                    </label>
                    {profileDraft.delegation.enabled ? (
                      <div style={{ marginTop: 8 }}>
                        <RefChecklist
                          rows={profiles.filter(p => p.id !== profileDraft.id).map(p => ({ id: p.id, title: p.displayName, detail: p.role, revision: p.revision }))}
                          selected={profileDraft.delegation.allowedProfileIds}
                          onChange={allowedProfileIds => setProfileDraft({ ...profileDraft, delegation: { enabled: true, allowedProfileIds } })}
                          empty="Create another profile before allowing delegation."
                        />
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>Immutable id: {profileDraft.id} · revision {profileDraft.revision}</span>
                    <div style={{ flex: 1 }} />
                    <button onClick={() => void saveProfile()} disabled={busy} style={{ ...button, background: "var(--accent)", color: "var(--accent-fg)", border: 0 }}>Save profile</button>
                  </div>
                </div>
              ) : <div style={panel}>Choose or create a profile.</div>}
            </div>
          ) : null}

          {tab === "skills" ? (
            <div style={{ display: "grid", gridTemplateColumns: "280px minmax(0,1fr)", gap: 12, minHeight: "100%" }}>
              <div style={{ ...panel, display: "grid", alignContent: "start", gap: 7 }}>
                <button onClick={() => {
                  const next = emptyPersonalSkill(new Date().toISOString(), projectId);
                  setSkillDraft(next);
                  setSkillId(next.id);
                  setSkillValidation(null);
                }} style={{ ...button, color: "#9ee6b0" }}>+ New blank skill</button>
                <span style={label}>Starter drafts</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                  {([
                    ["research", "Research"],
                    ["coding", "Coding"],
                    ["planning", "Planning"],
                    ["review", "Review"],
                    ["browser", "Browser / tools"],
                  ] as [PersonalSkillTemplateId, string][]).map(([id, title]) => (
                    <button key={id} onClick={() => {
                      const next = personalSkillFromTemplate(id, projectId);
                      setSkillDraft(next);
                      setSkillId(next.id);
                      setSkillValidation(null);
                    }} style={{ ...button, textAlign: "left", color: id === "browser" ? "#ffb56a" : "var(--fg)" }}>
                      {title}
                    </button>
                  ))}
                </div>
                <div style={{ color: "var(--fg-subtle)", fontSize: 10 }}>
                  Templates are editable drafts. They never auto-activate or attach to an agent.
                </div>
                <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                {visibleSkills.map(skill => (
                  <button key={skill.id} onClick={() => setSkillId(skill.id)} style={{
                    ...button,
                    textAlign: "left",
                    borderColor: skillId === skill.id ? "#7fd4ff" : "var(--border)",
                    opacity: skill.status === "archived" ? 0.6 : 1,
                  }}>
                    <b>{skill.name}</b>
                    <small style={{ display: "block", color: "var(--fg-subtle)" }}>
                      {skill.status} · {skill.scope}{skill.private ? " · private" : ""} · r{skill.revision}
                    </small>
                  </button>
                ))}
                {!visibleSkills.length ? <span style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>No personal skills visible in this project.</span> : null}

                {/* The installed SKILL.md library is a DIFFERENT store from these
                    hand-authored personal skills. Without it this rail reads as
                    "no skills" to a user who has dozens installed. Read-only
                    here: packs are installed in Studio → Skills and equipped
                    per profile on the Profiles tab. */}
                <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                <span style={label}>Installed skill library ({skills.length})</span>
                <div style={{ color: "var(--fg-subtle)", fontSize: 10 }}>
                  {skills.length
                    ? "Downloaded SKILL.md packs. Equip them per profile on the Profiles tab; manage installs in Studio → Skills."
                    : "No skill packs installed yet. Install them from Studio → Skills."}
                </div>
                <div style={{ display: "grid", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                  {skills.map(pack => (
                    <div key={pack.id} title={pack.description || pack.id} style={{
                      padding: "5px 7px", borderRadius: 6, border: "1px solid var(--border)",
                      background: "var(--bg-input)", fontSize: 11,
                    }}>
                      <b style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pack.name}</b>
                      <small style={{ color: "var(--fg-subtle)" }}>~{pack.ctx} ctx</small>
                    </div>
                  ))}
                </div>
              </div>

              {skillDraft ? (
                <div style={{ ...panel, display: "grid", gap: 10, alignContent: "start" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.4fr .75fr", gap: 8 }}>
                    <label><span style={label}>Name</span><input style={input} value={skillDraft.name} onChange={e => setSkillDraft({ ...skillDraft, name: e.target.value })} /></label>
                    <label><span style={label}>Skill id</span><input style={input} disabled={personalSkills.some(skill => skill.id === skillDraft.id)} value={skillDraft.id} onChange={e => setSkillDraft({ ...skillDraft, id: e.target.value as PersonalSkillDoc["id"] })} /></label>
                    <label><span style={label}>Status</span>
                      <select style={input} value={skillDraft.status} onChange={e => {
                        setSkillDraft({ ...skillDraft, status: e.target.value as PersonalSkillStatus });
                        setSkillValidation(null);
                      }}>
                        <option value="draft">Draft</option>
                        <option value="active" disabled={personalSkills.find(skill => skill.id === skillDraft.id)?.status === "quarantined"}>Active</option>
                        <option value="archived">Archived</option>
                        {skillDraft.status === "quarantined" ? <option value="quarantined">Quarantined — review required</option> : null}
                      </select>
                    </label>
                  </div>
                  {skillDraft.status === "quarantined" ? (
                    <div role="alert" style={{ color: "#ffb56a", border: "1px solid rgba(255,181,106,.4)", borderRadius: 8, padding: 8, fontSize: 10.5 }}>
                      Imported skill is quarantined. Review every field, save it as a draft, then activate the reviewed revision in a separate save.
                    </div>
                  ) : null}
                  <label><span style={label}>Purpose</span><input style={input} value={skillDraft.purpose} onChange={e => setSkillDraft({ ...skillDraft, purpose: e.target.value })} /></label>
                  <label><span style={label}>Instructions</span><textarea rows={7} style={{ ...input, resize: "vertical", lineHeight: 1.45 }} value={skillDraft.instructions} onChange={e => setSkillDraft({ ...skillDraft, instructions: e.target.value })} /></label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <label><span style={label}>Input contract</span><textarea rows={4} style={{ ...input, resize: "vertical" }} value={skillDraft.inputContract} onChange={e => setSkillDraft({ ...skillDraft, inputContract: e.target.value })} /></label>
                    <label><span style={label}>Output contract</span><textarea rows={4} style={{ ...input, resize: "vertical" }} value={skillDraft.outputContract} onChange={e => setSkillDraft({ ...skillDraft, outputContract: e.target.value })} /></label>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <span style={label}>Required tools</span>
                      <RefChecklist
                        rows={toolNames.map(id => ({ id, title: id }))}
                        selected={skillDraft.requiredTools}
                        onChange={requiredTools => {
                          setSkillDraft({ ...skillDraft, requiredTools });
                          setSkillValidation(null);
                        }}
                        empty="No registered tools."
                      />
                    </div>
                    <div>
                      <span style={label}>Permission boundary · allowed tools</span>
                      <RefChecklist
                        rows={toolNames.map(id => ({ id, title: id }))}
                        selected={skillDraft.permissionBoundary.allowedTools}
                        onChange={allowedTools => {
                          setSkillDraft({ ...skillDraft, permissionBoundary: { allowedTools } });
                          setSkillValidation(null);
                        }}
                        empty="No registered tools."
                      />
                    </div>
                  </div>
                  {!!skillDraft.requiredTools.length ? (
                    <div style={{ color: "#ffb56a", fontSize: 10.5 }}>
                      Tool-requiring skills can run only when attached to a profile that authorizes every required tool. They cannot attach to persistent teams until that runtime gains a tool loop.
                    </div>
                  ) : null}
                  <div style={{ display: "grid", gridTemplateColumns: ".8fr 1.2fr auto", gap: 8, alignItems: "end" }}>
                    <label><span style={label}>Scope</span>
                      <select style={input} value={skillDraft.scope} onChange={e => {
                        const scope = e.target.value as "global" | "project";
                        setSkillDraft({
                          ...skillDraft,
                          scope,
                          projectId: scope === "project" ? (skillDraft.projectId || projectId) : undefined,
                          private: scope === "project" ? skillDraft.private : false,
                        });
                        setSkillValidation(null);
                      }}>
                        <option value="project">Project</option>
                        <option value="global">Global public</option>
                      </select>
                    </label>
                    {skillDraft.scope === "project" ? <label><span style={label}>Project id</span><input style={input} value={skillDraft.projectId ?? ""} onChange={e => setSkillDraft({ ...skillDraft, projectId: e.target.value })} /></label> : <span />}
                    <label style={{ display: "flex", gap: 6, alignItems: "center", paddingBottom: 8, fontSize: 10.5 }}>
                      <input type="checkbox" disabled={skillDraft.scope !== "project"} checked={skillDraft.private} onChange={e => setSkillDraft({ ...skillDraft, private: e.target.checked })} />
                      Private
                    </label>
                  </div>
                  {skillValidation ? (
                    <div role={skillValidation.valid ? "status" : "alert"} style={{ color: skillValidation.valid ? "#9ee6b0" : "#ff9a8a", fontSize: 10.5 }}>
                      {skillValidation.valid ? "Validation passed. This revision is eligible to save or activate." : skillValidation.errors.map(message => <div key={message}>• {message}</div>)}
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                    <span style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>{skillDraft.id} · revision {skillDraft.revision}</span>
                    <span style={{ flex: 1 }} />
                    <button type="button" onClick={() => void validateSkill(personalSkillForSave(skillDraft)).catch(e => setError(`Skill validation failed: ${String(e)}`))} disabled={busy} style={button}>Validate</button>
                    <button type="button" onClick={() => void saveSkill()} disabled={busy} style={{ ...button, background: "var(--accent)", color: "var(--accent-fg)", border: 0 }}>Validate + save</button>
                  </div>
                </div>
              ) : <div style={panel}>Choose a skill, create a blank draft, or start from a template.</div>}
            </div>
          ) : null}

          {tab === "rules" ? (
            <div style={{ display: "grid", gridTemplateColumns: "280px minmax(0,1fr)", gap: 12, minHeight: "100%" }}>
              <div style={{ ...panel, display: "grid", alignContent: "start", gap: 7 }}>
                <button onClick={() => { const r = emptyRuleCard(new Date().toISOString(), projectId); setRuleDraft(r); setRuleId(r.id); }} style={{ ...button, color: "#9ee6b0" }}>+ New rule card</button>
                {visibleCards.map(r => (
                  <button key={r.id} onClick={() => setRuleId(r.id)} style={{ ...button, textAlign: "left", borderColor: ruleId === r.id ? KIND_COLOR[r.kind] : "var(--border)" }}>
                    <span style={{ color: KIND_COLOR[r.kind], fontSize: 9.5, fontWeight: 900 }}>{r.kind.toUpperCase()}</span>
                    <span style={{ display: "block", marginTop: 2 }}>{r.title}</span>
                    <small style={{ color: "var(--fg-subtle)" }}>{r.scope}{r.private ? " · private" : ""} · r{r.revision}</small>
                  </button>
                ))}
              </div>
              {ruleDraft ? (
                <div style={{ ...panel, display: "grid", gap: 10, alignContent: "start" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr .8fr .8fr", gap: 8 }}>
                    <label><span style={label}>Title</span><input style={input} value={ruleDraft.title} onChange={e => setRuleDraft({ ...ruleDraft, title: e.target.value })} /></label>
                    <label><span style={label}>Kind</span><select style={input} value={ruleDraft.kind} onChange={e => setRuleDraft({ ...ruleDraft, kind: e.target.value as RuleCardKind })}>{KINDS.map(k => <option key={k}>{k}</option>)}</select></label>
                    <label><span style={label}>Scope</span><select style={input} value={ruleDraft.scope} onChange={e => setRuleDraft({
                      ...ruleDraft,
                      scope: e.target.value as "global" | "project",
                      projectId: e.target.value === "project" ? (ruleDraft.projectId || projectId) : undefined,
                      private: e.target.value === "project" ? ruleDraft.private : false,
                    })}><option value="global">Global</option><option value="project">Project</option></select></label>
                  </div>
                  {ruleDraft.scope === "project" ? <label><span style={label}>Project id</span><input style={input} value={ruleDraft.projectId ?? ""} onChange={e => setRuleDraft({ ...ruleDraft, projectId: e.target.value })} /></label> : null}
                  <label><span style={label}>Rule body</span><textarea rows={12} style={{ ...input, resize: "vertical", lineHeight: 1.5 }} value={ruleDraft.body} onChange={e => setRuleDraft({ ...ruleDraft, body: e.target.value })} /></label>
                  {ruleDraft.kind === "conditional" ? (
                    <label><span style={label}>Condition · project ids (comma-separated)</span><input style={input} value={ruleDraft.condition?.projectIds?.join(", ") ?? ""} onChange={e => setRuleDraft({ ...ruleDraft, condition: { projectIds: e.target.value.split(",").map(s => s.trim()).filter(Boolean) } })} /></label>
                  ) : null}
                  <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                    <input type="checkbox" disabled={ruleDraft.scope !== "project"} checked={ruleDraft.private} onChange={e => setRuleDraft({ ...ruleDraft, private: e.target.checked })} />
                    <b style={{ fontSize: 11.5 }}>Private project rule</b>
                    <span style={{ color: "var(--fg-muted)", fontSize: 10.5 }}>Available only inside its project and excluded from export by default.</span>
                  </label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>{ruleDraft.id} · revision {ruleDraft.revision}</span>
                    <div style={{ flex: 1 }} />
                    <button onClick={() => void saveRule()} disabled={busy} style={{ ...button, background: "var(--accent)", color: "var(--accent-fg)", border: 0 }}>Save rule</button>
                  </div>
                </div>
              ) : <div style={panel}>Choose or create a rule card.</div>}
            </div>
          ) : null}

          {tab === "project" ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ ...panel, display: "flex", gap: 8, alignItems: "end" }}>
                <label style={{ flex: 1 }}><span style={label}>Project id</span><input style={input} value={projectId} onChange={e => setProjectId(e.target.value)} placeholder="Stable project id or absolute project key" /></label>
                <button onClick={() => void loadProject()} disabled={busy} style={button}>Load</button>
                <button onClick={() => void saveProject()} disabled={busy || !projectDraft} style={{ ...button, color: "#9ee6b0" }}>Save project config</button>
              </div>

              {projectDraft ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div style={{ ...panel, display: "grid", gap: 10, alignContent: "start" }}>
                    <div><span style={label}>Pinned profiles</span>
                      <RefChecklist
                        rows={profiles.map(p => ({ id: p.id, title: p.displayName, detail: p.role, revision: p.revision }))}
                        selected={projectDraft.profileRefs.map(r => r.id)}
                        onChange={ids => setProjectDraft({ ...projectDraft, profileRefs: ids.map(id => ({ id, revision: profiles.find(p => p.id === id)?.revision ?? 0 })) })}
                        empty="No personal profiles."
                      />
                    </div>
                    <div><span style={label}>Pinned project rules</span>
                      <RefChecklist
                        rows={visibleCards.map(r => ({ id: r.id, title: r.title, detail: `${r.kind}${r.private ? " · private" : ""}`, revision: r.revision }))}
                        selected={projectDraft.ruleCardRefs.map(r => r.id)}
                        onChange={ids => setProjectDraft({ ...projectDraft, ruleCardRefs: ids.map(id => ({ id, revision: visibleCards.find(r => r.id === id)?.revision ?? 0 })) })}
                        empty="No rules visible in this project."
                      />
                    </div>
                    <div style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>Project revision {projectDraft.revision}. References pin immutable ids + revisions; stale writes are rejected.</div>
                  </div>

                  <ProjectOverrideEditor
                    config={projectDraft}
                    profiles={profiles}
                    cards={visibleCards}
                    tools={toolNames}
                    skills={skills}
                    personalSkills={activeSkills}
                    models={models}
                    accountsStatus={accountsStatus}
                    onChange={setProjectDraft}
                  />
                </div>
              ) : null}

              <div style={{ ...panel, display: "grid", gap: 9 }}>
                <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
                  <label style={{ flex: 1 }}><span style={label}>Effective Preview profile</span>
                    <select style={input} value={effectiveProfileId} onChange={e => setEffectiveProfileId(e.target.value)}>
                      <option value="">Choose a profile…</option>
                      {profiles.map(p => <option key={p.id} value={p.id}>{p.displayName} · r{p.revision}</option>)}
                    </select>
                  </label>
                  <button onClick={() => void resolveEffective()} disabled={busy} style={{ ...button, color: "#7fd4ff" }}>Resolve effective config</button>
                </div>
                {effective ? <EffectivePreview effective={effective} project={projectDraft} /> : <div style={{ color: "var(--fg-subtle)", fontSize: 11.5 }}>Resolve to see deterministic precedence, provenance, validation, attached rules, and the final fail-closed permission set.</div>}
              </div>
            </div>
          ) : null}

          {tab === "teams" ? (
            <PersonalAgentTeamsPanel
              profiles={profiles}
              personalSkills={visibleSkills}
              projectId={projectId}
              onProjectIdChange={setProjectId}
            />
          ) : null}

          {tab === "transfer" ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ ...panel, display: "grid", gap: 10, alignContent: "start" }}>
                <h3 style={{ margin: 0, fontSize: 13 }}>Export</h3>
                <label style={{ display: "flex", gap: 8, alignItems: "start", cursor: "pointer" }}>
                  <input type="checkbox" checked={includePrivate} onChange={e => setIncludePrivate(e.target.checked)} />
                  <span>
                    <b style={{ fontSize: 11.5, color: includePrivate ? "#ffb56a" : "var(--fg)" }}>Include private rule content</b>
                    <span style={{ display: "block", fontSize: 10.5, color: "var(--fg-muted)" }}>
                      Off by default. Private rule and personal-skill bodies, memory, and secrets are excluded. Only enable for a destination you trust.
                    </span>
                  </span>
                </label>
                {includePrivate ? <div role="alert" style={{ color: "#ffb56a", fontSize: 11, border: "1px solid rgba(255,181,106,.4)", borderRadius: 8, padding: 8 }}>Warning: this export can contain private project instructions. Review it before sharing.</div> : null}
                <button onClick={() => void doExport()} disabled={busy} style={{ ...button, color: "#9ee6b0" }}>Create {includePrivate ? "private" : "safe"} export</button>
              </div>
              <div style={{ ...panel, display: "grid", gap: 10, alignContent: "start" }}>
                <h3 style={{ margin: 0, fontSize: 13 }}>Import</h3>
                <p style={{ color: "var(--fg-muted)", fontSize: 11.5, margin: 0 }}>Preview validates schema, revisions, cycles, dangling references, and project scope before any atomic write.</p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => void doImport(true)} disabled={busy || !transferPayload.trim()} style={button}>Preview import</button>
                  <button onClick={() => void doImport(false)} disabled={busy || !transferPayload.trim() || !!importPreview?.validationErrors?.length} style={{ ...button, color: "#9ee6b0" }}>Save import</button>
                </div>
                {importPreview ? (
                  <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                    <b>Preview:</b> {importPreview.profiles ?? 0} profiles · {importPreview.ruleCards ?? 0} rules · {importPreview.personalSkills ?? importPreview.skills ?? 0} skills · {importPreview.projectConfigs ?? 0} projects
                    {importPreview.validationErrors?.map((e, i) => <div key={i} style={{ color: "#ff9a8a" }}>• {e}</div>)}
                  </div>
                ) : null}
              </div>
              <textarea
                aria-label="Personal agent import or export JSON"
                value={transferPayload}
                onChange={e => { setTransferPayload(e.target.value); setImportPreview(null); }}
                placeholder="Export appears here, or paste a versioned JSON document to preview an import."
                spellCheck={false}
                rows={24}
                style={{ ...input, gridColumn: "1 / -1", resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 10.5 }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ProjectOverrideEditor({
  config, profiles, cards, tools, skills, personalSkills, models, accountsStatus, onChange,
}: {
  config: ProjectAgentConfigDoc;
  profiles: AgentProfileDoc[];
  cards: RuleCardDoc[];
  tools: string[];
  skills: SkillMeta[];
  personalSkills: PersonalSkillDoc[];
  models: ModelInfo[];
  accountsStatus: AccountsStatusLite | null;
  onChange: (config: ProjectAgentConfigDoc) => void;
}) {
  const [profileId, setProfileId] = useState(config.profileRefs[0]?.id ?? "");
  useEffect(() => {
    if (profileId && config.profileRefs.some(r => r.id === profileId)) return;
    setProfileId(config.profileRefs[0]?.id ?? "");
  }, [config.profileRefs, profileId]);
  const base = profiles.find(p => p.id === profileId);
  const override: ProfileOverride = config.profileOverrides[profileId] ?? {};
  const patch = (next: ProfileOverride) => onChange({
    ...config,
    profileOverrides: { ...config.profileOverrides, [profileId]: next },
  });
  if (!config.profileRefs.length) return <div style={panel}>Attach a profile to configure its project-local overrides.</div>;
  return (
    <div style={{ ...panel, display: "grid", gap: 9, alignContent: "start" }}>
      <label><span style={label}>Override profile</span>
        <select style={input} value={profileId} onChange={e => setProfileId(e.target.value)}>
          {config.profileRefs.map(ref => <option key={ref.id} value={ref.id}>{profiles.find(p => p.id === ref.id)?.displayName ?? ref.id} · pinned r{ref.revision}</option>)}
        </select>
      </label>
      {base ? (
        <>
          <label><span style={label}>System-instruction override</span><textarea rows={4} style={{ ...input, resize: "vertical" }} value={override.systemInstructions ?? ""} placeholder="Blank inherits the profile." onChange={e => patch({ ...override, systemInstructions: e.target.value || undefined })} /></label>
          <label><span style={label}>Model override</span><ModelPicker value={override.model?.modelId ?? ""} onChange={modelId => patch({ ...override, model: modelId ? { modelId, provider: providerForModel(modelId) } : undefined })} models={models} status={accountsStatus} fallbackLabel="(Inherit profile model)" /></label>
          <label><span style={label}>Memory override</span>
            <select style={input} value={override.memoryScope ?? ""} onChange={e => patch({ ...override, memoryScope: (e.target.value || undefined) as MemoryScope | undefined })}>
              <option value="">Inherit ({base.memoryScope})</option>
              <option value="none">None</option><option value="project">Project only</option><option value="global">Global</option>
            </select>
          </label>
          <div><span style={label}>Tool override (narrows profile; never adds)</span>
            <RefChecklist rows={tools.map(id => ({ id, title: id, disabled: !base.allowedTools.includes(id) }))} selected={override.allowedTools ?? base.allowedTools} onChange={allowedTools => patch({ ...override, allowedTools })} empty="No profile tools to narrow." />
          </div>
          <div><span style={label}>Skill override</span>
            <RefChecklist rows={skills.map(s => ({ id: s.id, title: s.name, detail: s.description }))} selected={override.skillIds ?? base.skillIds} onChange={skillIds => patch({ ...override, skillIds })} empty="No skills installed." />
          </div>
          <div><span style={label}>Personal-skill override</span>
            <RefChecklist
              rows={personalSkills.map(skill => ({
                id: skill.id,
                title: skill.name,
                detail: `${skill.purpose} · ${skill.requiredTools.length ? `tools: ${skill.requiredTools.join(", ")}` : "tool-free"}`,
                revision: skill.revision,
                disabled:
                  !(override.personalSkillRefs ?? base.personalSkillRefs ?? []).some(ref => ref.id === skill.id) &&
                  skill.requiredTools.some(tool => !(override.allowedTools ?? base.allowedTools).includes(tool)),
              }))}
              selected={(override.personalSkillRefs ?? base.personalSkillRefs ?? []).map(ref => ref.id)}
              onChange={ids => patch({
                ...override,
                personalSkillRefs: ids.map(id => ({
                  id,
                  revision: personalSkills.find(skill => skill.id === id)?.revision ?? 0,
                })),
              })}
              empty="No active personal skills visible in this project."
            />
          </div>
          <div><span style={label}>Rule override</span>
            <RefChecklist rows={cards.map(r => ({ id: r.id, title: r.title, detail: `${r.kind}${r.private ? " · private" : ""}`, revision: r.revision }))} selected={(override.ruleCardRefs ?? base.ruleCardRefs).map(r => r.id)} onChange={ids => patch({ ...override, ruleCardRefs: ids.map(id => ({ id, revision: cards.find(r => r.id === id)?.revision ?? 0 })) })} empty="No rules visible in this project." />
          </div>
        </>
      ) : null}
    </div>
  );
}

function EffectivePreview({
  effective, project,
}: {
  effective: EffectiveAgentConfig;
  project: ProjectAgentConfigDoc | null;
}) {
  const override = project?.profileOverrides[effective.id];
  const permission = permissionIntersection(effective.allowedTools, override?.allowedTools);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      <div style={{ display: "grid", gap: 7 }}>
        <div style={{ fontSize: 12 }}><b>{effective.displayName}</b> · {effective.role} · revision {effective.revision}</div>
        <div style={{ padding: 9, border: "1px solid rgba(158,230,176,.35)", background: "rgba(158,230,176,.06)", borderRadius: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 900, color: "#9ee6b0" }}>FAIL-CLOSED PERMISSIONS</div>
          <div style={{ fontSize: 11, marginTop: 3 }}>{permission.explanation}</div>
          <div style={{ color: "var(--fg-muted)", fontSize: 10.5, marginTop: 4 }}>{permission.tools.join(", ") || "No tools permitted"}</div>
        </div>
        {!!effective.validationErrors?.length && (
          <div role="alert" style={{ color: "#ff9a8a", fontSize: 11 }}>
            <b>Validation errors</b>
            {effective.validationErrors.map((e, i) => <div key={i}>• {e}</div>)}
          </div>
        )}
      </div>
      <div>
        <span style={label}>Provenance + precedence</span>
        <div style={{ maxHeight: 150, overflow: "auto", fontSize: 10.5, fontFamily: "ui-monospace, monospace" }}>
          {Object.entries(effective.provenance ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([field, source]) => (
            <div key={field} style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 8, borderBottom: "1px solid var(--border)", padding: "4px 0" }}>
              <span>{field}</span>
              <span style={{ color: "#7fd4ff" }}>{source.source} · {source.documentId}@r{source.revision}</span>
            </div>
          ))}
        </div>
        <span style={{ ...label, marginTop: 9 }}>Attached visible rules</span>
        {(effective.attachedRules ?? []).map(rule => (
          <div key={`${rule.id}@${rule.revision}`} style={{ borderLeft: `3px solid ${KIND_COLOR[rule.kind]}`, padding: "4px 7px", marginBottom: 5 }}>
            <b style={{ fontSize: 10.5 }}>{rule.title}</b>
            <span style={{ color: "var(--fg-muted)", fontSize: 10, marginLeft: 6 }}>{rule.provenance ?? `${rule.scope} · r${rule.revision}`}</span>
            <div style={{ whiteSpace: "pre-wrap", fontSize: 10.5, marginTop: 2 }}>{rule.body}</div>
          </div>
        ))}
        <span style={{ ...label, marginTop: 9 }}>Attached personal skills</span>
        {(effective.attachedSkills ?? []).map(skill => (
          <div key={`${skill.id}@${skill.revision}`} style={{ borderLeft: "3px solid #c08aff", padding: "4px 7px", marginBottom: 5 }}>
            <b style={{ fontSize: 10.5 }}>{skill.name}</b>
            <span style={{ color: "var(--fg-muted)", fontSize: 10, marginLeft: 6 }}>
              {skill.scope}{skill.private ? " · private" : ""} · r{skill.revision}
            </span>
            <div style={{ whiteSpace: "pre-wrap", fontSize: 10.5, marginTop: 2 }}>{skill.purpose}</div>
            <div style={{ color: "var(--fg-subtle)", fontSize: 10 }}>
              {skill.requiredTools.length ? `Requires: ${skill.requiredTools.join(", ")}` : "Tool-free"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
