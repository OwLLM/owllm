// Browser walkthrough for Personal Agents -> Teams + runs tab.
// Mocks the Tauri backend contract so the UI can be exercised in a plain
// Chromium launched by Playwright against the Vite dev server.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "http://localhost:5173";
const OUT = path.resolve(process.cwd(), ".screenshots");
await mkdir(OUT, { recursive: true });

const logs = [];
function log(kind, message, details) {
  const entry = { t: Date.now(), kind, message, details };
  logs.push(entry);
  const short = typeof details === "string" ? details : details ? JSON.stringify(details).slice(0, 200) : "";
  console.log(`[${kind}] ${message}${short ? " " + short : ""}`);
}

const mockBackend = `
(function () {
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) return;
  const now = () => new Date().toISOString();
  function uid(prefix) { return prefix + ":" + crypto.randomUUID(); }

  const profiles = [
    {
      schemaVersion: 1,
      id: "agent:coordinator-1",
      revision: 1,
      displayName: "Coordinator Owl",
      identity: { name: "Coordinator Owl", color: "#7fd4ff" },
      role: "coordinator",
      systemInstructions: "Coordinate the team.",
      model: { provider: "openai", modelId: "gpt-4o" },
      allowedTools: ["read_file", "search_web"],
      memoryScope: "project",
      delegation: { enabled: true, allowedProfileIds: [] },
      skillIds: [],
      ruleCardRefs: [],
      createdAt: now(),
      updatedAt: now(),
    },
    {
      schemaVersion: 1,
      id: "agent:coder-1",
      revision: 1,
      displayName: "Coder Owl",
      identity: { name: "Coder Owl", color: "#9ee6b0" },
      role: "specialist",
      systemInstructions: "Write code.",
      model: { provider: "openai", modelId: "gpt-4o-mini" },
      allowedTools: ["read_file", "write_file"],
      memoryScope: "project",
      delegation: { enabled: false, allowedProfileIds: [] },
      skillIds: [],
      ruleCardRefs: [],
      createdAt: now(),
      updatedAt: now(),
    },
    {
      schemaVersion: 1,
      id: "agent:researcher-1",
      revision: 1,
      displayName: "Researcher Owl",
      identity: { name: "Researcher Owl", color: "#c08aff" },
      role: "specialist",
      systemInstructions: "Research topics.",
      model: { provider: "openai", modelId: "gpt-4o-mini" },
      allowedTools: ["search_web", "fetch_url"],
      memoryScope: "project",
      delegation: { enabled: false, allowedProfileIds: [] },
      skillIds: [],
      ruleCardRefs: [],
      createdAt: now(),
      updatedAt: now(),
    },
  ];

  const ruleCards = [];
  const teams = [];
  const runs = [];
  const runEvents = new Map();

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function bump(doc) { doc.revision += 1; doc.updatedAt = now(); return doc; }
  function runIdOf(run) { return run.runId; }

  const handlers = {
    personal_agent_list_profiles: () => clone(profiles),
    personal_agent_list_rule_cards: ({ projectId, includePrivate }) => {
      return clone(ruleCards.filter(c => c.scope === "global" || (includePrivate && c.projectId === projectId)));
    },
    personal_agent_get_profile: ({ id }) => {
      const p = profiles.find(x => x.id === id);
      if (!p) throw new Error("Profile not found: " + id);
      return clone(p);
    },
    personal_agent_get_rule_card: ({ id }) => {
      const c = ruleCards.find(x => x.id === id);
      if (!c) throw new Error("Rule card not found: " + id);
      return clone(c);
    },
    personal_agent_save_profile: ({ doc }) => {
      const idx = profiles.findIndex(x => x.id === doc.id);
      const saved = bump(clone(doc));
      if (idx >= 0) profiles[idx] = saved; else profiles.push(saved);
      return clone(saved);
    },
    personal_agent_save_rule_card: ({ doc }) => {
      const idx = ruleCards.findIndex(x => x.id === doc.id);
      const saved = bump(clone(doc));
      if (idx >= 0) ruleCards[idx] = saved; else ruleCards.push(saved);
      return clone(saved);
    },
    personal_agent_get_project_config: ({ projectId }) => {
      return null;
    },
    personal_agent_save_project_config: ({ doc }) => {
      return bump(clone(doc));
    },
    personal_agent_effective_config: ({ profileId, projectId }) => {
      const p = profiles.find(x => x.id === profileId);
      if (!p) throw new Error("Profile not found");
      return { ...clone(p), provenance: {}, attachedRules: [], validationErrors: [] };
    },
    personal_agent_export_bundle: () => ({ schemaVersion: 1, profiles: clone(profiles), ruleCards: clone(ruleCards), projectConfigs: [], validationErrors: [] }),
    personal_agent_import_bundle: () => ({ profiles: 0, ruleCards: 0, projectConfigs: 0, validationErrors: [] }),

    personal_agent_team_list: ({ projectId, includeArchived }) => {
      return clone(teams.filter(t => includeArchived || !t.archived));
    },
    personal_agent_team_get: ({ teamId }) => {
      const t = teams.find(x => x.id === teamId);
      if (!t) throw new Error("Team not found: " + teamId);
      return clone(t);
    },
    personal_agent_team_save: ({ doc, expectedRevision }) => {
      const idx = teams.findIndex(x => x.id === doc.id);
      if (expectedRevision != null && idx >= 0 && teams[idx].revision !== expectedRevision) {
        throw new Error("Revision conflict");
      }
      const saved = bump(clone(doc));
      if (idx >= 0) teams[idx] = saved; else teams.push(saved);
      return clone(saved);
    },
    personal_agent_team_clone: ({ teamId, revision, newName, newId }) => {
      const src = teams.find(x => x.id === teamId);
      if (!src) throw new Error("Team not found");
      if (src.revision !== revision) throw new Error("Revision mismatch");
      const cloned = bump(clone(src));
      cloned.id = newId || uid("team");
      cloned.name = newName || cloned.name + " copy";
      cloned.revision = 1;
      cloned.createdAt = now();
      cloned.updatedAt = now();
      teams.push(cloned);
      return clone(cloned);
    },
    personal_agent_team_archive: ({ teamId, expectedRevision, archived }) => {
      const idx = teams.findIndex(x => x.id === teamId);
      if (idx < 0) throw new Error("Team not found");
      if (teams[idx].revision !== expectedRevision) throw new Error("Revision conflict");
      teams[idx].archived = archived;
      bump(teams[idx]);
      return clone(teams[idx]);
    },

    personal_agent_team_run_list: ({ projectId, teamId }) => {
      return clone(runs.filter(r => r.projectId === projectId && (!teamId || r.teamId === teamId)));
    },
    personal_agent_team_run_get: ({ projectId, runId }) => {
      const r = runs.find(x => x.projectId === projectId && runIdOf(x) === runId);
      if (!r) throw new Error("Run not found");
      return clone(r);
    },
    personal_agent_team_run_events: ({ projectId, runId, afterSeq, limit }) => {
      const list = runEvents.get(runId) || [];
      const from = (afterSeq || 0) + 1;
      const events = list.filter(e => e.seq >= from).slice(0, limit || 200);
      const nextAfterSeq = events.length ? Math.max(...events.map(e => e.seq)) : afterSeq || 0;
      return { runId, events: clone(events), nextAfterSeq, hasMore: false };
    },
    personal_agent_team_run_create: ({ request }) => {
      const team = teams.find(x => x.id === request.teamId);
      if (!team) throw new Error("Team not found");
      if (team.revision !== request.expectedTeamRevision) throw new Error("Team revision mismatch");
      const run = {
        schemaVersion: 1,
        runId: uid("run"),
        clientRequestId: request.clientRequestId,
        projectId: request.projectId,
        teamId: request.teamId,
        status: "running",
        snapshotHash: "sha256:" + Math.random().toString(36).slice(2),
        objective: request.objective,
        createdAt: now(),
        startedAt: now(),
        lastEventSeq: 1,
      };
      runs.push(run);
      runEvents.set(run.runId, [{
        schemaVersion: 1,
        runId: run.runId,
        seq: 1,
        ts: now(),
        kind: "run.started",
        agentMemberId: team.members[0]?.memberId,
        appliedRuleRefs: [],
        appliedSkillIds: [],
        output: { message: "Run started", objective: request.objective },
      }]);
      return clone(run);
    },
    personal_agent_team_run_cancel: ({ projectId, runId, reason }) => {
      const r = runs.find(x => x.projectId === projectId && runIdOf(x) === runId);
      if (!r) throw new Error("Run not found");
      r.status = "cancelled";
      r.finishedAt = now();
      r.lastEventSeq += 1;
      const list = runEvents.get(runId) || [];
      list.push({
        schemaVersion: 1,
        runId,
        seq: r.lastEventSeq,
        ts: now(),
        kind: "run.cancelled",
        agentMemberId: "coordinator",
        appliedRuleRefs: [],
        appliedSkillIds: [],
        output: { message: reason || "Cancelled" },
      });
      return clone(r);
    },
    personal_agent_team_run_recover: ({ request }) => {
      return handlers.personal_agent_team_run_create({ request: { ...request, teamId: request.teamId, objective: "Recovery run" } });
    },
  };

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      const handler = handlers[cmd];
      if (!handler) {
        const err = new Error("Mock backend: unknown command " + cmd);
        console.error(err.message, args);
        throw err;
      }
      // Simulate tiny async latency.
      await new Promise(r => setTimeout(r, 8));
      const result = handler(args || {});
      return result;
    },
  };
})();
`;

async function screenshot(page, name) {
  const file = path.join(OUT, `teams-walkthrough-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log("screenshot", name, file);
}

async function clickByText(page, text, options = {}) {
  const locator = page.getByText(text, { exact: false, ...options });
  await locator.first().waitFor({ state: "visible", timeout: 10000 });
  await locator.first().click();
  log("click", text);
}

async function fillByPlaceholder(page, placeholder, value) {
  const locator = page.getByPlaceholder(placeholder, { exact: false });
  await locator.first().fill(value);
  log("fill", placeholder, value);
}

async function fillByLabel(page, label, value) {
  const locator = page.locator("label", { hasText: label }).locator("input, textarea, select").first();
  await locator.fill(value);
  log("fill", label, value);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

page.on("console", msg => {
  const text = msg.text();
  const type = msg.type();
  log("console", `[${type}] ${text}`);
});
page.on("pageerror", err => log("pageerror", err.message, err.stack));
page.on("requestfailed", req => log("requestfailed", req.url(), req.failure()?.errorText));

await page.addInitScript(mockBackend);

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { passed++; log("assert", "PASS: " + message); }
  else { failed++; log("assert", "FAIL: " + message); }
}

try {
  log("step", "Navigate to Studio page");
  await page.goto(`${BASE}/?page=studio`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await screenshot(page, "01-studio-initial");

  log("step", "Switch to Agents view if needed");
  const agentsBtn = page.locator("button", { hasText: /Agents/ }).first();
  if (await agentsBtn.isVisible().catch(() => false)) {
    await agentsBtn.click();
    await page.waitForTimeout(400);
  }
  await screenshot(page, "02-studio-agents");

  log("step", "Open Personal Agents dialog");
  await clickByText(page, "Personal agents");
  await page.waitForTimeout(600);
  await screenshot(page, "03-personal-agents-dialog");

  log("step", "Switch to Teams + runs tab");
  await clickByText(page, "Teams + runs");
  await page.waitForTimeout(600);
  await screenshot(page, "04-teams-tab");

  log("step", "Create a new team");
  await clickByText(page, "New team");
  await page.waitForTimeout(300);
  await fillByLabel(page, "Team name", "E2E Test Team");
  await fillByLabel(page, "Description", "Browser walkthrough team");
  await screenshot(page, "05-team-draft");

  log("step", "Add specialists");
  await clickByText(page, "+ Specialist");
  await page.waitForTimeout(200);
  await clickByText(page, "+ Specialist");
  await page.waitForTimeout(200);
  await screenshot(page, "06-team-members");

  log("step", "Set delegation edges");
  const coordinatorRow = page.locator("text=Coordinator Owl").first().locator("xpath=../../..");
  const specialistRows = page.locator("text=Coder Owl, Researcher Owl"); // not ideal; use checkboxes by label
  // Instead: enable every delegation checkbox that is visible and enabled.
  const checkboxes = await page.locator('input[type="checkbox"]').all();
  for (const cb of checkboxes) {
    const disabled = await cb.isDisabled().catch(() => true);
    const checked = await cb.isChecked().catch(() => false);
    if (!disabled && !checked) {
      try { await cb.check({ force: true }); } catch {}
    }
  }
  await screenshot(page, "07-delegation-edges");

  log("step", "Save team");
  await clickByText(page, "Save team");
  await page.waitForTimeout(600);
  const status = await page.locator('[role="status"]').textContent().catch(() => "");
  assert(status.includes("Saved"), "Save status shows 'Saved'");
  await screenshot(page, "08-team-saved");

  log("step", "Clone team");
  const cloneInput = page.locator("label", { hasText: /Clone as/i }).locator("input").first();
  await cloneInput.fill("E2E Test Team Clone");
  await clickByText(page, "Clone");
  await page.waitForTimeout(600);
  const cloneStatus = await page.locator('[role="status"]').textContent().catch(() => "");
  assert(cloneStatus.includes("Cloned"), "Clone status shows 'Cloned'");
  await screenshot(page, "09-team-cloned");

  log("step", "Archive team");
  await clickByText(page, "Archive");
  await page.waitForTimeout(600);
  const archiveStatus = await page.locator('[role="status"]').textContent().catch(() => "");
  assert(archiveStatus.includes("Archived"), "Archive status shows 'Archived'");
  await screenshot(page, "10-team-archived");

  log("step", "Unarchive team");
  await clickByText(page, "Unarchive");
  await page.waitForTimeout(600);
  const unarchiveStatus = await page.locator('[role="status"]').textContent().catch(() => "");
  assert(unarchiveStatus.includes("Restored"), "Unarchive status shows 'Restored'");
  await screenshot(page, "11-team-unarchived");

  log("step", "Start a run");
  await fillByLabel(page, "Project id", "walkthrough-project");
  await fillByLabel(page, "Objective", "Verify team runtime end-to-end");
  await clickByText(page, "Start asynchronously");
  await page.waitForTimeout(800);
  const runStatus = await page.locator('[role="status"]').textContent().catch(() => "");
  assert(runStatus.includes("queued") || runStatus.includes("Run"), "Run creation status shown");
  await screenshot(page, "12-run-created");

  log("step", "Verify event polling");
  await page.waitForTimeout(1200);
  const events = await page.locator("text=run.started").count();
  assert(events >= 1, "At least one trace event polled in");
  await screenshot(page, "13-events-polled");

  log("step", "Cancel a run");
  await clickByText(page, "Cancel");
  await page.waitForTimeout(800);
  const cancelledStatus = await page.locator('[role="status"]').textContent().catch(() => "");
  // Cancel doesn't set a status in UI, but the run panel should show CANCELLED.
  const runPanelStatus = await page.locator("text=CANCELLED").count();
  assert(runPanelStatus >= 1 || cancelledStatus.includes("cancelled"), "Run shows cancelled state");
  await screenshot(page, "14-run-cancelled");

} catch (err) {
  log("error", err.message, err.stack);
  failed++;
  await screenshot(page, "ERROR-final");
} finally {
  await screenshot(page, "15-final");
  await browser.close();
}

console.log("\n=== WALKTHROUGH SUMMARY ===");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Console log entries: ${logs.filter(l => l.kind === "console").length}`);

const summaryFile = path.join(OUT, "teams-walkthrough-summary.json");
await writeFile(summaryFile, JSON.stringify({ passed, failed, logs }, null, 2));
console.log(`Summary written to ${summaryFile}`);

process.exit(failed > 0 ? 1 : 0);
