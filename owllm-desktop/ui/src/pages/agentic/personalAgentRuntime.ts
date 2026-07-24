import { invoke } from "@tauri-apps/api/core";
import {
  normalizeEffectiveAgentConfig,
  type BackendEffectiveAgentConfig,
  type EffectiveAgentConfig,
  type MemoryScope,
  type PersonalSkillDoc,
  type ProvenanceEntry,
  type RevisionRef,
  type RuleCardDoc,
} from "./personalAgentConfig";

export const PERSONAL_POLICY_MARKER = "__owllm_personal_policy__";
export const PERSONAL_SKILL_PREFIX = "__owllm_skill__:";
export const PERSONAL_MEMORY_PREFIX = "__owllm_memory__:";

export type RuntimePersonalAgent = {
  profileRef: RevisionRef;
  effective: EffectiveAgentConfig;
  modelId: string;
  provider?: string;
  allowedTools: string[];
  skillIds: string[];
  memoryScope: MemoryScope;
  memoryKey: string;
  memorySnapshot: string;
  rulesBlock: string;
  personalSkills: PersonalSkillDoc[];
};

type MemoryRow = {
  id: number;
  key: string;
  content: string;
  tags: string;
  author: string;
  ts: number;
  kind: string;
};

export type RuntimeAgentLike = {
  name: string;
  profileRef?: RevisionRef;
  runtimePersonal?: RuntimePersonalAgent;
};

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(String).map(v => v.trim()).filter(Boolean))];
}

function renderRules(
  rules: RuleCardDoc[],
  provenance: Record<string, ProvenanceEntry>,
): string {
  if (!rules.length) return "";
  const lines = ["--- PERSONAL AGENT RULES (resolved for this project) ---"];
  for (const rule of rules) {
    const condition = rule.condition?.projectIds?.length
      ? `; projects=${rule.condition.projectIds.join(",")}`
      : "";
    const winner = provenance[`ruleCards.${rule.id}@${rule.revision}`];
    const provenanceLabel = winner
      ? `; provenance=${winner.source}/${winner.documentId}@r${winner.revision}`
      : "";
    lines.push(
      `- [${rule.kind}; ${rule.scope}${rule.private ? "; private" : ""}${condition}; ${rule.id}@r${rule.revision}${provenanceLabel}] ` +
      `${rule.title}: ${rule.body}`,
    );
  }
  lines.push("--- END PERSONAL AGENT RULES ---");
  return lines.join("\n");
}

export function renderAttachedPersonalSkills(skills: PersonalSkillDoc[]): string {
  if (!skills.length) return "";
  const lines = [
    "--- ATTACHED PERSONAL SKILLS (only these personal skill definitions are authorized) ---",
  ];
  for (const skill of skills) {
    lines.push(
      `## ${skill.name} (${skill.id}@r${skill.revision})`,
      `Purpose: ${skill.purpose}`,
      `Instructions: ${skill.instructions}`,
      `Input contract: ${skill.inputContract}`,
      `Output contract: ${skill.outputContract}`,
      `Required tools: ${skill.requiredTools.join(", ") || "none"}`,
      `Permission boundary: ${skill.permissionBoundary.allowedTools.join(", ") || "no tools"}`,
    );
  }
  lines.push(
    "Do not invoke, infer, or search for any other personal skill. Ordinary installed skills remain governed separately by load_skill policy.",
    "--- END ATTACHED PERSONAL SKILLS ---",
  );
  return lines.join("\n");
}

function memoryKey(scope: MemoryScope, projectId: string): string {
  if (scope === "none") return "";
  return scope === "global" ? "global" : projectId;
}

async function memorySnapshot(scope: string): Promise<string> {
  if (!scope) return "";
  try {
    const rows = await invoke<MemoryRow[]>("team_memory_search", {
      scope,
      query: "",
      limit: 12,
      kinds: ["fact"],
    });
    if (!rows.length) return "";
    return [
      "PERSONAL AGENT MEMORY SNAPSHOT — resolved for this agent's configured scope:",
      ...rows.map(row => `  • ${row.key ? `[${row.key}] ` : ""}${row.content.replace(/\s*\n+\s*/g, " ").slice(0, 500)}`),
    ].join("\n");
  } catch {
    return "";
  }
}

export async function resolvePersonalAgentRuntime(
  projectId: string,
  ref: RevisionRef | null | undefined,
): Promise<RuntimePersonalAgent | null> {
  if (!ref?.id) return null;
  if (!projectId.trim()) {
    throw new Error(
      `personal agent ${ref.id}@r${ref.revision} requires a project id; refusing to fall back to unrestricted legacy dispatch`,
    );
  }
  const raw = await invoke<BackendEffectiveAgentConfig>("personal_agent_resolve", {
    projectId,
    profileId: ref.id,
  });
  const effective = normalizeEffectiveAgentConfig(raw);
  if (effective.validationErrors.length) {
    throw new Error(`personal agent ${ref.id} is invalid: ${effective.validationErrors.join("; ")}`);
  }
  if (effective.id !== ref.id || effective.revision !== ref.revision) {
    throw new Error(
      `personal agent revision mismatch: requested ${ref.id}@r${ref.revision}, resolved ${effective.id}@r${effective.revision}`,
    );
  }
  const allowedTools = normalizeList(effective.allowedTools);
  const attachedRefs = new Set((effective.personalSkillRefs ?? []).map(skill => `${skill.id}@${skill.revision}`));
  const attachedSkills = (effective.attachedSkills ?? []).filter(skill =>
    skill.status === "active" &&
    attachedRefs.has(`${skill.id}@${skill.revision}`) &&
    ((skill.scope === "global" && !skill.private) || (!!projectId && skill.projectId === projectId)),
  );
  const invalidSkills = attachedSkills.flatMap(skill => {
    const boundary = new Set(normalizeList(skill.permissionBoundary?.allowedTools));
    return normalizeList(skill.requiredTools).flatMap(tool => {
      if (!boundary.has(tool)) return [`${skill.id}@r${skill.revision} requires ${tool} outside its permission boundary`];
      if (!allowedTools.includes(tool)) return [`${skill.id}@r${skill.revision} requires ${tool}, which the agent profile does not allow`];
      return [];
    });
  });
  if (invalidSkills.length) {
    throw new Error(`personal agent ${ref.id} has unauthorized attached skills: ${invalidSkills.join("; ")}`);
  }
  const scope = effective.memoryScope;
  const key = memoryKey(scope, projectId);
  const personalSkillsBlock = renderAttachedPersonalSkills(attachedSkills);
  const rulesBlock = renderRules(effective.attachedRules, effective.provenance);
  return {
    profileRef: { id: ref.id, revision: ref.revision },
    effective: { ...effective, attachedSkills },
    modelId: effective.model?.modelId?.trim() ?? "",
    provider: effective.model?.provider?.trim() || undefined,
    allowedTools,
    skillIds: normalizeList(effective.skillIds),
    memoryScope: scope,
    memoryKey: key,
    memorySnapshot: await memorySnapshot(key),
    rulesBlock: [rulesBlock, personalSkillsBlock].filter(Boolean).join("\n\n"),
    personalSkills: attachedSkills,
  };
}

export async function resolveRuntimeAgents<T extends RuntimeAgentLike>(
  projectId: string,
  agents: T[],
): Promise<T[]> {
  return Promise.all(agents.map(async agent => {
    if (!agent.profileRef) return agent;
    return {
      ...agent,
      runtimePersonal: await resolvePersonalAgentRuntime(projectId, agent.profileRef) ?? undefined,
    };
  }));
}

export function intersectRuntimeTools(
  runtime: RuntimePersonalAgent | undefined,
  legacyRoleTools: string[] | undefined,
): string[] | undefined {
  if (!runtime) return legacyRoleTools;
  const roleUnrestricted = !legacyRoleTools?.length || legacyRoleTools.some(t => t.toLowerCase() === "all");
  const roleSet = new Set(legacyRoleTools ?? []);
  const tools = runtime.allowedTools.filter(tool => roleUnrestricted || roleSet.has(tool));
  if (runtime.memoryScope === "none") {
    for (const name of ["memory_search", "memory_write", "memory_read"]) {
      const i = tools.indexOf(name);
      if (i >= 0) tools.splice(i, 1);
    }
  }
  return [
    PERSONAL_POLICY_MARKER,
    `${PERSONAL_MEMORY_PREFIX}${runtime.memoryKey}`,
    ...runtime.skillIds.map(id => `${PERSONAL_SKILL_PREFIX}${id}`),
    ...tools,
  ];
}

export function policyToolNames(encoded: string[] | undefined): string[] | undefined {
  if (!encoded?.includes(PERSONAL_POLICY_MARKER)) return encoded;
  return encoded.filter(value =>
    value !== PERSONAL_POLICY_MARKER &&
    !value.startsWith(PERSONAL_SKILL_PREFIX) &&
    !value.startsWith(PERSONAL_MEMORY_PREFIX),
  );
}

export function policySkillIds(encoded: string[] | undefined): string[] | undefined {
  if (!encoded?.includes(PERSONAL_POLICY_MARKER)) return undefined;
  return encoded
    .filter(value => value.startsWith(PERSONAL_SKILL_PREFIX))
    .map(value => value.slice(PERSONAL_SKILL_PREFIX.length));
}

export function policyMemoryKey(encoded: string[] | undefined): string | undefined {
  if (!encoded?.includes(PERSONAL_POLICY_MARKER)) return undefined;
  return encoded.find(value => value.startsWith(PERSONAL_MEMORY_PREFIX))
    ?.slice(PERSONAL_MEMORY_PREFIX.length) ?? "";
}

export function assertProviderHonorsPersonalPolicy(
  provider: string,
  modelId: string,
  encoded: string[] | undefined,
): void {
  if (!encoded?.includes(PERSONAL_POLICY_MARKER)) return;
  const tools = policyToolNames(encoded) ?? [];
  const subscription = modelId.startsWith("sub/");
  if (subscription) {
    throw new Error(
      `Personal-agent fail-closed tool permissions are not enforceable on the ${provider} subscription CLI path. ` +
      "Choose a local model or an API model with native OWLLM tool execution.",
    );
  }
  if ((provider === "anthropic" || provider === "gemini") && tools.length > 0) {
    throw new Error(
      `The ${provider} API path does not expose OWLLM tools, but this personal agent requires: ${tools.join(", ")}.`,
    );
  }
}

export function applyDelegationPolicy<T extends RuntimeAgentLike, E extends { source: string; target: string }>(
  agents: T[],
  edges: E[],
): E[] {
  const byName = new Map(agents.map(agent => [agent.name, agent]));
  const hasGraph = edges.length > 0;
  const candidates: E[] = hasGraph
    ? edges
    : agents.flatMap(source => agents
        .filter(target => target.name !== source.name)
        .map(target => ({ source: source.name, target: target.name } as E)));
  return candidates.filter(edge => {
    const source = byName.get(edge.source);
    const target = byName.get(edge.target);
    if (!source || !target) return false;
    const runtime = source.runtimePersonal;
    if (!runtime) return true;
    if (!runtime.effective.delegation.enabled || !target.profileRef?.id) return false;
    return runtime.effective.delegation.allowedProfileIds.includes(target.profileRef.id);
  });
}

export function runtimeModelId(agent: RuntimeAgentLike, legacy: string): string {
  return agent.runtimePersonal?.modelId || legacy;
}

export function runtimeSkillIds(agent: RuntimeAgentLike, legacy: string[]): string[] {
  return agent.runtimePersonal ? agent.runtimePersonal.skillIds : legacy;
}

export function runtimeMemoryKey(agent: RuntimeAgentLike, legacyProjectId: string): string {
  return agent.runtimePersonal ? agent.runtimePersonal.memoryKey : legacyProjectId;
}
