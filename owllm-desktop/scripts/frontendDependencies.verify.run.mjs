import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activateStagedDependencies, dependencyProblem } from "./ensure-frontend-dependencies.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(APP, "package.json"), "utf8"));
const launcher = fs.readFileSync(path.join(APP, "launch-dev.bat"), "utf8");
const installer = fs.readFileSync(path.join(HERE, "ensure-frontend-dependencies.mjs"), "utf8");
let passed = 0;
const check = (ok, message) => {
  if (!ok) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};

check(pkg.scripts.predev === "npm run deps:ensure" && pkg.scripts.prebuild === "npm run deps:ensure" && pkg.scripts.pretauri === "npm run deps:ensure",
  "every frontend entry point validates dependencies before loading Vite or Tauri");
check(launcher.includes("call npm run deps:ensure") && !launcher.includes('if not exist "%cd%\\node_modules"'),
  "the double-click launcher no longer mistakes a partial node_modules directory for a valid install");
check(installer.includes("npmCommand(true)") && installer.includes('"--ignore-scripts"'),
  "a blocked npm lifecycle check retries in staging without publishing a partial install");

const empty = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-deps-empty-"));
try {
  fs.writeFileSync(path.join(empty, "package.json"), "{}\n");
  check(dependencyProblem(empty).includes("node_modules/vite/package.json is missing"),
    "a present-but-empty dependency directory is rejected with an actionable reason");
} finally {
  fs.rmSync(empty, { recursive: true, force: true });
}

const swap = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-deps-swap-"));
try {
  const live = path.join(swap, "node_modules");
  const stage = path.join(swap, "node_modules.partial", "node_modules");
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(live, "marker"), "old");
  fs.writeFileSync(path.join(stage, "marker"), "new");
  activateStagedDependencies(swap, path.dirname(stage));
  check(fs.readFileSync(path.join(live, "marker"), "utf8") === "new",
    "a complete staged dependency tree replaces the old tree atomically");
} finally {
  fs.rmSync(swap, { recursive: true, force: true });
}

const liveCheck = spawnSync(process.execPath, [path.join(HERE, "ensure-frontend-dependencies.mjs"), "--check"], { cwd: APP, encoding: "utf8" });
check(liveCheck.status === 0, `the repaired checkout passes the real dependency check${liveCheck.stderr ? `: ${liveCheck.stderr.trim()}` : ""}`);

console.log(`\nall checks passed (${passed})`);
