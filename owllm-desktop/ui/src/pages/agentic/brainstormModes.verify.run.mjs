#!/usr/bin/env node
// Regression guard for the brainstorm rework:
//
//  1. A brainstorm has a KIND the user picks (auto / new product / improve /
//     research / open). Before this, every brainstorm was framed as a
//     product-marketing exercise — ICP, competitors, feature-frequency table —
//     even for a question or a one-file code change.
//  2. The mode directives and the brainstormer role must agree about which
//     TRACKs exist. A directive pointing at a track the role doesn't define is
//     the same class of drift as a UI tool the backend doesn't know.
//  3. Five concrete defects observed in the live panel, each pinned here:
//     • the Board was permanently empty for anything but a NEW-PROJECT brief
//       (it only parsed "## Feature Priority"),
//     • a brand-new project never got its Notebook seeded (seeding was gated
//       on the project ALREADY having a team, and applyTeam didn't seed),
//     • "🔑 Brave Search key required" was shown unconditionally, including
//       for tracks that never search,
//     • the checkpoint stored the whole streamed transcript a second time and
//       rewrote it to disk on nearly every keystroke,
//     • `done` never cleared when BRIEF.md disappeared.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/brainstormModes.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");                    // owllm-desktop
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const TMP = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "brainstorm-modes-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

function loadTs(rel, { stubImports = false } = {}) {
  const out = path.join(TMP, path.basename(rel).replace(/\.tsx?$/, ".cjs"));
  let js = ts.transpileModule(readLF(path.join(HERE, rel)), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  if (stubImports) {
    // Only the pure exported helpers are exercised; every sibling/framework
    // import is answered by a permissive stub so the module loads standalone.
    fs.writeFileSync(path.join(TMP, "stub.cjs"), `
      const any = new Proxy(function () {}, {
        get: (_t, k) => (k === "__esModule" ? true : any),
        apply: () => any,
        construct: () => any,
      });
      module.exports = any;
    `);
    js = js.replace(/require\("[^"]+"\)/g, 'require("./stub.cjs")');
  }
  fs.writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}

let pass = 0;
const fails = [];
const check = (name, cond) => { if (cond) pass++; else fails.push(name); };
const section = (s) => console.log(`\n${s}`);

const modes = await loadTs("brainstormModes.ts");
const notebook = await loadTs("RunNotebook.tsx", { stubImports: true });
const panel = readLF(path.join(HERE, "BrainstormPanel.tsx"));
const role = readLF(path.join(REPO, "resources/agents/roles/brainstormer.yaml"));

// ── 1) The mode catalogue ────────────────────────────────────────────────────
section("1) brainstorm modes — the user picks the kind of thinking");
const ids = modes.BRAINSTORM_MODES.map((m) => m.id);
check("auto / product / improvement / research / open are all offered",
  ["auto", "product", "improvement", "research", "open"].every((id) => ids.includes(id)));
check("mode ids are unique", new Set(ids).size === ids.length);
check("auto is the default (unknown + missing id fall back to it)",
  modes.brainstormMode("nope").id === "auto" && modes.brainstormMode(undefined).id === "auto");
check("auto keeps today's behaviour: no directive, the role's STEP 0 decides",
  modes.brainstormMode("auto").directive === "");
check("every non-auto mode carries a directive that fixes the mode",
  modes.BRAINSTORM_MODES.filter((m) => m.id !== "auto")
    .every((m) => /MODE:/.test(m.directive) && /do NOT re-decide/i.test(m.directive)));
check("every mode has a hint, placeholder and opening line",
  modes.BRAINSTORM_MODES.every((m) => m.hint.trim() && m.placeholder.trim() && m.opening.trim()));
check("isBrainstormModeId rejects junk",
  modes.isBrainstormModeId("research") && !modes.isBrainstormModeId("marketing") && !modes.isBrainstormModeId(7));

section("2) only the tracks that search the web ask for a Brave key");
check("improvement never asks for a search key", modes.webResearchNotice(modes.brainstormMode("improvement")) === null);
check("new product requires the key", /required/.test(modes.webResearchNotice(modes.brainstormMode("product")) ?? ""));
check("research requires the key", /required/.test(modes.webResearchNotice(modes.brainstormMode("research")) ?? ""));
check("auto/open only mention it conditionally",
  /only if|only when/i.test(modes.webResearchNotice(modes.brainstormMode("auto")) ?? "")
  && /only if|only when/i.test(modes.webResearchNotice(modes.brainstormMode("open")) ?? ""));
check("research and open are explicitly told NOT to do a competitor scan",
  /no competitor scan|no ICP, no competitor scan/i.test(modes.brainstormMode("research").directive)
  && /no competitor scan/i.test(modes.brainstormMode("open").directive));

// ── 3) Directive ↔ role agreement (the drift guard) ──────────────────────────
section("3) every directive names a TRACK the brainstormer role actually defines");
for (const m of modes.BRAINSTORM_MODES) {
  const track = m.directive.match(/TRACK ([A-Z])/);
  if (!track) continue;
  check(`role defines TRACK ${track[1]} (referenced by mode "${m.id}")`,
    new RegExp(`TRACK ${track[1]} —`).test(role));
}
check("role defines the RESEARCH track", /TRACK C — RESEARCH/.test(role) && /RESEARCH — write exactly this shape/.test(role));
check("role defines the OPEN track", /TRACK D — OPEN/.test(role) && /OPEN — write exactly this shape/.test(role));
check("a mode stated by the UI is final for the role", /that mode is FINAL/.test(role));
check("research briefs must cite their sources", /No source ⇒ it belongs/.test(role));
check("every track still ends in an ordered ## Plan", /Every track ENDS by writing a PLAN/.test(role));

// ── 4) Board works for every mode, not just new-product ──────────────────────
section("4) the board renders a plan when there is no feature table");
const IMPROVEMENT_BRIEF = [
  "# Speed up the project list",
  "## Goal", "It is slow.",
  "## Plan",
  "1. Memoize the row component — ProjectList.tsx — list renders once per keystroke",
  "2. Virtualize the list — ProjectList.tsx — 1000 rows scroll at 60fps",
  "",
  "## Risks & Open Questions",
  "- none",
].join("\n");
const PRODUCT_BRIEF = [
  "# CRM",
  "## Feature Priority",
  "| Feature | C1 | C2 | C3 | C4 | C5 | Priority |",
  "|---------|----|----|----|----|----|----------|",
  "| Contact import | ✓ | ✓ | ✓ | ✓ | ✓ | v1 |",
  "| Inbox triage | ✗ | ✗ | ✗ | ✗ | ✗ | opportunity |",
].join("\n");
check("feature table still parses", modes.parseBriefFeatures(PRODUCT_BRIEF).length === 2);
check("v1 / opportunity priorities preserved",
  modes.parseBriefFeatures(PRODUCT_BRIEF)[0].priority === "v1"
  && modes.parseBriefFeatures(PRODUCT_BRIEF)[1].priority === "opportunity");
check("CRLF brief parses identically", modes.parseBriefFeatures(PRODUCT_BRIEF.replace(/\n/g, "\r\n")).length === 2);
check("an improvement brief has no feature table (this is what emptied the board)",
  modes.parseBriefFeatures(IMPROVEMENT_BRIEF).length === 0);
check("...and its ordered Plan is what the board shows instead",
  notebook.briefImplementationSteps(IMPROVEMENT_BRIEF, { fallback: false }).length === 2);
check("no plan at all → the board shows nothing rather than a placeholder step",
  notebook.briefImplementationSteps("# Title\n\nnothing here", { fallback: false }).length === 0);
check("the Notebook keeps its fallback step (default behaviour unchanged)",
  notebook.briefImplementationSteps("# Title\n\nnothing here").length === 1);
check("panel renders the plan board", panel.includes('data-ui="BrainstormPlanBoard"')
  && panel.includes("briefImplementationSteps(briefText, { fallback: false })"));

// ── 5) Checkpoint cost ───────────────────────────────────────────────────────
section("5) the checkpoint stops storing/rewriting the transcript twice");
const small = [{ text: "hello" }, { text: "world" }];
check("a small transcript is still checkpointed verbatim", modes.checkpointLines(small).length === 2);
const huge = Array.from({ length: 50 }, () => ({ text: "x".repeat(2000) }));
check("past the budget the lines are dropped (history rebuilds them)", modes.checkpointLines(huge).length === 0);
check("panel trims the checkpointed lines", panel.includes("lines: checkpointLines(lines)"));
check("disk writes are rate-limited", panel.includes("DISK_CHECKPOINT_INTERVAL_MS")
  && /if \(!opts\?\.flush && waited < DISK_CHECKPOINT_INTERVAL_MS\)/.test(panel));
check("a throttled write still lands later (trailing flush armed)",
  /diskTimerRef\.current = window\.setTimeout/.test(panel));
check("close/unmount/turn-end force the write",
  (panel.match(/queueCheckpoint\(checkpointRef\.current, \{ flush: true \}\)/g) ?? []).length >= 5);

// ── 6) The remaining live defects ────────────────────────────────────────────
section("6) mode wiring + the defects it sits next to");
check("panel offers the mode picker", panel.includes('data-ui="BrainstormModePicker"')
  && panel.includes('data-ui={`BrainstormMode-${m.id}`}'));
check("the mode locks once the conversation has started",
  panel.includes("const modeLocked = running || convHistory.length > 0"));
check("the chosen mode is injected into the co-founder system prompt",
  panel.includes("activeMode.directive"));
check("the first turn states the mode and uses its opening question",
  panel.includes("...(activeMode.directive ? [\"\", activeMode.directive] : [])")
  && panel.includes("activeMode.opening"));
// The schema version moved to v4 when orientations were added; the invariant
// under test is unchanged — every older checkpoint still loads instead of being
// discarded, and an unknown modeId still falls back to "auto".
check("the mode is persisted with the checkpoint (current version, older versions accepted)",
  panel.includes("modeId: isBrainstormModeId(value.modeId) ? value.modeId : \"auto\"")
  && /!\[1, 2, 3, 4\]\.includes\(value\.v as number\)/.test(panel));
check("the Brave-key line is conditional, not unconditional",
  panel.includes("webResearchNotice(activeMode)")
  && !panel.includes("<span>🔑 Brave Search key required (set in Accounts page)</span>"));
check("applying the FIRST team seeds that project's Notebook from the brief",
  panel.includes("seedNotebookFromBrief(projectId, briefForSeed)"));
check("...and offers to open it", (panel.match(/data-ui="BrainstormOpenNotebook"/g) ?? []).length === 2);
check("a vanished BRIEF.md clears 'done' instead of pointing at a missing file",
  /\} else if \(done\) \{[\s\S]*setDone\(false\)[\s\S]*BRIEF\.md is no longer on disk/.test(panel));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log("PASS brainstorm modes: kind selection, track agreement, board, seeding, checkpoint cost");
