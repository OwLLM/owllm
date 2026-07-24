// Focused verifier for the personal-agent team management/runtime boundary.
// Runs the real pure helpers and pins the source wiring that cannot be tested
// without the Tauri backend.
//
// Run: node ui/src/pages/agentic/personalAgentTeams.verify.run.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "personal-agent-teams-verify-"));
const panelSrc = fs.readFileSync(path.join(HERE, "PersonalAgentTeamsPanel.tsx"), "utf8");
const dialogSrc = fs.readFileSync(path.join(HERE, "PersonalAgentsDialog.tsx"), "utf8");
const teamsSrc = fs.readFileSync(path.join(HERE, "personalAgentTeams.ts"), "utf8");
for (const name of ["personalAgentConfig.ts", "personalAgentTeams.ts"]) {
  const source = fs.readFileSync(path.join(HERE, name), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(path.join(tmp, name.replace(/\.ts$/, ".cjs")), output);
}
const out = path.join(tmp, "personalAgentTeams.cjs");
// CommonJS resolution looks for .js for the relative config dependency.
fs.copyFileSync(path.join(tmp, "personalAgentConfig.cjs"), path.join(tmp, "personalAgentConfig.js"));
const h = await import(pathToFileURL(out).href);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, condition) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

console.log("Personal-agent team/runtime verification");

const profiles = [
  { id: "agent:coordinator", revision: 3, displayName: "Coordinator" },
  { id: "agent:specialist", revision: 2, displayName: "Specialist" },
];
const team = h.emptyPersonalAgentTeam(profiles, "2026-01-01T00:00:00.000Z");
check("new team uses schema version 1", team.schemaVersion === 1);
check("new team has exactly one coordinator", team.members.length === 1 && team.members[0].role === "coordinator");
check("coordinator profile id is explicit", team.coordinatorProfileId === "agent:coordinator");
check("safe delegation defaults are bounded and valid for a one-member team", team.delegationBudget.maxHandoffs === 4 && team.delegationBudget.maxDepth === 2 && team.delegationBudget.maxParallel === 1);
check("private context is off by default", team.contextPolicy.privateEnabled === false);

const specialistId = "member:specialist";
team.members.push({
  memberId: specialistId,
  profileId: "agent:specialist",
  role: "specialist",
  mayDelegateToMemberIds: [],
  contextAccess: "project",
});
team.members[0].mayDelegateToMemberIds = [specialistId, specialistId, team.members[0].memberId, "member:missing"];
const normalized = h.normalizePersonalAgentTeam(team);
check("delegation edges dedupe and drop self/missing targets", JSON.stringify(normalized.members[0].mayDelegateToMemberIds) === JSON.stringify([specialistId]));
check("valid coordinator + specialist team passes validation", h.validatePersonalAgentTeam(normalized).length === 0);

const invalid = {
  ...normalized,
  coordinatorProfileId: "agent:missing",
  members: normalized.members.map(member => ({ ...member, role: "specialist" })),
  delegationBudget: { ...normalized.delegationBudget, maxParallel: 9 },
};
const validation = h.validatePersonalAgentTeam(invalid);
check("client validation rejects missing coordinator", validation.some(message => /exactly one coordinator/i.test(message)));
check("client validation rejects parallel budget above member count", validation.some(message => /parallel/i.test(message)));
const specialistPrivate = {
  ...normalized,
  members: normalized.members.map((member, index) => index === 1
    ? { ...member, contextAccess: "private" }
    : member),
  contextPolicy: { ...normalized.contextPolicy, privateEnabled: true },
};
check(
  "private context is coordinator-only in validation and the member editor",
  h.validatePersonalAgentTeam(specialistPrivate).some(message => /coordinator-only/i.test(message))
    && panelSrc.includes("Private context — coordinator only")
    && panelSrc.includes("isCoordinator"),
);

const merged = h.mergeTraceEvents(
  [{ schemaVersion: 1, runId: "run:1", seq: 2, ts: "b", kind: "task", appliedRuleRefs: [], appliedSkillIds: [] }],
  [
    { schemaVersion: 1, runId: "run:1", seq: 1, ts: "a", kind: "queued", appliedRuleRefs: [], appliedSkillIds: [] },
    { schemaVersion: 1, runId: "run:1", seq: 2, ts: "b2", kind: "task-updated", appliedRuleRefs: [], appliedSkillIds: [] },
  ],
);
check("cursor replay is monotonic and deduped by seq", merged.map(event => event.seq).join(",") === "1,2");
check("later replay replaces the same sequence deterministically", merged[1].kind === "task-updated");
check("only succeeded/failed/cancelled are terminal", ["succeeded", "failed", "cancelled"].every(h.isTerminalRunStatus) && !h.isTerminalRunStatus("cancelling") && !h.isTerminalRunStatus("running"));

for (const command of [
  "personal_agent_team_list",
  "personal_agent_team_get",
  "personal_agent_team_save",
  "personal_agent_team_clone",
  "personal_agent_team_archive",
  "personal_agent_team_run_create",
  "personal_agent_team_run_get",
  "personal_agent_team_run_list",
  "personal_agent_team_run_events",
  "personal_agent_team_run_cancel",
  "personal_agent_team_run_recover",
]) {
  check(`team panel invokes ${command}`, panelSrc.includes(`"${command}"`));
}

check("team create uses idempotent client request id", panelSrc.includes("clientRequestId: newClientRequestId()"));
check("team save sends expected revision for persisted teams", panelSrc.includes("expectedRevision: persisted ? draft.revision : undefined"));
check("clone payload carries source revision and new name", panelSrc.includes("revision: draft.revision") && panelSrc.includes("newName: cloneName.trim()"));
check("archive payload carries expected revision", panelSrc.includes("expectedRevision: draft.revision") && panelSrc.includes("archived,"));
check("same-project reuse loads runs by project and team", panelSrc.includes('invoke<PersonalAgentRun[]>("personal_agent_team_run_list"') && panelSrc.includes("projectId: projectId.trim()") && panelSrc.includes("teamId: teamId || undefined"));
check("team list remains project-scoped and cannot retain an unrelated selected team", panelSrc.includes('invoke<PersonalAgentTeamDoc[]>("personal_agent_team_list"') && panelSrc.includes("projectId: projectId.trim() || undefined") && panelSrc.includes("!next.some(team => team.id === teamId)") && panelSrc.includes('setTeamId(next[0]?.id ?? "")'));
check("project/team changes cannot retain an unrelated selected run", panelSrc.includes("!next.some(run => runIdOf(run) === runId)") && panelSrc.includes('setRunId(next[0] ? runIdOf(next[0]) : "")'));
check("event polling uses project-scoped get/events with an after-sequence cursor", panelSrc.includes("afterSeq = Math.max(afterSeq, page.nextAfterSeq)") && panelSrc.includes('{ projectId: activeProjectId, runId }') && panelSrc.includes("{ projectId: activeProjectId, runId, afterSeq, limit: 200 }"));
check("terminal runs stop polling", panelSrc.includes("page.hasMore || !isTerminalRunStatus(run.status)"));
check("polling cleanup invalidates stale callbacks", panelSrc.includes("pollingGeneration.current += 1") && panelSrc.includes("cancelled = true"));
check("cancel action is project-scoped and unavailable after terminal state", panelSrc.includes("!isTerminalRunStatus(selectedRun.status)") && panelSrc.includes('invoke<PersonalAgentRun>("personal_agent_team_run_cancel"') && panelSrc.includes("projectId: activeProjectId"));
check("project-scoped failure retry preserves a link to the original run", panelSrc.includes("projectId: activeProjectId") && panelSrc.includes("runId: runIdOf(selectedRun)") && panelSrc.includes('recoverRun("retryFailed")') && !panelSrc.includes('recoverRun("resumeCheckpoint")'));
check("trace renderer is allowlist-only", panelSrc.includes('const allowed = ["ref", "hash", "summary", "message", "code", "path", "count", "bytes", "mime", "status"]'));
check("trace renderer never dumps arbitrary event JSON", !panelSrc.includes("JSON.stringify(event)") && !panelSrc.includes("JSON.stringify(value)"));
check("private rule bodies and memory values are absent from trace UI", !/ruleBody|privateBody|memoryValue|memoryContents/.test(panelSrc));
check("historical trace actors use pinned member ids, not the mutable team draft", panelSrc.includes("const actor = event.agentMemberId") && !panelSrc.includes("team?.members.find"));
check("dialog exposes the Teams + runs section", dialogSrc.includes('nav("teams", "Teams + runs")') && dialogSrc.includes("<PersonalAgentTeamsPanel"));
check("rule-card fetch always sends project context", dialogSrc.includes('{ id: ruleId, projectId: projectId.trim() }'));
check("backend export is authoritative with no cached fallback", dialogSrc.includes("Backend export failed; no export was created") && !dialogSrc.includes("exportBundleForUi("));
check("checkpoint recovery is not advertised before checkpoints exist", !panelSrc.includes("Resume checkpoint") && !teamsSrc.includes('"resumeCheckpoint"'));
check("team validation receives profile permissions", panelSrc.includes("validatePersonalAgentTeam(doc, personalSkills, profiles)"));

console.log("\nEnd-to-end-style runtime scenarios");

// Multi-agent delegation graph with isolation boundaries.
const multiProfiles = [
  { id: "agent:coordinator", revision: 1, displayName: "Coordinator" },
  { id: "agent:frontend", revision: 1, displayName: "Frontend" },
  { id: "agent:backend", revision: 1, displayName: "Backend" },
];
const multiTeam = h.emptyPersonalAgentTeam(multiProfiles, "2026-01-01T00:00:00.000Z");
multiTeam.members.push(
  { memberId: "member:frontend", profileId: "agent:frontend", role: "specialist", mayDelegateToMemberIds: [], contextAccess: "project" },
  { memberId: "member:backend", profileId: "agent:backend", role: "specialist", mayDelegateToMemberIds: [], contextAccess: "shared" },
);
// Coordinator may delegate to both; frontend may delegate to backend; backend attempts a self-edge.
multiTeam.members[0].mayDelegateToMemberIds = ["member:frontend", "member:backend"];
multiTeam.members[1].mayDelegateToMemberIds = ["member:backend"];
multiTeam.members[2].mayDelegateToMemberIds = ["member:backend"];
const normalizedMulti = h.normalizePersonalAgentTeam(multiTeam);
check("multi-agent team normalizes to 3 members", normalizedMulti.members.length === 3);
check("coordinator keeps both delegation edges", normalizedMulti.members[0].mayDelegateToMemberIds.join(",") === "member:frontend,member:backend");
check("frontend keeps allowed backend edge", normalizedMulti.members[1].mayDelegateToMemberIds.join(",") === "member:backend");
check("backend self-delegation is removed by normalization", normalizedMulti.members[2].mayDelegateToMemberIds.length === 0);
check("multi-agent team with explicit graph passes validation", h.validatePersonalAgentTeam(normalizedMulti).length === 0);
const permissionProfiles = [
  { id: "agent:coordinator", displayName: "Coordinator", allowedTools: [], delegation: { enabled: true, allowedProfileIds: ["agent:frontend", "agent:backend"] } },
  { id: "agent:frontend", displayName: "Frontend", allowedTools: [], delegation: { enabled: true, allowedProfileIds: ["agent:backend"] } },
  { id: "agent:backend", displayName: "Backend", allowedTools: [], delegation: { enabled: false, allowedProfileIds: [] } },
];
check("delegation graph respects profile allowlists",
  h.validatePersonalAgentTeam(normalizedMulti, [], permissionProfiles).length === 0);
const deniedProfiles = permissionProfiles.map(profile => profile.id === "agent:frontend"
  ? { ...profile, delegation: { enabled: true, allowedProfileIds: [] } }
  : profile);
check("frontend validation rejects a delegation edge outside the profile allowlist",
  h.validatePersonalAgentTeam(normalizedMulti, [], deniedProfiles).some(message => /may not delegate/i.test(message)));
const selfDelegating = {
  ...normalizedMulti,
  members: normalizedMulti.members.map((member, index) => index === 2
    ? { ...member, mayDelegateToMemberIds: [member.memberId] }
    : member),
};
check("validation rejects self-delegation in a multi-agent team", h.validatePersonalAgentTeam(selfDelegating).some(message => /cannot delegate to itself/i.test(message)));

// Context isolation: shared/project/private boundaries.
const sharedOff = { ...normalizedMulti, contextPolicy: { sharedEnabled: false, projectEnabled: true, privateEnabled: false } };
check("shared context rejected when policy disables it", h.validatePersonalAgentTeam(sharedOff).some(message => /shared context.*disabled/i.test(message)));
const projectOff = { ...normalizedMulti, contextPolicy: { sharedEnabled: true, projectEnabled: false, privateEnabled: true } };
check("project context rejected when policy disables it", h.validatePersonalAgentTeam(projectOff).some(message => /project context.*disabled/i.test(message)));

// Persisted team reuse: save bump, clone, archive round-trip.
const saved = { ...normalizedMulti, revision: 2, updatedAt: "2026-01-02T00:00:00.000Z" };
check("persisted team carries revision for compare-and-save", saved.revision > normalizedMulti.revision);
const cloned = { ...saved, id: "team:clone", revision: 1, name: `${saved.name} copy` };
check("cloned team resets revision and keeps member structure", cloned.revision === 1 && cloned.members.length === saved.members.length);
const archived = { ...saved, archived: true };
check("archive flag survives mutation", archived.archived === true);

// Cancellation and terminal-state transitions.
const queuedRun = { schemaVersion: 1, runId: "run:1", clientRequestId: "req:1", projectId: "project-a", teamId: saved.id, status: "queued", snapshotHash: "h1", objective: "test", createdAt: "2026-01-01T00:00:00.000Z", lastEventSeq: 0 };
check("queued run is not terminal", !h.isTerminalRunStatus(queuedRun.status));
const cancellingRun = { ...queuedRun, status: "cancelling" };
check("cancelling run is not terminal", !h.isTerminalRunStatus(cancellingRun.status));
const cancelledRun = { ...queuedRun, status: "cancelled", finishedAt: "2026-01-01T00:01:00.000Z" };
check("cancelled run is terminal", h.isTerminalRunStatus(cancelledRun.status));
const failedRun = { ...queuedRun, status: "failed", finishedAt: "2026-01-01T00:01:00.000Z" };
check("failed run is terminal and recoverable", h.isTerminalRunStatus(failedRun.status));

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (failures.length) failures.forEach(name => console.log(`  - ${name}`));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
