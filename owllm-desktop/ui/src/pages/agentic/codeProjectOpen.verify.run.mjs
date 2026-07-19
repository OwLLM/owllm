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

// Execute the real page/project matching helper.
const helperSource = read(path.join(HERE, "codeProjectPages.ts"));
const helperJs = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-code-project-open-"));
const helperPath = path.join(temp, "codeProjectPages.js");
fs.writeFileSync(helperPath, helperJs);
const { savedPageIdsForLocalProject } = require(helperPath);

const values = new Map([
  ["owllm:code:page:linux", JSON.stringify({
    projectRoot: "D:\\1_GitHome\\LLM-Studio", workspace: "D:\\fleet\\linux\\code",
    isolated: true, pageRename: "NVIDIA Thor Linux",
  })],
  ["owllm:code:page:mac", JSON.stringify({
    workspace: "D:/1_GitHome/LLM-Studio/", isolated: false,
    messages: [{ role: "user", content: "Cook the macOS build" }],
  })],
  ["owllm:code:page:foreign", JSON.stringify({
    projectRoot: "C:\\OtherPC\\LLM-Studio", workspace: "C:\\OtherPC\\fleet\\code",
    isolated: true, projectId: "same-project", repoUrl: "https://github.com/ruigro/LLM-Studio.git",
    messages: [{ role: "user", content: "Foreign checkout" }],
  })],
  ["owllm:code:page:failed", JSON.stringify({
    projectRoot: "D:\\1_GitHome\\LLM-Studio", workspace: "", isolated: false,
    status: "Couldn't create the worktree",
  })],
  ["owllm:code:page:broken", "{not-json"],
  ["owllm:code:page:windows", JSON.stringify({
    projectRoot: "D:\\1_GitHome\\LLM-Studio", workspace: "D:\\fleet\\windows\\code",
    isolated: true, draft: "continue here",
  })],
]);
const keys = [...values.keys()];
const storage = {
  get length() { return keys.length; },
  key(i) { return keys[i] ?? null; },
  getItem(key) { return values.get(key) ?? null; },
};
const pages = savedPageIdsForLocalProject(storage, "d:/1_GitHome/LLM-Studio/");
check(JSON.stringify(pages) === JSON.stringify(["linux", "mac", "windows"]),
  "opening a local project finds all saved Coding pages for that checkout");
check(!pages.includes("foreign"),
  "a same-repo page carrying another PC's absolute path is never activated");
check(!pages.includes("failed"),
  "a blank failed-open record does not replace real saved pages");
check(pages.includes("windows"),
  "a malformed record cannot hide later valid pages");

const code = read(path.join(HERE, "CodePage.tsx"));
check(code.includes("savedPageMetasForLocalProject(detail.project)") &&
      code.includes("setActiveId(saved[0].id)"),
  "the Coding project card activates recovered page tabs");
check(code.includes("if (detail.handled) return;") &&
      code.includes("await openWorkspace(project.location)"),
  "a project creates a new page only when no saved page exists");

const fleet = read(path.join(DESKTOP, "src-tauri", "src", "fleet.rs"));
const createStart = fleet.indexOf("pub async fn fleet_worktree_create(");
const createEnd = fleet.indexOf("// ------------------------------------------------------------------\n// 2.", createStart);
const createBody = fleet.slice(createStart, createEnd);
check(createStart >= 0 && !createBody.includes("sync_current_branch_from_origin(&cwd)"),
  "opening a Coding page does not require local/remote history reconciliation");
check(fleet.slice(createEnd).includes("sync_current_branch_from_origin(&cwd)"),
  "remote-history safety remains enforced when work is integrated");

const mirror = read(path.join(DESKTOP, "src-tauri", "src", "state_mirror.rs"));
check(mirror.includes('const LEGACY_IMPORT_MARKER: &str = "migration:legacy-webview-leveldb-v2"'),
  "the incomplete v1 profile recovery is retried once");
check(mirror.includes("history_bearing_key(&key) && value.len() > old.len()"),
  "legacy recovery replaces history only with a substantively larger record");

console.log(`\nall checks passed (${passed})`);
