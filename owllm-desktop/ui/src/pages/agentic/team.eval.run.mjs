// Team behavioral eval — Layer 2 runner.
//
// Layer 1 (routing.verify.run.mjs) judges the deterministic control flow with no
// model. Layer 2 judges an actual RUN: the app records a RunTrace per dispatch
// (who ran, did anyone write, critic verdict, did it terminate, done-gate), and
// scoreRun() grades it against the per-team expectations in teamEvalFixtures.ts.
//
// This runner does three things, in order:
//   1. self-tests the grader (scoreRun) on SYNTHETIC traces — deterministic, CI,
//      proves the judge itself is correct before trusting it on live data;
//   2. validates every fixture references a real team + agent;
//   3. if live traces exist (arg path, or owllm-desktop/.owllm/eval-traces.jsonl),
//      scores each against its fixture and prints a scorecard per team.
//
// Run:  node owllm-desktop/ui/src/pages/agentic/team.eval.run.mjs [traces.jsonl]
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");                    // owllm-desktop
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

// --- transpile the REAL TS modules into one tmp dir so relative requires resolve
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "team-eval-"));
function load(rel) {
  const out = path.join(tmp, rel.replace(/\.ts$/, ".js"));
  const js = ts.transpileModule(fs.readFileSync(path.join(HERE, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(out, js);
  return out;
}
load("teamConfig.ts");                    // required transitively by runTrace
const runTraceJs = load("runTrace.ts");
const fixturesJs = load("teamEvalFixtures.ts");
const { scoreRun, summarizeTrace } = await import(pathToFileURL(runTraceJs).href);
const { TEAM_FIXTURES } = await import(pathToFileURL(fixturesJs).href);

let pass = 0, fail = 0; const fails = [];
const check = (name, cond) => { if (cond) pass++; else { fail++; fails.push(name); } };

// --- 1) self-test the grader on synthetic traces --------------------------
console.log("1) Grader self-test (scoreRun on synthetic traces)");
const baseTrace = (over) => ({
  team: "product_studio", goal: "", goalKind: "code", agents: [], hops: 0,
  routeCorrections: 0, wroteFiles: false, criticVerdict: null, capHit: false,
  oscillationStops: 0, done: true, durationMs: 12000, finalAnswer: "", ts: 0, ...over,
});
const codeFix = TEAM_FIXTURES.find((f) => f.team === "product_studio" && f.expectKind === "code");
const trivial = TEAM_FIXTURES.find((f) => f.team === "product_studio" && f.expectKind === "general");

// a GOOD code run — coder ran, wrote files, finished, critic shipped → all green
const good = scoreRun(baseTrace({
  goal: codeFix.goal, agents: [{ name: "frontend_coder", domain: "coder", runs: 1 }],
  hops: 4, wroteFiles: true, done: true, criticVerdict: "ship",
}), codeFix);
check("good code run → ok", good.ok === true);

// the FAILURE we keep chasing — only the product owner ran, nothing written
const talked = scoreRun(baseTrace({
  goal: codeFix.goal, agents: [{ name: "product_owner", domain: "design", runs: 2 }],
  hops: 2, wroteFiles: false, done: false,
}), codeFix);
check("talk-only code run → NOT ok", talked.ok === false);
check("  …flags wrong agent", talked.checks.find((c) => c.name === "expected-agent-ran")?.pass === false);
check("  …flags no write", talked.checks.find((c) => c.name === "wrote-files")?.pass === false);
check("  …flags done-gate", talked.checks.find((c) => c.name === "done-gate")?.pass === false);

// a runaway run — hit the hop cap → terminated check fails
const runaway = scoreRun(baseTrace({
  goal: codeFix.goal, agents: [{ name: "frontend_coder", domain: "coder", runs: 6 }],
  hops: 40, wroteFiles: true, done: true, capHit: true,
}), codeFix);
check("capped run → terminated check fails", runaway.checks.find((c) => c.name === "terminated")?.pass === false);

// a clean trivial run — no specialist, no writes, fast → green
const triv = scoreRun(baseTrace({
  goal: trivial.goal, goalKind: "general", agents: [], hops: 0, wroteFiles: false, done: true,
}), trivial);
check("trivial run → ok", triv.ok === true);

// --- 2) validate fixtures reference real teams + agents --------------------
console.log("\n2) Fixture validation (every fixture points at a real team/agent)");
const teamsDir = path.join(REPO, "resources/agents/teams");
const teamFiles = fs.readdirSync(teamsDir).filter((f) => f.endsWith(".json"));
const teamByName = new Map();
for (const tf of teamFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(teamsDir, tf), "utf8"));
  teamByName.set(data.name, data);
}
for (const f of TEAM_FIXTURES) {
  const team = teamByName.get(f.team);
  check(`fixture team "${f.team}" exists`, !!team);
  if (team && f.expectAgent) {
    const has = (team.agents || []).some((a) => a.name === f.expectAgent);
    check(`  fixture agent @${f.expectAgent} exists in ${f.team}`, has);
  }
}

// --- 3) score live traces if present --------------------------------------
console.log("\n3) Live-run scorecard");
const argPath = process.argv[2];
const defaultPath = path.join(REPO, ".owllm", "eval-traces.jsonl");
const tracePath = argPath || (fs.existsSync(defaultPath) ? defaultPath : null);
if (!tracePath || !fs.existsSync(tracePath)) {
  console.log("  (no live traces yet — run a team in the app, then re-run with the exported");
  console.log("   eval-traces.jsonl, or it's read automatically from owllm-desktop/.owllm/)");
} else {
  const lines = fs.readFileSync(tracePath, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const traces = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  console.log(`  ${traces.length} trace(s) from ${path.relative(REPO, tracePath)}\n`);
  for (const tr of traces) {
    const exp = TEAM_FIXTURES.find((f) => f.team === tr.team && f.goal.trim() === (tr.goal || "").trim())
      || TEAM_FIXTURES.find((f) => f.team === tr.team);   // fall back to any fixture for that team
    console.log(`  ▸ ${tr.team}: ${summarizeTrace(tr)}`);
    if (!exp) { console.log(`     (no fixture for this team — recorded only)`); continue; }
    const card = scoreRun(tr, exp);
    for (const c of card.checks) console.log(`     ${c.pass ? "✓" : "✗"} ${c.name} — ${c.detail}`);
    check(`live[${tr.team}] "${(tr.goal || "").slice(0, 24)}…"`, card.ok);
  }
}

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (fails.length) { console.log("Failed:"); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fail === 0 ? 0 : 1);
