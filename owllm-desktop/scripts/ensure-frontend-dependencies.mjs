import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const REQUIRED_FILES = [
  "node_modules/vite/package.json",
  "node_modules/three/package.json",
  "node_modules/occt-import-js/dist/occt-import-js.wasm",
  "node_modules/typescript/package.json",
  "node_modules/@tauri-apps/cli/tauri.js",
];

export function dependencyProblem(root = APP) {
  for (const relative of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(root, relative))) return `${relative} is missing`;
  }
  try {
    createRequire(path.join(root, "package.json"))("rollup");
  } catch (error) {
    return `Rollup's native package is unusable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return "";
}

function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort. A stale staging directory is replaced next run.
  }
}

export function activateStagedDependencies(root, stage) {
  const live = path.join(root, "node_modules");
  const staged = path.join(stage, "node_modules");
  const previous = path.join(root, `.owllm-reclaimed-dependencies-${process.pid}-${Date.now()}`);
  let movedPrevious = false;

  try {
    if (fs.existsSync(live)) {
      fs.renameSync(live, previous);
      movedPrevious = true;
    }
    fs.renameSync(staged, live);
  } catch (error) {
    if (movedPrevious && !fs.existsSync(live)) {
      try { fs.renameSync(previous, live); } catch { /* retain the original error */ }
    }
    throw error;
  }

  if (movedPrevious) removeTree(previous);
}

function npmCommand(ignoreScripts = false) {
  const option = ignoreScripts ? " --ignore-scripts" : "";
  if (process.platform === "win32") {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `npm ci --no-audit --no-fund${option}`] };
  }
  return { command: "npm", args: ["ci", "--no-audit", "--no-fund", ...(ignoreScripts ? ["--ignore-scripts"] : [])] };
}

export function installDependencies(root = APP) {
  const stage = path.join(root, "node_modules.partial");
  const prepareStage = () => {
    removeTree(stage);
    fs.mkdirSync(stage, { recursive: true });
    for (const name of ["package.json", "package-lock.json", ".npmrc"]) {
      const source = path.join(root, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stage, name));
    }
  };

  prepareStage();
  let npm = npmCommand();
  console.log("[owllm-desktop] Installing frontend dependencies in a staging directory...");
  let result = spawnSync(npm.command, npm.args, { cwd: stage, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.warn("[owllm-desktop] npm's lifecycle check failed; retrying the isolated install without lifecycle scripts...");
    prepareStage();
    npm = npmCommand(true);
    result = spawnSync(npm.command, npm.args, { cwd: stage, stdio: "inherit" });
    if (result.error || result.status !== 0) {
      removeTree(stage);
      throw result.error || new Error(`npm ci exited with code ${result.status ?? "unknown"}`);
    }
  }

  const stagedProblem = dependencyProblem(stage);
  if (stagedProblem) {
    removeTree(stage);
    throw new Error(`npm completed, but the staged install is invalid: ${stagedProblem}`);
  }

  try {
    activateStagedDependencies(root, stage);
  } finally {
    removeTree(stage);
  }
}

export function ensureDependencies(root = APP) {
  const problem = dependencyProblem(root);
  if (!problem) return false;
  console.log(`[owllm-desktop] Repairing frontend dependencies: ${problem}`);
  installDependencies(root);
  const remaining = dependencyProblem(root);
  if (remaining) throw new Error(`Dependency repair did not produce a usable install: ${remaining}`);
  console.log("[owllm-desktop] Frontend dependencies are ready.");
  return true;
}

function main() {
  try {
    if (process.argv.includes("--check")) {
      const problem = dependencyProblem(APP);
      if (problem) throw new Error(problem);
      console.log("[owllm-desktop] Frontend dependencies are ready.");
      return;
    }
    ensureDependencies(APP);
  } catch (error) {
    console.error(`[owllm-desktop] Dependency setup failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Close any running Vite/Tauri/Node process for this checkout, then run the command again.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
