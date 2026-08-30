// The Code page's two agents are independently stoppable.
//
// Aborting an AbortController never reaches a spawned claude/codex/kimi/grok/
// gemini process — Tauri `invoke` has no cancellation channel — so a Stop
// button must ALSO ask Rust to kill that run's children (`cli_cancel_scope`).
// Rust scopes a child by the project `cwd` when the caller passes nothing, so
// both Code-page panes landed in one scope. Two failures followed, and neither
// looks like a crash: the second agent's Stop killed nothing (it never asked at
// all, so the agent kept working and the pane stayed busy), and the primary's
// global Stop tree-killed the second agent's CLI as collateral.
//
// What must hold:
//   1. each pane registers its OWN cancel scope before dispatching, and the two
//      scopes are never equal for the same workspace;
//   2. the second agent's Stop kills CLI children and unsticks its pane;
//   3. a scope registered on a run's signal actually reaches every CLI invoke
//      in dispatch.ts — a scope that is stored and never sent kills nothing;
//   4. a Stopped-then-superseded turn cannot clear the NEXT turn's busy flag.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
// Report EVERY failure: a gate that throws on the first one hides how much of
// the invariant is broken, which is exactly what matters when re-checking old
// code to confirm the gate discriminates.
function check(condition, message) {
  if (condition) { passed += 1; console.log(`OK ${message}`); }
  else { failed += 1; console.log(`FAIL ${message}`); }
}

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
/// Invariants below are about CODE. Strip comments first, or a comment that
/// merely EXPLAINS the rule satisfies the scan looking for it.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/^[ \t]*\/\/\/.*$/gm, "");

const codePageRaw = read(path.join(HERE, "CodePage.tsx"));
const dispatchRaw = read(path.join(HERE, "dispatch.ts"));
const codePage = stripComments(codePageRaw);
const dispatch = stripComments(dispatchRaw);

check(codePageRaw.length > 0, "CodePage.tsx is readable");
check(dispatchRaw.length > 0, "dispatch.ts is readable");

// --- 1. The scope channel exists and is keyed by the run ------------------
check(
  /export function setCliCancelScope\(signal: AbortSignal, scope: string\)/.test(dispatch),
  "dispatch exposes setCliCancelScope(signal, scope)",
);
check(
  /export function cliCancelScopeFor\(/.test(dispatch),
  "dispatch exposes cliCancelScopeFor(signal)",
);
check(
  /new WeakMap<AbortSignal, string>\(\)/.test(dispatch),
  "scopes are keyed by the run's AbortSignal (WeakMap — no leak per turn)",
);

// --- 2. The scope reaches EVERY CLI spawn --------------------------------
// A scope that is registered but never forwarded kills nothing. Each provider
// that can spawn a subscription CLI must read it and pass it down.
for (const fn of ["streamAnthropic", "streamOpenAI", "streamMoonshot", "streamXai", "streamGemini"]) {
  const body = dispatch.slice(dispatch.indexOf(`async function ${fn}(`));
  const scoped = body.slice(0, body.indexOf("\nasync function ", 1) + 1 || body.length);
  check(
    /const cancelScope = cliCancelScopeFor\(signal\)/.test(scoped),
    `${fn} resolves the run's cancel scope`,
  );
}
// Count the CLI invokes and the cancelScope hand-offs: a new CLI call site added
// later without a scope makes its run unstoppable, which is this whole bug.
const cliInvokes = dispatch.match(/invoke<string>\("(?:claude|codex|kimi|grok|gemini)_cli_(?:complete|stream)"/g) ?? [];
const scopePasses = dispatch.match(/cancelScope[,:]/g) ?? [];
check(cliInvokes.length >= 7, `every CLI backend still dispatches (${cliInvokes.length} invoke sites)`);
check(
  scopePasses.length >= cliInvokes.length,
  `each CLI spawn carries a cancel scope (${scopePasses.length} hand-offs ≥ ${cliInvokes.length} spawns)`,
);
check(
  /cancelScope: args\.cancelScope \?\? null/.test(dispatch),
  "the streaming CLI helpers forward the scope to Rust",
);

// --- 3. The two panes get DIFFERENT scopes -------------------------------
// Executable, not asserted: slice the real helpers out of CodePage and run
// them. A gate that only greps for the names would pass if both returned the
// same string, which is precisely the defect.
function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const primarySrc = sliceFn(codePage, "primaryCancelScope");
const secondarySrc = sliceFn(codePage, "secondaryCancelScope");
check(primarySrc !== null, "CodePage defines primaryCancelScope");
check(secondarySrc !== null, "CodePage defines secondaryCancelScope");
if (primarySrc && secondarySrc) {
  const strip = (s) => s.replace(/: string/g, "").replace(/\)\s*{/, ") {");
  // eslint-disable-next-line no-new-func
  const scopes = new Function(`${strip(primarySrc)}\n${strip(secondarySrc)}\nreturn { primaryCancelScope, secondaryCancelScope };`)();
  const ws = "C:/work/demo";
  check(scopes.primaryCancelScope(ws) === ws, "the primary's scope IS the workspace (matches Rust's cwd default)");
  check(
    scopes.secondaryCancelScope(ws) !== scopes.primaryCancelScope(ws),
    "the second agent's scope differs from the primary's for the SAME workspace",
  );
  check(scopes.secondaryCancelScope(ws).includes(ws), "the second agent's scope still identifies the workspace");
  check(
    scopes.primaryCancelScope("") === "" && scopes.secondaryCancelScope("") === "",
    "no workspace ⇒ no scope (the caller falls back to the global kill)",
  );
}

// --- 4. Both panes register their scope before dispatching ---------------
check(
  /setCliCancelScope\(ctrl\.signal, secondaryCancelScope\(workspace\)\)/.test(codePage),
  "the second agent registers its scope when its turn starts",
);
check(
  /setCliCancelScope\(ctrl\.signal, primaryCancelScope\(workspace\)\)/.test(codePage),
  "the primary registers its scope when its turn starts",
);
check(
  (codePage.match(/setCliCancelScope\(ctrl\.signal, primaryCancelScope\(workspace\)\)/g) ?? []).length >= 3,
  "EVERY primary run path registers it (send, plan & build, resume)",
);

// --- 5. The second agent's Stop actually stops ---------------------------
check(
  /const stopSecondary = \(\) => \{/.test(codePage),
  "the second agent has a real Stop handler",
);
check(
  /stopSecondary[\s\S]{0,400}?killCliChildren\(secondaryCancelScope\(workspace\)\)/.test(codePage),
  "the second agent's Stop kills its OWN CLI children",
);
check(
  /stopSecondary[\s\S]{0,400}?setSecondaryBusy\(false\)/.test(codePage),
  "the second agent's Stop unsticks the pane instead of waiting for the process",
);
check(
  /onStop=\{stopSecondary\}/.test(codePage),
  "the second pane's Stop button is wired to it",
);
check(
  !/onStop=\{\(\) => \{ secondAgentRun\.stop\(SID\); \}\}/.test(codePage),
  "the old abort-only Stop (which killed no CLI at all) is gone",
);

// --- 6. The primary's Stop no longer nukes the sibling -------------------
check(
  /killCliChildren\(primaryCancelScope\(workspace\)\)/.test(codePage),
  "the Coder's Stop is scoped to its own run",
);
check(
  !/const stop = \(\) => \{[\s\S]{0,300}?invoke\("cli_cancel_all"\)/.test(codePage),
  "the Coder's Stop no longer tree-kills every live CLI globally",
);
check(
  /function killCliChildren\(scope: string\)[\s\S]{0,400}?cli_cancel_scope[\s\S]{0,200}?cli_cancel_all/.test(codePage),
  "an unscoped page still falls back to the global kill (Stop never becomes a no-op)",
);

// --- 7. A stopped turn cannot unstick the next one -----------------------
check(
  /isCurrent\(sid: string, ctrl: AbortController\)/.test(codePage),
  "secondAgentRun can tell whether a controller is still the live turn",
);
check(
  /if \(secondAgentRun\.isCurrent\(SID, ctrl\)\) setSecondaryBusy\(false\)/.test(codePage),
  "a superseded turn's cleanup does not clear the NEXT turn's busy flag",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
