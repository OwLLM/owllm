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
const updatePrompt = uiFile("UpdatePrompt.tsx");
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

// --- the update path ends the process OUTSIDE the exit path ---------------
// `install()` does not return on Windows: tauri-plugin-updater hands the NSIS
// installer to the shell and leaves through `std::process::exit(0)`, so
// RunEvent::Exit never fires and `end_clean()` never runs. Without an explicit
// "this death is expected" the marker survives, and every auto-update makes the
// newly installed build open by accusing the previous one of crashing — which
// is exactly what 1.0.16→1.0.17→1.0.18 did on the reference machine.
check(
  /pub fn expect_replacement\(/.test(health) && /pub fn rearm\(/.test(health),
  "an installer-driven death can be declared expected, and undeclared if it doesn't happen",
);
check(
  /session_health_expect_replacement/.test(lib) && /session_health_rearm/.test(lib),
  "both commands are registered, or the frontend call is a no-op error",
);
check(
  /session_health_expect_replacement[\s\S]*?update\.install\(\)/.test(updatePrompt),
  "the marker is dropped BEFORE install(), which never returns on Windows",
);
check(
  /session_health_expect_replacement[\s\S]*?linux_appimage_update_install/.test(updatePrompt),
  "the marker is dropped BEFORE the AppImage helper, whose exit path is also outside RunEvent::Exit",
);
check(
  !/downloadAndInstall/.test(updatePrompt) && /update\.download\(/.test(updatePrompt),
  "download and install stay separate, so a crash mid-download is still reported",
);
check(
  /catch[\s\S]{0,200}session_health_rearm/.test(updatePrompt),
  "a failed install re-arms the marker instead of leaving the session unwatched",
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
// A reboot explains the process ending on its own. Counting it as a crash made
// every restart of the machine greet the user with "OwLLM closed unexpectedly"
// — the single most common false alarm this feature produced.
check(
  /alarming/.test(health) && /filter\(\|r\| r\.alarming\)/.test(health),
  "an ordinary reboot is recorded but never raises the notice",
);
check(
  /restarted[\s\S]{0,120}false,/.test(health),
  "the reboot branch is explicitly classified as not-alarming",
);
check(
  !/session_health_dismiss/.test(shell),
  "showing the notice never deletes the evidence the support report needs",
);

// --- Tauri lifecycle events are not reliable enough to be the only cleanup ----
// On Windows a normal X-close has been observed to skip RunEvent::Exit, so the
// marker survives and the next launch reports a crash that was a clean quit.
// Clean it redundantly on the user action (CloseRequested) and on the event
// loop's exit decision (ExitRequested), as well as the final Exit.
check(
  /WindowEvent::CloseRequested[\s\S]*?session_health::end_clean\(\)/.test(lib),
  "CloseRequested drops the marker so a normal X-close does not look like a crash",
);
check(
  /ExitRequested\s*\{[\s\S]*?session_health::end_clean\(\)/.test(lib),
  "ExitRequested also drops the marker as a fallback",
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
