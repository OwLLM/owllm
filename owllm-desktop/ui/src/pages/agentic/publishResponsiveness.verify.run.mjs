#!/usr/bin/env node
// Regression gate: host publishing is a long background job, never a modal GUI
// lock, and only one publisher may mutate a repository at a time.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const readLF = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const cards = readLF(path.join(HERE, "PublishCards.tsx"));
const release = readLF(path.join(APP, "src-tauri/src/release.rs"));
const finishScript = readLF(path.join(APP, "scripts/finish-and-publish.sh"));
const attributes = readLF(path.join(APP, "../.gitattributes"));

function fail(message) {
  console.error(`FAIL publish responsiveness: ${message}`);
  process.exit(1);
}

if (!cards.includes("const runningRef = useRef(false)") ||
    !cards.includes("if (runningRef.current)") ||
    !cards.includes("runningRef.current = true")) {
  fail("the immediate frontend single-flight latch is missing");
}
if (!cards.includes("}, { openOutput: false })") ||
    !cards.includes("setOutputOpen(openOutput)")) {
  fail("host publish automatically opens a blocking full-screen output modal");
}
// Unchanged intent: the rail carries a ONE-LINE summary, never the full log.
// The failure path now derives that single line with errorSummary() because the
// backend's first line is a constant header, so firstLine() rendered every
// broken release as a reasonless "finish_and_publish did not complete:".
if (!cards.includes('setActivity({ kind: "ok", msg: firstLine(msg) })') ||
    !cards.includes('setActivity({ kind: "err", msg: errorSummary(msg) })')) {
  fail("full publish logs can still expand the inline rail and capture the layout");
}
if (!cards.includes('lines.find((l) => l.includes("PUBLISH_FAILED:"))') ||
    !cards.includes("lines.find((l) => !/did not complete:?$/.test(l))")) {
  fail("a failed release still summarises as the constant backend header instead of its cause");
}
if (!/catch \(e\) \{[\s\S]*?setOutputOpen\(true\);/.test(cards)) {
  fail("a failed release leaves its output hidden behind a modal the user must find");
}
if (!cards.includes("elapsedClock(elapsedSeconds)") ||
    !cards.includes("Date.now() - startedAt")) {
  fail("a long host build has no visible elapsed-time heartbeat");
}
const leaseCalls = release.match(/acquire_publish_lease\(&repo_dir\)\?/g) ?? [];
if (!release.includes("static ACTIVE_PUBLISHES") ||
    !release.includes("struct PublishLease") ||
    leaseCalls.length !== 2) {
  fail("both backend publish entry points must share one per-repository lease");
}
if (!finishScript.includes("git rev-parse --git-common-dir") ||
    !finishScript.includes("claim_publish_lock") ||
    !finishScript.includes("release_publish_lock") ||
    !finishScript.includes("trap on_publish_exit EXIT")) {
  fail("separate app processes do not share a repository-level publish lease");
}
const refreshAt = finishScript.indexOf("git update-index -q --really-refresh");
const pendingAt = finishScript.indexOf('PENDING_STAGE="$(git status --porcelain');
if (refreshAt < 0 || pendingAt < 0 || refreshAt > pendingAt) {
  fail("Publish checks stale stat metadata before refreshing the Git index");
}
if (!finishScript.includes("|| true\nPENDING_STAGE=")) {
  fail("a genuine dirty file can make the index refresh abort before the actionable preflight");
}
for (const releaseFile of [
  "owllm-desktop/src-tauri/Cargo.toml text eol=lf",
  "owllm-desktop/src-tauri/Cargo.lock text eol=lf",
  "owllm-desktop/src-tauri/tauri.conf.json text eol=lf",
  // Tauri regenerates these with LF on every build; they were committed CRLF,
  // so each `cargo check` left an EOL-only 4882-line diff under the stage path
  // and the preflight below blocked EVERY publish until cleaned by hand.
  "owllm-desktop/src-tauri/gen/schemas/*.json text eol=lf",
]) {
  if (!attributes.includes(releaseFile)) {
    fail(`release metadata is not pinned to LF: ${releaseFile}`);
  }
}
if (!release.includes("tokio::task::spawn_blocking")) {
  fail("host publishing no longer runs off the async UI command executor");
}
if (!release.includes("release command exited {status} without stdout/stderr") ||
    !release.includes("repo_dir: {repo_dir}") ||
    !release.includes("script: {script_for_diag}")) {
  fail("finish_and_publish can still return the blank wrapper with no actionable diagnostics");
}

// Exercise the exact refresh/status sequence in a real temporary repository:
// content-identical rewrites stay clean, while a genuine edit remains visible
// even though --really-refresh is deliberately allowed to return non-zero.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-publish-preflight-"));
const git = (args, allowFailure = false) => {
  const result = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    fail(`fixture git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
};
try {
  git(["init", "-q"]);
  git(["config", "user.email", "verify@owllm.local"]);
  git(["config", "user.name", "OwLLM Verify"]);
  const releaseFile = path.join(fixture, "Cargo.toml");
  fs.writeFileSync(releaseFile, "[package]\nversion = \"1.0.0\"\n");
  git(["add", "Cargo.toml"]);
  git(["commit", "-qm", "fixture"]);

  fs.writeFileSync(releaseFile, "[package]\nversion = \"1.0.0\"\n");
  git(["update-index", "-q", "--really-refresh"], true);
  if (git(["status", "--porcelain", "--", "Cargo.toml"]).stdout.trim()) {
    fail("a content-identical release metadata rewrite remains dirty after the refresh");
  }

  fs.writeFileSync(releaseFile, "[package]\nversion = \"1.0.1\"\n");
  git(["update-index", "-q", "--really-refresh"], true);
  if (!git(["status", "--porcelain", "--", "Cargo.toml"]).stdout.trim()) {
    fail("the refresh hid a genuine release metadata edit");
  }

  // Generated-schema treadmill, end to end: a file committed with CRLF that its
  // generator rewrites with LF is dirty forever on an autocrlf host, which is
  // what made the preflight above reject every release. Prove the block exists
  // WITHOUT the pin, and that `text eol=lf` + renormalize actually clears it.
  git(["config", "core.autocrlf", "true"]);
  const attrFile = path.join(fixture, ".gitattributes");
  const generated = path.join(fixture, "gen.json");
  const generatorOutput = '{\n  "acl": true\n}\n';           // build emits LF
  fs.writeFileSync(attrFile, "gen.json -text\n");             // how it got committed
  fs.writeFileSync(generated, generatorOutput.replace(/\n/g, "\r\n"));
  git(["add", ".gitattributes", "gen.json"]);
  git(["commit", "-qm", "generated schema committed with CRLF"]);

  fs.writeFileSync(generated, generatorOutput);
  git(["update-index", "-q", "--really-refresh"], true);
  if (!git(["status", "--porcelain", "--", "gen.json"]).stdout.trim()) {
    fail("fixture did not reproduce the EOL-only churn the pin is meant to fix");
  }

  fs.writeFileSync(attrFile, "gen.json text eol=lf\n");
  git(["add", "--renormalize", "--", "gen.json"]);
  git(["add", ".gitattributes"]);
  git(["commit", "-qm", "pin generated schema to LF"]);
  fs.writeFileSync(generated, generatorOutput);               // build runs again
  git(["update-index", "-q", "--really-refresh"], true);
  if (git(["status", "--porcelain", "--", "gen.json"]).stdout.trim()) {
    fail("pinning the generated schema to LF does not stop it re-dirtying the stage path");
  }
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log("PASS publish is non-modal, off-thread, compact, and single-flight");
