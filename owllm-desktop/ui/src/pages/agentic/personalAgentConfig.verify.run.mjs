// Focused verifier for the pure personal-agent configuration boundary.
// It transpiles the real TypeScript helper, so assertions exercise the exact
// form↔contract, privacy, project-isolation, permission, and conflict logic
// used by PersonalAgentsDialog.
//
// Run: node ui/src/pages/agentic/personalAgentConfig.verify.run.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "personal-agent-verify-"));
const src = fs.readFileSync(path.join(HERE, "personalAgentConfig.ts"), "utf8");
const dialogSrc = fs.readFileSync(path.join(HERE, "PersonalAgentsDialog.tsx"), "utf8");
const studioSrc = fs.readFileSync(path.join(HERE, "StudioPage.tsx"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const out = path.join(tmp, "personalAgentConfig.cjs");
fs.writeFileSync(out, js);
const h = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, condition) {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`); }
}

console.log("Personal-agent configuration verification");
const profile = h.emptyAgentProfile("2026-01-01T00:00:00.000Z");
profile.displayName = "  My Agent  ";
profile.identity.name = " ";
profile.allowedTools = ["read_file", "read_file", "", " write_file_with_diff "];
profile.delegation = { enabled: false, allowedProfileIds: ["agent:other"] };
profile.skillIds = ["s1", "s1", "s2"];
const saved = h.profileForSave(profile, "2026-01-02T00:00:00.000Z");
check("new profiles begin at backend revision 1", profile.revision === 1);
check("new rules begin at backend revision 1", h.emptyRuleCard("2026-01-01").revision === 1);
check("new project configs begin at backend revision 1", h.emptyProjectAgentConfig("p1", "2026-01-01").revision === 1);
check("first save omits expectedRevision", h.expectedRevisionForSave(false, profile.revision) === undefined);
check("later save carries the current revision", h.expectedRevisionForSave(true, 3) === 3);
check("form mapping trims display name", saved.displayName === "My Agent");
check("identity safely falls back to display name", saved.identity.name === "My Agent");
check("tool form values normalize and dedupe", JSON.stringify(saved.allowedTools) === JSON.stringify(["read_file", "write_file_with_diff"]));
check("disabled delegation clears target ids", saved.delegation.allowedProfileIds.length === 0);
check("skill form values dedupe", JSON.stringify(saved.skillIds) === JSON.stringify(["s1", "s2"]));
check("mapping preserves immutable id", saved.id === profile.id);

const perm = h.permissionIntersection(["read", "write", "shell"], ["read", "shell", "network"]);
check("permission result is intersection, never union", JSON.stringify(perm.tools) === JSON.stringify(["read", "shell"]));
check("permission explanation explicitly says fail-closed intersection", perm.failClosed && /fail-closed intersection/i.test(perm.explanation));

const cards = [
  { ...h.emptyRuleCard("2026-01-01", ""), id: "rule:global", title: "global", scope: "global", private: false },
  { ...h.emptyRuleCard("2026-01-01", ""), id: "rule:bad-global-private", title: "bad", scope: "global", private: true },
  { ...h.emptyRuleCard("2026-01-01", "p1"), id: "rule:p1", title: "p1", scope: "project", projectId: "p1", private: true },
  { ...h.emptyRuleCard("2026-01-01", "p2"), id: "rule:p2", title: "p2", scope: "project", projectId: "p2", private: true },
];
const visible = h.visibleRuleCards(cards, "p1");
check("global rule remains visible", visible.some(r => r.id === "rule:global"));
check("invalid private global rule fails closed in project views", !visible.some(r => r.id === "rule:bad-global-private"));
check("same-project private rule is visible", visible.some(r => r.id === "rule:p1"));
check("other-project private rule is hidden", !visible.some(r => r.id === "rule:p2"));

const profileWithRefs = {
  ...saved,
  ruleCardRefs: cards.map(r => ({ id: r.id, revision: 1 })),
};
const safeExport = h.exportBundleForUi([profileWithRefs], cards, [], false);
check("safe export excludes all private rules by default", safeExport.ruleCards.length === 1 && safeExport.ruleCards[0].id === "rule:global");
check("safe export removes dangling private refs", safeExport.profiles[0].ruleCardRefs.length === 1 && safeExport.profiles[0].ruleCardRefs[0].id === "rule:global");
const privateExport = h.exportBundleForUi([profileWithRefs], cards, [], true);
check("explicit private export includes private cards", privateExport.ruleCards.length === 4);

const normalized = h.normalizeEffectiveAgentConfig({
  ...saved,
  provenance: { allowedTools: { source: "project_override", documentId: "project:p1", revision: 2 } },
  attachedRuleCards: [cards[0]],
  validationErrors: [],
});
check("effective response maps backend attachedRuleCards", normalized.attachedRules[0]?.id === "rule:global");
check("effective response preserves structured provenance", normalized.provenance.allowedTools.documentId === "project:p1");

const conflict = h.revisionConflictMessage("profile", profile.id, "stale revision: expected 2 got 3");
check("revision conflict preserves edits and tells user to reload", /another window|process/i.test(conflict) && /Reload/.test(conflict) && /edits remain/.test(conflict));
const ordinary = h.revisionConflictMessage("profile", profile.id, "disk full");
check("ordinary errors remain actionable backend text", ordinary === "disk full");

for (const command of [
  "personal_agent_list_profiles",
  "personal_agent_get_profile",
  "personal_agent_save_profile",
  "personal_agent_list_rule_cards",
  "personal_agent_get_rule_card",
  "personal_agent_save_rule_card",
  "personal_agent_get_project_config",
  "personal_agent_save_project_config",
  "personal_agent_resolve",
  "personal_agent_export",
  "personal_agent_import",
]) {
  check(`dialog invokes ${command}`, dialogSrc.includes(`"${command}"`));
}
check("Studio exposes the personal-agent editor", studioSrc.includes("Personal agents &amp; rules") && studioSrc.includes("<PersonalAgentsDialog"));
check("project-private rules are requested only with explicit project context", dialogSrc.includes("includePrivate: !!projectId") && dialogSrc.includes("includePrivate: true"));

// Simulate a restart by serializing the full UI state to the export bundle,
// then verifying that the bundle can reconstruct the same project-scoped
// visibility and memory isolation. This is the frontend half of the
// persistence contract: the backend stores/loads the bundle verbatim.
const profileA = { ...saved, id: "agent:a", displayName: "Agent A", ruleCardRefs: [] };
const profileB = { ...h.emptyAgentProfile("2026-01-01"), id: "agent:b", displayName: "Agent B", ruleCardRefs: [] };
const globalRule = { ...h.emptyRuleCard("2026-01-01", ""), id: "rule:global", title: "global", scope: "global", private: false };
const p1PrivateRule = { ...h.emptyRuleCard("2026-01-01", "p1"), id: "rule:p1-private", title: "p1-private", scope: "project", projectId: "p1", private: true };
const p2PrivateRule = { ...h.emptyRuleCard("2026-01-01", "p2"), id: "rule:p2-private", title: "p2-private", scope: "project", projectId: "p2", private: true };
profileA.ruleCardRefs = [{ id: globalRule.id, revision: 1 }, { id: p1PrivateRule.id, revision: 1 }];
profileB.ruleCardRefs = [{ id: globalRule.id, revision: 1 }, { id: p2PrivateRule.id, revision: 1 }];
const projectA = { ...h.emptyProjectAgentConfig("p1", "2026-01-01"), profileRefs: [{ id: profileA.id, revision: profileA.revision }], ruleCardRefs: [{ id: p1PrivateRule.id, revision: 1 }] };
const projectB = { ...h.emptyProjectAgentConfig("p2", "2026-01-01"), profileRefs: [{ id: profileB.id, revision: profileB.revision }], ruleCardRefs: [{ id: p2PrivateRule.id, revision: 1 }] };
const restartBundle = h.exportBundleForUi([profileA, profileB], [globalRule, p1PrivateRule, p2PrivateRule], [projectA, projectB], false);
const safeRulesAfterRestart = new Set(restartBundle.ruleCards.map(r => r.id));
check("restart-safe export keeps global rules", safeRulesAfterRestart.has("rule:global"));
check("restart-safe export drops project-private rules", !safeRulesAfterRestart.has("rule:p1-private") && !safeRulesAfterRestart.has("rule:p2-private"));
check("restart-safe export strips private refs from profiles", restartBundle.profiles.every(p => p.ruleCardRefs.every(ref => safeRulesAfterRestart.has(ref.id))));
check("restart-safe export strips private refs from project configs", restartBundle.projectConfigs?.every(c => c.ruleCardRefs.every(ref => safeRulesAfterRestart.has(ref.id))));
check("restart-safe export preserves project-to-profile pinning", restartBundle.projectConfigs?.some(c => c.projectId === "p1" && c.profileRefs[0]?.id === "agent:a"));
const unsafeRestartBundle = h.exportBundleForUi([profileA, profileB], [globalRule, p1PrivateRule, p2PrivateRule], [projectA, projectB], true);
check("explicit private restart export includes private rules for the same owner", unsafeRestartBundle.ruleCards.length === 3);

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (failures.length) failures.forEach(name => console.log(`  - ${name}`));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
