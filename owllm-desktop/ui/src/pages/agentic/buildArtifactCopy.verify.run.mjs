// Regression gate: build-release.bat must NOT announce a build it failed to
// install. A running OwLLM holds "OwLLM Desktop.exe" open, so the final copy
// fails with "being used by another process" -- that used to be swallowed
// (`>nul`, errorlevel ignored) and the script still printed
// "Run now: <path>". A freshly compiled build therefore reported success while
// the exe on disk stayed the PREVIOUS one, and got launched and tested as if it
// were new. (Observed twice on 2026-08-14: build-hub-20260814b.log ends with
// that copy error and the run-now exe kept the 13:47 build.)
//
// This harness EXECUTES the shipped copy block through cmd.exe against a target
// that cannot be overwritten, rather than reading the source text.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/buildArtifactCopy.verify.run.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const BAT = path.join(APP, "build-release.bat");

if (process.platform !== "win32") {
  console.log("SKIP buildArtifactCopy: cmd.exe only (the Windows bundle step).");
  process.exit(0);
}

let failures = 0;
const check = (label, cond) => {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failures += 1; }
};

const src = fs.readFileSync(BAT, "utf8");

// Slice the REAL artifact-install block: from the first copy of the built exe
// through the summary that announces where to run it. Anchors are asserted so a
// rename can't silently reduce this gate to testing an empty string.
const START = 'copy /Y "%RELEASE%\\owllm-desktop.exe" "%cd%\\OwLLM Desktop.exe"';
const END = "echo   Dist setup:";
const a = src.indexOf(START);
const b = src.indexOf(END, a);
check("the artifact-install block is still locatable in build-release.bat", a >= 0 && b > a);
if (a < 0 || b <= a) {
  console.error("\nAnchors moved — update this gate to match build-release.bat.");
  process.exit(1);
}
const block = src.slice(a, src.indexOf("\n", b) + 1);
check("the sliced block really is the install step, not the whole file",
  block.includes("Run now:") && !block.includes("npm run tauri"));

/// Run the block in a throwaway tree. `lockTarget` makes the run-now exe
/// impossible to overwrite (read-only), which is the same errorlevel the
/// sharing violation raises.
function runBlock({ lockTarget }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bac-verify-"));
  const release = path.join(tmp, "target", "x86_64-pc-windows-gnu", "release");
  fs.mkdirSync(path.join(release, "bundle", "nsis"), { recursive: true });
  fs.writeFileSync(path.join(release, "owllm-desktop.exe"), "FRESH BUILD");
  const runNow = path.join(tmp, "OwLLM Desktop.exe");
  fs.writeFileSync(runNow, "STALE BUILD");
  if (lockTarget) fs.chmodSync(runNow, 0o444);

  // %RELEASE% / %DIST% are set by build-release.bat immediately above the
  // sliced block; reproduce exactly those two assignments.
  const harness = path.join(tmp, "install.bat");
  fs.writeFileSync(harness, [
    "@echo off",
    "cd /d %~dp0",
    'set "RELEASE=%cd%\\target\\x86_64-pc-windows-gnu\\release"',
    'set "DIST=%cd%\\dist"',
    'if not exist "%DIST%" mkdir "%DIST%"',
    block,
    "exit /b 0",
    "",
  ].join("\r\n"));

  const r = spawnSync("cmd.exe", ["/c", harness], { encoding: "utf8", timeout: 60_000 });
  const installed = fs.existsSync(runNow) ? fs.readFileSync(runNow, "utf8") : "(missing)";
  // Drop the read-only bit so the temp tree can be removed.
  try { fs.chmodSync(runNow, 0o666); } catch { /* already writable */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, installed };
}

console.log("case 1: the copy succeeds — the block installs and announces it");
{
  const r = runBlock({ lockTarget: false });
  check("exits 0", r.status === 0);
  check("the fresh exe replaced the stale one", r.installed === "FRESH BUILD");
  check("it tells the user where to run it", r.out.includes("Run now:"));
}

console.log("case 2: the target cannot be replaced — the block must FAIL LOUDLY");
{
  const r = runBlock({ lockTarget: true });
  check("exits NON-zero instead of reporting success", r.status !== 0);
  check("it does NOT announce a run-now path for a stale exe", !r.out.includes("Run now:"));
  check("the failure is explicit", /ERROR: could not replace/.test(r.out));
  check("it says the build itself succeeded", /build SUCCEEDED/i.test(r.out));
  check("it names the fresh exe so the user can still get it", r.out.includes("owllm-desktop.exe"));
  check("it says what to close", /[Cc]lose any OwLLM Desktop/.test(r.out));
  check("the stale exe was left untouched (nothing half-written)", r.installed === "STALE BUILD");
}

if (failures > 0) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nall assertions passed");
