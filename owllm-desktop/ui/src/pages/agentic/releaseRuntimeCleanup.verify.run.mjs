#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const REPO = path.resolve(APP, "..");

let failed = 0;
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`ok - ${label}`);
  } else {
    failed++;
    console.error(`not ok - ${label}${detail ? `\n  ${detail}` : ""}`);
  }
}

const gitRs = fs.readFileSync(path.join(APP, "src-tauri/src/git.rs"), "utf8");
const libRs = fs.readFileSync(path.join(APP, "src-tauri/src/lib.rs"), "utf8");
const cards = fs.readFileSync(path.join(APP, "ui/src/pages/agentic/PublishCards.tsx"), "utf8");
const ignore = fs.readFileSync(path.join(REPO, ".gitignore"), "utf8");

check(".tmp_wheels is ignored as generated scratch", /(?:^|\n)\.tmp_wheels\/(?:\r?\n|$)/.test(ignore));
check("runtime detector includes .tmp_wheels as a compact root",
  /TRACKED_RUNTIME_PATHS[\s\S]*"\.tmp_wheels"/.test(gitRs)
    && /fn compact_tracked_runtime_paths/.test(gitRs)
    && /out\.push\("\.tmp_wheels"\.to_string\(\)\)/.test(gitRs));
check("cleanup command is registered with Tauri", libRs.includes("git::git_untrack_runtime_files"));
check("Publisher card calls deterministic cleanup instead of asking an agent to invent shell",
  cards.includes('invoke<string>("git_untrack_runtime_files"')
    && cards.includes("Clean tracked runtime")
    && !cards.includes("Use Fix with agent to safely de-track them"));
check("cleanup is cached-only and root-based",
  /vec!\["rm", "--cached", "-r", "--"\]/.test(gitRs)
    && /rm_args\.extend\(paths\.iter\(\)\.map\(String::as_str\)\)/.test(gitRs)
    && !/join\(""\)[\s\S]{0,200}git_untrack_runtime_files/.test(gitRs));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-runtime-cleanup-"));
const git = (...args) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" });
try {
  git("init", "-b", "main");
  git("config", "user.email", "cleanup-gate@owllm.local");
  git("config", "user.name", "OwLLM Cleanup Gate");
  fs.mkdirSync(path.join(tmp, ".tmp_wheels/browser-verify/node_modules/playwright"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".owllm"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".tmp_wheels/browser-verify/package.json"), "{}\n");
  fs.writeFileSync(path.join(tmp, ".tmp_wheels/browser-verify/node_modules/playwright/package.json"), "{}\n");
  fs.writeFileSync(path.join(tmp, ".owllm/project.json"), "{\"durable\":true}\n");
  fs.writeFileSync(path.join(tmp, "src/main.rs"), "fn main() {}\n");
  git("add", "-A");
  git("commit", "-m", "fixture");

  const tracked = git("ls-files").trim().split(/\r?\n/).filter(Boolean);
  const fused = tracked.join("");
  const oldShape = spawnSync("git", ["ls-files", "--error-unmatch", "--", fused], {
    cwd: tmp,
    encoding: "utf8",
  });
  check("old one-argument cleanup shape fails against a real repo", oldShape.status !== 0);

  fs.writeFileSync(path.join(tmp, ".gitignore"), ".tmp_wheels/\n");
  const fixed = spawnSync("git", ["rm", "--cached", "-r", "--", ".tmp_wheels"], {
    cwd: tmp,
    encoding: "utf8",
  });
  check("fixed cleanup uses one root pathspec and succeeds", fixed.status === 0, fixed.stderr || fixed.stdout);
  check("cleanup preserves the working-tree files",
    fs.existsSync(path.join(tmp, ".tmp_wheels/browser-verify/node_modules/playwright/package.json")));
  check("cleanup leaves durable .owllm project metadata tracked",
    git("ls-files", ".owllm/project.json").trim() === ".owllm/project.json");
  check("cleanup removes generated scratch from Git tracking",
    git("ls-files", ".tmp_wheels").trim() === "");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.error(`releaseRuntimeCleanup: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("releaseRuntimeCleanup: all checks passed");
