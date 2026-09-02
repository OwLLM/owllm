import {
  PERSONAL_POLICY_MARKER,
  applyDelegationPolicy,
  assertProviderHonorsPersonalPolicy,
  intersectRuntimeTools,
  policyMemoryKey,
  policySkillIds,
  policyToolNames,
  resolvePersonalAgentRuntime,
  runtimeMemoryKey,
  runtimeModelId,
  runtimeSkillIds,
  type RuntimePersonalAgent,
} from "./personalAgentRuntime";
import type { EffectiveAgentConfig } from "./personalAgentConfig";

let passed = 0;
function check(label: string, condition: unknown): void {
  if (!condition) throw new Error(`FAILED: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

function rejects(label: string, fn: () => void, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    check(label, pattern.test(String((error as Error).message)));
    return;
  }
  throw new Error(`FAILED: ${label} (did not throw)`);
}

const now = "2026-07-24T00:00:00.000Z";
const effective: EffectiveAgentConfig = {
  schemaVersion: 1,
  id: "agent:alice",
  revision: 4,
  displayName: "Alice",
  identity: { name: "Alice", color: "#123456" },
  role: "careful coder",
  systemInstructions: "Never widen permissions.",
  model: { provider: "openai", modelId: "api/openai/gpt-test" },
  allowedTools: ["read_file", "write_file", "memory_read"],
  memoryScope: "project",
  delegation: { enabled: true, allowedProfileIds: ["agent:bob"] },
  skillIds: ["engineering-craft"],
  personalSkillRefs: [],
  ruleCardRefs: [{ id: "rule:private", revision: 2 }],
  createdAt: now,
  updatedAt: now,
  provenance: {
    "ruleCards.rule:private@2": {
      source: "rule-card",
      documentId: "rule:private",
      revision: 2,
    },
  },
  attachedRules: [{
    schemaVersion: 1,
    id: "rule:private",
    revision: 2,
    kind: "constraint",
    title: "Project-only",
    body: "Do not expose this outside project-a.",
    scope: "project",
    projectId: "project-a",
    private: true,
    createdAt: now,
    updatedAt: now,
  }],
  attachedSkills: [],
  ruleSets: { sets: [], applied: [], superseded: [], errors: [] },
  validationErrors: [],
};

const runtime: RuntimePersonalAgent = {
  profileRef: { id: "agent:alice", revision: 4 },
  effective,
  modelId: "api/openai/gpt-test",
  provider: "openai",
  allowedTools: effective.allowedTools,
  skillIds: effective.skillIds,
  memoryScope: "project",
  memoryKey: "project-a",
  memorySnapshot: "private snapshot",
  rulesBlock: "private rules",
  personalSkills: [],
};

console.log("Personal-agent runtime verification:\n");

const intersected = intersectRuntimeTools(runtime, ["read_file", "memory_read", "shell"]);
check("personal policy marker is encoded", intersected?.includes(PERSONAL_POLICY_MARKER));
check("permissions use fail-closed profile ∩ role intersection",
  JSON.stringify(policyToolNames(intersected)) === JSON.stringify(["read_file", "memory_read"]));
check("attached skills are encoded exactly",
  JSON.stringify(policySkillIds(intersected)) === JSON.stringify(["engineering-craft"]));
check("project memory key is encoded", policyMemoryKey(intersected) === "project-a");

const denyRuntime = {
  ...runtime,
  allowedTools: [],
  memoryScope: "none" as const,
  memoryKey: "",
};
const denied = intersectRuntimeTools(denyRuntime, undefined);
check("explicit empty personal allowlist remains deny-all", policyToolNames(denied)?.length === 0);
check("memory none encodes an empty scope", policyMemoryKey(denied) === "");

const alice = { name: "alice", profileRef: runtime.profileRef, runtimePersonal: runtime };
const bob = { name: "bob", profileRef: { id: "agent:bob", revision: 1 } };
const eve = { name: "eve", profileRef: { id: "agent:eve", revision: 1 } };
const edges = applyDelegationPolicy(
  [alice, bob, eve],
  [{ source: "alice", target: "bob" }, { source: "alice", target: "eve" }, { source: "bob", target: "eve" }],
);
check("delegation keeps only explicitly allowed personal targets",
  edges.some(edge => edge.source === "alice" && edge.target === "bob") &&
  !edges.some(edge => edge.source === "alice" && edge.target === "eve"));
check("legacy source delegation remains compatible",
  edges.some(edge => edge.source === "bob" && edge.target === "eve"));

check("personal model overrides legacy role model", runtimeModelId(alice, "legacy-model") === runtime.modelId);
check("personal attached skills replace legacy role skills",
  JSON.stringify(runtimeSkillIds(alice, ["legacy-skill"])) === JSON.stringify(["engineering-craft"]));
check("personal memory scope replaces legacy project memory",
  runtimeMemoryKey(alice, "legacy-project") === "project-a");

rejects(
  "subscription CLI paths fail closed for personal permissions",
  () => assertProviderHonorsPersonalPolicy("codex", "sub/codex/gpt", intersected),
  /not enforceable/i,
);
rejects(
  "tool-less API paths reject personal agents that require tools",
  () => assertProviderHonorsPersonalPolicy("anthropic", "api/anthropic/claude", intersected),
  /does not expose OWLLM tools/i,
);

type InvokeHandler = (command: string, args: unknown) => unknown | Promise<unknown>;
(globalThis as unknown as { __personalAgentInvoke: InvokeHandler }).__personalAgentInvoke =
  async (command) => {
    if (command === "personal_agent_resolve") {
      return effective;
    }
    if (command === "team_memory_search") {
      return [{ id: 1, key: "private", content: "project-a only", tags: "", author: "test", ts: 1, kind: "fact" }];
    }
    throw new Error(`unexpected command: ${command}`);
  };

void resolvePersonalAgentRuntime("project-a", { id: "agent:alice", revision: 4 }).then(resolved => {
  check("backend effective config resolves at its exact pinned revision",
    resolved?.profileRef.id === "agent:alice" && resolved.profileRef.revision === 4);
  check("resolved project memory snapshot is scoped to the active project",
    resolved?.memoryKey === "project-a" && resolved.memorySnapshot.includes("project-a only"));
  check("resolved private rule is injected only from backend-selected attached rules",
    !!resolved?.rulesBlock.includes("rule:private@r2") && !!resolved.rulesBlock.includes("private"));
  check("resolved rule instructions include deterministic provenance",
    !!resolved?.rulesBlock.includes("provenance=rule-card/rule:private@r2"));
  return resolvePersonalAgentRuntime("", { id: "agent:alice", revision: 4 })
    .then(() => { throw new Error("FAILED: missing project id did not fail closed"); })
    .catch(error => {
      check("pinned profile with missing project id fails closed",
        /requires a project id.*refusing to fall back/i.test(String((error as Error).message)));
      console.log(`\nPASSED: ${passed} personal-agent runtime assertions.`);
    });
});
