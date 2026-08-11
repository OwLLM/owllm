// Gate for "why did OwLLM close?" — the crash/unclean-shutdown reporting path.
//
// Rust unit tests already cover the decision logic (session_health.rs). What
// they cannot see is the wiring, and every one of these wires fails SILENTLY
// and in the most misleading direction available:
//
//   * Lose the `end_clean()` call on RunEvent::Exit and every NORMAL quit is
//     reported to the user as a crash. The feature becomes a liar, and the
//     reports you receive become noise.
//   * Lose the `begin()` call and nothing is ever detected — the failure is
//     invisible, because "no crashes reported" looks exactly like "no crashes".
//   * Let the notice clear the stored records and the support report arrives
//     empty, which is worse than no report: it looks like evidence of health.
//
// Run: node ui/src/sessionHealth.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const readLF = (p) => {
  try {
    return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
};
const rustFile = (name) => readLF(path.join(DESKTOP, "src-tauri/src", name));
const uiFile = (name) => readLF(path.join(HERE, name));

let passed = 0;
let failed = 0;
const check = (ok, label) => {
  if (ok) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
};

const lib = rustFile("lib.rs");
const health = rustFile("session_health.rs");
const support = rustFile("support.rs");
const shell = uiFile("AppShell.tsx");
const toast = uiFile("components/Toast.tsx");

check(health.length > 0, "session_health.rs exists");

// --- the two halves of the marker contract -------------------------------
check(
  /session_health::begin\(/.test(lib),
  "startup claims a session marker (begin)",
);
check(
  /RunEvent::Exit\s*=>\s*\{[\s\S]*?session_health::end_clean\(\)/.test(lib),
  "a clean exit clears its marker, so normal quits are NOT reported as crashes",
);
// The marker must be claimed before anything that can fail or block, or a crash
// during startup would go unrecorded — precisely the crash worth recording.
check(
  lib.indexOf("session_health::begin(") < lib.indexOf("bootstrap::migrate_user_state_if_needed"),
  "the marker is claimed before the heavy startup work that might itself crash",
);

// --- identity: pid alone is not enough -----------------------------------
check(
  /process_started/.test(health) && /start_time\(\)/.test(health),
  "sessions are identified by process start time as well as pid (pid reuse)",
);
check(
  /boot_time/.test(health),
  "boot time is recorded, so a power cut is distinguishable from a kill",
);

// --- the records must outlive the notice ---------------------------------
check(
  /new_this_launch/.test(health),
  "the notice is driven by a per-launch counter, not by the stored records",
);
check(
  !/session_health_dismiss/.test(shell),
  "showing the notice never deletes the evidence the support report needs",
);

// --- the data has to reach the developer ---------------------------------
check(
  /unclean_shutdowns/.test(support) && /crash_log_tail/.test(support),
  "support reports carry the crash history and the log tail",
);

// --- exit-path breadcrumbs ------------------------------------------------
check(
  /fn log_exit_path/.test(lib),
  "exit-path breadcrumbs exist",
);
check(
  /ExitRequested\s*\{\s*code[\s\S]*?Backtrace::force_capture\(\)/.test(lib),
  "an in-process exit request records a backtrace naming whoever asked for it",
);

// --- the notice must survive long enough to be acted on -------------------
check(
  /sticky/.test(toast) && /t\.sticky \|\| timers\.current\.has/.test(toast),
  "a sticky toast is never armed with an expiry timer",
);
check(
  /\{ sticky: true \}/.test(shell),
  "the crash notice is sticky — it asks the user to do something",
);

if (failed > 0) {
  console.error(`\nsessionHealth.verify: FAILED (${failed} of ${passed + failed})`);
  process.exit(1);
}
console.log(`\nsessionHealth.verify: OK (${passed}/${passed})`);
