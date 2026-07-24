import {
  activePersonalSkills,
  emptyAgentProfile,
  personalSkillForSave,
  personalSkillFromTemplate,
  normalizePersonalAgentExportBundle,
  profileForSave,
  profileSkillCompatibilityErrors,
  validatePersonalSkillDraft,
  visiblePersonalSkills,
  type PersonalSkillDoc,
} from "./personalAgentConfig";
import { renderAttachedPersonalSkills } from "./personalAgentRuntime";
import {
  emptyPersonalAgentTeam,
  teamSkillCompatibilityErrors,
  validatePersonalAgentTeam,
} from "./personalAgentTeams";

let passed = 0;
function check(label: string, condition: unknown): void {
  if (!condition) throw new Error(`FAILED: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

const now = "2026-07-24T00:00:00.000Z";
const knownTools = ["browser_snapshot", "browser_click", "read_file", "write_file_with_diff"];

console.log("Personal-agent skills verification:\n");

for (const id of ["research", "coding", "planning", "review", "browser"] as const) {
  const draft = personalSkillFromTemplate(id, "project-a", now);
  check(`${id} template is draft-only`, draft.status === "draft");
  check(`${id} template uses safe project/private defaults`,
    draft.scope === "project" && draft.projectId === "project-a" && draft.private);
}

const browser = personalSkillFromTemplate("browser", "project-a", now);
check("browser template declares bounded required tools",
  browser.requiredTools.join(",") === "browser_snapshot,browser_click" &&
  browser.permissionBoundary.allowedTools.join(",") === "browser_snapshot,browser_click");

const malformed = {
  ...personalSkillFromTemplate("research", "project-a", now),
  id: "../escape" as PersonalSkillDoc["id"],
  status: "active" as const,
  purpose: "",
  instructions: "",
  inputContract: "",
  outputContract: "",
};
const malformedErrors = validatePersonalSkillDraft(malformed, knownTools);
check("malformed skill fails clearly", malformedErrors.length >= 5);
check("unsafe/path-like id is rejected", malformedErrors.some(error => /skill id/i.test(error)));

const incompleteDraft = {
  ...personalSkillFromTemplate("research", "project-a", now),
  purpose: "",
  instructions: "",
  inputContract: "",
  outputContract: "",
};
check("incomplete draft remains saveable while structurally safe",
  validatePersonalSkillDraft(incompleteDraft, knownTools).length === 0);
check("the same incomplete definition cannot activate",
  validatePersonalSkillDraft({ ...incompleteDraft, status: "active" }, knownTools)
    .filter(error => /before activation/i.test(error)).length === 4);

const escapedBoundary = {
  ...personalSkillFromTemplate("research", "project-a", now),
  requiredTools: ["read_file"],
  permissionBoundary: { allowedTools: [] },
};
check("required tools cannot escape permission boundary",
  validatePersonalSkillDraft(escapedBoundary, knownTools).some(error => /outside.*permission boundary/i.test(error)));

const unknownTool = {
  ...personalSkillFromTemplate("research", "project-a", now),
  requiredTools: ["shell_everything"],
  permissionBoundary: { allowedTools: ["shell_everything"] },
};
check("unknown tool names fail clearly",
  validatePersonalSkillDraft(unknownTool, knownTools).some(error => /not a registered OWLLM tool/i.test(error)));

const research = personalSkillForSave({
  ...personalSkillFromTemplate("research", "project-a", now),
  status: "active",
}, now);
check("complete active skill passes the local activation gate",
  validatePersonalSkillDraft(research, knownTools).length === 0);

const otherProject = { ...research, id: "personal__other" as const, projectId: "project-b" };
const publicSkill = {
  ...research,
  id: "personal__public" as const,
  scope: "global" as const,
  projectId: undefined,
  private: false,
};
check("private/project filtering exposes only the active project's bodies",
  visiblePersonalSkills([research, otherProject, publicSkill], "project-a").map(skill => skill.id).join(",") ===
  `${research.id},personal__public`);
check("active selector excludes non-active definitions",
  activePersonalSkills([{ ...research, status: "draft" }, publicSkill], "project-a").map(skill => skill.id).join(",") === "personal__public");

const profile = emptyAgentProfile(now);
const savedProfile = profileForSave({
  ...profile,
  personalSkillRefs: [
    { id: research.id, revision: 3 },
    { id: research.id, revision: 4 },
  ],
}, now);
check("profile attachments persist one exact latest supplied revision ref",
  savedProfile.personalSkillRefs.length === 1 &&
  savedProfile.personalSkillRefs[0].id === research.id &&
  savedProfile.personalSkillRefs[0].revision === 4);

const attachedBlock = renderAttachedPersonalSkills([research]);
check("attached personal skill is injected with instructions and contracts",
  attachedBlock.includes(research.id) &&
  attachedBlock.includes(research.instructions) &&
  attachedBlock.includes(research.inputContract) &&
  attachedBlock.includes(research.outputContract));
check("unattached personal skill is absent from the prompt",
  !attachedBlock.includes(otherProject.id));

const team = emptyPersonalAgentTeam([profile], now);
const browserProfile = {
  ...profile,
  allowedTools: ["browser_snapshot", "browser_click"],
  personalSkillRefs: [{ id: browser.id, revision: browser.revision }],
};
const activeBrowser = { ...browser, status: "active" as const };
check("profile save validation rejects attached skills after a required tool is removed",
  profileSkillCompatibilityErrors(
    { ...browserProfile, allowedTools: ["browser_snapshot"] },
    [activeBrowser],
  ).some(error => /must allow browser_click/i.test(error)));
const browserTeam = emptyPersonalAgentTeam([browserProfile], now);
browserTeam.skillRefs = [{ id: browser.id, revision: browser.revision }];
browserTeam.delegationBudget.maxParallel = 1;
check("authorized browser team skill passes the persistent runtime gate",
  teamSkillCompatibilityErrors(browserTeam, [activeBrowser], [browserProfile]).length === 0);
check("team validation accepts the bounded browser workflow",
  validatePersonalAgentTeam(browserTeam, [activeBrowser], [browserProfile]).length === 0);
check("team validation rejects browser skills when a member lacks required tools",
  validatePersonalAgentTeam(browserTeam, [activeBrowser], [profile]).some(error => /must allow/i.test(error)));
team.skillRefs = [{ id: research.id, revision: research.revision }];
check("tool-free active team skill passes compatibility",
  teamSkillCompatibilityErrors(team, [research], [profile]).length === 0);

const roundTrip = JSON.parse(JSON.stringify({
  profile: savedProfile,
  skill: research,
  team,
})) as { profile: typeof savedProfile; skill: PersonalSkillDoc; team: typeof team };
check("persistence round-trip preserves separate exact attachment refs",
  roundTrip.profile.personalSkillRefs[0].revision === 4 &&
  roundTrip.team.skillRefs[0].revision === research.revision &&
  roundTrip.skill.permissionBoundary.allowedTools.length === 0);

check("new personalSkills export field round-trips",
  normalizePersonalAgentExportBundle({
    schemaVersion: 1,
    profiles: [],
    ruleCards: [],
    personalSkills: [research],
  }).personalSkills?.[0].id === research.id);
check("legacy skills export alias remains import-compatible",
  normalizePersonalAgentExportBundle({
    schemaVersion: 1,
    profiles: [],
    ruleCards: [],
    skills: [research],
  }).personalSkills?.[0].id === research.id);

console.log(`\nPASSED: ${passed} personal-agent skill assertions.`);
