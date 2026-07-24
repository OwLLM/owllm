import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentProfileDoc, PersonalSkillDoc } from "./personalAgentConfig";
import {
  emptyPersonalAgentTeam,
  isTerminalRunStatus,
  mergeTraceEvents,
  newClientRequestId,
  normalizePersonalAgentTeam,
  PERSONAL_TEAM_RUNTIME_TOOL_NAMES,
  runIdOf,
  validatePersonalAgentTeam,
  type PersonalAgentContextAccess,
  type PersonalAgentRecoveryStrategy,
  type PersonalAgentRun,
  type PersonalAgentRunEventsPage,
  type PersonalAgentTeamDoc,
  type PersonalAgentTeamMember,
  type PersonalAgentTraceEvent,
} from "./personalAgentTeams";

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

function memberId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `member:${crypto.randomUUID()}`;
  }
  return `member:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function profileName(profiles: AgentProfileDoc[], profileId: string): string {
  return profiles.find(profile => profile.id === profileId)?.displayName ?? profileId;
}

function safeScalar(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

// The server contract guarantees redaction, but this renderer is deliberately
// allowlist-only so a future backend field cannot accidentally expose a rule
// body, memory value, credential, or arbitrary nested payload.
function safeTraceValue(value: PersonalAgentTraceEvent["output"] | PersonalAgentTraceEvent["error"]): string {
  if (value == null || typeof value !== "object") return safeScalar(value);
  const allowed = ["ref", "hash", "summary", "message", "code", "path", "count", "bytes", "mime", "status"];
  return allowed
    .flatMap(key => key in value ? [`${key}: ${safeScalar(value[key])}`] : [])
    .filter(Boolean)
    .join(" · ");
}

function safeHandoff(handoff: PersonalAgentTraceEvent["handoff"]): string {
  if (!handoff) return "";
  const allowed = ["fromMemberId", "toMemberId", "taskId", "parentTaskId", "depth", "handoffCount"];
  return allowed
    .flatMap(key => key in handoff ? [`${key}: ${safeScalar(handoff[key])}`] : [])
    .filter(Boolean)
    .join(" · ");
}

function MemberEditor({
  member,
  team,
  profiles,
  onChange,
  onRemove,
}: {
  member: PersonalAgentTeamMember;
  team: PersonalAgentTeamDoc;
  profiles: AgentProfileDoc[];
  onChange: (member: PersonalAgentTeamMember) => void;
  onRemove: () => void;
}) {
  const isCoordinator = member.role === "coordinator";
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 9, padding: 9, display: "grid", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr .7fr .8fr auto", gap: 7, alignItems: "end" }}>
        <label>
          <span style={label}>Profile</span>
          <select style={input} value={member.profileId} disabled={isCoordinator} onChange={event => onChange({ ...member, profileId: event.target.value })}>
            {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
          </select>
        </label>
        <label>
          <span style={label}>Role</span>
          <input style={input} value={isCoordinator ? "Coordinator" : "Specialist"} disabled />
        </label>
        <label>
          <span style={label}>Context</span>
          <select style={input} value={member.contextAccess} onChange={event => onChange({ ...member, contextAccess: event.target.value as PersonalAgentContextAccess })}>
            <option value="shared">Shared team context</option>
            <option value="project">Project context</option>
            {isCoordinator
              ? <option value="private">Private coordinator context</option>
              : member.contextAccess === "private"
                ? <option value="private" disabled>Private context — coordinator only</option>
                : null}
          </select>
        </label>
        <button type="button" onClick={onRemove} disabled={isCoordinator} style={{ ...button, color: isCoordinator ? "var(--fg-subtle)" : "#ff9a8a" }}>
          Remove
        </button>
      </div>
      <div>
        <span style={label}>May delegate explicitly to</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {team.members.filter(candidate => candidate.memberId !== member.memberId).map(candidate => (
            <label key={candidate.memberId} style={{ display: "flex", alignItems: "center", gap: 5, border: "1px solid var(--border)", borderRadius: 7, padding: "5px 7px", fontSize: 10.5 }}>
              <input
                type="checkbox"
                checked={member.mayDelegateToMemberIds.includes(candidate.memberId)}
                onChange={() => onChange({
                  ...member,
                  mayDelegateToMemberIds: member.mayDelegateToMemberIds.includes(candidate.memberId)
                    ? member.mayDelegateToMemberIds.filter(id => id !== candidate.memberId)
                    : [...member.mayDelegateToMemberIds, candidate.memberId],
                })}
              />
              {profileName(profiles, candidate.profileId)}
            </label>
          ))}
          {team.members.length < 2 ? <span style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>Add a specialist to enable handoffs.</span> : null}
        </div>
      </div>
    </div>
  );
}

function TraceEventRow({
  event,
}: {
  event: PersonalAgentTraceEvent;
}) {
  // Member ids are pinned into the immutable run snapshot. Do not resolve
  // them through the mutable team draft here: a later team revision could
  // otherwise misattribute a historical trace to a different profile.
  const actor = event.agentMemberId;
  const rules = event.appliedRuleRefs?.map(ref => `${ref.id}@${ref.revision}`).join(", ");
  const skills = event.appliedSkillIds?.join(", ");
  const handoff = safeHandoff(event.handoff);
  const output = safeTraceValue(event.output);
  const error = safeTraceValue(event.error);
  return (
    <div style={{ borderLeft: `3px solid ${error ? "#ff786e" : event.kind.includes("handoff") ? "#c08aff" : "#7fd4ff"}`, padding: "7px 9px", background: "var(--bg-surface)", borderRadius: "0 8px 8px 0", display: "grid", gap: 3 }}>
      <div style={{ display: "flex", gap: 7, alignItems: "baseline", fontSize: 10.5 }}>
        <b>#{event.seq} · {event.kind}</b>
        {actor ? <span style={{ color: "#7fd4ff" }}>{actor}</span> : null}
        {event.taskId ? <span style={{ color: "var(--fg-muted)" }}>task {event.taskId}</span> : null}
        {event.status ? <span style={{ color: "var(--fg-muted)" }}>{event.status}</span> : null}
        <span style={{ flex: 1 }} />
        {event.ts ? <time style={{ color: "var(--fg-subtle)", fontSize: 9.5 }}>{event.ts}</time> : null}
      </div>
      {rules ? <div style={{ fontSize: 10.5 }}><b>Rules:</b> {rules}</div> : null}
      {skills ? <div style={{ fontSize: 10.5 }}><b>Skills:</b> {skills}</div> : null}
      {handoff ? <div style={{ fontSize: 10.5 }}><b>Handoff:</b> {handoff}</div> : null}
      {output ? <div style={{ fontSize: 10.5, whiteSpace: "pre-wrap" }}><b>Output:</b> {output}</div> : null}
      {error ? <div style={{ color: "#ff9a8a", fontSize: 10.5, whiteSpace: "pre-wrap" }}><b>Error:</b> {error}</div> : null}
    </div>
  );
}

export default function PersonalAgentTeamsPanel({
  profiles,
  personalSkills,
  projectId,
  onProjectIdChange,
}: {
  profiles: AgentProfileDoc[];
  personalSkills: PersonalSkillDoc[];
  projectId: string;
  onProjectIdChange: (projectId: string) => void;
}) {
  const [teams, setTeams] = useState<PersonalAgentTeamDoc[]>([]);
  const [teamId, setTeamId] = useState("");
  const [draft, setDraft] = useState<PersonalAgentTeamDoc | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [objective, setObjective] = useState("");
  const [runInput, setRunInput] = useState("");
  const [runs, setRuns] = useState<PersonalAgentRun[]>([]);
  const [runId, setRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<PersonalAgentRun | null>(null);
  const [events, setEvents] = useState<PersonalAgentTraceEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const pollingGeneration = useRef(0);

  const reloadTeams = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await invoke<PersonalAgentTeamDoc[]>("personal_agent_team_list", {
        projectId: projectId.trim() || undefined,
        includeArchived,
      });
      setTeams(next);
      if (!next.some(team => team.id === teamId)) setTeamId(next[0]?.id ?? "");
    } catch (cause) {
      setError(`Couldn't load personal-agent teams: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const reloadRuns = async () => {
    if (!projectId.trim()) {
      setRuns([]);
      setRunId("");
      setSelectedRun(null);
      setEvents([]);
      return;
    }
    try {
      const next = await invoke<PersonalAgentRun[]>("personal_agent_team_run_list", {
        projectId: projectId.trim(),
        teamId: teamId || undefined,
        statuses: undefined,
        limit: 50,
      });
      setRuns(next);
      if (!next.some(run => runIdOf(run) === runId)) setRunId(next[0] ? runIdOf(next[0]) : "");
    } catch (cause) {
      setError(`Couldn't load prior team runs: ${String(cause)}`);
    }
  };

  useEffect(() => {
    void reloadTeams();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived, projectId]);

  useEffect(() => {
    if (!teamId) {
      setDraft(null);
      setPersisted(false);
      return;
    }
    if (!teams.some(team => team.id === teamId)) return;
    let dead = false;
    invoke<PersonalAgentTeamDoc>("personal_agent_team_get", { teamId, revision: undefined })
      .then(team => {
        if (dead) return;
        setDraft(normalizePersonalAgentTeam(team));
        setPersisted(true);
        setCloneName(`${team.name} copy`);
      })
      .catch(cause => { if (!dead) setError(`Couldn't open team ${teamId}: ${String(cause)}`); });
    return () => { dead = true; };
  }, [teamId, teams]);

  useEffect(() => {
    void reloadRuns();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, teamId]);

  useEffect(() => {
    const activeProjectId = projectId.trim();
    if (!runId || !activeProjectId) {
      setSelectedRun(null);
      setEvents([]);
      return;
    }
    const generation = ++pollingGeneration.current;
    let cancelled = false;
    let afterSeq = 0;
    setEvents([]);
    const poll = async () => {
      if (cancelled || pollingGeneration.current !== generation) return;
      try {
        const [run, page] = await Promise.all([
          invoke<PersonalAgentRun>("personal_agent_team_run_get", { projectId: activeProjectId, runId }),
          invoke<PersonalAgentRunEventsPage>("personal_agent_team_run_events", { projectId: activeProjectId, runId, afterSeq, limit: 200 }),
        ]);
        if (cancelled || pollingGeneration.current !== generation) return;
        setSelectedRun(run);
        setRuns(current => [run, ...current.filter(candidate => runIdOf(candidate) !== runIdOf(run))]);
        setEvents(current => mergeTraceEvents(current, page.events));
        afterSeq = Math.max(afterSeq, page.nextAfterSeq);
        if (page.hasMore || !isTerminalRunStatus(run.status)) {
          window.setTimeout(() => void poll(), page.hasMore ? 30 : 900);
        }
      } catch (cause) {
        if (!cancelled) setError(`Couldn't refresh run ${runId}: ${String(cause)}`);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      pollingGeneration.current += 1;
    };
  }, [projectId, runId]);

  const patchMember = (memberIdValue: string, next: PersonalAgentTeamMember) => {
    if (!draft) return;
    setDraft({ ...draft, members: draft.members.map(member => member.memberId === memberIdValue ? next : member) });
  };

  const setCoordinator = (profileId: string) => {
    if (!draft) return;
    const existing = draft.members.find(member => member.profileId === profileId);
    const coordinatorId = existing?.memberId ?? memberId();
    const members: PersonalAgentTeamMember[] = draft.members
      .filter(member => member.memberId !== coordinatorId)
      .map(member => ({
        ...member,
        role: "specialist",
        contextAccess: member.contextAccess === "private" ? "project" : member.contextAccess,
      }));
    members.unshift({
      memberId: coordinatorId,
      profileId,
      role: "coordinator",
      mayDelegateToMemberIds: existing?.mayDelegateToMemberIds ?? [],
      contextAccess: existing?.contextAccess ?? "project",
    });
    setDraft({ ...draft, coordinatorProfileId: profileId, members });
  };

  const addSpecialist = () => {
    if (!draft) return;
    const profile = profiles.find(candidate => !draft.members.some(member => member.profileId === candidate.id));
    if (!profile) {
      setError("Every available profile is already in this team.");
      return;
    }
    setDraft({
      ...draft,
      members: [...draft.members, {
        memberId: memberId(),
        profileId: profile.id,
        role: "specialist",
        mayDelegateToMemberIds: [],
        contextAccess: "project",
      }],
    });
  };

  const removeMember = (memberIdValue: string) => {
    if (!draft) return;
    setDraft({
      ...draft,
      members: draft.members
        .filter(member => member.memberId !== memberIdValue)
        .map(member => ({
          ...member,
          mayDelegateToMemberIds: member.mayDelegateToMemberIds.filter(id => id !== memberIdValue),
        })),
    });
  };

  const saveTeam = async () => {
    if (!draft) return;
    const doc = normalizePersonalAgentTeam(draft);
    const validation = validatePersonalAgentTeam(doc, personalSkills, profiles);
    if (validation.length) {
      setError(validation.join(" "));
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const saved = await invoke<PersonalAgentTeamDoc>("personal_agent_team_save", {
        doc,
        expectedRevision: persisted ? draft.revision : undefined,
      });
      setDraft(saved);
      setPersisted(true);
      setTeamId(saved.id);
      setTeams(current => [saved, ...current.filter(team => team.id !== saved.id)]);
      setStatus(`Saved ${saved.name} at revision ${saved.revision}.`);
    } catch (cause) {
      setError(`Couldn't save team: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const cloneTeam = async () => {
    if (!draft || !persisted || !cloneName.trim()) return;
    setBusy(true);
    setError("");
    try {
      const saved = await invoke<PersonalAgentTeamDoc>("personal_agent_team_clone", {
        teamId: draft.id,
        revision: draft.revision,
        newName: cloneName.trim(),
        newId: undefined,
      });
      setTeams(current => [saved, ...current]);
      setTeamId(saved.id);
      setDraft(saved);
      setPersisted(true);
      setStatus(`Cloned as ${saved.name}.`);
    } catch (cause) {
      setError(`Couldn't clone team: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const setArchived = async (archived: boolean) => {
    if (!draft || !persisted) return;
    setBusy(true);
    setError("");
    try {
      const saved = await invoke<PersonalAgentTeamDoc>("personal_agent_team_archive", {
        teamId: draft.id,
        expectedRevision: draft.revision,
        archived,
      });
      setDraft(saved);
      setTeams(current => includeArchived
        ? [saved, ...current.filter(team => team.id !== saved.id)]
        : current.filter(team => team.id !== saved.id));
      setStatus(`${archived ? "Archived" : "Restored"} ${saved.name}.`);
    } catch (cause) {
      setError(`Couldn't ${archived ? "archive" : "restore"} team: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const createRun = async () => {
    if (!draft || !persisted) {
      setError("Save the team before starting a run.");
      return;
    }
    if (!projectId.trim() || !objective.trim()) {
      setError("A project id and objective are required.");
      return;
    }
    setRunBusy(true);
    setError("");
    try {
      const run = await invoke<PersonalAgentRun>("personal_agent_team_run_create", {
        request: {
          clientRequestId: newClientRequestId(),
          projectId: projectId.trim(),
          teamId: draft.id,
          expectedTeamRevision: draft.revision,
          objective: objective.trim(),
          input: runInput.trim() || undefined,
        },
      });
      setRuns(current => [run, ...current.filter(candidate => runIdOf(candidate) !== runIdOf(run))]);
      setRunId(runIdOf(run));
      setSelectedRun(run);
      setStatus(`Run ${runIdOf(run)} queued. You can close this dialog; execution continues asynchronously.`);
    } catch (cause) {
      setError(`Couldn't start team run: ${String(cause)}`);
    } finally {
      setRunBusy(false);
    }
  };

  const cancelRun = async () => {
    if (!selectedRun || isTerminalRunStatus(selectedRun.status)) return;
    const activeProjectId = projectId.trim();
    if (!activeProjectId) {
      setError("A project id is required to cancel a team run.");
      return;
    }
    setRunBusy(true);
    try {
      const run = await invoke<PersonalAgentRun>("personal_agent_team_run_cancel", {
        projectId: activeProjectId,
        runId: runIdOf(selectedRun),
        reason: "Cancelled by user",
      });
      setSelectedRun(run);
      setRuns(current => [run, ...current.filter(candidate => runIdOf(candidate) !== runIdOf(run))]);
    } catch (cause) {
      setError(`Couldn't cancel run: ${String(cause)}`);
    } finally {
      setRunBusy(false);
    }
  };

  const recoverRun = async (strategy: PersonalAgentRecoveryStrategy) => {
    if (!selectedRun) return;
    const activeProjectId = projectId.trim();
    if (!activeProjectId) {
      setError("A project id is required to recover a team run.");
      return;
    }
    setRunBusy(true);
    setError("");
    try {
      const run = await invoke<PersonalAgentRun>("personal_agent_team_run_recover", {
        request: {
          clientRequestId: newClientRequestId(),
          projectId: activeProjectId,
          runId: runIdOf(selectedRun),
          strategy,
          taskId: undefined,
        },
      });
      setRuns(current => [run, ...current.filter(candidate => runIdOf(candidate) !== runIdOf(run))]);
      setRunId(runIdOf(run));
      setSelectedRun(run);
      setStatus(`Recovery run ${runIdOf(run)} queued from ${runIdOf(selectedRun)}.`);
    } catch (cause) {
      setError(`Couldn't recover run: ${String(cause)}`);
    } finally {
      setRunBusy(false);
    }
  };

  const validationErrors = draft
    ? validatePersonalAgentTeam(normalizePersonalAgentTeam(draft), personalSkills, profiles)
    : [];

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {(error || status) ? (
        <div role={error ? "alert" : "status"} style={{ ...panel, padding: 9, color: error ? "#ff9a8a" : "#9ee6b0" }}>
          {error || status}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "240px minmax(0,1fr)", gap: 10 }}>
        <aside style={{ ...panel, display: "grid", alignContent: "start", gap: 7 }}>
          <button type="button" onClick={() => {
            const next = emptyPersonalAgentTeam(profiles);
            setDraft(next);
            setTeamId(next.id);
            setPersisted(false);
            setCloneName(`${next.name} copy`);
          }} style={{ ...button, color: "#9ee6b0" }}>+ New team</button>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10.5 }}>
            <input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />
            Show archived teams
          </label>
          <div style={{ display: "grid", gap: 5, maxHeight: 560, overflow: "auto" }}>
            {teams.map(team => (
              <button key={team.id} type="button" onClick={() => setTeamId(team.id)} style={{
                ...button,
                textAlign: "left",
                opacity: team.archived ? 0.6 : 1,
                borderColor: teamId === team.id ? "#c08aff" : "var(--border)",
              }}>
                <b>{team.name}</b>
                <span style={{ display: "block", color: "var(--fg-subtle)", fontSize: 9.5 }}>
                  {team.members.length} agents · r{team.revision}{team.archived ? " · archived" : ""}
                </span>
              </button>
            ))}
          </div>
        </aside>

        {draft ? (
          <section style={{ display: "grid", gap: 10, minWidth: 0 }}>
            <div style={{ ...panel, display: "grid", gap: 9 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 8 }}>
                <label><span style={label}>Team name</span><input style={input} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
                <label><span style={label}>Description</span><input style={input} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr repeat(3,.55fr)", gap: 8 }}>
                <label><span style={label}>Coordinator</span>
                  <select style={input} value={draft.coordinatorProfileId} onChange={event => setCoordinator(event.target.value)}>
                    <option value="">Choose…</option>
                    {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
                  </select>
                </label>
                <label><span style={label}>Max handoffs</span><input type="number" min={0} style={input} value={draft.delegationBudget.maxHandoffs} onChange={event => setDraft({ ...draft, delegationBudget: { ...draft.delegationBudget, maxHandoffs: Number(event.target.value) } })} /></label>
                <label><span style={label}>Max depth</span><input type="number" min={0} style={input} value={draft.delegationBudget.maxDepth} onChange={event => setDraft({ ...draft, delegationBudget: { ...draft.delegationBudget, maxDepth: Number(event.target.value) } })} /></label>
                <label><span style={label}>Max parallel</span><input type="number" min={1} style={input} value={draft.delegationBudget.maxParallel} onChange={event => setDraft({ ...draft, delegationBudget: { ...draft.delegationBudget, maxParallel: Number(event.target.value) } })} /></label>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                {([
                  ["sharedEnabled", "Shared team context"],
                  ["projectEnabled", "Project context"],
                  ["privateEnabled", "Private coordinator context"],
                ] as const).map(([key, title]) => (
                  <label key={key} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 10.5 }}>
                    <input type="checkbox" checked={draft.contextPolicy[key]} onChange={event => setDraft({ ...draft, contextPolicy: { ...draft.contextPolicy, [key]: event.target.checked } })} />
                    {title}
                  </label>
                ))}
                <span style={{ flex: 1 }} />
                <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5 }}>Events retained <input type="number" min={1} style={{ ...input, width: 62 }} value={draft.retentionPolicy.eventDays} onChange={event => setDraft({ ...draft, retentionPolicy: { ...draft.retentionPolicy, eventDays: Number(event.target.value) } })} /> days</label>
                <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5 }}>Outputs retained <input type="number" min={1} style={{ ...input, width: 62 }} value={draft.retentionPolicy.outputDays} onChange={event => setDraft({ ...draft, retentionPolicy: { ...draft.retentionPolicy, outputDays: Number(event.target.value) } })} /> days</label>
              </div>

              <div style={{ display: "grid", gap: 6 }}>
                <div>
                  <b style={{ fontSize: 11.5 }}>Team personal skills</b>
                  <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 10.5 }}>
                    Applied to every member and pinned to an exact revision. Browser tools run only when every member profile explicitly allows them.
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 6 }}>
                  {personalSkills.filter(skill => skill.status === "active").map(skill => {
                    const attached = (draft.skillRefs ?? []).some(ref => ref.id === skill.id && ref.revision === skill.revision);
                    const unsupported = skill.requiredTools.filter(tool => !PERSONAL_TEAM_RUNTIME_TOOL_NAMES.has(tool));
                    const unauthorized = draft.members.flatMap(member => {
                      const profile = profiles.find(candidate => candidate.id === member.profileId);
                      return profile
                        ? skill.requiredTools.filter(tool => !profile.allowedTools.includes(tool))
                        : [];
                    });
                    const incompatible = unsupported.length > 0 || unauthorized.length > 0;
                    return (
                      <label key={`${skill.id}@${skill.revision}`} style={{
                        display: "grid", gridTemplateColumns: "18px 1fr", gap: 6,
                        border: "1px solid var(--border)", borderRadius: 8, padding: "7px 8px",
                        opacity: incompatible ? 0.58 : 1,
                        cursor: incompatible ? "not-allowed" : "pointer",
                      }}>
                        <input
                          type="checkbox"
                          disabled={incompatible}
                          checked={attached}
                          onChange={() => setDraft({
                            ...draft,
                            skillRefs: attached
                              ? (draft.skillRefs ?? []).filter(ref => !(ref.id === skill.id && ref.revision === skill.revision))
                              : [...(draft.skillRefs ?? []), { id: skill.id, revision: skill.revision }],
                          })}
                        />
                        <span>
                          <b style={{ fontSize: 10.5 }}>{skill.name} · r{skill.revision}</b>
                          <span style={{ display: "block", color: incompatible ? "#ffb56a" : "var(--fg-muted)", fontSize: 9.5 }}>
                            {incompatible
                              ? unsupported.length
                                ? `Unsupported by the persistent team runtime: ${[...new Set(unsupported)].join(", ")}.`
                                : `Every member profile must allow: ${[...new Set(unauthorized)].join(", ")}.`
                              : skill.purpose}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                  {!personalSkills.some(skill => skill.status === "active") ? (
                    <span style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>No active personal skills are visible for this project.</span>
                  ) : null}
                </div>
              </div>

              <div style={{ display: "grid", gap: 7 }}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <b style={{ fontSize: 11.5 }}>Members · explicit delegation graph</b>
                  <span style={{ flex: 1 }} />
                  <button type="button" onClick={addSpecialist} style={button}>+ Specialist</button>
                </div>
                {draft.members.map(member => (
                  <MemberEditor
                    key={member.memberId}
                    member={member}
                    team={draft}
                    profiles={profiles}
                    onChange={next => patchMember(member.memberId, next)}
                    onRemove={() => removeMember(member.memberId)}
                  />
                ))}
              </div>

              {validationErrors.length ? (
                <div role="alert" style={{ color: "#ff9a8a", fontSize: 10.5 }}>
                  {validationErrors.map(message => <div key={message}>• {message}</div>)}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 7, alignItems: "end" }}>
                <button type="button" onClick={() => void saveTeam()} disabled={busy || !!validationErrors.length} style={{ ...button, background: "var(--accent)", color: "var(--accent-fg)", border: 0 }}>Save team</button>
                <button type="button" onClick={() => void setArchived(!draft.archived)} disabled={busy || !persisted} style={{ ...button, color: draft.archived ? "#9ee6b0" : "#ff9a8a" }}>{draft.archived ? "Unarchive" : "Archive"}</button>
                <span style={{ flex: 1 }} />
                <label style={{ width: 210 }}><span style={label}>Clone as</span><input style={input} value={cloneName} onChange={event => setCloneName(event.target.value)} /></label>
                <button type="button" onClick={() => void cloneTeam()} disabled={busy || !persisted || !cloneName.trim()} style={button}>Clone</button>
              </div>
            </div>

            <div style={{ ...panel, display: "grid", gap: 9 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 8 }}>
                <label><span style={label}>Project id</span><input style={input} value={projectId} onChange={event => onProjectIdChange(event.target.value)} placeholder="Same project key used by profiles and memory" /></label>
                <label><span style={label}>Objective</span><input style={input} value={objective} onChange={event => setObjective(event.target.value)} placeholder="A concrete team outcome" /></label>
              </div>
              <label><span style={label}>Optional input / constraints</span><textarea rows={3} style={{ ...input, resize: "vertical" }} value={runInput} onChange={event => setRunInput(event.target.value)} /></label>
              <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <button type="button" onClick={() => void createRun()} disabled={runBusy || draft.archived || !persisted} style={{ ...button, color: "#9ee6b0" }}>▶ Start asynchronously</button>
                <span style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>Creates an idempotent immutable run snapshot and returns immediately.</span>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={() => void reloadRuns()} disabled={runBusy} style={button}>↻ Runs</button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "230px minmax(0,1fr)", gap: 10, minHeight: 280 }}>
              <div style={{ ...panel, display: "grid", alignContent: "start", gap: 5, maxHeight: 480, overflow: "auto" }}>
                <b style={{ fontSize: 11.5 }}>Prior runs</b>
                {runs.map(run => (
                  <button key={runIdOf(run)} type="button" onClick={() => setRunId(runIdOf(run))} style={{
                    ...button,
                    textAlign: "left",
                    borderColor: runId === runIdOf(run) ? "#7fd4ff" : "var(--border)",
                  }}>
                    <b>{run.status}</b>
                    <span style={{ display: "block", color: "var(--fg-muted)", fontSize: 9.5 }}>{run.objective}</span>
                    <span style={{ display: "block", color: "var(--fg-subtle)", fontSize: 9 }}>{runIdOf(run)}</span>
                  </button>
                ))}
              </div>

              <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                {selectedRun ? (
                  <>
                    <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                      <b>{selectedRun.status.toUpperCase()}</b>
                      <span style={{ color: "var(--fg-muted)", fontSize: 10.5 }}>{runIdOf(selectedRun)} · seq {selectedRun.lastEventSeq}</span>
                      <span style={{ flex: 1 }} />
                      {!isTerminalRunStatus(selectedRun.status) ? <button type="button" onClick={() => void cancelRun()} disabled={runBusy} style={{ ...button, color: "#ff9a8a" }}>■ Cancel</button> : null}
                      {selectedRun.status === "failed" || selectedRun.status === "cancelled" ? (
                        <>
                          <button type="button" onClick={() => void recoverRun("retryFailed")} disabled={runBusy} style={button}>Retry run</button>
                        </>
                      ) : null}
                    </div>
                    <div style={{ height: 4, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{
                        height: "100%",
                        width: isTerminalRunStatus(selectedRun.status) ? "100%" : selectedRun.status === "queued" ? "12%" : "62%",
                        background: selectedRun.status === "failed" ? "#ff786e" : selectedRun.status === "cancelled" ? "#ffd97a" : "#7fd4ff",
                        transition: "width .25s ease",
                      }} />
                    </div>
                    <div style={{ flex: 1, minHeight: 0, maxHeight: 430, overflow: "auto", display: "grid", alignContent: "start", gap: 6 }}>
                      {events.map(event => <TraceEventRow key={event.seq} event={event} />)}
                      {!events.length ? <span style={{ color: "var(--fg-subtle)", fontSize: 10.5 }}>Waiting for ordered runtime events…</span> : null}
                    </div>
                  </>
                ) : <div style={{ color: "var(--fg-subtle)", fontSize: 11 }}>Start or select a prior run to inspect progress and redacted trace output.</div>}
              </div>
            </div>
          </section>
        ) : <section style={panel}>Create a profile first, then create or select a team.</section>}
      </div>
    </div>
  );
}
