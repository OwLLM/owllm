#!/usr/bin/env node
// stopNeverBlocks — Stop must never sit behind the local model load.
//
// THE BUG THIS EXISTS FOR
// Every chat surface auto-starts llama-server on the first send. That phase can
// run for MINUTES (server_start may download the whole inference engine module,
// then map a multi-GB GGUF into VRAM), and it was the one phase no Stop button
// could touch:
//   * `invoke("server_start")` was awaited raw — a Tauri invoke has no
//     cancellation channel, so the caller was pinned to it.
//   * the readiness polls waited on bare `setTimeout` and checked nothing.
//   * worst of all, AgentsPage/CodePage created the run's AbortController
//     AFTER the load, so `abortRef` still pointed at the PREVIOUS run — Stop
//     had literally nothing live to abort for that whole window.
// Result: press Stop during a cold load and nothing happened. The button
// flipped, the run kept going, and the UI looked hostage.
//
// WHY THIS GUARD IS DERIVED, NOT A PAGE LIST
// The last two rounds of this class of bug were fixed one page at a time and
// came straight back on the next surface. So the invariant is computed from the
// source: ANY file that starts the local server AND owns a cancellable stream
// must route every start/poll await through the shared abort helpers. Add a
// fourth chat page tomorrow and it is covered the moment it streams.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");
const read = (abs) => fs.readFileSync(abs, "utf8");

// Comments are stripped before matching. A previous guard in this repo passed
// because it matched its own explanatory prose instead of live code.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.verify\.run\.mjs$/.test(e.name)) out.push(p);
  }
  return out;
}

let failed = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failed += 1; console.error(`FAIL ${name}`); }
}

// ---------- 1. the shared primitives exist and behave ----------
const dispatch = stripComments(read(path.join(SRC, "pages/agentic/dispatch.ts")));

check("dispatch exports abortable()", /export function abortable</.test(dispatch));
check("dispatch exports isAbortError()", /export function isAbortError\(/.test(dispatch));
check("dispatch exports sleepAbortable()", /export function sleepAbortable\(/.test(dispatch));
check(
  "abortable rejects with a DOMException named AbortError",
  /abortable[\s\S]{0,700}?DOMException\("aborted", "AbortError"\)/.test(dispatch),
);
check(
  "abortable short-circuits an already-aborted signal",
  /abortable[\s\S]{0,300}?signal\.aborted\)\s*return Promise\.reject/.test(dispatch),
);
check(
  "abortable detaches its listener so a long-lived signal does not leak handlers",
  /abortable[\s\S]{0,700}?removeEventListener\("abort"/.test(dispatch),
);
check(
  "sleepAbortable tolerates a null signal (callers may have no live run)",
  /sleepAbortable\(ms: number, signal\?: AbortSignal \| null\)/.test(dispatch),
);

// ---------- 2. DERIVED: every cancellable server-start is abortable ----------
// A file "starts the local server" if it invokes server_start; it is
// "cancellable" if it actually calls .abort() somewhere — i.e. it owns a Stop
// affordance. That intersection is exactly the set of surfaces whose load
// phase must obey Stop.
//
// The discriminator is .abort() and NOT a mention of AbortSignal, which was
// too loose: bridgeCore passes a throwaway `new AbortController().signal` (a
// Telegram/WhatsApp user has no Stop button to press) and ServerPage only uses
// `AbortSignal.timeout()` on its fetch probes — its start IS the explicit Load
// action and its cancel is the separate Stop-server button. Neither is a run
// the user can interrupt mid-load, so neither belongs in this rule.
const files = walk(SRC).map((abs) => ({ abs, rel: path.relative(SRC, abs), src: stripComments(read(abs)) }));
const starters = files.filter((f) => /invoke\(\s*["']server_start["']/.test(f.src));
const cancellable = starters.filter((f) => /\.abort\(\)/.test(f.src));

check("the derived scan actually found the server-start call sites", starters.length >= 4);
check("the derived scan actually found cancellable surfaces", cancellable.length >= 4);
// Guard the discriminator itself: if a future refactor makes .abort() vanish
// from a chat page, the scan would silently cover nothing and report all-green.
for (const rel of [
  "pages/finetuning/ChatPage.tsx",
  "pages/agentic/AgentsPage.tsx",
  "pages/agentic/CodePage.tsx",
  "pages/finetuning/DatasetBuilderPage.tsx",
]) {
  check(
    `${rel} is inside the derived scan (its Stop must reach the model load)`,
    cancellable.some((f) => f.rel.split(path.sep).join("/") === rel),
  );
}

for (const f of cancellable) {
  // Every server_start in a cancellable file must be wrapped: abortable(invoke("server_start"…
  const raw = [...f.src.matchAll(/invoke\(\s*["']server_start["']/g)];
  const wrapped = [...f.src.matchAll(/abortable\(\s*invoke\(\s*["']server_start["']/g)];
  check(`${f.rel}: every server_start await is raced against a Stop signal`, raw.length === wrapped.length);

  // And no readiness poll may wait on a bare timer — that is what made Stop
  // land up to 500-1000 ms late, or never, in the load loops.
  check(
    `${f.rel}: readiness waits use sleepAbortable, not a bare setTimeout`,
    !/new Promise\(\s*\(\s*r\s*\)\s*=>\s*setTimeout\(\s*r\s*,/.test(f.src),
  );
}

// ---------- 3. the controller must exist BEFORE the load ----------
// This is the defect that made Stop a guaranteed no-op: the run registered its
// AbortController only after the model was already loading.
const agents = stripComments(read(path.join(SRC, "pages/agentic/AgentsPage.tsx")));
const idxCtrl = agents.indexOf("abortRef.current = ctrl");
const idxLoad = agents.indexOf("await ensureLocalServer(wantedLocal");
check("dispatchGoal registers its abort controller", idxCtrl > 0);
check("dispatchGoal awaits the local server load", idxLoad > 0);
check(
  "dispatchGoal installs the run's controller BEFORE the cold model load",
  idxCtrl > 0 && idxLoad > 0 && idxCtrl < idxLoad,
);
check(
  "a Stop during the load unwinds instead of starting the run anyway",
  /if \(ctrl\.signal\.aborted\)[\s\S]{0,220}?releaseRunAbort\(\)/.test(agents),
);
check(
  "an aborted load does not leave a stale controller for the next Stop to hit",
  /releaseRunAbort = \(\)[\s\S]{0,260}?agentRunAborts\.delete\(agentSessId\)/.test(agents),
);

// ---------- 4. every abort controller in the dock is reachable from Stop ----------
// The dock's "Load model" button owns the single longest job in the page
// (180 s start + a 10 min /health wait) and had no controller at all.
check(
  "the dock Stop handler aborts the model-load controller too",
  /owllm:dispatch-abort[\s\S]{0,60}/.test(agents)
    && /dockLoadAbortRef\.current\?\.abort\(\)/.test(agents),
);
check(
  "the dock Stop handler still aborts both run controllers",
  /supSendAbortRef\.current\?\.abort\(\)/.test(agents)
    && /abortRef\.current\?\.abort\(\)/.test(agents),
);
check(
  "the 10-minute /health wait is raced against Stop",
  /abortable\(readyPromise, loadAbort\.signal\)/.test(agents),
);

// ---------- 5. a deliberate Stop is not reported as a failure ----------
// Painting "failed to start" / "timed out after 90s" over a user's deliberate
// Stop is how a working cancel still reads as a bug.
const ftChat = stripComments(read(path.join(SRC, "pages/finetuning/ChatPage.tsx")));
check(
  "fine-tuning chat: Stop during load does not paint a server error",
  /if \(!isAbortError\(e\)\) updateCol\("A", \{ error: `Failed to start server/.test(ftChat),
);
check(
  "fine-tuning chat: the send passes its live signal into the server start",
  /ensureLocalServer\(wantedModelId, signal\)/.test(ftChat),
);
// The invariant is "a deliberate Stop paints NO error", not the wording of the
// error it isn't painting. The message itself moved to localStartFailureText
// (which now carries the engine's real reason instead of a fixed "within 90s"
// sentence), so pin the abort branch — that is the part Stop depends on.
check(
  "agents: Stop during load is not reported as a start failure",
  /ctrl\.signal\.aborted\s*\?\s*null\s*:\s*localStartFailureText\(wantedLocal/.test(agents),
);
check(
  "agents: a real (non-Stop) start failure still reports the engine's own reason",
  /localStartFailureText\(wantedLocal, localStartFailureRef\.current\)/.test(agents),
);
check(
  "agents: solo chat passes its live signal into the server start",
  /ensureLocalServer\(supModelId, 90_000, supSendAbort\.signal\)/.test(agents),
);

// ---------- 6. CodePage must not read a stale controller ----------
const code = stripComments(read(path.join(SRC, "pages/agentic/CodePage.tsx")));
check(
  "CodePage: ensureServer takes the caller's signal instead of reading abortRef",
  /async function ensureServer\(id: string, signal\?: AbortSignal\)/.test(code)
    && !/ensureServer[\s\S]{0,700}?abortRef\.current\?\.signal/.test(code),
);
check(
  "CodePage: all three call sites hand their live signal down",
  (code.match(/ensureServer\((?:modelId|secModel), (?:signal|ctrl\.signal)\)/g) ?? []).length === 3,
);

console.log(failed === 0 ? "\nOK" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
