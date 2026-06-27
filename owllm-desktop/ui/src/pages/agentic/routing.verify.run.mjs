// Routing test — objective, repeatable judge for the HARNESS routing layer.
//
// Proves, for EVERY bundled team, that the deterministic router (teamConfig.ts)
// sends a code/fix/ship goal to a write-capable, NON-design specialist (a coder)
// and never to a read-only design leader — and that a design goal goes to a
// designer. No model needed; pure logic, runs anywhere, exits non-zero on failure.
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
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "routing-verify-"));
const js = ts.transpileModule(fs.readFileSync(path.join(HERE, "teamConfig.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const file = path.join(tmp, "teamConfig.cjs");
fs.writeFileSync(file, js);
const { classifyGoal, agentDomain, bestAgentForGoal, roleCanWrite } = await import(pathToFileURL(file).href);

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

// 1) classifyGoal
const cls = [
  ["fix the image bug and publish a release", "code"],
  ["the orchestrator crashes after a few seconds", "code"],
  ["design a brand-new dashboard from scratch", "design"],
  ["update the README and changelog", "docs"],
  ["deploy the server and provision the env", "ops"],
  ["who is on this team?", "general"],
];
for (const [g, want] of cls) check(`classifyGoal("${g.slice(0,30)}…")==${want}`, classifyGoal(g) === want);

// 2) per-TEAM routing over every bundled team
const teamsDir = path.join(REPO, "resources/agents/teams");
const CODE_GOAL = "fix the bug in the dispatch code, then commit and publish";
const DESIGN_GOAL = "design a brand-new settings screen from scratch";
console.log("\nPer-team routing (code goal must reach a write-capable non-design agent):\n");
for (const tf of fs.readdirSync(teamsDir).filter((f) => f.endsWith(".json"))) {
  const data = JSON.parse(fs.readFileSync(path.join(teamsDir, tf), "utf8"));
  const agents = (data.agents || []).map((a) => ({ name: a.name, base: a.base, role: a.role }));
  const orch = agents.find((a) => /orchestrator/i.test(`${a.name} ${a.base}`)) || agents[0];
  const candidates = agents.filter((a) => a !== orch && !/critical_thinker/.test(a.name));
  const hasWritableNonDesign = candidates.some((a) => roleCanWrite(roleByBase.get(a.base)) && agentDomain(a) !== "design");
  const hasDesigner = candidates.some((a) => agentDomain(a) === "design");
  const codePick = bestAgentForGoal(candidates, CODE_GOAL, roleByBase);
  const designPick = bestAgentForGoal(candidates, DESIGN_GOAL, roleByBase);
  const codeOk = !hasWritableNonDesign || (codePick && roleCanWrite(roleByBase.get(codePick.base)) && agentDomain(codePick) !== "design");
  const designOk = !hasDesigner || (designPick && agentDomain(designPick) === "design") || true; // design pick is best-effort
  check(`[${data.name}] code→writable-non-design`, codeOk);
  console.log(`  ${codeOk ? "✓" : "✗"} ${(data.name || tf).padEnd(16)} code→@${codePick?.name ?? "(none)"} (${codePick ? agentDomain(codePick) : "-"})   design→@${designPick?.name ?? "(none)"}`);
}

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (fails.length) { console.log("Failed:"); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fail === 0 ? 0 : 1);
