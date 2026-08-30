// Focused verification for the device-name derivation (2026-08-08).
//
// THE BUG: every Linux and macOS install showed up in Remote Devices under the
// identical name "This OwLLM PC", so a fleet of distinct machines was
// indistinguishable. Four separate sites derived the machine name from
// `COMPUTERNAME` (Windows-only) or `HOSTNAME` (a *shell* variable that a
// GUI-launched app never inherits), so on every non-Windows install both were
// absent and each site fell through to its hardcoded constant.
//
// Measured before the fix, on this user's registry: all 4 Windows records
// carried real hostnames; all 9 Linux records and the Mac read "This OwLLM PC".
// Confirmed by running BOTH derivations on real Linux and real macOS with the
// env vars stripped — old → "This OwLLM PC", new → the real hostname.
//
// Source-level structural assertions across the Rust backend (no runtime).
// Lives in pages/agentic/ so the smoke matrix auto-discovers it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// CRLF-robust read: Windows core.autocrlf checks LF-committed files out as CRLF,
// so a needle containing \n would false-fail on a CRLF working tree.
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
const failures = [];
// Report EVERY failure rather than throwing on the first — one run should show
// the whole picture, which is what makes the discrimination test meaningful.
function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`✓ ${message}`);
  } else {
    failures.push(message);
    console.log(`✗ ${message}`);
  }
}

const T = "../../../../src-tauri/src"; // ui/src/pages/agentic → owllm-desktop
const SRC = path.resolve(HERE, T);
const hardware = read(`${T}/hardware.rs`);
const identity = read(`${T}/remote_devices/identity.rs`);
const executor = read(`${T}/remote_devices/executor.rs`);
const vault = read(`${T}/vault.rs`);
const projects = read(`${T}/projects.rs`);

// ── 1. One shared derivation, and it asks the OS ──────────────────────────
check(
  /pub fn machine_name\(\) -> Option<String>/.test(hardware),
  "hardware: exposes a shared machine_name() -> Option<String> (None = names nothing, caller keeps its own fallback)",
);
check(
  /sysinfo::System::host_name\(\)/.test(hardware),
  "hardware: machine_name() asks the OS via sysinfo::System::host_name() — works on Linux/macOS where the env vars do not",
);
// Order matters: the OS must be consulted BEFORE the env vars, or a stale
// inherited HOSTNAME would still win.
const fnBody = hardware.slice(
  hardware.indexOf("pub fn machine_name()"),
  hardware.indexOf("pub fn selected_gpu_uuids"),
);
check(
  fnBody.indexOf("sysinfo::System::host_name()") <
    fnBody.indexOf('std::env::var("COMPUTERNAME")'),
  "hardware: the OS lookup is tried BEFORE the env-var fallbacks",
);
check(
  /trim_end_matches\("\.local"\)/.test(fnBody) && /trim_end_matches\("\.lan"\)/.test(fnBody),
  'hardware: strips a trailing ".local"/".lan" (macOS reports e.g. "Sos-MacBook-Air.local")',
);
check(
  /eq_ignore_ascii_case\("localhost"\)/.test(fnBody) && /name\.is_empty\(\)/.test(fnBody),
  "hardware: an empty name or a bare 'localhost' yields None rather than a useless device name",
);
check(
  !/hostname|scutil|uname/.test(fnBody.replace(/\/\/.*/g, "")),
  "hardware: no subprocess spawned to read the hostname (sysinfo is already a dependency)",
);

// ── 2. Every caller delegates — nothing re-derives it ─────────────────────
for (const [label, src] of [
  ["remote_devices/identity.rs", identity],
  ["remote_devices/executor.rs", executor],
  ["vault.rs", vault],
  ["projects.rs", projects],
]) {
  check(
    src.includes("crate::hardware::machine_name()"),
    `${label}: delegates to the shared crate::hardware::machine_name()`,
  );
}
// Each caller keeps its own fallback wording — the shared helper must not have
// flattened four distinct user-visible strings into one.
check(identity.includes('"This OwLLM PC"'), "identity: keeps its own 'This OwLLM PC' fallback wording");
check(vault.includes('"this-pc"'), "vault: keeps its own 'this-pc' fallback wording");
check(executor.includes('"unknown"'), "executor: keeps its own 'unknown' fallback wording");
check(projects.includes('"This PC"'), "projects: keeps its own 'This PC' fallback wording");

// ── 3. Tree-wide: the broken derivation cannot come back ──────────────────
// Scans EVERY .rs file rather than a hand-listed set, so a site written next
// year is covered too, and names the offending file.
function rsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...rsFiles(p));
    else if (e.name.endsWith(".rs")) out.push(p);
  }
  return out;
}
const offenders = [];
for (const file of rsFiles(SRC)) {
  const rel = path.relative(SRC, file).replace(/\\/g, "/");
  if (rel === "hardware.rs") continue; // the one legitimate home for the fallback
  const body = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  // Strip comments so prose explaining the old bug doesn't trip the scan.
  const code = body.replace(/\/\/.*$/gm, "");
  if (/std::env::var\("(COMPUTERNAME|HOSTNAME)"\)/.test(code)) offenders.push(rel);
}
check(
  offenders.length === 0,
  `no file outside hardware.rs derives the machine name from COMPUTERNAME/HOSTNAME env vars${
    offenders.length ? ` — found in: ${offenders.join(", ")}` : ""
  }`,
);

// ── 4. Existing installs are healed, user renames are not clobbered ───────
check(
  /const LEGACY_PLACEHOLDER_NAME: &str = "This OwLLM PC";/.test(identity),
  "identity: the legacy placeholder is a named const, so the fallback and the heal cannot drift apart",
);
check(
  /if ident\.name == LEGACY_PLACEHOLDER_NAME/.test(identity),
  "identity: load_or_create heals an identity stamped with the placeholder (the name is persisted at first-create, so new installs alone would never fix an existing fleet)",
);
check(
  /if ident\.name == LEGACY_PLACEHOLDER_NAME[\s\S]{0,240}?write_identity\(&ident\)/.test(identity),
  "identity: the healed name is persisted, not just returned for this session",
);
// The heal must be an EXACT match: a name the user typed themselves (e.g.
// "Thor") must survive untouched.
check(
  !/starts_with\(LEGACY_PLACEHOLDER_NAME\)|contains\(LEGACY_PLACEHOLDER_NAME\)/.test(identity),
  "identity: the heal matches the placeholder EXACTLY (never prefix/substring), so a user-chosen device name is never rewritten",
);
check(
  /if let Some\(real\) = crate::hardware::machine_name\(\)/.test(identity),
  "identity: the heal only fires when the OS actually supplies a name (otherwise the placeholder stands)",
);

if (failures.length) {
  console.log(`\nFAIL device name: ${failures.length} check(s) failed, ${passed} passed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OK device name: ${passed}/${passed} checks passed`);
