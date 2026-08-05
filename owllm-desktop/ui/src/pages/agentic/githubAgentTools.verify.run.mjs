import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const localTools = fs.readFileSync(path.join(here, "localTools.ts"), "utf8");
const codePage = fs.readFileSync(path.join(here, "CodePage.tsx"), "utf8");

let passed = 0;
let failed = 0;
function check(ok, message) {
  if (ok) { passed += 1; console.log(`PASS ${message}`); }
  else { failed += 1; console.error(`FAIL ${message}`); }
}

for (const name of [
  "github_status",
  "github_list_repositories",
  "github_repo_url",
  "github_create_repo",
  "github_clone_project",
]) {
  check(localTools.includes(`name: "${name}"`), `${name} is advertised as a local tool`);
  check(localTools.includes(`case "${name}"`), `${name} is executable by the local tool dispatcher`);
}
check(localTools.includes('invoke<string>("github_create_repo"'), "repo creation uses the existing native command");
check(localTools.includes('invoke<string>("github_clone_project"'), "clone uses the existing native command");
check(localTools.includes('invoke<string>("github_repo_url"'), "origin lookup uses the existing native command");
check(codePage.includes("first-class tools: github_status"), "Plan & build tells the coding agent about GitHub tools");

console.log(`github agent tools: ${passed} pass · ${failed} fail`);
process.exitCode = failed ? 1 : 0;
