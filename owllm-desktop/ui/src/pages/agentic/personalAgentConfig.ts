import type { RuleSetResolution } from "./agentRuleSets";

export const PERSONAL_AGENT_SCHEMA_VERSION = 1 as const;

export type MemoryScope = "none" | "project" | "global";
export type RuleCardKind = "fact" | "preference" | "constraint" | "workflow" | "conditional";
export type RuleCardScope = "global" | "project";
export type RevisionRef = { id: string; revision: number };
export type PersonalSkillStatus = "draft" | "active" | "archived" | "quarantined";
export type PersonalSkillScope = "global" | "project";
export type PersonalSkillTemplateId = "research" | "coding" | "planning" | "review" | "browser";

export type PersonalSkillDoc = {
  schemaVersion: 1;
  id: `personal__${string}`;
  revision: number;
  name: string;
  purpose: string;
  instructions: string;
  requiredTools: string[];
  inputContract: string;
  outputContract: string;
  permissionBoundary: { allowedTools: string[] };
  scope: PersonalSkillScope;
  projectId?: string;
  private: boolean;
  status: PersonalSkillStatus;
  createdAt: string;
  updatedAt: string;
};

export type PersonalSkillValidationResult = {
  valid: boolean;
  errors: string[];
};

export type AgentProfileDoc = {
  schemaVersion: 1;
  id: `agent:${string}`;
  revision: number;
  displayName: string;
  identity: { name: string; avatar?: string; color?: string };
  role: string;
  systemInstructions: string;
  model: { provider?: string; modelId?: string };
  allowedTools: string[];
  memoryScope: MemoryScope;
  delegation: { enabled: boolean; allowedProfileIds: string[] };
  skillIds: string[];
  personalSkillRefs: RevisionRef[];
  ruleCardRefs: RevisionRef[];
  createdAt: string;
  updatedAt: string;
};

export type RuleCardDoc = {
  schemaVersion: 1;
  id: `rule:${string}`;
  revision: number;
  kind: RuleCardKind;
  title: string;
  body: string;
  condition?: { projectIds?: string[] };
  scope: RuleCardScope;
  projectId?: string;
  private: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProfileOverride = {
  systemInstructions?: string;
  model?: { provider?: string; modelId?: string };
  allowedTools?: string[];
  memoryScope?: MemoryScope;
  delegation?: { enabled?: boolean; allowedProfileIds?: string[] };
  skillIds?: string[];
  personalSkillRefs?: RevisionRef[];
  ruleCardRefs?: RevisionRef[];
  /// Per-agent rule-set assignment — the high-precedence layer. Project-scoped
  /// by construction: it lives on the project config, not on the global profile.
  ruleSetRefs?: RevisionRef[];
};

export type ProjectAgentConfigDoc = {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  profileRefs: RevisionRef[];
  ruleCardRefs: RevisionRef[];
  /// Project-wide rule-set assignment — the low-precedence layer.
  ruleSetRefs: RevisionRef[];
  profileOverrides: Record<string, ProfileOverride>;
  createdAt: string;
  updatedAt: string;
};

export type EffectiveRule = RuleCardDoc & { provenance?: string };
export type ProvenanceEntry = {
  source: string;
  documentId: string;
  revision: number;
};
export type EffectiveAgentConfig = AgentProfileDoc & {
  provenance: Record<string, ProvenanceEntry>;
  attachedRules: EffectiveRule[];
  attachedSkills: PersonalSkillDoc[];
  /// The resolved rule-set stack. Its winning rules are already inside
  /// attachedRules; this carries the order and everything a higher-precedence
  /// set overruled, so a superseded rule is visible rather than just absent.
  ruleSets: RuleSetResolution;
  validationErrors: string[];
};
export type BackendEffectiveAgentConfig = Omit<EffectiveAgentConfig, "attachedRules" | "attachedSkills" | "ruleSets"> & {
  profile?: AgentProfileDoc;
  attachedRules?: EffectiveRule[];
  attachedRuleCards?: EffectiveRule[];
  attachedSkills?: PersonalSkillDoc[];
  ruleSets?: RuleSetResolution;
};

export type PersonalAgentExportBundle = {
  schemaVersion: 1;
  profiles: AgentProfileDoc[];
  ruleCards: RuleCardDoc[];
  personalSkills?: PersonalSkillDoc[];
  /** Legacy import alias. New exports use personalSkills. */
  skills?: PersonalSkillDoc[];
  projectConfigs?: ProjectAgentConfigDoc[];
  validationErrors?: string[];
};

function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function emptyAgentProfile(now = new Date().toISOString()): AgentProfileDoc {
  return {
    schemaVersion: PERSONAL_AGENT_SCHEMA_VERSION,
    id: `agent:${uid()}`,
    revision: 1,
    displayName: "New personal agent",
    identity: { name: "Personal Agent", color: "#7fd4ff" },
    role: "assistant",
    systemInstructions: "",
    model: {},
    allowedTools: [],
    memoryScope: "project",
    delegation: { enabled: false, allowedProfileIds: [] },
    skillIds: [],
    personalSkillRefs: [],
    ruleCardRefs: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function emptyPersonalSkill(
  now = new Date().toISOString(),
  projectId = "",
): PersonalSkillDoc {
  return {
    schemaVersion: PERSONAL_AGENT_SCHEMA_VERSION,
    id: `personal__${uid()}`,
    revision: 1,
    name: "New personal skill",
    purpose: "",
    instructions: "",
    requiredTools: [],
    inputContract: "",
    outputContract: "",
    permissionBoundary: { allowedTools: [] },
    scope: "project",
    projectId: projectId.trim() || undefined,
    private: true,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

const PERSONAL_SKILL_TEMPLATES: Record<PersonalSkillTemplateId, {
  name: string;
  purpose: string;
  instructions: string;
  inputContract: string;
  outputContract: string;
  requiredTools?: string[];
}> = {
  research: {
    name: "Research brief",
    purpose: "Collect reliable evidence and turn it into a concise, source-aware brief.",
    instructions: "Clarify the question, inspect available evidence, distinguish fact from inference, and report gaps.",
    inputContract: "A research question, scope, and any source constraints.",
    outputContract: "A concise brief with findings, evidence references, uncertainty, and next steps.",
  },
  coding: {
    name: "Focused implementation",
    purpose: "Implement a small, verified code change while preserving project conventions.",
    instructions: "Inspect before editing, make the smallest root-cause change, and verify with the project's checks.",
    inputContract: "A concrete change request, repository context, and acceptance criteria.",
    outputContract: "Changed files, behavior delivered, verification result, and remaining risks.",
  },
  planning: {
    name: "Execution plan",
    purpose: "Turn a goal into a dependency-aware, verifiable execution plan.",
    instructions: "Identify assumptions, smallest tasks, owners, dependencies, risks, and a clear definition of done.",
    inputContract: "A goal, constraints, known context, and desired deadline or scope.",
    outputContract: "An ordered plan with owners, dependencies, checks, and explicit open decisions.",
  },
  review: {
    name: "Adversarial review",
    purpose: "Review a change for correctness, completeness, permissions, and untested failure modes.",
    instructions: "Trace real call paths, reproduce concrete risks, separate blockers from polish, and give an evidence-backed verdict.",
    inputContract: "A change, diff, design, or artifact plus its acceptance criteria.",
    outputContract: "Findings ordered by severity, verification evidence, gaps, and APPROVE or REVISE.",
  },
  browser: {
    name: "Browser and tool workflow",
    purpose: "Operate an authorized browser or tool workflow with visible, bounded actions.",
    instructions: "Inspect state before acting, use only authorized tools, confirm destructive steps, and report observed results.",
    inputContract: "A target page or tool task, allowed actions, and success criteria.",
    outputContract: "Observed state, actions taken, final state, and any permission or tool failures.",
    requiredTools: ["browser_snapshot", "browser_click"],
  },
};

export function personalSkillFromTemplate(
  templateId: PersonalSkillTemplateId,
  projectId = "",
  now = new Date().toISOString(),
): PersonalSkillDoc {
  const template = PERSONAL_SKILL_TEMPLATES[templateId];
  const skill = emptyPersonalSkill(now, projectId);
  const requiredTools = normalizeStringList(template.requiredTools);
  return {
    ...skill,
    name: template.name,
    purpose: template.purpose,
    instructions: template.instructions,
    inputContract: template.inputContract,
    outputContract: template.outputContract,
    requiredTools,
    permissionBoundary: { allowedTools: requiredTools },
    status: "draft",
  };
}

export function emptyRuleCard(now = new Date().toISOString(), projectId = ""): RuleCardDoc {
  return {
    schemaVersion: PERSONAL_AGENT_SCHEMA_VERSION,
    id: `rule:${uid()}`,
    revision: 1,
    kind: "fact",
    title: "New rule",
    body: "",
    scope: projectId ? "project" : "global",
    projectId: projectId || undefined,
    private: !!projectId,
    createdAt: now,
    updatedAt: now,
  };
}

export function emptyProjectAgentConfig(projectId: string, now = new Date().toISOString()): ProjectAgentConfigDoc {
  return {
    schemaVersion: PERSONAL_AGENT_SCHEMA_VERSION,
    projectId,
    revision: 1,
    profileRefs: [],
    ruleCardRefs: [],
    ruleSetRefs: [],
    profileOverrides: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(String).map(v => v.trim()).filter(Boolean))];
}

export function profileForSave(profile: AgentProfileDoc, now = new Date().toISOString()): AgentProfileDoc {
  return {
    ...profile,
    schemaVersion: 1,
    displayName: profile.displayName.trim() || "Personal agent",
    identity: {
      name: profile.identity.name.trim() || profile.displayName.trim() || "Personal Agent",
      ...(profile.identity.avatar?.trim() ? { avatar: profile.identity.avatar.trim() } : {}),
      ...(profile.identity.color?.trim() ? { color: profile.identity.color.trim() } : {}),
    },
    role: profile.role.trim() || "assistant",
    systemInstructions: profile.systemInstructions.trim(),
    model: {
      ...(profile.model.provider?.trim() ? { provider: profile.model.provider.trim() } : {}),
      ...(profile.model.modelId?.trim() ? { modelId: profile.model.modelId.trim() } : {}),
    },
    allowedTools: normalizeStringList(profile.allowedTools),
    delegation: {
      enabled: !!profile.delegation.enabled,
      allowedProfileIds: profile.delegation.enabled
        ? normalizeStringList(profile.delegation.allowedProfileIds).filter(id => id !== profile.id)
        : [],
    },
    skillIds: normalizeStringList(profile.skillIds),
    personalSkillRefs: dedupeRefs(profile.personalSkillRefs ?? []),
    ruleCardRefs: dedupeRefs(profile.ruleCardRefs),
    updatedAt: now,
  };
}

export function profileSkillCompatibilityErrors(
  profile: AgentProfileDoc,
  skills: PersonalSkillDoc[],
): string[] {
  const byRef = new Map(skills.map(skill => [`${skill.id}@${skill.revision}`, skill]));
  const allowed = new Set(profile.allowedTools);
  const errors: string[] = [];
  for (const reference of profile.personalSkillRefs ?? []) {
    const skill = byRef.get(`${reference.id}@${reference.revision}`);
    if (!skill) continue;
    const missing = skill.requiredTools.filter(tool => !allowed.has(tool));
    if (missing.length) {
      errors.push(
        `${profile.displayName} must allow ${missing.join(", ")} before attaching ${skill.name}.`,
      );
    }
  }
  return errors;
}

export function personalSkillForSave(
  skill: PersonalSkillDoc,
  now = new Date().toISOString(),
): PersonalSkillDoc {
  const scope = skill.scope;
  const requiredTools = normalizeStringList(skill.requiredTools);
  const allowedTools = normalizeStringList(skill.permissionBoundary?.allowedTools);
  return {
    ...skill,
    schemaVersion: PERSONAL_AGENT_SCHEMA_VERSION,
    id: skill.id.trim() as PersonalSkillDoc["id"],
    name: skill.name.trim() || "Untitled personal skill",
    purpose: skill.purpose.trim(),
    instructions: skill.instructions.trim(),
    requiredTools,
    inputContract: skill.inputContract.trim(),
    outputContract: skill.outputContract.trim(),
    permissionBoundary: { allowedTools },
    scope,
    projectId: scope === "project" ? skill.projectId?.trim() || undefined : undefined,
    private: scope === "project" ? !!skill.private : false,
    updatedAt: now,
  };
}

export function validatePersonalSkillDraft(
  skill: PersonalSkillDoc,
  knownTools?: string[],
): string[] {
  const errors: string[] = [];
  const allowed = new Set(normalizeStringList(skill.permissionBoundary?.allowedTools));
  const known = knownTools ? new Set(normalizeStringList(knownTools)) : null;
  if (!/^personal__[a-z0-9_-]+$/i.test(skill.id)) {
    errors.push("Skill id must start with personal__ and contain only letters, numbers, underscores, or hyphens.");
  }
  if (!skill.name.trim()) errors.push("Skill name is required.");
  if (skill.status === "active") {
    if (!skill.purpose.trim()) errors.push("Purpose is required before activation.");
    if (!skill.instructions.trim()) errors.push("Instructions are required before activation.");
    if (!skill.inputContract.trim()) errors.push("Input contract is required before activation.");
    if (!skill.outputContract.trim()) errors.push("Output contract is required before activation.");
  }
  if (skill.scope === "project" && !skill.projectId?.trim()) errors.push("Project-scoped skills require a project id.");
  for (const tool of normalizeStringList(skill.requiredTools)) {
    if (!allowed.has(tool)) errors.push(`Required tool ${tool} is outside the skill permission boundary.`);
    if (known && !known.has(tool)) errors.push(`Required tool ${tool} is not a registered OWLLM tool.`);
  }
  for (const tool of allowed) {
    if (known && !known.has(tool)) errors.push(`Permission tool ${tool} is not a registered OWLLM tool.`);
  }
  return [...new Set(errors)];
}

export function visiblePersonalSkills(
  skills: PersonalSkillDoc[],
  projectId: string,
): PersonalSkillDoc[] {
  return skills.filter(skill => {
    if (skill.scope === "global") return !skill.private;
    return !!projectId && skill.projectId === projectId;
  });
}

export function activePersonalSkills(
  skills: PersonalSkillDoc[],
  projectId: string,
): PersonalSkillDoc[] {
  return visiblePersonalSkills(skills, projectId).filter(skill => skill.status === "active");
}

export function normalizePersonalAgentExportBundle(raw: unknown): PersonalAgentExportBundle {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<PersonalAgentExportBundle>;
  return {
    schemaVersion: 1,
    profiles: Array.isArray(value.profiles) ? value.profiles : [],
    ruleCards: Array.isArray(value.ruleCards) ? value.ruleCards : [],
    personalSkills: Array.isArray(value.personalSkills)
      ? value.personalSkills
      : Array.isArray(value.skills) ? value.skills : [],
    projectConfigs: Array.isArray(value.projectConfigs) ? value.projectConfigs : [],
    validationErrors: Array.isArray(value.validationErrors) ? value.validationErrors.map(String) : [],
  };
}

export function ruleCardForSave(rule: RuleCardDoc, now = new Date().toISOString()): RuleCardDoc {
  const projectId = rule.scope === "project" ? rule.projectId?.trim() : undefined;
  return {
    ...rule,
    schemaVersion: 1,
    title: rule.title.trim() || "Untitled rule",
    body: rule.body.trim(),
    scope: rule.scope,
    projectId: projectId || undefined,
    private: rule.scope === "project" && rule.private,
    condition: rule.kind === "conditional"
      ? { projectIds: normalizeStringList(rule.condition?.projectIds) }
      : undefined,
    updatedAt: now,
  };
}

export function dedupeRefs(refs: RevisionRef[]): RevisionRef[] {
  const out = new Map<string, RevisionRef>();
  for (const ref of refs ?? []) {
    if (!ref?.id) continue;
    out.set(ref.id, { id: ref.id, revision: Math.max(0, Number(ref.revision) || 0) });
  }
  return [...out.values()];
}

export function visibleRuleCards(cards: RuleCardDoc[], projectId: string): RuleCardDoc[] {
  return cards.filter(card => {
    if (card.scope === "global") return !card.private;
    return !!projectId && card.projectId === projectId;
  });
}

export function expectedRevisionForSave(isPersisted: boolean, revision: number): number | undefined {
  return isPersisted ? revision : undefined;
}

export function normalizeEffectiveAgentConfig(raw: BackendEffectiveAgentConfig): EffectiveAgentConfig {
  const profile = raw.profile ?? raw;
  return {
    ...profile,
    personalSkillRefs: profile.personalSkillRefs ?? [],
    provenance: raw.provenance ?? {},
    attachedRules: raw.attachedRuleCards ?? raw.attachedRules ?? [],
    attachedSkills: raw.attachedSkills ?? [],
    ruleSets: raw.ruleSets ?? { sets: [], applied: [], superseded: [], errors: [] },
    validationErrors: raw.validationErrors ?? [],
  };
}

export function permissionIntersection(
  profileTools: string[],
  projectTools?: string[],
): { tools: string[]; explanation: string; failClosed: boolean } {
  const base = normalizeStringList(profileTools);
  if (projectTools === undefined) {
    return {
      tools: base,
      explanation: "Effective tools come from the profile allowlist. Project rules did not widen permissions.",
      failClosed: true,
    };
  }
  const project = new Set(normalizeStringList(projectTools));
  const tools = base.filter(tool => project.has(tool));
  return {
    tools,
    explanation: `Fail-closed intersection: profile (${base.length}) ∩ project override (${project.size}) = ${tools.length}. Permissions are never additive.`,
    failClosed: true,
  };
}

export function exportBundleForUi(
  profiles: AgentProfileDoc[],
  cards: RuleCardDoc[],
  projectConfigs: ProjectAgentConfigDoc[],
  includePrivate = false,
): PersonalAgentExportBundle {
  const allowedRules = cards.filter(card => includePrivate || !card.private);
  const allowedIds = new Set<string>(allowedRules.map(card => card.id));
  return {
    schemaVersion: 1,
    profiles: profiles.map(profile => ({
      ...profile,
      ruleCardRefs: profile.ruleCardRefs.filter(ref => allowedIds.has(ref.id)),
    })),
    ruleCards: allowedRules,
    projectConfigs: projectConfigs.map(config => ({
      ...config,
      ruleCardRefs: config.ruleCardRefs.filter(ref => allowedIds.has(ref.id)),
      profileOverrides: Object.fromEntries(Object.entries(config.profileOverrides).map(([id, override]) => [
        id,
        {
          ...override,
          ruleCardRefs: override.ruleCardRefs?.filter(ref => allowedIds.has(ref.id)),
        },
      ])),
    })),
  };
}

export function revisionConflictMessage(kind: "profile" | "rule" | "skill" | "project", id: string, error: unknown): string {
  const raw = String((error as { message?: string })?.message ?? error);
  if (/revision|conflict|stale|compare.?and.?swap/i.test(raw)) {
    return `${kind} ${id} changed in another window or process. Reload it before saving; your edits remain in this form. (${raw})`;
  }
  return raw;
}
