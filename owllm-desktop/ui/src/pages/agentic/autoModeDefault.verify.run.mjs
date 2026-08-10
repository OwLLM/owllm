// Auto mode defaults ON, and a self-inflicted tool block is explained.
//
// `claude -p` is non-interactive. When a tool needs approval there is nobody to
// answer the prompt, so the turn ends with "permission to use <tool> hasn't
// been granted" having run ZERO tools. Auto mode is what stops that, and it
// used to default OFF — which made "the agent can't use its own browser" the
// out-of-the-box experience for every new project.
//
// Two invariants, both of which regress silently (the app still builds, still
// runs, and the agent still produces a confident-sounding reply):
//
//   1. a project that has never touched the ⚡ toggle is auto-approved, while
//      an EXPLICIT opt-out is still honoured, and
//   2. when a CLI does refuse a tool, the user is told the real cause and one
//      imperative step — not left with the CLI's own prose.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
// Report EVERY failure: a gate that throws on the first one hides how much of
// the invariant is actually broken, which matters when re-checking old code.
function check(condition, message) {
  if (condition) { passed += 1; console.log(`OK ${message}`); }
  else { failed += 1; console.log(`FAIL ${message}`); }
}

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
/// Invariants below are about CODE. Strip comments first, or a comment that
/// merely EXPLAINS the rule satisfies the scan looking for it.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const agentsPage = stripComments(read(path.join(HERE, "AgentsPage.tsx")));
const dispatch = stripComments(read(path.join(HERE, "dispatch.ts")));
const blockersSrc = read(path.join(HERE, "runBlockers.ts"));

check(agentsPage.length > 0, "AgentsPage.tsx is readable");
check(dispatch.length > 0, "dispatch.ts is readable");
check(blockersSrc.length > 0, "runBlockers.ts exists");

// --- 1. Auto mode default ------------------------------------------------
// localStorage is the LIVE source of the toggle; the agent_projects
// .auto_approve_all column is written but never read by the UI. A gate that
// pinned the column would pass while the real default stayed OFF.
check(
  /const\s+AUTO_APPROVE_DEFAULT\s*=\s*true/.test(agentsPage),
  "AgentsPage declares AUTO_APPROVE_DEFAULT = true",
);
check(
  /raw\s*===\s*null\s*\?\s*AUTO_APPROVE_DEFAULT/.test(agentsPage),
  "a missing owllm:autoapprove key falls back to the default, not to false",
);
check(
  !/localStorage\.getItem\(autoApproveKey\)\s*===\s*"1"/.test(agentsPage),
  "the old `getItem(...) === \"1\"` default-OFF read is gone",
);
check(
  /readAutoApprove\(autoApproveKey\)/.test(agentsPage),
  "both the initial state and the project-switch effect go through readAutoApprove",
);
check(
  (agentsPage.match(/readAutoApprove\(autoApproveKey\)/g) ?? []).length >= 2,
  "no read path was left on the old default (initial state AND effect)",
);
check(
  /localStorage\.setItem\(k,\s*next\s*\?\s*"1"\s*:\s*"0"\)/.test(agentsPage),
  "an explicit choice is still persisted as \"1\"/\"0\" so opting OUT survives",
);

// Behaviour, not just shape: the three cases the read has to distinguish.
const readAutoApprove = (raw, key = "k") => {
  const AUTO_APPROVE_DEFAULT = true;
  if (!key) return AUTO_APPROVE_DEFAULT;
  return raw === null ? AUTO_APPROVE_DEFAULT : raw === "1";
};
check(readAutoApprove(null) === true, "never chosen  → ON");
check(readAutoApprove("1") === true, "explicitly ON → ON");
check(readAutoApprove("0") === false, "explicitly OFF → OFF (the opt-out is honoured)");

// --- 2. The blocker notice ----------------------------------------------
// A missing/broken module must be REPORTED as failed checks, not crash the
// gate — a crashing verifier reads as "the suite is broken", not "the code is".
let detectRunBlocker = () => null;
try {
  const bundled = await esbuild.build({
    entryPoints: [path.join(HERE, "runBlockers.ts")],
    bundle: true, write: false, format: "esm", platform: "neutral",
  });
  ({ detectRunBlocker } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  ));
} catch (e) {
  console.log(`(runBlockers.ts could not be loaded: ${e?.message ?? e})`);
}

// The exact wording observed in the Personal Assistant 3 run.
const REAL = "I attempted to use the browser but the permission to use " +
  "mcp__owllm__browser_tabs hasn't been granted yet, so I could not proceed.";
const hit = detectRunBlocker(REAL);
check(!!hit, "the real observed refusal is recognised");
check(hit?.code === "cli_tool_permission", "it is classified as a tool-permission block");
check(hit?.tools?.includes("mcp__owllm__browser_tabs"), "the named MCP tool is extracted");
check(/auto mode/i.test(hit?.action ?? ""), "the action names Auto mode");
check(/\/auto|⚡/.test(hit?.action ?? ""), "the action says WHERE to do it");
check(
  /non-interactive|no prompt|nobody|no one/i.test(hit?.why ?? ""),
  "the reason states the real mechanism, not the CLI's phrasing",
);

check(detectRunBlocker("") === null, "empty reply is not a blocker");
check(detectRunBlocker(null) === null, "null reply is not a blocker");
check(
  detectRunBlocker("I refactored the permission checks in auth.rs and added a test.") === null,
  "merely mentioning permissions is not a blocker (no false positive)",
);
check(
  detectRunBlocker("Done — I granted the user read permission on the bucket.") === null,
  "a granted-permission success line is not a blocker",
);
check(
  !!detectRunBlocker("The requested permissions were denied, so the edit did not run."),
  "the denied phrasing is recognised too",
);

// --- 3. It is actually wired, at the one place every CLI call passes -----
check(
  /export\s+function\s+setRunBlockerHandler/.test(dispatch),
  "dispatch exports setRunBlockerHandler",
);
check(
  /const\s+result\s*=\s*await\s+fn\(\)[\s\S]{0,600}?detectRunBlocker\(result\)/.test(dispatch),
  "withCliAuthRetry inspects the successful reply — refusals are NOT errors",
);
check(
  /_blockerHandler\?\.\(\{\s*\.\.\.blocker,\s*backend\s*\}\)/.test(dispatch),
  "the notice carries which CLI refused",
);
check(
  /setRunBlockerHandler\(\s*\(info: RunBlockerInfo\)/.test(agentsPage),
  "AgentsPage registers the handler",
);
check(
  /setRunBlockerHandler\(null\)/.test(agentsPage),
  "the handler is unregistered on unmount (no stale closure across pages)",
);
check(
  /autoApproveRef\.current\s*$|autoApproveRef\.current/.test(agentsPage),
  "the notice checks the LIVE toggle before blaming it",
);
check(
  /notify\(`\$\{cli\} blocked its own tool call/.test(agentsPage),
  "the user gets a toast, not just a line buried in a long thread",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
