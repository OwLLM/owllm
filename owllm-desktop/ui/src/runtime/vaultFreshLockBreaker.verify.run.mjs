// A live Git writer's fresh lock is contention, not repository corruption.
//
// The vault has several periodic channels. Before this regression guard, three
// channels colliding with one legitimate fresh `.lock` incremented the
// corruption counter three times and opened the exponential circuit breaker.
// Remote Devices then showed "local clone needs attention" even though `git
// fsck` was clean and the writer merely needed to finish.
//
// Dependency-free source gate: smoke-matrix runs it even on a release host
// without UI node_modules. The Rust unit test holds the executable regression;
// this gate ensures both that test and its production branch remain present.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../../..");
const vault = fs.readFileSync(path.join(DESKTOP, "src-tauri", "src", "vault.rs"), "utf8")
  .replace(/\r\n/g, "\n");

let passed = 0;
const check = (ok, message) => {
  if (!ok) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
};

const runGit = vault.split("fn run_git(args:")[1]?.split("\n}\n\n/// Clone the vault")[0] ?? "";
const lockArm = runGit.split("Err(e) if is_lock_contention(&e) => {")[1]?.split("\n        other =>")[0] ?? "";

check(lockArm.length > 0,
  "run_git handles every lock-contention error in an explicit branch");
check(!runGit.includes("is_lock_contention(&e) && repair_stale_lock(&e)"),
  "a fresh lock cannot fall through into the corruption counter");
const freshElse = lockArm.indexOf("} else {");
check(lockArm.includes("if repair_stale_lock(&e)")
  && freshElse > lockArm.indexOf("note_repo_health(&retried)")
  && lockArm.indexOf("Err(e)", freshElse) > freshElse,
  "only a stale lock is repaired/retried; a fresh lock surfaces without poisoning health");

const test = vault.split("fn a_lock_young_enough_to_be_live_is_never_stolen()")[1]
  ?.split("\n    #[test]")[0] ?? "";
check(test.includes("for _ in 0..3") && test.includes("sync_cooldown_remaining().is_none()"),
  "the Rust regression drives three fresh-lock collisions and proves the breaker stays closed");

console.log(`\nvaultFreshLockBreaker: ${passed} checks passed`);
