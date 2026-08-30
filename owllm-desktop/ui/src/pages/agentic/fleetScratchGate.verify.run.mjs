#!/usr/bin/env node
// Gate for the predicate that decides whether a page may run a model.
//
// `fleet.rs::is_app_scratch` is the single choke point for BOTH the refresh gate
// ("this page is not current with the project… the page has pending edits") and
// every commit path (`unstage_app_scratch`, used by worktree finalize, the
// Publisher checkpoint, and git.rs's status). Every bug it has had was a
// directory it failed to recognise as OWLLM's own churn.
//
// It cannot be covered by `cargo test`: the lib-test binary aborts with
// STATUS_ENTRYPOINT_NOT_FOUND on Windows before a single test runs, so the
// asserts in fleet.rs were never executed. `fleet_scratch.rs` is therefore
// dependency-free and this gate compiles it ALONE with `rustc --test`, which
// needs no crate graph and no DLLs. That is why the guard actually runs.
//
// Regression it pins (2026-08-30): the disk janitor renames a build cache to
// `.owllm-reclaimed-<stamp>/` before deleting it. That name was gitignored only
// under `owllm-desktop/`, so in `owllm-website/` the renamed cache read as
// thousands of untracked "pending edits" — every model run blocked — and a Sync
// then committed one (a6080592 tracked a rollup `.node` binary). The janitor
// later deleted the directory, leaving a phantom `D` no Sync could ever clear.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const moduleFile = join(repo, "owllm-desktop", "src-tauri", "src", "fleet_scratch.rs");

let pass = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

check("fleet_scratch.rs exists", existsSync(moduleFile), moduleFile);
if (!existsSync(moduleFile)) {
  console.error("FAIL: dependency-free scratch module missing");
  process.exit(1);
}

// The module must stay dependency-free, or it stops being compilable alone and
// this gate silently degrades to "skipped".
const src = readFileSync(moduleFile, "utf8");
check(
  "module has no crate imports",
  !/^\s*use\s+(crate|super::super|tauri|serde|std::process)/m.test(src),
  "an import here re-breaks standalone compilation"
);
check("module defines the quarantine prefix", src.includes('QUARANTINE_PREFIX: &str = ".owllm-reclaimed-"'));
check(
  "quarantine is matched per path segment at any depth",
  /split\('\/'\)\.any\(\|seg\| seg\.starts_with\(QUARANTINE_PREFIX\)\)/.test(src),
  "a root-only or prefix-only match misses owllm-website/.owllm-reclaimed-*/"
);

// fleet.rs must consume the shared predicate rather than re-declaring its own.
const fleetSrc = readFileSync(join(repo, "owllm-desktop", "src-tauri", "src", "fleet.rs"), "utf8");
check(
  "fleet.rs re-exports the shared predicate",
  /use crate::fleet_scratch::\{[^}]*is_app_scratch[^}]*\}/.test(fleetSrc)
);
check(
  "fleet.rs no longer defines a second copy",
  !/fn is_app_scratch\(/.test(fleetSrc),
  "a duplicate predicate would drift from the tested one"
);

// The quarantine name must be ignored for EVERY subproject, not just
// owllm-desktop/ — that asymmetry is what let the flood reach git at all.
const rootIgnore = readFileSync(join(repo, ".gitignore"), "utf8");
check(
  "root .gitignore covers the quarantine dir",
  /^\.owllm-reclaimed-\*\/$/m.test(rootIgnore),
  "only owllm-desktop/.gitignore covered it before"
);

// The real test: compile the module alone and RUN its asserts.
const rustc = spawnSync("rustc", ["--version"], { encoding: "utf8" });
if (rustc.status !== 0) {
  console.error("FAIL: rustc not available — this gate cannot verify the predicate");
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "owllm-scratch-gate-"));
try {
  const bin = join(out, "fleet_scratch_test.exe");
  const build = spawnSync(
    "rustc",
    ["--test", "--edition", "2021", "-A", "dead_code", "-o", bin, moduleFile],
    { encoding: "utf8" }
  );
  check("module compiles standalone", build.status === 0, (build.stderr || "").trim().slice(0, 600));
  if (build.status === 0) {
    const run = spawnSync(bin, ["--test-threads", "1"], { encoding: "utf8" });
    const stdout = run.stdout || "";
    check("standalone tests pass", run.status === 0, (stdout + (run.stderr || "")).trim().slice(0, 900));
    // Guard against a vacuous pass: the binary must actually have run tests.
    const ran = Number(/(\d+) passed/.exec(stdout)?.[1] ?? 0);
    check("tests actually executed", ran >= 3, `only ${ran} test(s) ran`);
    for (const name of [
      "app_scratch_is_ignored_but_source_is_not",
      "refresh_gate_filter_drops_janitor_churn_and_keeps_user_edits",
      "porcelain_path_parsing",
    ]) {
      check(`ran ${name}`, stdout.includes(name), "test missing from the module");
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`FAIL fleetScratchGate: ${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS fleetScratchGate: ${pass}/${pass} checks`);
