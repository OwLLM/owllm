// Background-work continuity: a turn's promise must survive the turn.
//
// A Code-page turn is a one-shot CLI process. When the agent starts a long
// background job (build, test matrix, deploy) and ends its turn, the CLI exits
// and the job keeps running with nobody left to receive the result — "I'll
// commit when the matrix finishes" silently never happened. cli_orphans.rs
// samples each CLI child's descendant tree while it lives (all OSes — on Unix
// orphans reparent to init at parent death, so a post-exit walk finds
// nothing), adopts survivors at NATURAL exit under the turn's cancel scope,
// and emits detected/finished events; the Code page then auto-resumes the
// session with a continuation turn.
//
// What must hold:
//   1. every CLI spawn is tracked, every natural exit adopts, every kill path
//      forgets (Stop must NEVER produce an automatic continuation);
//   2. the Rust→UI wire is camelCase on BOTH sides (a serde casing the UI
//      doesn't read is how the WSL host-fallback stayed dead for two releases);
//   3. the Code page subscribes both panes' scopes, dispatches the
//      continuation through the live send closures, and caps the chain;
//   4. the adoption state machine behaves: stragglers die silently inside the
//      grace, survivors announce, the last exit finishes, the ceiling stops
//      an intentional daemon from arming a continuation forever.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAURI_SRC = path.join(HERE, "..", "..", "..", "..", "src-tauri", "src");

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) { passed += 1; console.log(`OK ${message}`); }
  else { failed += 1; console.log(`FAIL ${message}`); }
}

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
// Invariants are about CODE. Strip comments first, or a comment that merely
// explains a rule satisfies the scan looking for it.
const stripRs = (s) => s.replace(/^[ \t]*\/\/.*$/gm, "").replace(/^[ \t]*\/\/[/!].*$/gm, "");
const stripTs = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/^[ \t]*\/\/\/.*$/gm, "");

const accountsRaw = read(path.join(TAURI_SRC, "accounts.rs"));
const orphansRaw = read(path.join(TAURI_SRC, "cli_orphans.rs"));
const libRaw = read(path.join(TAURI_SRC, "lib.rs"));
const modTsRaw = read(path.join(HERE, "orphanContinuation.ts"));
const codePageRaw = read(path.join(HERE, "CodePage.tsx"));
const accounts = stripRs(accountsRaw);
const orphans = stripRs(orphansRaw);
const lib = stripRs(libRaw);
const modTs = stripTs(modTsRaw);
const codePage = stripTs(codePageRaw);

check(accountsRaw.length > 0, "accounts.rs is readable");
check(orphansRaw.length > 0, "cli_orphans.rs is readable");
check(libRaw.length > 0, "lib.rs is readable");
check(modTsRaw.length > 0, "orphanContinuation.ts is readable");
check(codePageRaw.length > 0, "CodePage.tsx is readable");

// --- 1. Every CLI spawn tracked; natural exits adopt; kills forget ---------
function sliceRustFn(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return null;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const registerFn = sliceRustFn(accounts, "fn register_cli_child_scoped(");
check(
  registerFn !== null && /crate::cli_orphans::track\(pid\)/.test(registerFn),
  "register_cli_child_scoped (the ONE spawn choke point every CLI uses) starts descendant tracking",
);

const finishFn = sliceRustFn(accounts, "fn finish_cli_child_natural(");
check(finishFn !== null, "finish_cli_child_natural exists");
check(
  finishFn !== null
    && /crate::cli_orphans::adopt\(pid, scope\.as_deref\(\)\)/.test(finishFn)
    && finishFn.indexOf("cli_orphans::adopt") < finishFn.indexOf("unregister_cli_child(pid)"),
  "natural exit adopts survivors under the child's scope BEFORE dropping it from the registry",
);

const waitOne = sliceRustFn(accounts, "fn wait_cli_child(");
const waitLines = sliceRustFn(accounts, "fn wait_cli_child_lines<F>(");
for (const [name, body] of [["wait_cli_child", waitOne], ["wait_cli_child_lines", waitLines]]) {
  check(
    body !== null && /finish_cli_child_natural\(pid\)/.test(body),
    `${name}: natural exit goes through finish_cli_child_natural (one-shot claude/codex/kimi/gemini/grok all funnel here)`,
  );
  check(
    body !== null && /crate::cli_orphans::forget\(pid\)/.test(body),
    `${name}: the timeout kill forgets — a tree-killed turn must not adopt`,
  );
}

// Both streaming runners (claude + codex) branch on their watchdog flag:
// timed-out kills forget, natural ends adopt.
const streamAdopts = accounts.match(/} else \{\s*finish_cli_child_natural\(child_pid\);\s*\}/g) ?? [];
const streamForgets = accounts.match(/crate::cli_orphans::forget\(child_pid\)/g) ?? [];
check(streamAdopts.length >= 2, `both streaming CLI runners adopt on natural exit (${streamAdopts.length}/2)`);
check(streamForgets.length >= 2, `both streaming CLI runners forget on a watchdog kill (${streamForgets.length}/2)`);

const killLoop = sliceRustFn(accounts, "fn kill_cli_children(");
check(
  killLoop !== null
    && /crate::cli_orphans::forget\(pid\)/.test(killLoop)
    && killLoop.indexOf("cli_orphans::forget") < killLoop.indexOf("unregister_cli_child(pid)"),
  "Stop (global or scoped) forgets the tree it kills — a stopped turn can NEVER arm a continuation",
);

// A future natural-exit site that calls bare unregister loses background work
// again. Every unregister in accounts.rs must be either inside the finish
// helper or immediately preceded by a forget.
const bareUnregisters = (accounts.match(/unregister_cli_child\(/g) ?? []).length;
const guardedUnregisters =
  (accounts.match(/crate::cli_orphans::forget\((?:pid|child_pid)\);\s*\n\s*unregister_cli_child\(/g) ?? []).length
  + (finishFn !== null && /unregister_cli_child\(pid\)/.test(finishFn) ? 1 : 0)
  + 1; // the definition of unregister_cli_child itself
check(
  bareUnregisters === guardedUnregisters,
  `every unregister site either adopts (via finish_cli_child_natural) or forgets — no silent third path (${guardedUnregisters}/${bareUnregisters})`,
);

// --- 2. The watcher module + app wiring -----------------------------------
check(/mod cli_orphans;/.test(lib), "lib.rs declares the module");
check(/cli_orphans::init\(app\.handle\(\)\)/.test(lib), "setup() hands the watcher its emit handle");
check(
  /cli_orphans::cli_orphans_snapshot,/.test(lib) && /cli_orphans::cli_orphans_ack,/.test(lib),
  "snapshot + ack commands are registered (webview reload cannot lose a finished group)",
);
check(
  /"cli-orphans-detected"/.test(orphans) && /"cli-orphans-finished"/.test(orphans),
  "the watcher emits both events",
);
check(
  /fn sample_descendants\(/.test(orphans) && /fn advance_adopted\(/.test(orphans),
  "descendants are sampled while the CLI LIVES (post-exit walks find nothing on Unix) and adopted orphans advance",
);
check(
  /start_time\(\) == entry\.proc_\.start_time/.test(orphans),
  "every aliveness check matches process start time — PID reuse can't fake a live orphan",
);

// --- 3. The wire is camelCase on BOTH sides -------------------------------
const wireStruct = orphans.slice(orphans.indexOf("pub struct OrphanWire") - 200, orphans.indexOf("pub struct OrphanWire"));
const groupStruct = orphans.slice(orphans.indexOf("pub struct OrphanGroup") - 200, orphans.indexOf("pub struct OrphanGroup"));
check(/#\[serde\(rename_all = "camelCase"\)\]/.test(wireStruct), "OrphanWire serializes camelCase");
check(/#\[serde\(rename_all = "camelCase"\)\]/.test(groupStruct), "OrphanGroup serializes camelCase");
check(
  /ran_secs/.test(orphans) && /still_running/.test(orphans),
  "the Rust fields whose casing changes on the wire exist (ran_secs, still_running)",
);
check(
  /ranSecs/.test(modTs) && /stillRunning/.test(modTs),
  "the UI reads the camelCase names serde actually sends",
);
check(
  !/ran_secs|still_running/.test(modTs) && !/ran_secs|still_running/.test(codePage),
  "the UI never reads the snake_case spellings (the exact dead-fallback bug class)",
);

// --- 4. Code page: subscribe both panes, dispatch live, cap the chain ------
check(
  /subscribeOrphanContinuation\(primaryCancelScope\(workspace\)/.test(codePage),
  "the primary pane's scope is subscribed",
);
check(
  /subscribeOrphanContinuation\(secondaryCancelScope\(workspace\)/.test(codePage),
  "the second agent's scope is subscribed",
);
check(
  /sendRef\.current\?\.\(orphanContinuationPrompt\(ev\.group\)\)/.test(codePage)
    && /sendSecondaryRef\.current\?\.\(orphanContinuationPrompt\(ev\.group\)\)/.test(codePage),
  "continuations dispatch through the ref'd send closures (fresh history/busy — and mid-turn they queue as a steer)",
);
check(
  /orphanDetectedNotice\(ev\.group\)/.test(codePage),
  "background work surviving a turn is announced in the transcript",
);
check(
  (codePage.match(/orphanHopsRef\.current = 0/g) ?? []).length >= 2,
  "both composers reset the continuation cap (a human in the loop re-arms it)",
);
check(
  /orphanHopsRef\.current >= ORPHAN_MAX_HOPS/.test(codePage),
  "the continuation chain is capped — a continuation that spawns background work can't loop forever",
);

// --- 5. Module logic: hold-and-replay + the continuation text (executed) ---
const deliverFn = sliceRustFn(modTs, "function deliver(");
check(
  deliverFn !== null && /pendingFinished\.set\(/.test(deliverFn),
  "a finished group with no live subscriber is HELD, not dropped (page unmounted ≠ promise dead)",
);
const subscribeFn = sliceRustFn(modTs, "function subscribeOrphanContinuation(");
check(
  subscribeFn !== null && /pendingFinished\.get\(scope\)/.test(subscribeFn) && /cli_orphans_ack/.test(subscribeFn),
  "subscribing replays a held group immediately and acks it to the backend buffer",
);
check(
  /invoke<\{ live: OrphanGroup\[\]; finished: OrphanGroup\[\] \}>\("cli_orphans_snapshot"\)/.test(modTs),
  "module init re-seeds from the backend snapshot after a webview reload",
);

{
  // Execute the real prompt builders — the continuation must demand
  // verification, because the watcher cannot know exit codes.
  const fns = ["fmtDuration", "orphanLines", "orphanDetectedNotice", "orphanContinuationPrompt"]
    .map((n) => {
      const decl = sliceRustFn(modTs, `function ${n}(`);
      return decl ? decl.replace(/^export /, "").replace(/: string\)/g, ")").replace(/: number\)/g, ")") : null;
    });
  if (fns.every(Boolean)) {
    const stripped = fns
      .join("\n")
      .replace(/\(secs: number\)/g, "(secs)")
      .replace(/\(group: OrphanGroup\)/g, "(group)")
      .replace(/: string/g, "");
    const api = new Function(`${stripped}\nreturn { orphanDetectedNotice, orphanContinuationPrompt };`)();
    const group = {
      scope: "C:/work/proj",
      stillRunning: false,
      orphans: [{ pid: 4242, name: "node", cmdline: "node scripts/release-matrix.mjs", ranSecs: 754 }],
    };
    const prompt = api.orphanContinuationPrompt(group);
    check(
      prompt.includes("never assume success") && prompt.includes("release-matrix"),
      "EXECUTED: the continuation prompt names the finished process and demands verification from its own output",
    );
    const stuck = api.orphanContinuationPrompt({ ...group, stillRunning: true });
    check(
      /STILL running/i.test(stuck),
      "EXECUTED: the ceiling variant reports still-running work instead of claiming it finished",
    );
    check(
      api.orphanDetectedNotice(group).includes("pid 4242"),
      "EXECUTED: the transcript notice identifies the surviving process",
    );
  } else {
    check(false, "prompt builders could not be sliced from orphanContinuation.ts");
  }
}

// --- 6. The adoption state machine, compiled and executed ------------------
{
  const graceConst = (orphansRaw.match(/const ANNOUNCE_GRACE: Duration = [^;]+;/) ?? [])[0];
  const ceilingConst = (orphansRaw.match(/const WATCH_CEILING: Duration = [^;]+;/) ?? [])[0];
  const enumDecl = sliceRustFn(orphans, "pub(crate) enum OrphanPhase");
  const phaseFn = sliceRustFn(orphans, "pub(crate) fn orphan_phase(");
  if (graceConst && ceilingConst && enumDecl && phaseFn) {
    const program = [
      "use std::time::Duration;",
      graceConst,
      ceilingConst,
      "#[derive(Debug, PartialEq, Eq)]",
      enumDecl,
      phaseFn,
      "fn main() {",
      `  assert_eq!(orphan_phase(false, false, Duration::from_secs(3)), OrphanPhase::DropSilently, "a straggler dying inside the grace must be silent — every MCP-server shutdown would otherwise announce");`,
      `  assert_eq!(orphan_phase(false, true, Duration::from_secs(3)), OrphanPhase::KeepWatching, "no announcement before the grace elapses");`,
      `  assert_eq!(orphan_phase(false, true, ANNOUNCE_GRACE), OrphanPhase::Announce, "a survivor past the grace is announced");`,
      `  assert_eq!(orphan_phase(true, false, Duration::from_secs(600)), OrphanPhase::Finished, "an announced orphan exiting is what fires the continuation");`,
      `  assert_eq!(orphan_phase(true, true, WATCH_CEILING), OrphanPhase::CeilingHit, "a daemon must not be watched forever");`,
      `  assert_eq!(orphan_phase(true, true, WATCH_CEILING - Duration::from_secs(1)), OrphanPhase::KeepWatching, "the ceiling must not fire early");`,
      `  assert!(ANNOUNCE_GRACE >= Duration::from_secs(5), "grace shorter than CLI teardown makes every turn announce stragglers");`,
      `  println!("RUST_ORPHAN_PHASE_OK");`,
      "}",
    ].join("\n");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-orphangate-"));
    const src = path.join(dir, "phasecheck.rs");
    const exe = path.join(dir, process.platform === "win32" ? "phasecheck.exe" : "phasecheck");
    try {
      fs.writeFileSync(src, program, "utf8");
      execFileSync("rustc", ["--edition", "2021", "-A", "warnings", "-o", exe, src], { stdio: "pipe" });
      const out = execFileSync(exe, { encoding: "utf8" });
      check(out.includes("RUST_ORPHAN_PHASE_OK"),
        "EXECUTED: the SHIPPED adoption state machine — silent stragglers, grace-gated announce, finish-on-exit, bounded watch");
    } catch (e) {
      const detail = String(e?.stderr ?? e?.message ?? e).split("\n").slice(0, 12).join("\n");
      check(false, `the shipped orphan_phase failed its behavioural check:\n${detail}`);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
  } else {
    check(false, "orphan_phase/constants could not be sliced from cli_orphans.rs");
  }
}

console.log(`\nbackgroundWorkContinuity: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
