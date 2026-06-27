// Harness verifier — the objective, repeatable judge for the agentic CONTROL
// FLOW. It proves the deterministic decisions the dispatch loop makes (routing,
// task classification, critic verdict, the done-gate, the no-progress guard) are
// correct, for EVERY bundled team where relevant. No model needed; pure logic,
// runs anywhere in seconds, exits non-zero on failure.
//
// This is "Layer 1": it judges the plumbing, not the agents' answers. (Layer 2 —
// the behavioral eval over live runs — is team.eval.run.mjs.)
//
// Run:  node owllm-desktop/ui/src/pages/agentic/routing.verify.run.mjs
//
// teamConfig.ts only TYPE-imports from dispatch.ts (erased at runtime), so we can
// transpile + require it standalone via the TypeScript compiler API (pure JS) —
// same trick as askUserBubble.verify.run.mjs (no test framework in this repo).
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));        // …/ui/src/pages/agentic
const REPO = path.resolve(HERE, "../../../..");                    // owllm-desktop
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

// --- transpile + load the REAL pure modules -------------------------------
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "harness-verify-"));
function load(rel) {
  const out = path.join(tmp, rel.replace(/\.ts$/, ".cjs"));
  const js = ts.transpileModule(fs.readFileSync(path.join(HERE, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}
const {
  classifyGoal, agentDomain, bestAgentForGoal, roleCanWrite,
  parseCriticVerdict, criticConcluded, criticIsSatisfied, criticRefused,
  toolRoleIsWrite, goalRequiresWrite, runIsDone, runDelivered, normalizeRunOutput, isNoProgress,
} = await load("teamConfig.ts");
const { parseDispatchesDetailed, parseDispatches, stripDispatchDirectives } = await load("dispatchParse.ts");
const { formatWorkLogEntry, renderRelevantWork, enrichInstructionWithMemory, oneLine } = await load("teamMemoryFormat.ts");

// --- role tool_allowlists (so roleCanWrite matches the app) ---------------
function parseToolAllowlist(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const i = lines.findIndex((l) => /^tool_allowlist:/.test(l));
  if (i < 0) return undefined;
  const inline = lines[i].slice("tool_allowlist:".length).trim();
  if (inline && inline !== "|" && inline !== ">") return [inline.replace(/^["']|["']$/g, "")]; // e.g. "all"
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const m = /^\s*-\s*(.+?)\s*$/.exec(lines[j]);
    if (m) { out.push(m[1].replace(/^["']|["']$/g, "")); continue; }
    if (/^\S/.test(lines[j])) break; // next top-level key
  }
  return out.length ? out : undefined;
}
const rolesDir = path.join(REPO, "resources/agents/roles");
const roleByBase = new Map();
for (const f of fs.readdirSync(rolesDir).filter((f) => f.endsWith(".yaml"))) {
  const base = f.replace(/\.yaml$/, "");
  const txt = fs.readFileSync(path.join(rolesDir, f), "utf8");
  roleByBase.set(base, { toolAllowlist: parseToolAllowlist(txt), canDispatch: /^can_dispatch:\s*true/m.test(txt) });
}

// --- assertions -----------------------------------------------------------
let pass = 0, fail = 0;
const fails = [];
function check(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }
const section = (s) => console.log(`\n${s}`);

// 1) classifyGoal — the table that routing, the done-gate and effort all key off.
section("1) classifyGoal");
const cls = [
  // code: change/fix/ship existing code (stems must catch inflections)
  ["fix the image bug and publish a release", "code"],
  ["the orchestrator crashes after a few seconds", "code"],   // crashes (was missed)
  ["the build failed and tests are broken", "code"],          // failed / broken
  ["refactor the dispatch module", "code"],
  ["commit and push the changes", "code"],
  ["tag and release v0.7.0", "code"],
  // design: make something NEW
  ["design a brand-new dashboard from scratch", "design"],
  ["wireframe a new settings screen", "design"],
  ["write a whitepaper for the product", "design"],
  // docs: changelog must NOT read as code ("chang" stem)
  ["update the README and changelog", "docs"],               // changelog (was code)
  ["write documentation for the API", "docs"],
  // ops
  ["deploy the server and provision the env", "ops"],
  ["set up the sandbox", "ops"],
  // general
  ["who is on this team?", "general"],
  ["summarize what this team does", "general"],
];
for (const [g, want] of cls) check(`classifyGoal("${g.slice(0, 28)}…")==${want} (got ${classifyGoal(g)})`, classifyGoal(g) === want);

// 2) per-TEAM routing over every bundled team
section("2) Per-team routing (code goal must reach a write-capable non-design agent)");
const teamsDir = path.join(REPO, "resources/agents/teams");
const CODE_GOAL = "fix the bug in the dispatch code, then commit and publish";
const DESIGN_GOAL = "design a brand-new settings screen from scratch";
for (const tf of fs.readdirSync(teamsDir).filter((f) => f.endsWith(".json"))) {
  const data = JSON.parse(fs.readFileSync(path.join(teamsDir, tf), "utf8"));
  const agents = (data.agents || []).map((a) => ({ name: a.name, base: a.base, role: a.role }));
  const orch = agents.find((a) => /orchestrator/i.test(`${a.name} ${a.base}`)) || agents[0];
  const candidates = agents.filter((a) => a !== orch && !/critical_thinker/.test(a.name));
  const hasWritableNonDesign = candidates.some((a) => roleCanWrite(roleByBase.get(a.base)) && agentDomain(a) !== "design");
  const codePick = bestAgentForGoal(candidates, CODE_GOAL, roleByBase);
  const designPick = bestAgentForGoal(candidates, DESIGN_GOAL, roleByBase);
  const codeOk = !hasWritableNonDesign || (codePick && roleCanWrite(roleByBase.get(codePick.base)) && agentDomain(codePick) !== "design");
  check(`[${data.name}] code→writable-non-design`, codeOk);
  console.log(`  ${codeOk ? "✓" : "✗"} ${(data.name || tf).padEnd(16)} code→@${codePick?.name ?? "(none)"} (${codePick ? agentDomain(codePick) : "-"})   design→@${designPick?.name ?? "(none)"}`);
}

// 3) critic verdict — the loop must terminate on the STRUCTURED line, and only
//    fall back to prose when there is no verdict (the "concern about X but Y is
//    broken" bug: a CONCERN verdict must NOT read as approval).
section("3) Critic verdict / loop-termination");
check("VERDICT: SHIP → concluded", criticConcluded("Looks risky.\nVERDICT: SHIP") === true);
check("VERDICT: CONCERN → NOT concluded", criticConcluded("All good, lgtm!\nVERDICT: CONCERN — race condition") === false);
check("CONCERN beats prose 'no concerns'", parseCriticVerdict("no concerns about auth\nVERDICT: CONCERN — Y broken") === "concern");
check("no verdict + satisfied prose → concluded", criticConcluded("Looks good, ready to ship.") === true);
check("no verdict + refusal → concluded (deferred, not vetoed)", criticConcluded("I cannot help with this abliteration task.") === true);
check("no verdict + substantive critique → NOT concluded", criticConcluded("You should also handle the empty-input case.") === false);
check("criticIsSatisfied lgtm", criticIsSatisfied("lgtm") === true);
check("criticRefused 'I won't'", criticRefused("I won't generate that dataset.") === true);

// 4) done-gate — a code/ops goal with zero write tools is NOT done; design/docs/
//    general are done regardless (they don't have to mutate the world).
section("4) Done-gate");
check("toolRoleIsWrite(🛠 Edit)", toolRoleIsWrite("🛠 Edit") === true);
check("toolRoleIsWrite(🛠 Bash)", toolRoleIsWrite("🛠 Bash") === true);
check("toolRoleIsWrite(🛠 read_file)==false", toolRoleIsWrite("🛠 read_file") === false);
check("toolRoleIsWrite(💬 Edit)==false (not a tool)", toolRoleIsWrite("💬 Edit") === false);
check("goalRequiresWrite(code)", goalRequiresWrite("fix the crash and commit") === true);
check("goalRequiresWrite(design)==false", goalRequiresWrite("design a new screen from scratch") === false);
check("code goal + no write → NOT done", runIsDone("fix the crash and commit", false) === false);
check("code goal + wrote → done", runIsDone("fix the crash and commit", true) === true);
check("design goal + no write → done", runIsDone("design a new screen from scratch", false) === true);
check("general goal + no write → done", runIsDone("who is on this team?", false) === true);
// runDelivered also accounts for WHO ran — the real bug: a UI task phrased with
// no code verb classifies as "general", but if a coder ran and wrote nothing it
// did NOT deliver. (This is the run that wrongly reported "✓ done".)
const UI_GOAL = "in the studio page put the built-in agents in order, purple container";
check("UI goal classifies general (no code verb)", classifyGoal(UI_GOAL) === "general");
check("…general + coder ran + no write → NOT delivered", runDelivered(UI_GOAL, false, ["coder"]) === false);
check("…general + coder ran + wrote → delivered", runDelivered(UI_GOAL, true, ["coder"]) === true);
check("general + only design ran + no write → delivered", runDelivered(UI_GOAL, false, ["design"]) === true);
check("general + nobody ran + no write → delivered", runDelivered("who is on this team?", false, []) === true);
check("code goal + no write → NOT delivered (regardless of who)", runDelivered("fix the crash and commit", false, []) === false);

// 5) no-progress / oscillation guard
section("5) No-progress guard");
const a1 = normalizeRunOutput("  Here   is\nthe SAME answer.  ");
const a2 = normalizeRunOutput("here is the same answer.");
check("normalizeRunOutput collapses ws+case", a1 === a2);
check("repeat (>40 chars) → no progress", isNoProgress(a1.padEnd(50, "x"), a1.padEnd(50, "x")) === true);
check("first run (prev undefined) → progress", isNoProgress(undefined, a1.padEnd(50, "x")) === false);
check("different output → progress", isNoProgress("aaaa".padEnd(50, "a"), "bbbb".padEnd(50, "b")) === false);
check("short repeat (<40 chars) ignored", isNoProgress("ok", "ok") === false);

// 6) dispatch parser — the bug that broke the "easy task": a MULTI-LINE @agent
//    instruction (header + numbered change list) must reach the specialist
//    WHOLE. The old single-line `(.+)$` capture delivered only the header.
section("6) Dispatch parser (multi-line instruction must survive)");
const TEAM = { agents: [{ name: "frontend_coder" }, { name: "backend_coder" }, { name: "orchestrator" }] };
const multiLine = [
  "Proceeding to dispatch.",
  "",
  "@frontend_coder: In StudioPage.tsx, make these changes to the Curated section only:",
  "",
  "1. Sort built-in agents by level (orchestrator, then leaders, then others).",
  "2. Wrap the curated grid in a purple container.",
  "",
  "Report the diff and the tsc result.",
].join("\n");
const p1 = parseDispatchesDetailed(multiLine, TEAM, "orchestrator");
check("one dispatch parsed", p1.dispatches.length === 1);
check("instruction includes the numbered change list (was DROPPED before)", /1\. Sort built-in agents/.test(p1.dispatches[0]?.instruction || "") && /2\. Wrap the curated grid/.test(p1.dispatches[0]?.instruction || ""));
check("instruction is multi-line, not a truncated header", (p1.dispatches[0]?.instruction || "").split("\n").length >= 3);

// two dispatches: each owns its own block, no bleed
const twoBlocks = [
  "@frontend_coder: do the UI part:",
  "- add the container",
  "@backend_coder: do the API part:",
  "- add the endpoint",
].join("\n");
const p2 = parseDispatchesDetailed(twoBlocks, TEAM, "orchestrator");
check("two dispatches parsed", p2.dispatches.length === 2);
check("first block stops at next directive", /add the container/.test(p2.dispatches[0].instruction) && !/endpoint/.test(p2.dispatches[0].instruction));
check("second block owns its lines", /add the endpoint/.test(p2.dispatches[1].instruction));

// single-line still works; fuzzy name resolves; unknown reported
const p3 = parseDispatchesDetailed("@frontend_codr: quick fix", TEAM, "orchestrator");
check("single-line + fuzzy name still resolves", p3.dispatches[0]?.agentName === "frontend_coder");
const p4 = parseDispatchesDetailed("@nobody: do a thing", TEAM, "orchestrator");
check("unknown agent → unresolved, not silently dropped", p4.unresolved.length === 1 && p4.dispatches.length === 0);
// stripDispatchDirectives hides the whole instruction block from the clean reply
check("stripDispatchDirectives keeps preamble, drops the block", stripDispatchDirectives(multiLine).trim() === "Proceeding to dispatch.");

// 7) shared work-state (RAG) — auto-captured work is keyword-rich + synchronized
//    into the next agent's task by RELEVANCE, not recency.
section("7) Team work-state (RAG sync)");
const wl = formatWorkLogEntry("backend_coder", "add the /login endpoint with JWT", "Implemented POST /login in auth.py, returns a JWT; added tests.");
check("worklog carries the agent + task + outcome keywords", /@backend_coder/.test(wl) && /login/.test(wl) && /JWT/i.test(wl) && /auth\.py/.test(wl));
check("oneLine collapses whitespace/newlines", oneLine("a\n  b   c") === "a b c");
const relBlock = renderRelevantWork([
  { content: "@backend_coder — TASK: add /login endpoint. DID: POST /login in auth.py returns JWT.", author: "backend_coder", tags: "worklog" },
]);
check("relevant-work block has a sync header", /RELEVANT TEAM WORK/.test(relBlock) && /auth\.py/.test(relBlock));
check("empty entries → empty block", renderRelevantWork([]) === "");
const enriched = enrichInstructionWithMemory(relBlock, "wire the frontend login form to the API");
check("enriched instruction fences the task after the memory", enriched.includes("--- YOUR TASK ---") && enriched.endsWith("wire the frontend login form to the API") && enriched.startsWith("RELEVANT TEAM WORK"));
check("no memory → instruction unchanged", enrichInstructionWithMemory("", "just do X") === "just do X");

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (fails.length) { console.log("Failed:"); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fail === 0 ? 0 : 1);
