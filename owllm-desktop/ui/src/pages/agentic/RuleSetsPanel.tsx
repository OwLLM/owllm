// RuleSetsPanel — project-scoped rule-set profiles for personal agents.
//
// Three things live here and nowhere else:
//   • the template gallery (software development / scientific research /
//     social media) and the editor that customises and versions a set;
//   • the two assignment layers — project-wide, and per agent;
//   • the preview, which is resolved by the BACKEND (personal_agent_preview_rule_sets)
//     so what the user reads is produced by the same code the agent runs on.
//
// Everything persistent goes through the personal-agent repository: sets live in
// the project's own encrypted scope, assignments live on that project's config
// doc. That is what makes the selection survive navigation and restart, and what
// keeps a project's rules and private bodies out of every other project.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  RULE_SET_TEMPLATE_LIST,
  RULE_SET_TOPICS,
  assignableRuleSets,
  describeRuleSetStack,
  emptyRuleSet,
  emptyRuleSetRule,
  forkRuleSet,
  ruleSetForSave,
  ruleSetFromTemplate,
  validateRuleSetDraft,
  type RuleKind,
  type RuleSetDoc,
  type RuleSetResolution,
  type RuleSetRule,
  type RuleSetTemplateId,
  type RuleSetTopic,
} from "./agentRuleSets";
import {
  emptyProjectAgentConfig,
  expectedRevisionForSave,
  revisionConflictMessage,
  type AgentProfileDoc,
  type ProjectAgentConfigDoc,
} from "./personalAgentConfig";

const panel: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--bg-panel)",
  padding: 12,
};
const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-surface)",
  color: "var(--fg)",
  padding: "7px 9px",
  font: "inherit",
  fontSize: 11.5,
};
const label: React.CSSProperties = {
  display: "block",
  color: "var(--fg-muted)",
  fontSize: 9.5,
  fontWeight: 850,
  letterSpacing: 0.45,
  marginBottom: 4,
  textTransform: "uppercase",
};
const button: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-surface)",
  color: "var(--fg)",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 750,
  padding: "6px 9px",
};

const KINDS: RuleKind[] = ["fact", "preference", "constraint", "workflow", "conditional"];
const STATUS_COLOR: Record<string, string> = {
  draft: "#ffd97a",
  active: "#9ee6b0",
  archived: "var(--fg-subtle)",
};

function RuleEditor({ rule, onChange, onRemove }: {
  rule: RuleSetRule;
  onChange: (rule: RuleSetRule) => void;
  onRemove: () => void;
}) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 9, padding: 9, display: "grid", gap: 7 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr .8fr .9fr .9fr auto", gap: 7, alignItems: "end" }}>
        <label><span style={label}>Title</span>
          <input style={input} value={rule.title} onChange={e => onChange({ ...rule, title: e.target.value })} />
        </label>
        <label><span style={label}>Kind</span>
          <select style={input} value={rule.kind} onChange={e => onChange({ ...rule, kind: e.target.value as RuleKind })}>
            {KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </label>
        <label title="The axis this rule decides. Two rules that name the same topic collide; the higher-precedence set wins.">
          <span style={label}>Conflict topic</span>
          <select
            style={input}
            value={rule.topic}
            onChange={e => onChange({ ...rule, topic: e.target.value as RuleSetTopic | "" })}
          >
            <option value="">— none (always applies) —</option>
            {RULE_SET_TOPICS.map(topic => <option key={topic} value={topic}>{topic}</option>)}
          </select>
        </label>
        <label title="The position this rule takes on its topic. Same topic + same stance dedupes; a different stance is a real conflict.">
          <span style={label}>Stance</span>
          <input
            style={input}
            value={rule.stance}
            disabled={!rule.topic}
            placeholder={rule.topic ? "e.g. cite-primary-sources" : "topic first"}
            onChange={e => onChange({ ...rule, stance: e.target.value })}
          />
        </label>
        <button onClick={onRemove} title="Remove this rule" style={{ ...button, color: "#ff9a8a" }}>🗑</button>
      </div>
      <label><span style={label}>Rule</span>
        <textarea
          rows={3}
          style={{ ...input, resize: "vertical", lineHeight: 1.45 }}
          value={rule.body}
          onChange={e => onChange({ ...rule, body: e.target.value })}
        />
      </label>
    </div>
  );
}

export default function RuleSetsPanel({ projectId, onProjectIdChange, profiles }: {
  projectId: string;
  onProjectIdChange: (projectId: string) => void;
  profiles: AgentProfileDoc[];
}) {
  const [sets, setSets] = useState<RuleSetDoc[]>([]);
  /// Which sets the BACKEND has. A freshly created draft sits in `sets` so it is
  /// selectable, but it must still save as revision 1 with no expectedRevision —
  /// deriving "persisted" from `sets` would send a compare-and-swap the backend
  /// is right to reject.
  const [persistedIds, setPersistedIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<RuleSetDoc | null>(null);
  const [config, setConfig] = useState<ProjectAgentConfigDoc | null>(null);
  const [configPersisted, setConfigPersisted] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [preview, setPreview] = useState<RuleSetResolution | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const pid = projectId.trim();
  const assignable = useMemo(() => assignableRuleSets(sets, pid), [sets, pid]);
  const draftErrors = useMemo(() => (draft ? validateRuleSetDraft(draft) : []), [draft]);
  const persisted = useMemo(
    () => !!draft && persistedIds.includes(draft.id),
    [persistedIds, draft],
  );

  // Every read is scoped to one project id. There is no "all projects" call, so
  // a set from another project can never reach this panel's state.
  const load = useCallback(async () => {
    if (!pid) { setSets([]); setConfig(null); setPreview(null); return; }
    setBusy(true); setError("");
    try {
      const [nextSets, nextConfig] = await Promise.all([
        invoke<RuleSetDoc[]>("personal_agent_list_rule_sets", { projectId: pid }),
        invoke<ProjectAgentConfigDoc | null>("personal_agent_get_project_config", { projectId: pid }),
      ]);
      setSets(nextSets);
      setPersistedIds(nextSets.map(set => set.id));
      setConfig(nextConfig ?? emptyProjectAgentConfig(pid));
      setConfigPersisted(!!nextConfig);
      setSelectedId(current => (nextSets.some(set => set.id === current) ? current : nextSets[0]?.id ?? ""));
    } catch (e) {
      setError(`Couldn't load rule sets for ${pid}: ${String(e)}`);
    } finally { setBusy(false); }
  }, [pid]);

  useEffect(() => { void load(); }, [load]);

  // Reopening the dialog, or coming back from another tab, re-derives the draft
  // from the stored set rather than from component state, so an edit is never
  // silently resurrected after a failed save.
  useEffect(() => {
    const found = sets.find(set => set.id === selectedId);
    setDraft(found ? { ...found, rules: found.rules.map(rule => ({ ...rule })) } : null);
  }, [selectedId, sets]);

  const projectRefIds = useMemo(
    () => new Set((config?.ruleSetRefs ?? []).map(ref => ref.id)),
    [config],
  );
  const agentRefIds = useMemo(
    () => new Set((config?.profileOverrides?.[agentId]?.ruleSetRefs ?? []).map(ref => ref.id)),
    [config, agentId],
  );

  const saveDraft = async () => {
    if (!draft) return;
    const doc = ruleSetForSave(draft);
    const errors = validateRuleSetDraft(doc);
    if (errors.length) { setError(errors.join(" ")); return; }
    setBusy(true); setError(""); setStatus("");
    try {
      const saved = await invoke<RuleSetDoc>("personal_agent_save_rule_set", {
        doc,
        expectedRevision: expectedRevisionForSave(persisted, draft.revision),
      });
      setSets(prev => [...prev.filter(set => set.id !== saved.id), saved]
        .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name)));
      setPersistedIds(prev => (prev.includes(saved.id) ? prev : [...prev, saved.id]));
      setSelectedId(saved.id);
      setStatus(`Saved ${saved.name} at revision ${saved.revision} (${saved.status}).`);
    } catch (e) {
      setError(revisionConflictMessage("rule", String(doc.id), e));
    } finally { setBusy(false); }
  };

  // Assignment writes go straight to the project config, so the choice is
  // durable the moment it is made — not on some later "save" the user may skip.
  const assign = async (layer: "project" | "agent", setId: string, on: boolean) => {
    if (!config) return;
    const set = assignable.find(candidate => candidate.id === setId);
    if (!set && on) { setError("That rule set is no longer active in this project."); return; }
    const ref = { id: setId, revision: set?.revision ?? 0 };
    const next: ProjectAgentConfigDoc = layer === "project"
      ? {
          ...config,
          ruleSetRefs: on
            ? [...config.ruleSetRefs.filter(r => r.id !== setId), ref]
            : config.ruleSetRefs.filter(r => r.id !== setId),
        }
      : (() => {
          const override = config.profileOverrides[agentId] ?? {};
          const current = override.ruleSetRefs ?? [];
          return {
            ...config,
            profileOverrides: {
              ...config.profileOverrides,
              [agentId]: {
                ...override,
                ruleSetRefs: on
                  ? [...current.filter(r => r.id !== setId), ref]
                  : current.filter(r => r.id !== setId),
              },
            },
          };
        })();
    setBusy(true); setError(""); setStatus("");
    try {
      const saved = await invoke<ProjectAgentConfigDoc>("personal_agent_save_project_config", {
        doc: next,
        expectedRevision: expectedRevisionForSave(configPersisted, config.revision),
      });
      setConfig(saved);
      setConfigPersisted(true);
      setStatus(`${on ? "Assigned" : "Unassigned"} at the ${layer} layer; project config is now revision ${saved.revision}.`);
    } catch (e) {
      setError(revisionConflictMessage("project", next.projectId, e));
    } finally { setBusy(false); }
  };

  // Resolved by the backend so the preview cannot drift from the runtime.
  const runPreview = async () => {
    if (!pid) { setError("Enter a project id first."); return; }
    const byId = new Map<string, RuleSetDoc>(sets.map(set => [set.id, set]));
    const pick = (refs: { id: string }[] | undefined) =>
      (refs ?? []).flatMap(ref => {
        const found = byId.get(ref.id);
        return found ? [found] : [];
      });
    // The open draft previews as it currently reads, saved or not.
    const withDraft = (list: RuleSetDoc[]) =>
      draft ? list.map(set => (set.id === draft.id ? ruleSetForSave(draft) : set)) : list;
    setBusy(true); setError(""); setStatus("");
    try {
      const resolution = await invoke<RuleSetResolution>("personal_agent_preview_rule_sets", {
        projectId: pid,
        agentRuleSets: withDraft(pick(config?.profileOverrides?.[agentId]?.ruleSetRefs)),
        projectRuleSets: withDraft(pick(config?.ruleSetRefs)),
      });
      setPreview(resolution);
    } catch (e) {
      setError(`Preview failed: ${String(e)}`);
    } finally { setBusy(false); }
  };

  return (
    <div data-ui="ruleSetsPanel" style={{ display: "grid", gap: 12 }}>
      <div style={{ ...panel, display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
        <label style={{ flex: "1 1 260px" }}><span style={label}>Project id</span>
          <input
            style={input}
            value={projectId}
            onChange={e => onProjectIdChange(e.target.value)}
            placeholder="Rule sets are project-scoped — pick the project first"
          />
        </label>
        <label style={{ flex: "1 1 220px" }}><span style={label}>Agent (for the per-agent layer)</span>
          <select style={input} value={agentId} onChange={e => setAgentId(e.target.value)}>
            <option value="">— project layer only —</option>
            {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
          </select>
        </label>
        <button onClick={() => void load()} disabled={busy || !pid} style={button}>↻ Reload</button>
      </div>

      {(error || status) ? (
        <div role={error ? "alert" : "status"} style={{
          padding: "7px 11px", fontSize: 11.5, borderRadius: 8,
          color: error ? "#ff9a8a" : "#9ee6b0",
          background: error ? "rgba(255,80,70,0.08)" : "rgba(80,220,130,0.07)",
        }}>{error || status}</div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "300px minmax(0,1fr)", gap: 12 }}>
        <div style={{ ...panel, display: "grid", gap: 9, alignContent: "start" }}>
          <span style={label}>Start from a template</span>
          {RULE_SET_TEMPLATE_LIST.map(template => (
            <button
              key={template.id}
              disabled={!pid || busy}
              onClick={() => {
                const created = ruleSetFromTemplate(template.id as RuleSetTemplateId, pid);
                setSets(prev => [...prev, created]);
                setSelectedId(created.id);
                setStatus(`${template.label} draft created — review it, then save and activate.`);
              }}
              style={{ ...button, textAlign: "left", display: "grid", gap: 2 }}
            >
              <span style={{ fontSize: 12 }}>{template.icon} {template.label}</span>
              <span style={{ color: "var(--fg-muted)", fontSize: 10, fontWeight: 500 }}>{template.hint}</span>
            </button>
          ))}
          <button
            disabled={!pid || busy}
            onClick={() => {
              const created = emptyRuleSet(pid);
              setSets(prev => [...prev, created]);
              setSelectedId(created.id);
            }}
            style={{ ...button, color: "#9ee6b0" }}
          >+ Empty rule set</button>

          <span style={{ ...label, marginTop: 6 }}>This project's rule sets</span>
          {sets.length === 0 ? (
            <div style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
              {pid ? "None yet — start from a template above." : "Enter a project id to see its rule sets."}
            </div>
          ) : sets.map(set => (
            <button
              key={set.id}
              onClick={() => setSelectedId(set.id)}
              style={{
                ...button, textAlign: "left", display: "grid", gap: 2,
                borderColor: selectedId === set.id ? "#7fd4ff" : "var(--border)",
              }}
            >
              <span style={{ fontSize: 11.5 }}>{set.name}</span>
              <span style={{ color: STATUS_COLOR[set.status] ?? "var(--fg-muted)", fontSize: 10, fontWeight: 500 }}>
                {set.status} · r{set.revision} · priority {set.priority}
                {projectRefIds.has(set.id) ? " · project" : ""}
                {agentId && agentRefIds.has(set.id) ? " · agent" : ""}
              </span>
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          {draft ? (
            <div style={{ ...panel, display: "grid", gap: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.4fr .7fr .7fr", gap: 8 }}>
                <label><span style={label}>Name</span>
                  <input style={input} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
                </label>
                <label title="Lower wins inside a layer.">
                  <span style={label}>Priority</span>
                  <input
                    type="number"
                    style={input}
                    value={draft.priority}
                    onChange={e => setDraft({ ...draft, priority: Number(e.target.value) })}
                  />
                </label>
                <label><span style={label}>Status</span>
                  <select
                    style={input}
                    value={draft.status}
                    onChange={e => setDraft({ ...draft, status: e.target.value as RuleSetDoc["status"] })}
                  >
                    <option value="draft">draft</option>
                    <option value="active">active</option>
                    <option value="archived">archived</option>
                  </select>
                </label>
              </div>
              <label><span style={label}>Summary</span>
                <textarea
                  rows={2}
                  style={{ ...input, resize: "vertical", lineHeight: 1.45 }}
                  value={draft.summary}
                  onChange={e => setDraft({ ...draft, summary: e.target.value })}
                />
              </label>

              <div style={{ display: "grid", gap: 8 }}>
                <span style={label}>Rules ({draft.rules.length})</span>
                {draft.rules.map((rule, index) => (
                  <RuleEditor
                    key={rule.id}
                    rule={rule}
                    onChange={next => setDraft({
                      ...draft,
                      rules: draft.rules.map((existing, i) => (i === index ? next : existing)),
                    })}
                    onRemove={() => setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}
                  />
                ))}
                <button
                  onClick={() => setDraft({ ...draft, rules: [...draft.rules, emptyRuleSetRule()] })}
                  style={{ ...button, color: "#9ee6b0" }}
                >+ Add rule</button>
              </div>

              {draftErrors.length ? (
                <div role="alert" style={{ color: "#ff9a8a", fontSize: 11, display: "grid", gap: 2 }}>
                  {draftErrors.map(message => <span key={message}>• {message}</span>)}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>
                  {draft.id} · revision {draft.revision} · {draft.templateId}
                </span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => {
                    const copy = forkRuleSet(draft, pid);
                    setSets(prev => [...prev, copy]);
                    setSelectedId(copy.id);
                    setStatus("Forked — the copy keeps the original's rule ids, so assigning both dedupes instead of double-counting.");
                  }}
                  disabled={busy}
                  style={button}
                >⑂ Fork as new set</button>
                <button
                  onClick={() => void saveDraft()}
                  disabled={busy || draftErrors.length > 0}
                  style={{ ...button, color: "#9ee6b0" }}
                >Save {persisted ? `as revision ${draft.revision + 1}` : "new rule set"}</button>
              </div>
            </div>
          ) : (
            <div style={{ ...panel, color: "var(--fg-subtle)", fontSize: 11.5 }}>
              Choose a rule set, or start one from a template.
            </div>
          )}

          <div style={{ ...panel, display: "grid", gap: 10 }}>
            <span style={label}>Assign — project layer applies to every agent; the agent layer overrides it</span>
            {assignable.length === 0 ? (
              <div style={{ color: "var(--fg-subtle)", fontSize: 11 }}>
                No active rule set in this project yet. Activate one above to assign it.
              </div>
            ) : assignable.map(set => (
              <div key={set.id} style={{
                display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: 10,
                alignItems: "center", border: "1px solid var(--border)", borderRadius: 9, padding: "7px 9px",
              }}>
                <span>
                  <b style={{ fontSize: 11.5 }}>{set.name}</b>
                  <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 10.5 }}>
                    {set.summary || set.templateId} · r{set.revision} · priority {set.priority}
                  </span>
                </span>
                <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 10.5, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    disabled={busy || !config}
                    checked={projectRefIds.has(set.id)}
                    onChange={e => void assign("project", set.id, e.target.checked)}
                  />
                  Project
                </label>
                <label
                  title={agentId ? "" : "Choose an agent above to use the per-agent layer"}
                  style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 10.5, cursor: agentId ? "pointer" : "not-allowed", opacity: agentId ? 1 : 0.5 }}
                >
                  <input
                    type="checkbox"
                    disabled={busy || !config || !agentId}
                    checked={agentRefIds.has(set.id)}
                    onChange={e => void assign("agent", set.id, e.target.checked)}
                  />
                  This agent
                </label>
              </div>
            ))}
            {config ? (
              <div style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>
                Saved on project config revision {config.revision}. Assignments pin an id and a revision, so editing a
                set later does not silently change what an agent already runs on.
              </div>
            ) : null}
          </div>

          <div style={{ ...panel, display: "grid", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ ...label, marginBottom: 0 }}>Preview the resolved stack</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => void runPreview()} disabled={busy || !pid} style={{ ...button, color: "#7fd4ff" }}>
                Resolve preview
              </button>
            </div>
            {preview ? (
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ fontSize: 11.5 }}>{describeRuleSetStack(preview)}</div>
                {preview.errors.length ? (
                  <div role="alert" style={{ color: "#ff9a8a", fontSize: 11, display: "grid", gap: 2 }}>
                    {preview.errors.map(message => <span key={message}>• {message}</span>)}
                  </div>
                ) : null}
                <div style={{ display: "grid", gap: 5 }}>
                  {preview.applied.map(entry => (
                    <div key={`${entry.setId}:${entry.rule.id}`} style={{ borderLeft: "3px solid #9ee6b0", padding: "3px 8px" }}>
                      <b style={{ fontSize: 10.5 }}>{entry.rule.title}</b>
                      <span style={{ color: "var(--fg-muted)", fontSize: 10, marginLeft: 6 }}>
                        {entry.setName} · {entry.layer}{entry.rule.topic ? ` · ${entry.rule.topic}=${entry.rule.stance}` : ""}
                      </span>
                      <div style={{ whiteSpace: "pre-wrap", fontSize: 10.5, marginTop: 2 }}>{entry.rule.body}</div>
                    </div>
                  ))}
                </div>
                {preview.superseded.length ? (
                  <div style={{ display: "grid", gap: 5 }}>
                    <span style={label}>Superseded — kept visible, never silently dropped</span>
                    {preview.superseded.map(entry => (
                      <div key={`${entry.setId}:${entry.rule.id}`} style={{ borderLeft: `3px solid ${entry.reason === "conflict" ? "#ffd97a" : "var(--border)"}`, padding: "3px 8px" }}>
                        <b style={{ fontSize: 10.5 }}>{entry.rule.title}</b>
                        <span style={{ color: "var(--fg-muted)", fontSize: 10, marginLeft: 6 }}>{entry.reason}</span>
                        <div style={{ color: "var(--fg-muted)", fontSize: 10.5, marginTop: 2 }}>{entry.explanation}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div style={{ color: "var(--fg-subtle)", fontSize: 11.5 }}>
                Resolve to see the precedence order, every rule that applies, and every rule a
                higher-precedence set overruled — resolved by the same backend the agent runs on.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
