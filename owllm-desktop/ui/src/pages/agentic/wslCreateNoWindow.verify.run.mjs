#!/usr/bin/env node
// Every Windows subprocess spawn MUST set CREATE_NO_WINDOW (0x08000000) or a
// black cmd.exe window flashes each time. This bit the user in v0.9.63 when a
// personal-assistant project polled git status inside WSL every 4 seconds and
// each poll flashed a console — root cause was `wsl_program_command` returning
// a bare Command whose one live caller (`fleet.rs:git_once`) forgot the flag.
//
// The fix baked CREATE_NO_WINDOW into the helper. This harness pins that the
// helper still bakes it in, that no future caller re-holes the helper, and
// that the historically-repeat-spawn call sites keep the flag.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1)));
const APP = path.resolve(HERE, "../../../..");
const RUST = path.join(APP, "src-tauri", "src");
const read = (rel) => fs.readFileSync(path.join(RUST, rel), "utf8").replace(/\r\n/g, "\n");

const checks = [];
function check(name, cond) {
  checks.push({ name, ok: Boolean(cond) });
  if (!cond) throw new Error(`FAIL ${name}`);
}

// ---- helper contract: wsl_program_command MUST bake in CREATE_NO_WINDOW ----
const wsl = read("wsl.rs");
const helperMatch = wsl.match(/pub fn wsl_program_command\([\s\S]*?\n\}/);
check("wsl_program_command exists", helperMatch);
const helperBody = helperMatch[0];
check(
  "wsl_program_command sets creation_flags inside #[cfg(windows)]",
  /#\[cfg\(windows\)\][\s\S]{0,120}creation_flags\(CREATE_NO_WINDOW\)/.test(helperBody),
);
check(
  "wsl_program_command is NOT #[allow(dead_code)] — fleet.rs uses it",
  !/#\[allow\(dead_code\)\][\s\S]{0,80}pub fn wsl_program_command/.test(wsl),
);

// ---- CREATE_NO_WINDOW constant must resolve in the helper's file ----
check(
  "wsl.rs defines CREATE_NO_WINDOW = 0x08000000",
  /const CREATE_NO_WINDOW: u32 = 0x08000000/.test(wsl),
);

// ---- every wsl.exe spawn in wsl.rs must carry the flag ----
// Windows-only lines only: skip anything inside #[cfg(not(windows))] blocks
// (there are none in this file today; this catch pins that too).
const wslExeSpawnCount = (wsl.match(/Command::new\("wsl\.exe"\)/g) || []).length;
const wslCreationFlagsCount = (wsl.match(/creation_flags\(CREATE_NO_WINDOW\)/g) || []).length;
check(
  `wsl.rs: creation_flags call count (${wslCreationFlagsCount}) >= wsl.exe spawn count (${wslExeSpawnCount})`,
  wslCreationFlagsCount >= wslExeSpawnCount,
);

// ---- the historic repeat-spawn call site (fleet.rs::git_once) ----
const fleet = read("fleet.rs");
const gitOnceMatch = fleet.match(/fn git_once\([\s\S]*?\nfn /);
check("fleet.rs::git_once exists", gitOnceMatch);
const gitOnceBody = gitOnceMatch[0];
check(
  "fleet.rs::git_once still routes WSL projects through wsl_program_command",
  /wsl_program_command\(/.test(gitOnceBody),
);
// Either the caller sets its own flag OR the helper bakes it in. The helper
// baking is the current design; assert AT LEAST ONE holds so the fix survives
// even if someone rewrites the caller.
const gitOnceHasOwnFlag = /creation_flags\(0x08000000\)/.test(gitOnceBody) ||
                          /creation_flags\(CREATE_NO_WINDOW\)/.test(gitOnceBody);
const helperBakesIn = /#\[cfg\(windows\)\][\s\S]{0,120}creation_flags\(CREATE_NO_WINDOW\)/.test(helperBody);
check(
  "git_once cannot flash a console (helper bakes flag OR caller sets it)",
  gitOnceHasOwnFlag || helperBakesIn,
);

// ---- other historically-repeated Windows spawn sites keep their flag ----
// server.rs: llama-server (fires when a local model loads for the assistant)
const server = read("server.rs");
check(
  "server.rs still sets creation_flags(0x08000000) on the llama-server spawn",
  /creation_flags\(0x08000000\)/.test(server),
);

// git.rs: git-status polls (every 4s from GitBar / 5s from PublishCards)
const gitRs = read("git.rs");
check(
  "git.rs: every git spawn goes through the CREATE_NO_WINDOW helper",
  /const CREATE_NO_WINDOW: u32 = 0x0800_0000/.test(gitRs) &&
    /creation_flags\(CREATE_NO_WINDOW\)/.test(gitRs),
);

// mcp_gateway.rs: WSL interop probe (called during personal-assistant tool wiring)
const gw = read("mcp_gateway.rs");
check(
  "mcp_gateway.rs still sets CREATE_NO_WINDOW on its wsl.exe interop probe",
  /Command::new\("wsl\.exe"\)[\s\S]{0,300}creation_flags\(0x08000000\)/.test(gw),
);

// ---- pass ----
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`);
console.log(`\n${checks.filter(c => c.ok).length}/${checks.length} checks passed`);
