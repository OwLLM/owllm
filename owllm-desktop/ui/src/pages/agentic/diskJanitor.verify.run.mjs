// Guards the GLOBAL disk-janitor contract: OwLLM's total disk footprint must
// stay bounded WITHOUT the user opening anything.
//
// The defect class this pins down: every earlier reclaim was scoped to one
// project and triggered by USING it (orphan sweep at team-run start, page-cache
// sweep at page open). A project the user stopped opening was never swept
// again, release staging in the ACTIVE worktree was invisible to all sweeps
// (21 GB of `.cache`/`dist` in one worktree), and the WSL linux-build
// workspace had no cleaner at all (30 GB of stale cargo targets). Each past
// "fix" was a garbage collector for the artifact seen that day; nothing owned
// the total. The janitor owns the total, and the DISK_PRODUCERS registry makes
// a producer without a cleaner a RELEASE FAILURE, not a future surprise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
const fleetScratch = read(path.join(DESKTOP, "src-tauri", "src", "fleet_scratch.rs"));
const sandbox = read(path.join(DESKTOP, "src-tauri", "src", "sandbox.rs"));
const lib = read(path.join(DESKTOP, "src-tauri", "src", "lib.rs"));
const card = read(path.join(DESKTOP, "ui", "src", "pages", "core", "SandboxDiskCard.tsx"));

// Slice a Rust item body so every assertion is anchored to the function it
// names — a bare substring search would happily match a comment elsewhere.
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

// ------------------------------------------- the producer → cleaner registry
const registry = /const DISK_PRODUCERS: &\[\(&str, &str\)\] = &\[([\s\S]*?)\];/.exec(fleet);
check(!!registry, "the DISK_PRODUCERS registry is declared where the gate can read it");
const rows = [...registry[1].matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((m) => [m[1], m[2]]);
check(rows.length >= 6, `the registry lists every known producer (${rows.length} rows)`);
for (const [what, cleaner] of rows) {
  check(
    fleet.includes(`fn ${cleaner}(`) || sandbox.includes(`fn ${cleaner}(`),
    `producer "${what}" names a cleaner that actually exists: ${cleaner}`
  );
}
for (const required of [
  "reclaim_build_caches",
  "reclaim_staging",
  "fleet_cleanup_orphans",
  "fleet_reclaim_page_caches",
  "janitor_sweep_all",
  "trim_impl",
]) {
  check(rows.some(([, c]) => c === required),
    `the registry still covers ${required} — removing a cleaner row is a release failure`);
}

// ------------------------------------------------------- the global janitor
const sweep = bodyOf(fleet, "pub(crate) fn janitor_sweep_all(");
check(sweep.includes("fleet_root()"),
  "the janitor enumerates the app-owned fleet root DIRECTLY — no project has to be open");
check(sweep.includes('leaf.join(".git").exists()'),
  "the janitor only ever touches leaf directories that are git worktrees the app created");
check(sweep.includes("reclaim_build_caches(&leaf, JANITOR_BUILD_IDLE_SECS)"),
  "build caches are reclaimed with the janitor's long idle window");
check(sweep.includes("reclaim_staging(&leaf, STAGING_IDLE_SECS)"),
  "release staging is reclaimed in EVERY worktree — including the active one");
check(!/worktree",\s*"remove|branch",\s*"-D|remove_dir_all_native/.test(sweep),
  "the janitor never removes a worktree, a branch, or a whole directory tree");
check(/const JANITOR_BUILD_IDLE_SECS: u64 = 7 \* 24 \* 60 \* 60;/.test(fleet),
  "the janitor waits a full WEEK on build caches (it cannot know which pages other instances have open)");
check(/const STAGING_IDLE_SECS: u64 = 7 \* 24 \* 60 \* 60;/.test(fleet),
  "release staging must sit idle a full week before it is taken");

// ---------------------------------------------------- the staging reclaimer
const staging = bodyOf(fleet, "fn reclaim_staging(");
check(staging.includes('git(root, &["check-ignore", "-q"'),
  "staging is deleted only after git confirms it is ignored — never tracked source");
check(/\.map\(\|e\| e\.as_secs\(\) < min_idle_secs\)\s*\n\s*\.unwrap_or\(true\)/.test(staging),
  "a staging dir whose mtime cannot be read is treated as LIVE and kept");
check(staging.includes("evict_cache_dir(&path)") || staging.includes("evict_cache_dir(&cp)"),
  "staging directories leave rename-first — never unlinked in place");
check(staging.includes("starts_with(QUARANTINE_PREFIX)"),
  "wreckage from an interrupted staging sweep is retried, so it cannot become its own leak");
check(/const DIST_KEEP_CHILD: &str = "modules";/.test(fleet) &&
      staging.includes("c.file_name() == DIST_KEEP_CHILD"),
  "dist/modules (downloaded payload archives, hours to re-fetch) is NEVER reclaimed");
check(/if n == "dist" \{[\s\S]*?continue; \/\/ never treat dist itself as reclaimable/.test(staging),
  "`dist` itself is never removed — only its stale children");
const cacheNames = /const BUILD_CACHE_DIR_NAMES: &\[&str\] = &\[([^\]]*)\];/.exec(fleet);
check(!!cacheNames && !cacheNames[1].includes('"dist"') && !cacheNames[1].includes('".cache"'),
  "staging names stay OUT of BUILD_CACHE_DIR_NAMES — the page-open sweep keeps its narrower, faster contract");

// --------------------------------------------------------------- scheduling
const spawn = bodyOf(fleet, "pub(crate) fn spawn_global_disk_janitor(");
check(spawn.includes("loop {") && spawn.includes("JANITOR_INTERVAL_SECS"),
  "the janitor is PERIODIC — a long-lived session is swept without restarting the app");
check(spawn.includes("janitor_sweep_all()") && spawn.includes("crate::sandbox::auto_housekeep()"),
  "each pass sweeps both the host fleet worktrees and the WSL sandbox");
check(spawn.includes("catch_unwind"),
  "a panic in one pass cannot kill the janitor for the rest of the session");
check(/^\s*fleet::spawn_global_disk_janitor\(\);/m.test(lib),
  "the janitor is actually spawned at app startup — an unspawned (or commented-out) janitor cleans nothing");

// -------------------------------------------- the WSL build-workspace prune
const prune = /const PRUNE_BUILD_WORKSPACE_SCRIPT: &str = r#"([\s\S]*?)"#;/.exec(sandbox);
check(!!prune, "the linux-build workspace prune script exists");
check(prune[1].includes('"$HOME/owllm-build"') && !/find "\$HOME"\s/.test(prune[1]),
  "the prune is rooted at the app-owned ~/owllm-build only — never a user directory");
check(prune[1].includes("-name target"),
  "only cargo `target` directories are pruned — sources and toolchains stay");
check(prune[1].includes('-newermt "7 days ago"'),
  "a target with ANY file touched this week is warm and kept");
const trim = bodyOf(sandbox, "fn trim_impl(distro: Option<String>, force: bool)");
check(trim.includes("PRUNE_BUILD_WORKSPACE_SCRIPT"),
  "housekeeping actually runs the build-workspace prune, not just declares it");
check(trim.includes("fstrim -a"),
  "freed blocks are still fstrim'd so the vhdx can be compacted");
const housekeep = bodyOf(sandbox, "pub(crate) fn auto_housekeep(");
check(housekeep.includes("running_distros()"),
  "periodic housekeeping still refuses to cold-start WSL just to clean");

// ------------------------------------------------------ footprint visibility
check(sandbox.includes("pub build_bytes: u64,") &&
      /OWLLM_BUILD=\$\(du -sb "\$HOME\/owllm-build"/.test(sandbox),
  "the build workspace is measured and reported, not anonymous");
check(card.includes("buildBytes") && card.includes("Linux build workspace"),
  "the disk card shows the build workspace so growth is attributable in the app");

// ------------------------------------------------- the walker's Rust tests
for (const t of [
  "fn staging_reclaim_takes_ignored_stale_and_keeps_dist_modules(",
  "fn staging_reclaim_never_takes_unignored_paths(",
  "fn disk_producers_registry_is_well_formed(",
]) {
  check(fleet.includes(t), `cargo regression test present: ${t.replace("fn ", "").replace("(", "")}`);
}

// ------------------------------------------- the walker, EXECUTED (behaviour)
// The cargo lib-tests exist but Windows dev shells can hit
// STATUS_ENTRYPOINT_NOT_FOUND launching the Tauri lib test binary, so the gate
// compiles the SHIPPED walker source itself (sliced above) and runs it against
// a real throwaway git repo — the same pattern as the CLI-failure gate.
{
  const constLine = (name) => {
    // QUARANTINE_PREFIX lives in the dependency-free scratch module so its
    // model-run/commit filter can be compiled and executed on Windows. The
    // remaining janitor constants stay in fleet.rs.
    const m = new RegExp(`const ${name}: [^=]+= [^;]+;`).exec(`${fleet}\n${fleetScratch}`);
    check(!!m, `sliceable const ${name}`);
    return m[0];
  };
  const program = [
    `use std::path::Path;`,
    `#[allow(dead_code)]`,
    `fn git(dir: &Path, args: &[&str]) -> Result<(bool, String, String), String> {`,
    `    let out = std::process::Command::new("git").current_dir(dir).args(args).output().map_err(|e| e.to_string())?;`,
    `    Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned()))`,
    `}`,
    constLine("QUARANTINE_PREFIX"),
    constLine("BUILD_CACHE_DIR_NAMES"),
    constLine("STAGING_DIR_NAMES"),
    constLine("DIST_KEEP_CHILD"),
    bodyOf(fleet, "fn evict_cache_dir("),
    staging, // the shipped reclaim_staging, verbatim
    `fn sh(dir: &Path, args: &[&str]) { assert!(std::process::Command::new("git").current_dir(dir).args(args).status().unwrap().success(), "git {:?}", args); }`,
    `fn main() {`,
    `  let base = std::env::temp_dir().join(format!("owllm-janitor-gate-{}", std::process::id()));`,
    `  let _ = std::fs::remove_dir_all(&base);`,
    `  let repo = base.join("ignored"); std::fs::create_dir_all(&repo).unwrap();`,
    `  sh(&repo, &["init", "-q", "-b", "main"]);`,
    `  std::fs::write(repo.join(".gitignore"), ".cache/\\ndist/\\n").unwrap();`,
    `  std::fs::create_dir_all(repo.join(".cache/work")).unwrap();`,
    `  std::fs::write(repo.join(".cache/work/payload.bin"), b"x").unwrap();`,
    `  std::fs::create_dir_all(repo.join("dist/modules")).unwrap();`,
    `  std::fs::write(repo.join("dist/modules/manifest.json"), b"{}").unwrap();`,
    `  std::fs::create_dir_all(repo.join("dist/bundle")).unwrap();`,
    `  std::fs::write(repo.join("dist/OwLLM-setup.exe"), b"x").unwrap();`,
    `  assert_eq!(reclaim_staging(&repo, u64::MAX), 0, "young staging must be LIVE and kept");`,
    `  assert!(repo.join(".cache/work/payload.bin").exists());`,
    `  let removed = reclaim_staging(&repo, 0);`,
    `  assert!(removed >= 3, "stale ignored staging must go, got {removed}");`,
    `  assert!(!repo.join(".cache").exists(), ".cache reclaimed");`,
    `  assert!(!repo.join("dist/bundle").exists(), "dist child reclaimed");`,
    `  assert!(!repo.join("dist/OwLLM-setup.exe").exists(), "stale installer file reclaimed");`,
    `  assert!(repo.join("dist/modules/manifest.json").exists(), "dist/modules NEVER reclaimed");`,
    `  assert!(repo.join("dist").exists(), "dist itself NEVER removed");`,
    `  let user = base.join("unignored"); std::fs::create_dir_all(&user).unwrap();`,
    `  sh(&user, &["init", "-q", "-b", "main"]);`,
    `  std::fs::create_dir_all(user.join(".cache")).unwrap();`,
    `  std::fs::write(user.join(".cache/notes.txt"), b"mine").unwrap();`,
    `  std::fs::create_dir_all(user.join("dist/bundle")).unwrap();`,
    `  assert_eq!(reclaim_staging(&user, 0), 0, "un-ignored paths are USER data and must survive");`,
    `  assert!(user.join(".cache/notes.txt").exists());`,
    `  let _ = std::fs::remove_dir_all(&base);`,
    `  println!("RUST_JANITOR_CHECKS_OK");`,
    `}`,
  ].join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-janitorgate-"));
  const src = path.join(dir, "janitorcheck.rs");
  const exe = path.join(dir, process.platform === "win32" ? "janitorcheck.exe" : "janitorcheck");
  try {
    fs.writeFileSync(src, program, "utf8");
    execFileSync("rustc", ["--edition", "2021", "-A", "warnings", "-o", exe, src], { stdio: "pipe" });
    const out = execFileSync(exe, { encoding: "utf8" });
    check(out.includes("RUST_JANITOR_CHECKS_OK"),
      "the SHIPPED staging walker, executed on a real repo: takes stale ignored staging, keeps dist/modules and user data");
  } catch (e) {
    const detail = String(e?.stderr ?? e?.message ?? e).split("\n").slice(0, 12).join("\n");
    check(false, `the shipped staging walker failed its behavioural check:\n${detail}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

console.log(`\nall checks passed (${passed})`);
