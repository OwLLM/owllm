// Guards the disk-reclaim contract for Code-page worktrees.
//
// The defect: a page worktree had exactly two fates, and neither reclaimed
// anything while the page stayed open. `fleet_cleanup_orphans` skips
// `owllm-page/*` on purpose (unmerged edits), and `fleet_worktree_remove` only
// strips caches on an explicit, confirmed close. Navigating away from a page
// therefore kept its multi-GB `target/` forever — measured at ~12 GB of parked
// `target/` across four workspaces on one machine, which is why that disk
// refilled days after being cleared by hand.
//
// The second defect: `dist/` was treated as regenerable build output, but
// `dist/modules/` is the module payload cache — multi-GB archives that
// build-modules.ps1 DOWNLOADS. Reclaiming it would have thrown away 9.4 GB that
// costs hours to re-fetch, and that `build-release.bat` itself refuses to
// rebuild when present.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../../../..");
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
let passed = 0;
const check = (ok, message) => {
  if (!ok) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};

const fleet = read(path.join(DESKTOP, "src-tauri", "src", "fleet.rs"));
const lib = read(path.join(DESKTOP, "src-tauri", "src", "lib.rs"));
const codePage = read(path.join(HERE, "CodePage.tsx"));

// Slice a Rust item body so every assertion below is anchored to the function
// it names — a bare substring search would happily match a comment elsewhere.
const bodyOf = (source, signature) => {
  const start = source.indexOf(signature);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return "";
};

// ---------------------------------------------------------------- the payload
// cache must never be mistaken for build output
const cacheNames = /const BUILD_CACHE_DIR_NAMES: &\[&str\] = &\[([^\]]*)\];/.exec(fleet);
check(!!cacheNames, "the reclaimable-cache list is still declared where the gate can read it");
const names = cacheNames[1].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean);
check(!names.includes("dist"),
  "`dist` is NOT reclaimable — dist/modules holds downloaded payload archives, not build output");
check(names.includes("target") && names.includes("node_modules"),
  "`target` and `node_modules` are still reclaimed (they rebuild from sources on disk)");

// ------------------------------------------------------- the reclaim walker
const walker = bodyOf(fleet, "fn reclaim_build_caches(");
check(walker.includes("min_idle_secs: u64"),
  "the reclaim walker takes its idle window as a parameter, so page and team sweeps can differ");
check(/\.map\(\|e\| e\.as_secs\(\) < min_idle_secs\)\s*\n\s*\.unwrap_or\(true\)/.test(walker),
  "a cache whose mtime cannot be read is treated as LIVE and kept, never deleted on a guess");
check(walker.includes('git(root, &["check-ignore", "-q"'),
  "a directory is deleted only after git confirms it is ignored — never tracked source");
check(walker.includes("evict_cache_dir(&path)") && !walker.includes("std::fs::remove_dir_all(&path).is_ok()"),
  "the walker evicts rename-first — it never unlinks a cache in place");
check(walker.includes("starts_with(QUARANTINE_PREFIX)"),
  "wreckage from an interrupted sweep is retried, so it cannot become its own leak");

// A locked file used to leave a gutted `node_modules` that still LOOKED
// populated, so the next build picked it up and failed. Rename-first makes the
// outcome binary: fully out of the way, or completely untouched.
const evict = bodyOf(fleet, "fn evict_cache_dir(");
check(/if std::fs::rename\(path, &quarantine\)\.is_err\(\) \{\s*\n\s*return false;/.test(evict),
  "a cache that cannot be renamed is reported as NOT reclaimed and left byte-for-byte intact");
const renameIdx = evict.indexOf("std::fs::rename(path, &quarantine)");
const unlinkIdx = evict.indexOf("remove_dir_all(&quarantine)");
check(renameIdx >= 0 && unlinkIdx > renameIdx,
  "nothing is unlinked until AFTER the rename has succeeded");
check(/const QUARANTINE_PREFIX: &str = "\.owllm-reclaimed-";/.test(fleet) &&
      !names.some((n) => ".owllm-reclaimed-".startsWith(n)),
  "the quarantine name can never be mistaken for a build cache by a later build");

// ---------------------------------------------------- the new page-cache sweep
const sweep = bodyOf(fleet, "pub async fn fleet_reclaim_page_caches(");
check(sweep.length > 0, "fleet_reclaim_page_caches exists");
check(sweep.includes('if !branch.starts_with("owllm-page/")'),
  "the page sweep only ever visits owllm-page/* worktrees");
check(sweep.includes("if same_worktree(&wt, &active)"),
  "the page sweep skips the worktree the caller just opened");
check(sweep.includes("reclaim_build_caches(&wt, PAGE_CACHE_IDLE_SECS)"),
  "the page sweep uses the long (parked) idle window, not the 1-hour build window");
check(sweep.length > 0 && !/worktree",\s*"remove|branch",\s*"-D|remove_dir_all_native/.test(sweep),
  "the page sweep never removes a worktree, a branch, or a whole directory tree");
check(/const PAGE_CACHE_IDLE_SECS: u64 = 24 \* 60 \* 60;/.test(fleet),
  "a parked page must be silent for a full day before its caches are reclaimed");
check(lib.includes("fleet::fleet_reclaim_page_caches,"),
  "the command is registered on the Tauri handler — an unregistered command can never run");

// ------------------------------------------------------------- the call site
check(/invoke<number>\("fleet_reclaim_page_caches", \{ projectCwd: dir, activeWorktree: outcome\.path \}\)/.test(codePage),
  "opening a Coding workspace sweeps this project's parked page caches");
const invokeIdx = codePage.indexOf('invoke<number>("fleet_reclaim_page_caches"');
const readyIdx = codePage.indexOf('if (outcome.status === "ready")');
check(readyIdx >= 0 && invokeIdx > readyIdx,
  "the sweep runs only after the workspace is ready, so it never delays preparing one");
check(/void invoke<number>\("fleet_reclaim_page_caches"[\s\S]{0,160}?\.catch\(\(\) => \{\}\)/.test(codePage),
  "the sweep is fire-and-forget — it can never block or fail opening a workspace");

// --------------------------------------------------- invariants that must hold
// These passed BEFORE this change too. They are here so a later edit cannot
// quietly turn the new sweep into something that deletes the user's work.
const orphans = bodyOf(fleet, "pub async fn fleet_cleanup_orphans(");
check(orphans.includes('if !branch.starts_with("owllm-fleet/")'),
  "the team sweep still refuses to delete Code-page worktrees");
check(bodyOf(fleet, "pub async fn fleet_worktree_remove(").includes(
  "reclaim_build_caches(&PathBuf::from(&args.worktree_path), BUILD_CACHE_LIVE_SECS)"),
  "an explicitly-kept worktree still reclaims caches on the 1-hour build window");

console.log(`\nall checks passed (${passed})`);
