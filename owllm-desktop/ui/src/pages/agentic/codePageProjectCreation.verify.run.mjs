#!/usr/bin/env node
// Coding-page project creation — one honest creation contract.
//
// Pins the four things that made "New project" weak and misleading before:
// the coding page never used the projects root (the folder field opened
// blank), "create" silently opened whatever folder was picked instead of
// creating <parent>\<slug> through the managed backend (no Project Card, no
// git init), pressing Enter with no folder did NOTHING (silent return), and
// the create button quietly relabelled itself "Open folder". Also pins the
// removal of the orphaned NewProjectDialog dead twin.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const UI = path.resolve(HERE, "../..");
const APP = path.resolve(UI, "../..");
const read = (relative) => fs.readFileSync(path.join(UI, relative), "utf8").replace(/\r\n/g, "\n");
const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(`FAIL ${name}`);
}

const page = read("pages/agentic/CodePage.tsx");

// ---- the coding page derives folders from the shared projects root ----
check("The coding page uses the shared root/path helpers (no parallel slug copy)",
  /import \{ projectsRootGet, projectPathUnder, projectFolderSlug \} from "\.\/projectsRoot";/.test(page)
    && !/replace\(\/\[\^a-zA-Z0-9\._-\]\+\/g/.test(page));
check("Opening the New-project dialog prefills the location from the projects root",
  /const openNewProject = [\s\S]{0,900}projectsRootGet\(\)/.test(page));
check("A parent the user picked is never overwritten by the async root fetch",
  /setNpParent\(\(prev\) => prev \|\| r\.path\)/.test(page));

// ---- "create" actually creates, through the managed backend ----
const createFn = page.slice(page.indexOf("const createNewProject"), page.indexOf("const isolatedNow"));
check("The created folder is always <parent> + slug(name) — name and path cannot disagree",
  /const target = projectPathUnder\(parent, npName\);/.test(createFn));
check("Host creation goes through the managed backend (folder + Project Card + git init)",
  /"create_project"/.test(createFn)
    && /create_location: true/.test(createFn)
    && /project_kind: "coding"/.test(createFn));
check("The old pass-through that just opened the picked folder verbatim is gone",
  !/createdPath = npFolder/.test(page) && !/\bnpFolder\b/.test(page));

// ---- no silent dead-ends ----
check("A missing name or location shows a visible error instead of silently returning",
  /setNpErr\("Give the project a name\."\)/.test(createFn)
    && /setNpErr\("Choose where to create the project\."\)/.test(createFn));
check("The dialog renders the error where the user is looking",
  /\{npErr && \(/.test(page));
check("A creation failure lands in the dialog, never in Agent 1's composer",
  /setNpErr\(`Couldn't create the project: /.test(createFn)
    && !/setStatus\(`Couldn't create project/.test(page));

// ---- honest controls, one mental model ----
check("The create button never relabels itself \"Open folder\"",
  !/: "Open folder"/.test(page)
    && /"Create isolated project" : "Create project"/.test(page));
check("Isolated and host modes share one location row (both show the live slug)",
  (page.match(/projectFolderSlug\(npName\)/g) ?? []).length >= 2
    && /Created at<\/label>/.test(page));

// ---- every coding-page folder picker opens where projects live ----
const pickers = page.match(/invoke<string \| null>\("pick_folder",[\s\S]{0,400}?\}\);/g) ?? [];
check("The coding page still has its three folder pickers (new project, clone, import)",
  pickers.length === 3);
check("Every picker passes a startDir instead of opening wherever the OS last browsed",
  pickers.every((p) => /startDir:/.test(p)));

// ---- the dead twin is gone ----
check("The orphaned NewProjectDialog dead twin is deleted and imported nowhere",
  !fs.existsSync(path.join(UI, "pages/agentic/NewProjectDialog.tsx"))
    && !/from "\.\/NewProjectDialog"/.test(read("pages/agentic/AgentsPage.tsx")));

// ---- backend pieces this flow now relies on ----
const projects = fs.readFileSync(path.join(APP, "src-tauri/src/projects.rs"), "utf8").replace(/\r\n/g, "\n");
check("create_location creates the folder, writes the Project Card and inits git",
  /std::fs::create_dir_all\(&workspace\)/.test(projects)
    && /owllm_dir\.join\("project\.json"\)/.test(projects)
    && /ensure_owned_git_repo\(&workspace\)/.test(projects));

console.log(`PASS coding-page project creation (${checks.length}/${checks.length})`);
