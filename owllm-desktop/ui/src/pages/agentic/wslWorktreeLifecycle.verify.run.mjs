#!/usr/bin/env node
// Real Windows -> WSL integration gate for the fleet worktree boundary.
//
// This deliberately creates the source repository on a Windows drive, addresses
// it through /mnt/<drive> inside WSL, and keeps the isolated worktree under the
// distro user's Linux home. It exercises the same create -> edit -> finalize ->
// squash-merge -> remove lifecycle as fleet.rs without trusting the flaky WSL
// UNC redirector for filesystem operations.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log("SKIP WSL worktree lifecycle: Windows-only integration gate.");
  process.exit(0);
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

const distroBytes = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "buffer" });
const distroText = Buffer.from(distroBytes.stdout ?? [])
  .toString("utf16le")
  .replace(/\0/g, "");
const distro = distroText.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
if (!distro) {
  console.log("SKIP WSL worktree lifecycle: no WSL distro is installed.");
  process.exit(0);
}

function windowsToLinux(windowsPath) {
  const normalized = path.resolve(windowsPath).replace(/\\/g, "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) throw new Error(`not a Windows drive path: ${windowsPath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function bashQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function wsl(script) {
  return run("wsl.exe", ["-d", distro, "--", "bash", "-s"], { input: script });
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-wsl-fleet-"));
const repo = path.join(temp, "source-repo");
fs.mkdirSync(repo);
const linuxRepo = windowsToLinux(repo);
const runId = `verify-${process.pid}-${Date.now()}`;
let linuxWorktree = "";
let branch = "";

try {
  wsl(`
set -euo pipefail
repo=${bashQuote(linuxRepo)}
git -C "$repo" init -b main
git -C "$repo" config user.email isolation@owllm.local
git -C "$repo" config user.name "OwLLM WSL Lifecycle"
printf 'shared checkout\\n' > "$repo/feature.txt"
git -C "$repo" add feature.txt
git -C "$repo" commit -m base
`);

  const details = wsl(`
set -euo pipefail
repo=${bashQuote(linuxRepo)}
dest="$HOME/.owllm/fleet/source-repo/${runId}/coder"
branch="owllm-fleet/${runId}/coder"
mkdir -p -- "$(dirname "$dest")"
git -C "$repo" worktree add -b "$branch" "$dest" HEAD >/dev/null
printf '__WORKTREE__=%s\\n__BRANCH__=%s\\n' "$dest" "$branch"
`);
  linuxWorktree = details.match(/__WORKTREE__=(.+)/)?.[1]?.trim() ?? "";
  branch = details.match(/__BRANCH__=(.+)/)?.[1]?.trim() ?? "";
  if (!linuxWorktree || !branch) throw new Error(`could not parse worktree details:\n${details}`);

  wsl(`
set -euo pipefail
repo=${bashQuote(linuxRepo)}
wt=${bashQuote(linuxWorktree)}
branch=${bashQuote(branch)}
printf 'isolated WSL edit\\n' > "$wt/feature.txt"
git -C "$wt" add -A
git -C "$wt" commit -m "[coder] WSL lifecycle" >/dev/null
git -C "$repo" merge --squash --no-commit "$branch" >/dev/null
git -C "$repo" commit -m "[merge:coder] integrate parallel dispatch" >/dev/null
git -C "$repo" worktree remove --force "$wt"
git -C "$repo" branch -D "$branch" >/dev/null
rmdir -- "$(dirname "$wt")" 2>/dev/null || true
`);

  const finalContent = fs.readFileSync(path.join(repo, "feature.txt"), "utf8");
  if (finalContent !== "isolated WSL edit\n") {
    throw new Error(`merge result is wrong: ${JSON.stringify(finalContent)}`);
  }
  const stillExists = wsl(
    `if [ -d ${bashQuote(linuxWorktree)} ]; then printf yes; else printf no; fi`,
  ).trim();
  if (stillExists !== "no") throw new Error(`worktree was not removed: ${linuxWorktree}`);

  console.log(`PASS real Windows-to-WSL worktree lifecycle (${distro})`);
} finally {
  if (linuxWorktree && branch) {
    try {
      wsl(`
repo=${bashQuote(linuxRepo)}
git -C "$repo" worktree remove --force ${bashQuote(linuxWorktree)} >/dev/null 2>&1 || true
git -C "$repo" branch -D ${bashQuote(branch)} >/dev/null 2>&1 || true
rm -rf -- ${bashQuote(linuxWorktree)}
`);
    } catch {
      // The primary failure is reported above; cleanup remains best-effort.
    }
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
