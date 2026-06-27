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

// --- transpile + load the REAL teamConfig.ts ------------------------------
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "harness-verify-"));
const js = ts.transpileModule(fs.readFileSync(path.join(HERE, "teamConfig.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const file = path.join(tmp, "teamConfig.cjs");
fs.writeFileSync(file, js);
const {
  classifyGoal, agentDomain, bestAgentForGoal, roleCanWrite,
  parseCriticVerdict, criticConcluded, criticIsSatisfied, criticRefused,
  toolRoleIsWrite, goalRequiresWrite, runIsDone, normalizeRunOutput, isNoProgress,
} = await import(pathToFileURL(file).href);

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

// 5) no-progress / oscillation guard
section("5) No-progress guard");
const a1 = normalizeRunOutput("  Here   is\nthe SAME answer.  ");
const a2 = normalizeRunOutput("here is the same answer.");
check("normalizeRunOutput collapses ws+case", a1 === a2);
check("repeat (>40 chars) → no progress", isNoProgress(a1.padEnd(50, "x"), a1.padEnd(50, "x")) === true);
check("first run (prev undefined) → progress", isNoProgress(undefined, a1.padEnd(50, "x")) === false);
check("different output → progress", isNoProgress("aaaa".padEnd(50, "a"), "bbbb".padEnd(50, "b")) === false);
check("short repeat (<40 chars) ignored", isNoProgress("ok", "ok") === false);

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (fails.length) { console.log("Failed:"); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fail === 0 ? 0 : 1);
