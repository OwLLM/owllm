import {
  dedupeRefs,
  type AgentProfileDoc,
  type PersonalSkillDoc,
  type RevisionRef,
} from "./personalAgentConfig";

export const PERSONAL_AGENT_TEAM_SCHEMA_VERSION = 1 as const;
export const PERSONAL_TEAM_RUNTIME_TOOL_NAMES = new Set([
  "browser_back",
  "browser_click",
  "browser_close",
  "browser_device",
  "browser_fill",
  "browser_get_text",
  "browser_navigate",
  "browser_open",
  "browser_press",
  "browser_reload",
  "browser_scroll",
  "browser_screenshot",
  "browser_select",
  "browser_snapshot",
  "browser_tab_close",
  "browser_tab_select",
  "browser_tabs",
]);

export type PersonalAgentTeamRole = "coordinator" | "specialist";
export type PersonalAgentContextAccess = "shared" | "project" | "private";
export type PersonalAgentRunStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";
export type PersonalAgentRecoveryStrategy = "retryFailed";

export type PersonalAgentTeamMember = {
  memberId: string;
  profileId: string;
  role: PersonalAgentTeamRole;
  mayDelegateToMemberIds: string[];
  contextAccess: PersonalAgentContextAccess;
};

export type PersonalAgentTeamDoc = {
  schemaVersion: 1;
  id: string;
  revision: number;
  name: string;
  description: string;
  archived: boolean;
  coordinatorProfileId: string;
  members: PersonalAgentTeamMember[];
  skillRefs: RevisionRef[];
  delegationBudget: {
    maxHandoffs: number;
    maxDepth: number;
    maxParallel: number;
  };
  contextPolicy: {
    sharedEnabled: boolean;
    projectEnabled: boolean;
    privateEnabled: boolean;
  };
  retentionPolicy: {
    eventDays: number;
    outputDays: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type PersonalAgentRun = {
  schemaVersion: number;
  runId: string;
  clientRequestId: string;
  projectId: string;
  teamId: string;
  status: PersonalAgentRunStatus;
  snapshotHash: string;
  objective: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  recoveryOfRunId?: string;
  lastEventSeq: number;
};

export type PersonalAgentTraceEvent = {
  schemaVersion: number;
  runId: string;
  seq: number;
  ts: string;
  kind: string;
  agentMemberId?: string;
  taskId?: string;
  parentTaskId?: string;
  status?: string;
  appliedRuleRefs: { id: string; revision: number }[];
  appliedSkillIds: string[];
  handoff?: Record<string, string | number | boolean | null>;
  output?: string | number | boolean | null | Record<string, string | number | boolean | null>;
  error?: string | number | boolean | null | Record<string, string | number | boolean | null>;
};

export type PersonalAgentRunEventsPage = {
  runId: string;
  events: PersonalAgentTraceEvent[];
  nextAfterSeq: number;
  hasMore: boolean;
};

export const TERMINAL_PERSONAL_AGENT_RUN_STATUSES = new Set<PersonalAgentRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

function uid(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function emptyPersonalAgentTeam(
  profiles: AgentProfileDoc[],
  now = new Date().toISOString(),
): PersonalAgentTeamDoc {
  const coordinator = profiles[0];
  const memberId = uid("member");
  return {
    schemaVersion: PERSONAL_AGENT_TEAM_SCHEMA_VERSION,
    id: uid("team"),
    revision: 1,
    name: "New personal-agent team",
    description: "",
    archived: false,
    coordinatorProfileId: coordinator?.id ?? "",
    skillRefs: [],
    members: coordinator
      ? [{
          memberId,
          profileId: coordinator.id,
          role: "coordinator",
          mayDelegateToMemberIds: [],
          contextAccess: "project",
        }]
      : [],
    delegationBudget: { maxHandoffs: 4, maxDepth: 2, maxParallel: 1 },
    contextPolicy: { sharedEnabled: true, projectEnabled: true, privateEnabled: false },
    retentionPolicy: { eventDays: 30, outputDays: 30 },
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizePersonalAgentTeam(team: PersonalAgentTeamDoc): PersonalAgentTeamDoc {
  const members = team.members.map(member => ({
    ...member,
    mayDelegateToMemberIds: [...new Set(member.mayDelegateToMemberIds)]
      .filter(id => id !== member.memberId && team.members.some(candidate => candidate.memberId === id)),
  }));
  return {
    ...team,
    schemaVersion: PERSONAL_AGENT_TEAM_SCHEMA_VERSION,
    name: team.name.trim() || "Personal-agent team",
    description: team.description.trim(),
    coordinatorProfileId: team.coordinatorProfileId.trim(),
    skillRefs: dedupeRefs(team.skillRefs ?? []),
    members,
    delegationBudget: {
      maxHandoffs: Math.max(0, Math.floor(team.delegationBudget.maxHandoffs || 0)),
      maxDepth: Math.max(0, Math.floor(team.delegationBudget.maxDepth || 0)),
      maxParallel: Math.max(1, Math.floor(team.delegationBudget.maxParallel || 1)),
    },
    retentionPolicy: {
      eventDays: Math.max(1, Math.floor(team.retentionPolicy.eventDays || 1)),
      outputDays: Math.max(1, Math.floor(team.retentionPolicy.outputDays || 1)),
    },
  };
}

export function teamSkillCompatibilityErrors(
  team: PersonalAgentTeamDoc,
  skills: PersonalSkillDoc[],
  profiles: AgentProfileDoc[] = [],
): string[] {
  const byRef = new Map(skills.map(skill => [`${skill.id}@${skill.revision}`, skill]));
  const profilesById = new Map<string, AgentProfileDoc>(
    profiles.map(profile => [profile.id, profile]),
  );
  const errors: string[] = [];
  for (const ref of team.skillRefs ?? []) {
    const skill = byRef.get(`${ref.id}@${ref.revision}`);
    if (!skill) {
      errors.push(`Team skill ${ref.id}@r${ref.revision} is missing or not visible in this project.`);
      continue;
    }
    if (skill.status !== "active") {
      errors.push(`Team skill ${skill.name} must be active; current status is ${skill.status}.`);
    }
    const unsupported = skill.requiredTools.filter(tool => !PERSONAL_TEAM_RUNTIME_TOOL_NAMES.has(tool));
    if (unsupported.length) {
      errors.push(
        `Team skill ${skill.name} requires unsupported persistent-team tools: ${unsupported.join(", ")}.`,
      );
    }
    for (const member of team.members) {
      const profile = profilesById.get(member.profileId);
      if (!profile) continue;
      const missing = skill.requiredTools.filter(tool => !profile.allowedTools.includes(tool));
      if (missing.length) {
        errors.push(
          `${profile.displayName} must allow ${missing.join(", ")} before team skill ${skill.name} can run.`,
        );
      }
    }
  }
  return errors;
}

export function validatePersonalAgentTeam(
  team: PersonalAgentTeamDoc,
  personalSkills: PersonalSkillDoc[] = [],
  profiles: AgentProfileDoc[] = [],
): string[] {
  const errors: string[] = [];
  const memberIds = new Set(team.members.map(member => member.memberId));
  const membersById = new Map<string, PersonalAgentTeamMember>(
    team.members.map(member => [member.memberId, member]),
  );
  const profilesById = new Map<string, AgentProfileDoc>(
    profiles.map(profile => [profile.id, profile]),
  );
  const coordinatorMembers = team.members.filter(member => member.role === "coordinator");
  if (!team.name.trim()) errors.push("Team name is required.");
  if (!team.coordinatorProfileId.trim()) errors.push("Choose a coordinator profile.");
  if (coordinatorMembers.length !== 1) errors.push("A team must contain exactly one coordinator member.");
  if (coordinatorMembers[0]?.profileId !== team.coordinatorProfileId) {
    errors.push("Coordinator member and coordinator profile must match.");
  }
  if (memberIds.size !== team.members.length) errors.push("Member ids must be unique.");
  if (new Set(team.members.map(member => member.profileId)).size !== team.members.length) {
    errors.push("A profile can appear only once in a team.");
  }
  for (const member of team.members) {
    if (!member.profileId.trim()) errors.push(`Member ${member.memberId} has no profile.`);
    const profile = profilesById.get(member.profileId);
    for (const targetId of member.mayDelegateToMemberIds) {
      if (!memberIds.has(targetId)) errors.push(`Member ${member.memberId} delegates to missing member ${targetId}.`);
      if (targetId === member.memberId) errors.push(`Member ${member.memberId} cannot delegate to itself.`);
      const target = membersById.get(targetId);
      if (profile && target) {
        if (!profile.delegation.enabled) {
          errors.push(`${profile.displayName} is not allowed to delegate.`);
        } else if (!profile.delegation.allowedProfileIds.includes(target.profileId)) {
          errors.push(
            `${profile.displayName} may not delegate to ${profilesById.get(target.profileId)?.displayName ?? target.profileId}.`,
          );
        }
      }
    }
    if (member.contextAccess === "shared" && !team.contextPolicy.sharedEnabled) {
      errors.push(`Member ${member.memberId} requests shared context, but shared context is disabled.`);
    }
    if (member.contextAccess === "project" && !team.contextPolicy.projectEnabled) {
      errors.push(`Member ${member.memberId} requests project context, but project context is disabled.`);
    }
    if (member.contextAccess === "private" && member.role !== "coordinator") {
      errors.push(`Member ${member.memberId} cannot use private context because private context is coordinator-only.`);
    }
    if (member.contextAccess === "private" && !team.contextPolicy.privateEnabled) {
      errors.push(`Member ${member.memberId} requests private context, but private context is disabled.`);
    }
  }
  if (team.delegationBudget.maxParallel > Math.max(1, team.members.length)) {
    errors.push("Max parallel agents cannot exceed the team member count.");
  }
  errors.push(...teamSkillCompatibilityErrors(team, personalSkills, profiles));
  return [...new Set(errors)];
}

export function newClientRequestId(): string {
  return uid("request");
}

export function runIdOf(run: PersonalAgentRun): string {
  return run.runId;
}

export function mergeTraceEvents(
  current: PersonalAgentTraceEvent[],
  incoming: PersonalAgentTraceEvent[],
): PersonalAgentTraceEvent[] {
  const bySeq = new Map<number, PersonalAgentTraceEvent>();
  for (const event of [...current, ...incoming]) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function isTerminalRunStatus(status?: string): status is PersonalAgentRunStatus {
  return !!status && TERMINAL_PERSONAL_AGENT_RUN_STATUSES.has(status as PersonalAgentRunStatus);
}
