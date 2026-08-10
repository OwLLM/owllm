// Regression gate: the Code page's SECOND agent must survive a page change,
// exactly like the primary coder does.
//
// The bug: CodeWorkspace held the second agent's AbortController in a component
// ref and aborted it from an unmount cleanup —
//     useEffect(() => () => { secondaryAbortRef.current?.abort(); }, []);
// — while its busy flag lived in `useState`. Switching page unmounts the
// component, so the run was killed mid-reply and the remounted page came back
// idle over a half-written message: "the chat freezes and stops working". The
// primary coder never had this, because its run flag and transcript live in
// chatRuntime (a module singleton that outlives the page).
//
// This gate does three things, and the middle one is the real evidence:
//   1. pins the source contract (no abort-on-unmount, busy read from the store),
//   2. EXECUTES the real chatRuntime through an unmount/remount lifecycle,
//   3. EXECUTES the module-level abort registry sliced out of CodePage.tsx,
//      so Stop still reaches the run after the page has been remounted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import * as esbuild from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE_PAGE = path.join(HERE, "CodePage.tsx");
const RUNTIME = path.resolve(HERE, "../../runtime/chatRuntime.ts");

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}`); }
};

console.log("\nCodePage second-agent run survival:\n");

if (!fs.existsSync(CODE_PAGE)) {
  console.error("  ✗ CodePage.tsx not found");
  throw new Error("FAILED: CodePage.tsx missing — cannot verify second-agent run survival.");
}
const src = fs.readFileSync(CODE_PAGE, "utf8").replace(/\r\n/g, "\n");
// The invariant is about CODE, and the comments here quote the very shapes the
// gate forbids. Strip them so an explanatory note can never fail its own check.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !/^\s*(\/\/|\/\/\/)/.test(l)).join("\n");

// ---- 1. source contract ----------------------------------------------------

check("the second agent is NOT aborted from an unmount cleanup",
  !/useEffect\(\(\)\s*=>\s*\(\)\s*=>\s*\{[^}]*secondary[A-Za-z]*Abort/i.test(code)
  && !/secondaryAbortRef/.test(code));

check("its busy flag is a persisted CodeState field, not component state",
  /secondaryBusy\?:\s*boolean/.test(code)
  && /const secondaryBusy: boolean = stx\.secondaryBusy \?\? false;/.test(code)
  && !/useState[^\n]*setSecondaryBusy/.test(code)
  && /const setSecondaryBusy = \(v: boolean\) => setField\("secondaryBusy", v\)/.test(code));

check("the run flag is written through the store that outlives the page",
  /setSecondaryBusy\(true\)/.test(code) && /setSecondaryBusy\(false\)/.test(code));

check("neither run flag is persisted true across an app restart",
  /\{ \.\.\.s, busy: false, secondaryBusy: false \}/.test(code)
  && /\{ \.\.\.DEFAULT_CODE_STATE, \.\.\.s, busy: false, secondaryBusy: false \}/.test(code));

check("the abort controller lives in a module-level registry",
  /const secondaryAborts = new Map<string, AbortController>\(\);/.test(code)
  && /secondAgentRun\.arm\(SID, ctrl\)/.test(code)
  && /secondAgentRun\.disarm\(SID, ctrl\)/.test(code));

// Same invariant, re-expressed: Stop now also kills the pane's CLI children
// (see codeAgentStopScope.verify.run.mjs), so the button routes through a named
// handler instead of an inline arrow. What must still hold is that the abort
// reaches the run through the MODULE registry — a component ref would be null
// after a remount, which is what made Stop unreachable across a page change.
check("Stop goes through the registry, so it works after a remount",
  /onStop=\{stopSecondary\}/.test(code)
  && /const stopSecondary = \(\) => \{[\s\S]{0,200}?secondAgentRun\.stop\(SID\);/.test(code));

check("closing the TAB stops the run that page changes no longer stop",
  /secondAgentRun\.stop\(sidForPage\(id\)\)/.test(code));

check("a background page glows for a second-agent run (parity with the coder)",
  /!!snap\?\.busy \|\| !!snap\?\.secondaryBusy/.test(code));

check("the busy guard reads the live flag, not this render's closure",
  /if \(isSecondaryBusyNow\(\)\) \{/.test(code)
  && /const isSecondaryBusyNow = \(\): boolean =>/.test(code));

// ---- 2. EXECUTE the real chatRuntime across unmount/remount ---------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-secondagent-"));
const bundle = path.join(tmp, "runtime.mjs");
try {
  await esbuild.build({
    entryPoints: [RUNTIME],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundle,
    logLevel: "silent",
  });
  const { chatRuntime } = await import(`file://${bundle.replace(/\\/g, "/")}`);
  const SID = "code:ws:p_test";
  chatRuntime.ensureSession(SID, { messages: [], secondaryMessages: [], secondaryBusy: false });

  // A page mounts and subscribes, the way CodeWorkspace does.
  let repaints = 0;
  let unsubscribe = chatRuntime.subscribe(SID, () => { repaints += 1; });
  const payload = () => chatRuntime.getSnapshot(SID).payload;
  const appendSecondary = (text) => chatRuntime.setPayload(SID, (prev) => ({
    ...prev,
    secondaryMessages: [...prev.secondaryMessages, { role: "assistant", content: text }],
  }));

  // Turn starts.
  chatRuntime.setPayload(SID, (prev) => ({ ...prev, secondaryBusy: true }));
  appendSecondary("first token");
  check("mounted page repaints while the second agent streams", repaints > 0);

  // PAGE CHANGE: the component unmounts. Its subscription goes away; the run
  // does not. This is the line that used to abort the controller.
  unsubscribe();
  const afterUnmount = repaints;

  // The run keeps writing — onSecondaryDelta goes through the same store.
  appendSecondary("token written while the page was away");
  appendSecondary("and another");

  check("the run keeps writing into the store with zero subscribers",
    payload().secondaryMessages.length === 3);
  check("an unmounted page receives no repaints (no setState-after-unmount)",
    repaints === afterUnmount);

  // REMOUNT: navigating back re-subscribes and reads the still-growing buffer.
  unsubscribe = chatRuntime.subscribe(SID, () => { repaints += 1; });
  const remounted = payload();
  check("the remounted page sees the second agent STILL busy",
    remounted.secondaryBusy === true);
  check("the remounted page sees every token written while it was away",
    remounted.secondaryMessages.map((m) => m.content).join("|")
      === "first token|token written while the page was away|and another");

  // The turn finishes after the remount.
  chatRuntime.setPayload(SID, (prev) => ({ ...prev, secondaryBusy: false }));
  check("the finished turn clears busy for the remounted page",
    payload().secondaryBusy === false);
  unsubscribe();

  // The old shape, for contrast: a busy flag in component state is reborn as
  // its initial value on remount, which is exactly the frozen-idle symptom.
  const componentState = { secondaryBusy: false };            // useState(false)
  componentState.secondaryBusy = true;                        // turn starts
  const remountedComponentState = { secondaryBusy: false };   // page change
  check("component-state busy would report idle mid-run (the old bug)",
    componentState.secondaryBusy === true && remountedComponentState.secondaryBusy === false);

  // ---- 3. EXECUTE the abort registry sliced out of CodePage.tsx ------------

  const start = src.indexOf("const secondaryAborts = new Map<string, AbortController>();");
  const objStart = src.indexOf("const secondAgentRun = {", start);
  const objEnd = src.indexOf("\n};", objStart);
  if (start < 0 || objStart < 0 || objEnd < 0) {
    check("the abort registry could be sliced out of CodePage.tsx", false);
  } else {
    const slice = src.slice(start, objEnd + 3);
    const js = (await esbuild.transform(slice + "\nexport { secondAgentRun, secondaryAborts };\n", {
      loader: "ts", format: "esm",
    })).code;
    const regFile = path.join(tmp, "registry.mjs");
    fs.writeFileSync(regFile, js);
    const { secondAgentRun, secondaryAborts } = await import(`file://${regFile.replace(/\\/g, "/")}`);

    const A = "code:ws:pA";
    const B = "code:ws:pB";
    const ctrlA = new AbortController();
    secondAgentRun.arm(A, ctrlA);

    // Stop is pressed AFTER a page change — the registry is module-level, so
    // the controller is still reachable even though the ref that held it is gone.
    secondAgentRun.stop(A);
    check("Stop after a remount still aborts the live run", ctrlA.signal.aborted === true);

    const ctrlB = new AbortController();
    secondAgentRun.arm(B, ctrlB);
    secondAgentRun.stop(A);
    check("stopping one page does not abort ANOTHER page's second agent",
      ctrlB.signal.aborted === false);

    // A finished turn must not disarm the turn that replaced it.
    const first = new AbortController();
    const second = new AbortController();
    secondAgentRun.arm(B, first);
    secondAgentRun.arm(B, second);
    secondAgentRun.disarm(B, first);          // late cleanup from the old turn
    secondAgentRun.stop(B);
    check("a late disarm from a finished turn cannot orphan the next one",
      second.signal.aborted === true);

    secondAgentRun.disarm(B, second);
    check("disarming the armed controller clears the registry entry",
      !secondaryAborts.has(B));

    const idle = new AbortController();
    secondAgentRun.stop("code:ws:never-armed");
    check("stopping a page with no run is a no-op", idle.signal.aborted === false);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) throw new Error(`FAILED: ${failures} second-agent run-survival check(s).`);
console.log("\nall CodePage second-agent run-survival checks passed");
