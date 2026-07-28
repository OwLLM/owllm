#!/usr/bin/env node
// Projects root — the folder new projects are created under, chosen once at
// onboarding (the user's GitHub-synced folder, or OwLLM's own default).
//
// Pins the two things that broke before this existed: the user had to hand-type
// a path for EVERY project, and two call sites derived the folder name with
// their own copy of the slug logic. Also pins the wiring so a later refactor
// can't quietly drop the onboarding step or the automatic prefill.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const UI = path.resolve(HERE, "../..");
const APP = path.resolve(UI, "../..");
const read = (relative) => fs.readFileSync(path.join(UI, relative), "utf8").replace(/\r\n/g, "\n");
const readRust = (relative) => fs.readFileSync(path.join(APP, "src-tauri/src", relative), "utf8").replace(/\r\n/g, "\n");
const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(`FAIL ${name}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-projects-root-"));
try {
  // ---- pure path derivation, executed (not grepped) ----
  const source = read("pages/agentic/projectsRoot.ts");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(temp, "projectsRoot.mjs");
  // The module imports Tauri's invoke, which has no Node resolution here. Only
  // the pure helpers are under test, so stub the import rather than pull in the
  // whole Tauri runtime.
  fs.writeFileSync(path.join(temp, "core.mjs"), "export const invoke = async () => { throw new Error('not used'); };\n");
  fs.writeFileSync(modulePath, compiled.replace('"@tauri-apps/api/core"', '"./core.mjs"'));
  const mod = await import(pathToFileURL(modulePath).href);

  check("A Windows root keeps backslashes",
    mod.projectPathUnder("C:\\1_Git", "my site") === "C:\\1_Git\\my-site");
  check("A POSIX/WSL root keeps forward slashes",
    mod.projectPathUnder("/home/me/code", "my site") === "/home/me/code/my-site");
  check("A trailing separator is not doubled",
    mod.projectPathUnder("C:\\1_Git\\", "app") === "C:\\1_Git\\app");
  check("Unsafe characters never reach the filesystem",
    mod.projectPathUnder("/root", "a/b:c*?\"<>|d") === "/root/a-b-c-d");
  check("A name that slugs to nothing still yields a usable folder",
    mod.projectFolderSlug("///") === "new-project"
      && mod.projectPathUnder("/root", "  ") === "/root/new-project");
  check("Dots, dashes and underscores survive (repo-style names)",
    mod.projectFolderSlug("owllm-desktop_v2.1") === "owllm-desktop_v2.1");
  check("An empty root returns empty so the caller still asks",
    mod.projectPathUnder("", "app") === "" && mod.projectPathUnder("   ", "app") === "");

  // ---- backend contract ----
  const projects = readRust("projects.rs");
  check("The root resolves to a configured path or OwLLM's default",
    /pub fn projects_root_get\(\) -> ProjectsRoot/.test(projects)
      && /configured: false/.test(projects));
  check("The default reuses the ~/OwLLM home agents may already write to",
    /join\("OwLLM"\)\.join\("Projects"\)/.test(projects));
  check("Setting the root creates the folder so the first project needs no second prompt",
    /pub fn projects_root_set/.test(projects)
      && /create_dir_all\(&chosen\)/.test(projects));
  check("Passing no path accepts OwLLM's default rather than clearing the setting",
    /None => default_projects_root\(\)/.test(projects));
  check("A file where a folder belongs is refused instead of silently failing later",
    /chosen\.exists\(\) && !chosen\.is_dir\(\)/.test(projects));
  check("The root is device-local, never synced (paths are not portable)",
    /owllm_config_home\(\)\?\.join\("projects_root\.json"\)/.test(projects));
  check("A fresh install always has a projects folder, even if onboarding is closed",
    /pub fn ensure_projects_root/.test(projects)
      && /projects::ensure_projects_root\(\);/.test(readRust("lib.rs")));
  check("Both root commands are registered with Tauri",
    /projects::projects_root_get,/.test(readRust("lib.rs"))
      && /projects::projects_root_set,/.test(readRust("lib.rs")));
  check("The folder picker can open where projects live",
    /start_dir: Option<String>/.test(readRust("dialog.rs"))
      && /dialog\.set_directory\(p\)/.test(readRust("dialog.rs")));

  // ---- onboarding asks, exactly once, with both answers ----
  const onboarding = read("pages/core/AccountSyncModal.tsx");
  check("Onboarding has a dedicated projects-folder step",
    onboarding.includes('dataUi="OnboardingProjectsRoot"'));
  check("Onboarding offers the user's own GitHub-synced folder",
    onboarding.includes("Use my own folder") && onboarding.includes("browseProjectsRoot"));
  check("Onboarding offers accepting OwLLM's default",
    /chooseProjectsRoot\(null\)/.test(onboarding));
  check("Onboarding shows which folder will be used",
    /projectsRoot\?\.path/.test(onboarding));
  check("The step marks itself done only once the user has actually chosen",
    /done=\{!!projectsRoot\?\.configured\}/.test(onboarding));

  // ---- the payoff: new projects land there automatically ----
  const dialog = read("pages/agentic/ProjectSettingsDialog.tsx");
  check("The create dialog prefills the location from the projects root",
    /projectPathUnder\(projectsRoot, name\)/.test(dialog));
  check("Only folder-creating recipes are auto-placed (existing-repo recipes still ask)",
    /folderMode === "create"[\s\S]{0,120}projectPathUnder\(projectsRoot, name\)/.test(dialog));
  check("A path the user typed or picked is never overwritten by the prefill",
    /locationTouched\.current = true/.test(dialog)
      && /if \(!open \|\| mode !== "new" \|\| locationTouched\.current\) return;/.test(dialog));
  check("Browse opens in the projects root",
    /startDir: projectsRoot \|\| null/.test(dialog));
  // ---- automatic project NAME: create a project in two clicks ----
  check("The first project of a kind is numbered 1",
    mod.nextProjectName("Personal Assistant", []) === "Personal Assistant 1");
  check("Recreating the same kind increments",
    mod.nextProjectName("Personal Assistant", ["Personal Assistant 1"]) === "Personal Assistant 2");
  check("Numbering continues from the highest, not the count",
    mod.nextProjectName("Personal Assistant", ["Personal Assistant 1", "Personal Assistant 3"])
      === "Personal Assistant 4");
  check("Deleting a middle project never re-issues a live name",
    mod.nextProjectName("Personal Assistant", ["Personal Assistant 2"]) === "Personal Assistant 3");
  check("Other kinds are counted separately",
    mod.nextProjectName("Web App", ["Personal Assistant 1", "Personal Assistant 2"]) === "Web App 1");
  check("A hand-typed name of the same family is not miscounted",
    mod.nextProjectName("Web App", ["Web App", "Web App notes", "Web App 7"]) === "Web App 8");
  check("Matching ignores case and surrounding blanks",
    mod.nextProjectName("Web App", ["  web app 4 "]) === "Web App 5");
  check("A seed with regex characters is matched literally, not as a pattern",
    mod.nextProjectName("C++ Tool", ["C++ Tool 2"]) === "C++ Tool 3");
  check("An empty seed still yields a usable name",
    mod.nextProjectName("   ", []) === "Project 1");
  check("The generated name produces a clean folder",
    mod.projectPathUnder("C:\\1_Git", mod.nextProjectName("Personal Assistant", []))
      === "C:\\1_Git\\Personal-Assistant-1");

  check("Every project kind carries a name seed",
    (dialog.match(/nameSeed: "/g) ?? []).length === (dialog.match(/namePh: "/g) ?? []).length);
  check("Picking a kind names the project automatically",
    /setName\(nextProjectName\(seed, existingNames\)\)/.test(dialog));
  check("The automatic name numbers off the projects that already exist",
    /existingNames\?: readonly string\[\]/.test(dialog));
  check("A name the user typed is never overwritten",
    /nameTouched\.current = true/.test(dialog)
      && /if \(!open \|\| mode !== "new" \|\| nameTouched\.current \|\| !kindKey\) return;/.test(dialog));
  check("Reopening the dialog starts a fresh automatic name",
    /nameTouched\.current = false/.test(dialog));
  const agents = read("pages/agentic/AgentsPage.tsx");
  check("Every dialog call site is fed the existing project names",
    (agents.match(/existingNames=\{existingProjectNames\}/g) ?? []).length
      === (agents.match(/<ProjectSettingsDialog/g) ?? []).length);
  check("The name list is memoised so the naming effect cannot loop",
    /const existingProjectNames = useMemo\(\(\) => projects\.map\(p => p\.name\), \[projects\]\)/.test(agents));

  check("Both call sites share one slug implementation (no parallel copy)",
    (dialog.match(/projectPathUnder\(/g) ?? []).length >= 2
      && !/replace\(\/\[\^a-zA-Z0-9\._-\]\+\/g/.test(dialog));

  console.log(`PASS projects root (${checks.length}/${checks.length})`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
