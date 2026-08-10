// A CLI that DIES must say why, and Stop must kill only its own run.
//
// Observed: "(error: claude CLI exited 143 — no stdout or stderr)" and
// "exited 1 — no stdout or stderr" in the agentic page, while the same account
// worked perfectly in chat. Two distinct causes, neither visible from the exit
// code, both of which produce that identical useless string:
//
//   * LINUX killed it. A WSL-isolated project runs the agent CLI INSIDE the
//     distro, whose default memory cap is 50% of host RAM. The kernel SIGKILLs
//     the biggest process; it flushes nothing; the verdict sits unread in
//     /var/log/kern.log. (Host runs page to disk instead and never hit this,
//     which is exactly why chat looked fine.)
//   * WE killed it. The per-run Cancel called `cli_cancel_all`, so stopping one
//     run tree-killed every OTHER live run's CLI too, and each survivor
//     reported a bare non-zero exit.
//
// Every invariant here regresses SILENTLY: the app builds, the run still ends,
// and the user still sees a plausible-looking error. So this gate checks the
// behaviour by RUNNING it — the Rust parser is compiled and executed, and the
// TS detector is bundled and called — not merely grepped for.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "../../..");            // owllm-desktop/ui
const TAURI_SRC = path.resolve(UI, "../src-tauri/src");

let passed = 0;
let failed = 0;
// Report EVERY failure. A gate that throws on the first hides how much of the
// invariant is broken — which is the whole point when re-checking old code.
function check(condition, message) {
  if (condition) { passed += 1; console.log(`OK ${message}`); }
  else { failed += 1; console.log(`FAIL ${message}`); }
}

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
/// Invariants below are about CODE. Strip comments first, or a comment that
/// merely EXPLAINS a rule satisfies the scan looking for it.
const stripRustComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/^[ \t]*\/\/\/.*$/gm, "");
const stripTsComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const accountsRaw = read(path.join(TAURI_SRC, "accounts.rs"));
const sandboxRaw = read(path.join(TAURI_SRC, "sandbox.rs"));
const gatewayRaw = read(path.join(TAURI_SRC, "mcp_gateway.rs"));
const libRaw = read(path.join(TAURI_SRC, "lib.rs"));
const accounts = stripRustComments(accountsRaw);
const sandbox = stripRustComments(sandboxRaw);
const gateway = stripRustComments(gatewayRaw);
const agentsPage = stripTsComments(read(path.join(HERE, "AgentsPage.tsx")));
const dispatch = stripTsComments(read(path.join(HERE, "dispatch.ts")));

check(accounts.length > 0, "accounts.rs is readable");
check(sandbox.length > 0, "sandbox.rs is readable");
check(gateway.length > 0, "mcp_gateway.rs is readable");
check(agentsPage.length > 0, "AgentsPage.tsx is readable");
check(dispatch.length > 0, "dispatch.ts is readable");

// ---------------------------------------------------------------------------
// 1. Stop is SCOPED — cancelling one run must not kill the others
// ---------------------------------------------------------------------------
check(
  /pub fn cli_cancel_scope\(\s*scope: String\s*\)/.test(accounts),
  "accounts.rs exposes cli_cancel_scope",
);
check(
  /accounts::cli_cancel_scope/.test(libRaw),
  "cli_cancel_scope is registered as a Tauri command (an unregistered command is invisible)",
);
check(
  /accounts::cli_cancel_all/.test(libRaw),
  "the global cli_cancel_all is still registered (the dock's Stop still means everything)",
);
check(
  /fn kill_cli_children\(\s*scope: Option<&str>\s*\)/.test(accounts),
  "one shared kill loop takes the scope, so global and scoped cannot drift apart",
);
check(
  /fn cli_child_in_scope\(/.test(accounts),
  "the scope-matching RULE is a named pure function, not inline in the kill loop",
);
check(
  /\.filter\(\|\(_, owner\)\| cli_child_in_scope\(owner\.as_deref\(\), scope\)\)/.test(accounts),
  "the kill loop uses that rule (so the tested rule is the shipped one)",
);
check(
  /if scope\.is_empty\(\)\s*\{[\s\S]{0,160}?return Err/.test(accounts),
  "an EMPTY scope is rejected — it must never silently degrade into kill-everything",
);
check(
  /HashMap<u32, Option<String>>/.test(accounts),
  "the child registry records an owner per pid, not just a bare pid set",
);
check(
  !/HashSet<u32>>\s*\{[\s\S]{0,200}?cli_children/.test(accounts),
  "the old unscoped HashSet child registry is gone",
);
// Every spawn must register WITH a scope, or that child is unreachable by a
// per-run Cancel and only the global Stop can ever reach it.
const scopedRegistrations = (accounts.match(/register_cli_child_scoped\(&child,/g) ?? []).length;
const unscopedRegistrations = (accounts.match(/register_cli_child\(&child\)/g) ?? []).length;
check(scopedRegistrations >= 8, `every CLI spawn registers a scope (found ${scopedRegistrations}, want >= 8)`);
check(unscopedRegistrations === 0, "no spawn site still registers unscoped");
check(
  /cancel_scope\.as_deref\(\)\.or\(cwd\.as_deref\(\)\)/.test(accounts),
  "the scope DEFAULTS to cwd, so scoping works without every caller remembering to pass one",
);
check(
  (accounts.match(/cancel_scope: Option<String>/g) ?? []).length >= 8,
  "every CLI command accepts an explicit cancel_scope override",
);
check(
  /invoke\(cancelScope \? "cli_cancel_scope" : "cli_cancel_all"/.test(agentsPage),
  "AgentsPage's per-run Cancel is scoped, falling back to global only when there IS no scope",
);
check(
  !/void invoke\("cli_cancel_all"\)[\s\S]{0,40}\n\s*\/\/ Kill any in-flight TTS/.test(agentsPage),
  "the per-run Cancel no longer unconditionally calls cli_cancel_all",
);

// ---------------------------------------------------------------------------
// 2. A killed child is REPORTED as killed, not as a mystery exit
// ---------------------------------------------------------------------------
check(
  /fn mark_cli_child_cancelled\(/.test(accounts) && /fn take_cli_child_cancelled\(/.test(accounts),
  "kills we perform are recorded so the error path can name them",
);
check(
  /mark_cli_child_cancelled\(pid\);[\s\S]{0,200}?terminate_cli_child\(pid\)/.test(accounts),
  "the pid is marked BEFORE the kill — the child's wait can return on another thread instantly",
);
check(
  /while q\.len\(\) > CANCELLED_PID_MEMORY/.test(accounts),
  "the cancelled-pid memory is bounded (it must not grow for the life of the app)",
);
check(
  /fn cli_exit_err_ctx\(/.test(accounts),
  "there is a context-aware exit-error builder",
);
check(
  /if !generic\.ends_with\("no stdout or stderr"\)\s*\{\s*return generic;/.test(accounts),
  "a REAL diagnostic still wins — the auth envelope must keep reaching withCliAuthRetry",
);
check(
  /pid\.is_some_and\(take_cli_child_cancelled\)/.test(accounts),
  "a cancelled pid is reported as cancelled",
);
check(
  /crate::sandbox::wsl_oom_report\(cli, cwd\)/.test(accounts),
  "an otherwise-silent death consults the kernel log",
);
// The funnel is only a funnel if the call sites actually use it.
const ctxCalls = (accounts.match(/cli_exit_err_ctx\(/g) ?? []).length;
check(ctxCalls >= 9, `every CLI failure path goes through cli_exit_err_ctx (found ${ctxCalls})`);
const plainCalls = (accounts.match(/[^_]cli_exit_err\(/g) ?? []).length;
// Remaining plain uses: the definition, the delegation inside _ctx, and unit tests.
check(plainCalls <= 4, `no production path still returns the bare cli_exit_err (found ${plainCalls})`);

// ---------------------------------------------------------------------------
// 3. The OOM forensics actually parse a REAL kernel verdict
//    Compiled and EXECUTED — the crate's own `cargo test --lib` cannot launch
//    in this environment (STATUS_ENTRYPOINT_NOT_FOUND), so a gate that merely
//    asserted those #[test]s exist would be protecting nothing.
// ---------------------------------------------------------------------------
check(
  /pub\(crate\) fn parse_oom_report\(/.test(sandbox),
  "sandbox.rs exposes a pure, testable OOM parser",
);
check(
  /pub\(crate\) fn wsl_oom_report\(/.test(sandbox),
  "sandbox.rs exposes the probe that reads the distro's kernel log",
);
check(
  /if !is_isolated\(cwd\)\s*\{\s*return None;/.test(sandbox),
  "the probe only runs for WSL-isolated projects — a host run cannot hit this failure",
);
check(
  /Out of memory: Killed process/.test(sandbox),
  "the parser keys off the kernel's own verdict line",
);
check(
  /pub async fn sandbox_raise_memory\(/.test(sandbox) && /sandbox::sandbox_raise_memory/.test(libRaw),
  "the one-click fix exists AND is registered as a command",
);
check(
  !/wsl\.exe[\s\S]{0,80}--shutdown/.test(sandbox.slice(sandbox.indexOf("fn ensure_memory_config"), sandbox.indexOf("fn ensure_memory_config") + 2000)),
  "raising the limit does NOT restart WSL (that would kill every running agent)",
);

/// Slice a top-level Rust item out of a source file by brace matching, so the
/// gate compiles the SHIPPED text rather than a copy that can drift.
function sliceItem(src, header) {
  const at = src.indexOf(header);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

const scopeRule = sliceItem(accountsRaw, "pub(crate) fn cli_child_in_scope(");
check(!!scopeRule, "the scope rule could be sliced out of accounts.rs");

const wanted = [
  "fn recommended_wsl_memory_gb(",
  "fn merge_memory_into_wslconfig(",
  "fn wslconfig_key_gb(",
  "pub struct OomHit {",
  "pub(crate) fn parse_oom_report(",
  "pub(crate) fn oom_message(",
];
const slices = wanted.map((h) => sliceItem(sandboxRaw, h));
check(slices.every(Boolean), "every pure helper could be sliced out of sandbox.rs");

if (slices.every(Boolean) && scopeRule) {
  slices.push(scopeRule);
  // The captured kernel verdict from the run that started all this. Verbatim.
  const REAL_LOG = [
    "MemTotal:       16330460 kB",
    "2026-08-10T11:54:37.473523+09:00 DESKTOP-FKSSKS3 kernel: Out of memory: Killed process 26855 (claude.exe) total-vm:17026816kB, anon-rss:12863744kB, file-rss:3708kB, shmem-rss:0kB, UID:1000 pgtables:32864kB oom_score_adj:0",
  ].join("\n");
  const program = [
    "#![allow(dead_code)]",
    slices
      .join("\n\n")
      .replace(/^pub\(crate\) fn /gm, "fn ")
      .replace(/, serde::Serialize\)\]/g, ")]")
      .replace(/^pub struct OomHit/m, "struct OomHit")
      .replace(/^    pub /gm, "    "),
    `const REAL_LOG: &str = ${JSON.stringify(REAL_LOG)};`,
    `fn main() {`,
    // Recent kill → reported, with the kernel's own numbers.
    `  let hit = parse_oom_report(REAL_LOG, "2026-08-10T11:44:37").expect("recent OOM reported");`,
    `  assert_eq!(hit.task, "claude.exe");`,
    `  assert!((hit.used_gb - 12.27).abs() < 0.1, "used_gb {}", hit.used_gb);`,
    `  assert!(hit.limit_gb.is_some_and(|g| (g - 15.57).abs() < 0.2), "limit {:?}", hit.limit_gb);`,
    `  let msg = oom_message("claude", &hit);`,
    `  assert!(msg.contains("out-of-memory") && msg.contains("claude.exe"), "{msg}");`,
    `  assert!(msg.contains("Raise the WSL memory limit"), "{msg}");`,
    // Stale kill → NEVER blamed for a later failure.
    `  assert!(parse_oom_report(REAL_LOG, "2026-08-14T00:00:00").is_none(), "stale OOM must not be blamed");`,
    // Undated line → untrustworthy, so ignored.
    `  assert!(parse_oom_report("kernel: Out of memory: Killed process 1 (claude.exe) anon-rss:100kB", "2026-08-10T11:44:37").is_none());`,
    // No OOM at all → nothing to report.
    `  assert!(parse_oom_report("MemTotal: 16330460 kB", "2026-01-01T00:00:00").is_none());`,
    // The memory recommendation must BEAT WSL's 50% default, which is what got killed.
    `  assert_eq!(recommended_wsl_memory_gb(32), (24, 12));`,
    `  assert_eq!(recommended_wsl_memory_gb(4), (4, 2));`,
    `  assert_eq!(recommended_wsl_memory_gb(256), (64, 16));`,
    // Merge: adds, is idempotent, and NEVER lowers a user's own higher limit.
    `  let out = merge_memory_into_wslconfig("", 24, 12).expect("writes when absent");`,
    `  assert!(out.contains("[wsl2]") && out.contains("memory=24GB") && out.contains("swap=12GB"), "{out}");`,
    `  assert!(merge_memory_into_wslconfig(&out, 24, 12).is_none(), "idempotent");`,
    `  assert!(merge_memory_into_wslconfig("[wsl2]\\nmemory=48GB\\nswap=32GB\\n", 24, 12).is_none(), "never lowers");`,
    `  let keep = merge_memory_into_wslconfig("[wsl2]\\nmemory=8GB\\nprocessors=8\\n", 24, 12).unwrap();`,
    `  assert!(keep.contains("memory=24GB") && keep.contains("processors=8"), "{keep}");`,
    `  assert_eq!(keep.matches("[wsl2]").count(), 1, "{keep}");`,
    // The scope rule that caused the original bug: cancelling run A must not
    // reach run B, and must not reach an unscoped child either.
    `  assert!(cli_child_in_scope(Some("C:/a"), None), "global Stop reaches a scoped child");`,
    `  assert!(cli_child_in_scope(None, None), "global Stop reaches an unscoped child");`,
    `  assert!(cli_child_in_scope(Some("C:/a"), Some("C:/a")), "own run is killed");`,
    `  assert!(!cli_child_in_scope(Some("C:/b"), Some("C:/a")), "ANOTHER run is NOT killed");`,
    `  assert!(!cli_child_in_scope(None, Some("C:/a")), "an unscoped child is NOT killed by a scoped Stop");`,
    `  println!("RUST_OOM_CHECKS_OK");`,
    `}`,
  ].join("\n");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-oomgate-"));
  const src = path.join(dir, "oomcheck.rs");
  const exe = path.join(dir, process.platform === "win32" ? "oomcheck.exe" : "oomcheck");
  try {
    fs.writeFileSync(src, program, "utf8");
    execFileSync("rustc", ["--edition", "2021", "-A", "warnings", "-o", exe, src], { stdio: "pipe" });
    const out = execFileSync(exe, { encoding: "utf8" });
    check(out.includes("RUST_OOM_CHECKS_OK"), "the SHIPPED Rust OOM parser handles the real kernel log correctly");
  } catch (e) {
    const detail = String(e?.stderr ?? e?.message ?? e).split("\n").slice(0, 12).join("\n");
    check(false, `the shipped Rust OOM parser failed its behavioural check:\n${detail}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

// ---------------------------------------------------------------------------
// 4. The failure is EXPLAINED to the user (behaviour, executed)
// ---------------------------------------------------------------------------
// A missing/broken export must be REPORTED as failed checks, never crash the
// gate — a crashing verifier reads as "the suite is broken", not "the code is",
// and that is exactly the shape old code presents.
let loaded = null;
try {
  const bundled = await esbuild.build({
    entryPoints: [path.join(HERE, "runBlockers.ts")],
    bundle: true, write: false, format: "esm", platform: "neutral",
  });
  loaded = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
} catch (e) {
  console.log(`(runBlockers.ts could not be loaded: ${e?.message ?? e})`);
}
const hasDetector = typeof loaded?.detectRunFailure === "function";
check(hasDetector, "runBlockers exports detectRunFailure");
const detectRunFailure = hasDetector ? loaded.detectRunFailure : () => null;

// The exact string the Rust side now produces for an OOM kill.
const OOM_ERR =
  "claude CLI was killed by Linux out-of-memory — this project runs in WSL, and " +
  "claude.exe was using 12.3 GB of a 15.6 GB WSL limit. Nothing is wrong with your " +
  "account, the model or the task. Raise the WSL memory limit (Settings → Sandbox → " +
  "\"Raise WSL memory\"), then run it again.";
const oom = detectRunFailure(OOM_ERR);
check(oom?.code === "wsl_out_of_memory", "an OOM kill is classified as out-of-memory");
check(/12\.3 GB/.test(oom?.why ?? ""), "the measured numbers survive into the notice (not paraphrased away)");
check(/raise wsl memory/i.test(oom?.action ?? ""), "the action names the one-click fix");

const cancelled = detectRunFailure("claude CLI stopped — you cancelled this run.");
check(cancelled?.code === "run_cancelled", "a user Stop is classified as a cancel, not a failure");
check(/did not fail/i.test(cancelled?.why ?? ""), "a cancel is not reported as a fault");

// The two strings from the user's own screenshot.
for (const raw of [
  "claude CLI exited 143 — no stdout or stderr",
  "claude CLI exited 1 — no stdout or stderr",
]) {
  const hit = detectRunFailure(raw);
  check(hit?.code === "cli_died_silently", `"${raw}" is explained rather than left bare`);
  check(/killed from outside/i.test(hit?.why ?? ""), `"${raw}" says the process was killed, not that it failed`);
}

check(detectRunFailure("") === null, "empty error is not a diagnosis");
check(detectRunFailure(null) === null, "null error is not a diagnosis");
check(
  detectRunFailure("claude CLI exited 1 — error: model not found") === null,
  "a CLI that DID explain itself is left alone (no false positive)",
);
check(
  detectRunFailure("I fixed the out-of-memory handling in the parser.") === null,
  "merely discussing out-of-memory is not an OOM kill",
);

// ---------------------------------------------------------------------------
// 5. It is wired at the one place every CLI call passes, and rendered honestly
// ---------------------------------------------------------------------------
check(
  /catch \(e: any\) \{[\s\S]{0,600}?detectRunFailure\(msg\)/.test(dispatch),
  "withCliAuthRetry inspects the ERROR path too, not only successful replies",
);
check(
  /const failure = detectRunFailure\(msg\);[\s\S]{0,200}?if \(signal\.aborted\) throw e;/.test(dispatch),
  "the diagnosis is reported BEFORE the abort short-circuit, so a stopped run is still explained",
);
check(
  /import \{ detectRunBlocker, detectRunFailure/.test(dispatch),
  "dispatch imports the failure detector from the shared module (no second copy)",
);
check(
  /info\.code === "wsl_out_of_memory"/.test(agentsPage),
  "the notice branches on the cause",
);
check(
  /const isRefusal = info\.code === "cli_tool_permission"/.test(agentsPage),
  "the Auto-mode override applies ONLY to a self-refusal — a kill has nothing to do with the toggle",
);
check(
  !/stopped itself, not the task[\s\S]{0,40}\$\{info\.why\}/.test(agentsPage) ||
    /const lead =/.test(agentsPage),
  "a killed CLI is not described as having 'stopped itself'",
);
check(
  /info\.code !== "run_cancelled"\) notify\(/.test(agentsPage),
  "the user is not toasted about their own Stop",
);
check(
  /"raise-wsl-memory"/.test(agentsPage) && /RaiseWslMemoryBtn/.test(agentsPage),
  "the action is a real one-click button, not a pointer to UI that does not exist",
);
check(
  /owllm:raise-wsl-memory/.test(agentsPage) &&
    /invoke<[^>]*>\("sandbox_raise_memory"\)/.test(agentsPage),
  "the button is wired to the backend command",
);
check(
  /action\?: "wsl-restart" \| "retry-goal" \| "raise-wsl-memory"/.test(agentsPage),
  "the chat entry type admits the new action (an unmodelled action renders nothing)",
);

// ---------------------------------------------------------------------------
// 6. OwLLM's own tool results cannot be the thing that blows up the context
// ---------------------------------------------------------------------------
check(
  /const MAX_TOOL_OUTPUT_CHARS: usize/.test(gateway),
  "the MCP gateway caps how much one tool result can return",
);
check(
  /cap_tool_output\(name, &text\)/.test(gateway),
  "the cap is applied on the tools/call reply path",
);
check(
  /NOT the whole result/.test(gatewayRaw),
  "a truncated result SAYS so — a silently shortened page reads as a complete one",
);
check(
  /text\.chars\(\)\.take\(MAX_TOOL_OUTPUT_CHARS\)/.test(gateway),
  "truncation is by chars, so it can never split a UTF-8 sequence",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
