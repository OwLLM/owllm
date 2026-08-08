// Regression gate for new non-isolated projects with no first commit.
// Auto-discovered by scripts/smoke-matrix.mjs via *.verify.run.mjs.
// Run from owllm-desktop/: node ui/src/pages/agentic/githubEmptyProjectSetup.verify.run.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const githubSource = readFileSync(join(here, "../../../../src-tauri/src/github.rs"), "utf8");
const codePageSource = readFileSync(join(here, "CodePage.tsx"), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const headProbe = 'git(&["rev-parse", "--verify", "HEAD"])';
const pushHead = 'git(&["push", "-u", "origin", "HEAD"])';

check("the native setup checks for an unborn HEAD", () => {
  assert.ok(githubSource.includes(headProbe));
});

check("the unborn-HEAD check runs before the initial push", () => {
  assert.ok(githubSource.indexOf(headProbe) < githubSource.indexOf(pushHead));
});

check("an empty project is reported as ready for its first commit", () => {
  assert.ok(githubSource.includes("origin wired; the first commit will publish the branch"));
});

check("successful automatic setup does not populate Agent 1's composer status", () => {
  const setupStart = codePageSource.indexOf('if (npCreateRepo && createdPath)');
  const setupEnd = codePageSource.indexOf('if (createdPath) await ensureCatalogProject', setupStart);
  const setupBlock = codePageSource.slice(setupStart, setupEnd);
  assert.ok(setupStart >= 0 && setupEnd > setupStart);
  assert.ok(setupBlock.includes('await invoke<string>("github_create_repo"'));
  // Composer notices are gone entirely (composerNoNotifications.verify.run.mjs).
  // What must still hold: a SUCCESSFUL setup stays silent, and only the
  // failure path raises a notification.
  assert.ok(setupBlock.includes("// Success is deliberately silent"));
  assert.ok(!/notify\(""\)/.test(setupBlock));
  assert.ok(setupBlock.includes("the GitHub repo could not be set up"));
});

// Instrument the real Git executable so this gate proves the mechanism instead
// of trusting a source-only assertion: an unborn HEAD cannot be pushed, while
// the repository and origin remain valid and ready for the first commit.
const root = mkdtempSync(join(tmpdir(), "owllm-empty-project-"));
try {
  const work = join(root, "work");
  const remote = join(root, "remote.git");
  mkdirSync(work);
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", work, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", work, "remote", "add", "origin", remote], { stdio: "ignore" });

  const head = spawnSync("git", ["-C", work, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  const push = spawnSync("git", ["-C", work, "push", "-u", "origin", "HEAD"], { encoding: "utf8" });

  check("a fresh project has an unborn HEAD", () => {
    assert.notEqual(head.status, 0);
  });

  check("blindly pushing that unborn HEAD reproduces the old failure", () => {
    assert.notEqual(push.status, 0);
    assert.match(`${push.stdout}${push.stderr}`, /src refspec HEAD does not match any/i);
  });

  check("the empty project still has the correctly wired origin", () => {
    const origin = execFileSync("git", ["-C", work, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    assert.equal(origin, remote);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error(`githubEmptyProjectSetup: ${passed}/7 checks passed`);
} else {
  console.log(`githubEmptyProjectSetup: ${passed}/7 checks passed`);
}
