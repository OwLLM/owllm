import { firefox } from "playwright";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.DEV_URL || "http://localhost:5173/?page=studio";
const HEADLESS = process.env.HEADLESS !== "0";

function uid() {
  return randomUUID();
}

function now() {
  return new Date().toISOString();
}

function emptyProfile() {
  return {
    schemaVersion: 1,
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
    ruleCardRefs: [],
    createdAt: now(),
    updatedAt: now(),
  };
}

function emptyRule(projectId = "") {
  return {
    schemaVersion: 1,
    id: `rule:${uid()}`,
    revision: 1,
    kind: "fact",
    title: "New rule",
    body: "",
    scope: projectId ? "project" : "global",
    projectId: projectId || undefined,
    private: !!projectId,
    createdAt: now(),
    updatedAt: now(),
  };
}

function emptyProject(projectId) {
  return {
    schemaVersion: 1,
    projectId,
    revision: 1,
    profileRefs: [],
    ruleCardRefs: [],
    profileOverrides: {},
    createdAt: now(),
    updatedAt: now(),
  };
}

async function run() {
  const browser = await firefox.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();

  const logs = [];
  const errors = [];

  page.on("console", (msg) => {
    const entry = { type: msg.type(), text: msg.text(), location: msg.location() };
    logs.push(entry);
    if (msg.type() === "error") {
      errors.push(entry);
      console.error("[console.error]", msg.text());
    }
  });

  page.on("pageerror", (err) => {
    const entry = { type: "pageerror", text: err.message, stack: err.stack };
    errors.push(entry);
    console.error("[pageerror]", err.message);
  });

  // In-memory backend mock for the personal-agent layer.
  const profiles = new Map();
  const rules = new Map();
  const projects = new Map();

  await page.addInitScript(({ profiles, rules, projects }) => {
    const profileStore = new Map(profiles);
    const ruleStore = new Map(rules);
    const projectStore = new Map(projects);

    function visibleRules(projectId) {
      return [...ruleStore.values()].filter((r) => {
        if (r.scope === "global") return !r.private;
        return !!projectId && r.projectId === projectId;
      });
    }

    function clone(v) {
      return JSON.parse(JSON.stringify(v));
    }

    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args = {}) => {
        // console.log("[invoke]", cmd, args);
        switch (cmd) {
          case "personal_agent_list_profiles":
            return clone([...profileStore.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)));

          case "personal_agent_list_rule_cards": {
            const projectId = args.projectId;
            const includePrivate = args.includePrivate;
            const out = [...ruleStore.values()].filter((r) => {
              if (r.scope === "global") return true;
              if (!projectId) return false;
              if (r.projectId === projectId) return true;
              return false;
            });
            return clone(out.sort((a, b) => a.title.localeCompare(b.title)));
          }

          case "personal_agent_get_profile": {
            const p = profileStore.get(args.id);
            if (!p) throw new Error(`profile ${args.id} not found`);
            return clone(p);
          }

          case "personal_agent_get_rule_card": {
            const r = ruleStore.get(args.id);
            if (!r) throw new Error(`rule ${args.id} not found`);
            return clone(r);
          }

          case "personal_agent_get_project_config": {
            const p = projectStore.get(args.projectId);
            return p ? clone(p) : null;
          }

          case "personal_agent_save_profile": {
            const doc = clone(args.doc);
            const existing = profileStore.get(doc.id);
            const expected = args.expectedRevision;
            if (existing && expected != null && existing.revision !== expected) {
              throw new Error(`revision conflict on ${doc.id}`);
            }
            doc.revision = existing ? existing.revision + 1 : 1;
            doc.updatedAt = new Date().toISOString();
            profileStore.set(doc.id, doc);
            return clone(doc);
          }

          case "personal_agent_save_rule_card": {
            const doc = clone(args.doc);
            const existing = ruleStore.get(doc.id);
            const expected = args.expectedRevision;
            if (existing && expected != null && existing.revision !== expected) {
              throw new Error(`revision conflict on ${doc.id}`);
            }
            doc.revision = existing ? existing.revision + 1 : 1;
            doc.updatedAt = new Date().toISOString();
            ruleStore.set(doc.id, doc);
            return clone(doc);
          }

          case "personal_agent_save_project_config": {
            const doc = clone(args.doc);
            const existing = projectStore.get(doc.projectId);
            const expected = args.expectedRevision;
            if (existing && expected != null && existing.revision !== expected) {
              throw new Error(`revision conflict on ${doc.projectId}`);
            }
            doc.revision = existing ? existing.revision + 1 : 1;
            doc.updatedAt = new Date().toISOString();
            projectStore.set(doc.projectId, doc);
            return clone(doc);
          }

          case "personal_agent_resolve": {
            const profile = [...profileStore.values()].find((p) => p.id === args.profileId);
            if (!profile) throw new Error(`profile ${args.profileId} not found`);
            const project = projectStore.get(args.projectId);
            const attached = profile.ruleCardRefs
              .map((ref) => ruleStore.get(ref.id))
              .filter(Boolean)
              .map((r) => ({ ...r, provenance: `${r.scope} · r${r.revision}` }));
            const override = project?.profileOverrides?.[profile.id] ?? {};
            const baseTools = profile.allowedTools || [];
            const projTools = override.allowedTools;
            let tools = baseTools;
            let explanation = "Effective tools come from the profile allowlist. Project rules did not widen permissions.";
            if (projTools !== undefined) {
              const set = new Set(projTools);
              tools = baseTools.filter((t) => set.has(t));
              explanation = `Fail-closed intersection: profile (${baseTools.length}) ∩ project override (${projTools.length}) = ${tools.length}. Permissions are never additive.`;
            }
            return clone({
              ...profile,
              provenance: {
                displayName: { source: "profile", documentId: profile.id, revision: profile.revision },
                role: { source: "profile", documentId: profile.id, revision: profile.revision },
                systemInstructions: { source: "profile", documentId: profile.id, revision: profile.revision },
                model: { source: "profile", documentId: profile.id, revision: profile.revision },
                allowedTools: { source: project ? "project" : "profile", documentId: project?.projectId || profile.id, revision: project?.revision || profile.revision },
                memoryScope: { source: "profile", documentId: profile.id, revision: profile.revision },
              },
              attachedRules: attached,
              attachedRuleCards: attached,
              validationErrors: [],
            });
          }

          case "personal_agent_export": {
            const projectId = args.projectId;
            const includePrivate = args.includePrivate;
            const bundle = {
              schemaVersion: 1,
              profiles: clone([...profileStore.values()]),
              ruleCards: clone([...ruleStore.values()].filter((r) => includePrivate || !r.private)),
              projectConfigs: clone([...projectStore.values()].filter((p) => !projectId || p.projectId === projectId)),
            };
            return JSON.stringify(bundle, null, 2);
          }

          case "personal_agent_import": {
            const payload = JSON.parse(args.payload);
            const preview = args.preview;
            const projectId = args.projectId;
            const validationErrors = [];

            if (!payload || payload.schemaVersion !== 1) {
              validationErrors.push("Invalid bundle schema version");
              return { profiles: 0, ruleCards: 0, projectConfigs: 0, validationErrors };
            }

            const profilesIn = payload.profiles || [];
            const rulesIn = payload.ruleCards || [];
            const projectsIn = payload.projectConfigs || [];

            if (!preview) {
              for (const p of profilesIn) profileStore.set(p.id, p);
              for (const r of rulesIn) ruleStore.set(r.id, r);
              for (const p of projectsIn) projectStore.set(p.projectId, p);
            }

            return {
              profiles: profilesIn.length,
              ruleCards: rulesIn.length,
              projectConfigs: projectsIn.length,
              validationErrors,
            };
          }

          default:
            // Window chrome calls (minimize/maximize/close) and event
            // listeners only happen on user interaction; other unmocked
            // commands are not exercised by this dialog.
            if (cmd.startsWith("plugin:window|")) return null;
            if (cmd === "plugin:event|listen") return () => Promise.resolve(() => {});
            throw new Error(`unmocked invoke command: ${cmd}`);
        }
      },
      transformCallback: (callback) => {
        const id = Math.random().toString(36).slice(2);
        return id;
      },
      unregisterCallback: () => {},
      convertFileSrc: (filePath, protocol = "asset") => `${protocol}://${filePath}`,
      metadata: { currentWindow: { label: "main" } },
    };
  }, {
    profiles: [...profiles.entries()],
    rules: [...rules.entries()],
    projects: [...projects.entries()],
  });

  console.log(`Navigating to ${BASE_URL}`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  // Dismiss the first-run account/sync onboarding modal if it appears.
  try {
    await page.waitForSelector('text=Welcome to OwLLM', { state: "visible", timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector('text=Welcome to OwLLM', { state: "hidden", timeout: 5000 });
    console.log("Closed onboarding modal");
  } catch {
    // Modal not shown; proceed.
  }

  // Studio defaults to the Teams tab; the Personal agents button is on Agents.
  // The header also has an Agents tab, so target the second occurrence (Studio's).
  await page.locator('text=🤖 Agents').nth(1).click();

  // Wait for the studio page to render and the Personal agents button to appear.
  await page.waitForSelector("text=Personal agents", { timeout: 15000 });
  console.log("Studio page loaded, opening Personal agents dialog");

  await page.click("text=Personal agents");

  // Dialog should appear.
  const dialog = page.locator('[role="dialog"][aria-label="Personal agents configuration"]');
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  console.log("Dialog opened");

  // --- Profiles tab: create a new profile ---
  await dialog.getByRole("button", { name: "+ New profile" }).click();
  console.log("Creating new profile");

  await dialog.locator('label:has-text("Display name") input').fill("E2E Test Agent");
  await dialog.locator('label:has-text("Identity name") input').fill("Tester");
  await dialog.locator('label:has-text("Role") input').fill("tester");
  await dialog.locator('label:has-text("General") textarea').fill("You are a helpful test agent.");

  await dialog.getByRole("button", { name: "Save profile" }).click();
  await dialog.locator('text=Saved E2E Test Agent').waitFor({ timeout: 10000 });
  console.log("Profile saved");

  // --- Rule cards tab: create a rule ---
  await dialog.getByRole("button", { name: "Rule cards" }).click();
  await dialog.getByRole("button", { name: "+ New rule card" }).click();
  console.log("Creating new rule card");

  await dialog.locator('label:has-text("Title") input').fill("E2E Test Rule");
  await dialog.locator('label:has-text("Rule body") textarea').fill("Always answer concisely during end-to-end tests.");

  await dialog.getByRole("button", { name: "Save rule" }).click();
  await dialog.locator('text=Saved E2E Test Rule').waitFor({ timeout: 10000 });
  console.log("Rule card saved");

  // --- Project config tab: load project, pin profile, set override ---
  await dialog.getByRole("button", { name: "Project config + preview" }).click();
  console.log("Switching to project config");

  await dialog.locator('label:has-text("Project id") input').fill("e2e-test-project");
  await dialog.getByRole("button", { name: "Load" }).click();
  await dialog.locator('text=No saved config for e2e-test-project').waitFor({ timeout: 10000 });
  console.log("Project loaded");

  // Pin the profile.
  await dialog.locator('label').filter({ hasText: 'E2E Test Agent' }).first().click();
  console.log("Profile pinned");

  await dialog.getByRole("button", { name: "Save project config" }).click();
  await dialog.locator('text=Saved project e2e-test-project').waitFor({ timeout: 10000 });
  console.log("Project config saved");

  // Resolve effective config.
  await dialog.locator('label:has-text("Effective Preview profile") select').selectOption({ label: /E2E Test Agent/ });
  await dialog.getByRole("button", { name: "Resolve effective config" }).click();
  await dialog.locator('text=FAIL-CLOSED PERMISSIONS').waitFor({ timeout: 10000 });
  console.log("Effective config resolved");

  // --- Import / export tab ---
  await dialog.getByRole("button", { name: "Import / export" }).click();
  console.log("Switching to transfer tab");

  await dialog.getByRole("button", { name: "Create safe export" }).click();
  const exportTextarea = dialog.locator('[aria-label="Personal agent import or export JSON"]');
  await exportTextarea.waitFor({ timeout: 10000 });
  const exportText = await exportTextarea.inputValue();
  const bundle = JSON.parse(exportText);
  console.log(`Export ready: ${bundle.profiles.length} profiles, ${bundle.ruleCards.length} rules`);

  // Preview a modified import.
  const importBundle = {
    schemaVersion: 1,
    profiles: [
      {
        ...bundle.profiles[0],
        displayName: "Imported Agent",
        id: `agent:${uid()}`,
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      },
    ],
    ruleCards: [],
    projectConfigs: [],
  };
  await exportTextarea.fill(JSON.stringify(importBundle, null, 2));
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await dialog.locator('text=Preview:').waitFor({ timeout: 10000 });
  console.log("Import preview shown");

  await dialog.getByRole("button", { name: "Save import" }).click();
  await dialog.locator('text=Import saved atomically').waitFor({ timeout: 10000 });
  console.log("Import saved");

  // Close dialog.
  await dialog.getByRole("button", { name: "Close personal agents" }).click();
  await dialog.waitFor({ state: "detached", timeout: 10000 });
  console.log("Dialog closed");

  await browser.close();

  console.log("\n--- SUMMARY ---");
  console.log(`Console errors: ${errors.length}`);
  console.log(`Total console entries: ${logs.length}`);

  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const e of errors) {
      console.log(`  [${e.type}] ${e.text}`);
      if (e.stack) console.log(`    ${e.stack}`);
    }
    process.exit(1);
  } else {
    console.log("No runtime errors observed.");
    process.exit(0);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
