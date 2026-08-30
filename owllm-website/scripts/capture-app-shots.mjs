/*
 * Capture real screenshots of the actual OWLLM interface (the browser-mode
 * bundle staged by build-app-demo.mjs) for use as website imagery. These
 * replace stock photos: everything shown on the site is the real app.
 *
 * Output: src/assets/app/*.png (committed — regenerate after UI redesigns).
 *
 * Usage: node scripts/capture-app-shots.mjs [baseUrl]
 *   baseUrl defaults to http://localhost:4322 (astro dev serving public/).
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..", "..", "owllm-desktop");
const require = createRequire(path.join(desktopDir, "package.json"));
const { chromium } = require("playwright");

const base = process.argv[2] || "http://localhost:4322";
const outDir = path.join(here, "..", "src", "assets", "app");
fs.mkdirSync(outDir, { recursive: true });

// The two workflow captures below render the real AgentsPage against the real
// bundled OWLLM Team profile. Browser-mode has no Rust database, so this tiny
// read-only Tauri contract supplies one deterministic project to the shipping
// React component. It does not redraw the graph: GraphCanvas, FlowHeader, the
// Solo-Loop roster, owl artwork, colors, arrows, and layout all come from the
// app itself.
const canonicalTeam = JSON.parse(fs.readFileSync(
  path.join(desktopDir, "resources", "agents", "teams", "owllm_team.json"),
  "utf8",
));
const teamDir = path.join(desktopDir, "resources", "agents", "teams");
const bundledTeams = fs.readdirSync(teamDir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(fs.readFileSync(path.join(teamDir, file), "utf8")));

// Real entries from Anthropic's published skills collection. The capture uses
// the shipping SkillLibraryDialog and its normal command contract; deterministic
// data keeps the marketing screenshot reproducible without cloning a third-party
// repository during every website build.
const skillSources = [
  {
    key: "anthropics",
    label: "Anthropic — official skills",
    git_url: "https://github.com/anthropics/skills.git",
    description: "Anthropic's reference SKILL.md collection (PDF, Excel, Word, PowerPoint helpers). MIT licensed, drop-in compatible.",
    skills_subpath: "",
  },
  {
    key: "superpowers",
    label: "obra/superpowers — community skills",
    git_url: "https://github.com/obra/superpowers.git",
    description: "Curated community SKILL.md collection — engineering, research, and writing helpers.",
    skills_subpath: "",
  },
];
const publishedSkills = [
  { relative_dir: "skills/docx", name: "docx", description: "Create, edit, and inspect Microsoft Word documents." },
  { relative_dir: "skills/pdf", name: "pdf", description: "Read, create, edit, and validate PDF documents." },
  { relative_dir: "skills/pptx", name: "pptx", description: "Create and edit presentation decks." },
  { relative_dir: "skills/xlsx", name: "xlsx", description: "Create, edit, analyze, and validate spreadsheets." },
].map((skill) => ({
  source_key: "anthropics",
  skill_md_path: `/skills/anthropics/${skill.relative_dir}/SKILL.md`,
  installed: true,
  ...skill,
}));

const bundledSkillDir = path.join(desktopDir, "resources", "agents", "skills");
const bundledSkillPacks = fs.readdirSync(bundledSkillDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const skillPath = path.join(bundledSkillDir, entry.name, "SKILL.md");
    const text = fs.readFileSync(skillPath, "utf8");
    const frontmatterText = text.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? "";
    const value = (key) => frontmatterText.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
    return {
      id: entry.name,
      path: skillPath,
      dir: path.dirname(skillPath),
      frontmatter: { name: value("name"), description: value("description") },
      body: text.replace(/^---\s*\n[\s\S]*?\n---\s*/, ""),
    };
  });

function installWorkflowCaptureBackend({ team, teams, sources, skills, skillPacks, emptyProjects = false }) {
  try {
    localStorage.setItem("owllm.wizard.completed", "1");
    localStorage.setItem("owllm:agents:page:main:project", "website-workflow-demo");
  } catch {}

  const roster = team.agents.map((agent) => ({
    name: agent.name,
    base: agent.base,
    defaultModelId: agent.default_model_id,
  }));
  const project = {
    id: "website-workflow-demo",
    name: "OWLLM Team",
    description: "Verified build workflow",
    location: "/workspace/project",
    repo_url: "",
    created_device_id: "website-capture",
    created_device_name: "Website capture",
    trust_writes: false,
    auto_approve_all: false,
    team: roster.map((agent) => agent.name),
    team_default_model_id: "",
    graph_json: JSON.stringify({
      templateId: team.name,
      edges: team.graph.edges,
      roster,
    }),
    chat_json: "",
    agent_logs_json: "",
    updated_at: "2026-01-01T00:00:00Z",
  };

  const defaults = {
    list_projects: emptyProjects ? [] : [project],
    list_team_templates: teams.map((entry) => ({
      id: entry.name,
      path: "",
      built_in: true,
      data: entry,
    })),
    list_agent_roles: [],
    list_models: [],
    list_skill_packs: skillPacks,
    list_skill_sources: sources,
    fetch_skill_source: { local_path: "/skills/anthropics" },
    discover_skills: skills,
    read_skill_md: "---\nname: pdf\ndescription: Read, create, edit, and validate PDF documents.\n---\n\n# PDF documents\n\nUse this skill when a task needs reliable PDF reading, creation, editing, or validation.",
    load_bridge_configs: {
      telegram: { bot_token: "", project_id: "" },
      whatsapp: { access_token: "", project_id: "" },
    },
    server_status: { running: false, model_id: null, port: null, message: "" },
    accounts_status: null,
    directives_list: [],
    project_get_director_mode: false,
    agent_full_access_get: false,
    path_is_dir: true,
    state_mirror_load: { generation: 0, entries: [] },
    module_list: [],
    module_hardware_snapshot: { cpu: "", ramMb: 0, gpus: [] },
    overlay_frame_enabled: false,
    vram_status: { gpus: [] },
    inference_expose_get: null,
    github_status: { connected: false, login: null },
    projects_root_get: { path: "/workspace" },
    mcp_load_config: {},
    mcp_list_all_tools: [],
    fetch_remote_text: "",
    vault_status: null,
  };

  const windowApi = {
    label: "main",
    minSize: { width: 800, height: 600 },
    maxSize: null,
    resizable: true,
    maximizable: true,
    minimizable: true,
    closable: true,
    title: "OWLLM",
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    registerListener: async () => () => {},
    unregisterListener: async () => {},
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: windowApi },
    transformCallback: () => "",
    invoke: async (command) => {
      if (command in defaults) return structuredClone(defaults[command]);
      if (command.startsWith("plugin:")) return undefined;
      return undefined;
    },
  };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${base}/app-demo/index.html`, { waitUntil: "domcontentloaded" });
const later = page.getByRole("button", { name: "Set up later" });
if (await later.isVisible().catch(() => false)) await later.click();

/** Click a header toggle (a real <button>) or a tab-strip item (a span). */
async function go(name) {
  const btn = page.getByRole("button", { name, exact: true }).first();
  if (await btn.isVisible().catch(() => false)) await btn.click();
  else await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(900); // let icons/artwork paint
}

// Ordered as one forward walk through the app — module toggles are
// single-active (clicking the current one returns Home), so we never
// revisit a toggle and each step lands exactly one click away.
const shots = [
  { file: "home.png", nav: [] },
  { file: "models.png", nav: ["🛠 Fine Tuning"] }, // opens on Models
  { file: "chat.png", nav: ["💬 Chat"] },
  { file: "agents.png", nav: ["🎭 Agentic Team"] }, // opens on Agents
  { file: "code.png", nav: ["💻 Coding"] },
];

// Capture the app's content panel only, not the viewport: the app renders a
// transparent window margin around its frame (HybridFrame), which a viewport
// screenshot bakes in as a black band — a second frame around every image on
// the site. The panel is the first child of the frame root.
const panel = page.locator('[data-ui="hybrid-frame-root"] > div').first();

for (const { file, nav } of shots) {
  for (const step of nav) await go(step);
  // Browser mode surfaces a "no backend" toast on some pages; toasts
  // auto-dismiss, so let them clear before the marketing capture.
  await page.waitForTimeout(process.env.OWLLM_CAPTURE_FAST ? 300 : 6000);
  if (await panel.count()) await panel.screenshot({ path: path.join(outDir, file) });
  else await page.screenshot({ path: path.join(outDir, file) });
  console.log(`captured ${file}`);
}

// App-native orchestration imagery for the website's central product story.
// These are screenshots of the actual graph canvas in both modes, not a
// marketing illustration assembled from the topic.
const workflowPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await workflowPage.addInitScript(
  installWorkflowCaptureBackend,
  {
    team: canonicalTeam,
    teams: bundledTeams,
    sources: skillSources,
    skills: publishedSkills,
    skillPacks: bundledSkillPacks,
  },
);
await workflowPage.goto(`${base}/app-demo/index.html`, { waitUntil: "domcontentloaded" });
const workflowLater = workflowPage.getByRole("button", { name: "Set up later" });
if (await workflowLater.isVisible().catch(() => false)) await workflowLater.click();

const agenticToggle = workflowPage.getByRole("button", { name: "🎭 Agentic Team", exact: true });
if (await agenticToggle.isVisible().catch(() => false)) await agenticToggle.click();
const agentsTab = workflowPage.getByText("🤖 Agents", { exact: true }).first();
if (await agentsTab.isVisible().catch(() => false)) await agentsTab.click();

const workflow = workflowPage.locator('[data-ui="RosterLeft"]');
await workflow.locator('[data-ui="FlowModeSwitch"]').waitFor({ state: "visible" });
await workflowPage.waitForTimeout(1200);
await workflow.screenshot({ path: path.join(outDir, "orchestrated-workflow.png") });
console.log("captured orchestrated-workflow.png");

await workflowPage.locator('[data-ui="FlowModeSolo"]').click();
await workflowPage.waitForTimeout(700);
await workflow.screenshot({ path: path.join(outDir, "solo-loop.png") });
console.log("captured solo-loop.png");

// The same Agentic page has a second, equally important view: the graph can be
// replaced by one live transcript per agent. Capture the actual Chat grid.
await workflowPage.locator('[data-ui="FlowModeOrch"]').click();
await workflowPage.locator('[data-ui="FlowViewBtn-chat"]').click();
await workflowPage.waitForTimeout(700);
await workflow.screenshot({ path: path.join(outDir, "agent-chat-grid.png") });
console.log("captured agent-chat-grid.png");

// A project kind prepares a real environment recipe. Start from the app's real
// creation launchpad so the Website intent opens the same pre-seeded designer a
// user gets—not a component mounted out of context.
const environmentPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await environmentPage.addInitScript(
  installWorkflowCaptureBackend,
  {
    team: canonicalTeam,
    teams: bundledTeams,
    sources: skillSources,
    skills: publishedSkills,
    skillPacks: bundledSkillPacks,
    emptyProjects: true,
  },
);
await environmentPage.goto(`${base}/app-demo/index.html`, { waitUntil: "domcontentloaded" });
const environmentLater = environmentPage.getByRole("button", { name: "Set up later" });
if (await environmentLater.isVisible().catch(() => false)) await environmentLater.click();
await environmentPage.getByRole("button", { name: "🎭 Agentic Team", exact: true }).click();
await environmentPage.getByText("🤖 Agents", { exact: true }).first().click();
// The project hub paints before its async team library finishes loading. Wait
// for that real data before submitting or the dialog correctly falls back to
// its recipe picker instead of opening the pre-seeded Web form.
await environmentPage.waitForTimeout(800);
await environmentPage.getByPlaceholder(/Describe the product, website, or software outcome/).fill("Build a verified web application");
await environmentPage.getByRole("button", { name: "Prepare project" }).click();
const environmentDesigner = environmentPage.locator('[data-ui="ProjectEnvironmentDesigner"]');
if (!(await environmentDesigner.isVisible().catch(() => false))) {
  const webRecipe = environmentPage.getByRole("button", { name: /Website \/ Web app/ });
  if (await webRecipe.isVisible().catch(() => false)) {
    await webRecipe.click();
  } else {
    throw new Error(`Project designer did not open. Visible page:\n${(await environmentPage.locator("body").innerText()).slice(0, 3000)}`);
  }
}
await environmentDesigner.waitFor({ state: "visible" });
await environmentPage.waitForTimeout(300);
const environmentPanelBox = await environmentPage.locator('[data-ui="hybrid-frame-root"] > div').first().boundingBox();
await environmentPage.screenshot({
  path: path.join(outDir, "adaptive-workspace.png"),
  ...(environmentPanelBox ? { clip: environmentPanelBox } : {}),
});
console.log("captured adaptive-workspace.png");

// Capture the shipping Skills surface from the same composited app page. The
// grid is populated from OWLLM's bundled SKILL.md files and its install button
// opens the curated/custom-git library.
const skillsPage = environmentPage;
await skillsPage.getByTitle("Close").last().click();
await skillsPage.getByText("🎭 Studio", { exact: true }).first().click();
await skillsPage.getByRole("button", { name: "📚 Skills", exact: true }).click();
const skillLibrary = skillsPage.getByTitle(/Install SKILL\.md packs/);
await skillLibrary.waitFor({ state: "visible" });
await skillsPage.waitForTimeout(800);
const skillsPanelBox = await skillsPage.locator('[data-ui="hybrid-frame-root"] > div').first().boundingBox();
await skillsPage.screenshot({
  path: path.join(outDir, "skills-library.png"),
  ...(skillsPanelBox ? { clip: skillsPanelBox } : {}),
});
console.log("captured skills-library.png");

await browser.close();
