// Project portability contract shared by Coding and Agentic. A repo URL is the
// cross-device identity; an absolute folder is valid only on its owning device.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");
const DESKTOP = path.resolve(SRC, "../..");
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const check = (ok, message) => {
  if (!ok) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};

// Execute the real pure decision module.
const portableSource = read(path.join(HERE, "projectPortability.ts"));
const output = ts.transpileModule(portableSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-project-portability-"));
const modulePath = path.join(temp, "projectPortability.js");
fs.writeFileSync(modulePath, output);
const portable = require(modulePath);

check(portable.projectAvailability({ location: "C:\\work\\repo", repo_url: "" }) === "local",
  "a this-device folder is runnable");
check(portable.projectAvailability({ location: "", repo_url: "https://github.com/me/repo.git" }) === "clone-required",
  "a repo-backed remote project must be cloned");
check(portable.projectAvailability({ location: "", repo_url: "" }) === "source-device-only",
  "a remote project without GitHub remains source-device-only");
check(portable.projectCanRun({ location: "", repo_url: "https://github.com/me/repo.git" }) === false,
  "a GitHub identity alone never masquerades as a local folder");
check(portable.projectOriginLabel({ created_device_name: "FARNOTEBOOK001" }) === "FARNOTEBOOK001",
  "the creator PC is shown explicitly");

const code = read(path.join(HERE, "CodePage.tsx"));
check(code.includes('data-ui="CodingProjectHub"') && code.includes("Portable coding command center"),
  "Coding uses a full-page managed-project hub");
check(code.includes("projectAvailability(project)") && code.includes("GHOSTED"),
  "Coding renders remote projects as ghosted cards");
check(code.includes('invoke<string>("github_clone_project"') &&
      code.includes('invoke("update_project", { input: { id: project.id, location } })'),
  "Coding clones to a new local folder before binding this device");
check(code.includes("createdDeviceName") && code.includes("createdDeviceId"),
  "Coding project chats record their creator device");
check(code.includes("createdDeviceName: deviceIdentity.name"),
  "no-project chats record their creator PC too");

const agents = read(path.join(HERE, "AgentsPage.tsx"));
check(agents.includes('data-ui="AgenticProjectHub"') &&
      agents.includes('data-ui="GhostProjectNotice"'),
  "Agentic replaces an unbound project with a ghost project hub");
check(agents.includes("projectHubOpen") && agents.includes("Open the full project manager"),
  "Agentic exposes the same full-page manager for locally runnable projects");
check(agents.includes("projectCanRun({ ...selectedProject, location: runCwd })"),
  "both Agentic send paths refuse to run without this device's folder");
check(agents.includes("Clone on this PC") &&
      agents.includes('invoke<string>("github_clone_project"'),
  "Agentic offers the same repo-to-local clone path");
check(agents.includes("create and push the repo first") &&
      agents.includes("source computer"),
  "a no-repo ghost explains the required source-PC action");

const dialog = read(path.join(HERE, "ProjectSettingsDialog.tsx"));
check(dialog.includes('data-ui="GitHubPortableProjectChoice"') &&
      dialog.includes("GitHub is the shared project identity"),
  "new Agentic projects strongly present the GitHub-first choice");
check(dialog.includes("createGithubRepo") && dialog.includes('invoke<string>("github_create_repo"'),
  "the recommended Agentic creation flow actually creates the repo");

const projects = read(path.join(DESKTOP, "src-tauri", "src", "projects.rs"));
check(projects.includes("repo_url TEXT NOT NULL DEFAULT ''") &&
      projects.includes("created_device_id TEXT NOT NULL DEFAULT ''"),
  "the project database persists portable repo and creator identity");
check(projects.includes("CASE WHEN location_device_id = ?1 THEN location ELSE '' END"),
  "the API still withholds paths owned by another device");

const vault = read(path.join(DESKTOP, "src-tauri", "src", "vault.rs"));
check(vault.includes("repo_url: String") && vault.includes("reconcile project repo"),
  "the vault syncs repo identity independently of device-local paths");
check(vault.includes("locations.get(self_id)") && vault.includes("does NOT") && vault.includes("p.location"),
  "fresh devices use only their own location-map entry");

const github = read(path.join(DESKTOP, "src-tauri", "src", "github.rs"));
check(github.includes("pub async fn github_clone_project") &&
      github.includes('cmd.arg("clone")') &&
      github.includes("let destination = parent.join(leaf)"),
  "the clone command always creates a child folder under the chosen local parent");

console.log(`\nall checks passed (${passed})`);
