// Harness verifier for the Verification Gate's PURE decision logic (gate.ts),
// focused on the Project Card path added in the slice-2 portability work:
// the card's `verify` section is a first-class place to declare the check, with
// the dedicated verify.json winning when both exist, and auto-detect last.
//
// No test framework in this repo — transpile the pure .ts module and import it
// standalone (same trick as agentPrompt.verify.run.mjs; gate.ts has zero runtime
// imports so it loads clean).
//
// Run:  node owllm-desktop/ui/src/pages/agentic/gate.verify.run.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));        // …/ui/src/pages/agentic
const REPO = path.resolve(HERE, "../../../..");                    // owllm-desktop
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "gate-verify-"));
function load(rel) {
  const out = path.join(tmp, rel.replace(/\.ts$/, ".cjs"));
  const js = ts.transpileModule(fs.readFileSync(path.join(HERE, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}
const {
  parseCardVerify, parseVerifyConfig, pickGateCommand,
  classifyGateStatus, detectVerifyCommand,
} = await load("gate.ts");

let pass = 0, fail = 0;
const fails = [];
function check(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }
const section = (s) => console.log(`\n${s}`);

// 1) parseCardVerify — extracts the `verify` section, same {command,lanes} shape.
section("1) parseCardVerify reads the card's verify section");
const CARD = JSON.stringify({
  name: "X",
  release: { command: "publish.sh" },
  verify: { command: "npm run build", lanes: { backend: "cargo check" } },
});
check("absent/blank card → null", parseCardVerify("") === null && parseCardVerify(null) === null && parseCardVerify(undefined) === null);
check("malformed JSON → null (not a throw)", parseCardVerify("{not json") === null);
check("card without a verify section → null", parseCardVerify(JSON.stringify({ name: "X" })) === null);
const cv = parseCardVerify(CARD);
check("card verify parsed → object", cv && typeof cv === "object");
check("card top-level command read", cv.command === "npm run build");
check("card lane read", cv.lanes && cv.lanes.backend === "cargo check");

// 2) pickGateCommand over a card verify — lane wins, else top-level command.
section("2) pickGateCommand against the card verify (lane > command > '')");
check("backend lane wins for backend scope", pickGateCommand(cv, "backend") === "cargo check");
check("frontend falls back to top-level command", pickGateCommand(cv, "frontend") === "npm run build");
check("full falls back to top-level command", pickGateCommand(cv, "full") === "npm run build");
check("null cfg → '' (unverified, never a guess)", pickGateCommand(null, "full") === "");

// 3) Precedence model: verify.json wins over the card when BOTH exist.
//    (Mirror of runGate's order: try verify.json first; only consult the card
//     when that produced no command for the scope.)
section("3) precedence — dedicated verify.json wins over the card");
function resolve(verifyJsonText, cardText, scope) {
  let cmd = pickGateCommand(parseVerifyConfig(verifyJsonText), scope);
  if (!cmd) cmd = pickGateCommand(parseCardVerify(cardText), scope);
  return cmd;
}
check("verify.json present → its command wins, card ignored",
  resolve(JSON.stringify({ command: "make check" }), CARD, "full") === "make check");
check("no verify.json → card command used",
  resolve("", CARD, "full") === "npm run build");
check("no verify.json → card lane used for its scope",
  resolve("", CARD, "backend") === "cargo check");
check("neither → '' (then runGate would auto-detect)",
  resolve("", JSON.stringify({ name: "X" }), "full") === "");

// 4) classifyGateStatus unchanged — exit code decides, no command → unverified.
section("4) classifyGateStatus still grounds 'done' in the exit code");
check("no command → unverified", classifyGateStatus(false, undefined) === "unverified");
check("exit 0 → passed", classifyGateStatus(true, 0) === "passed");
check("exit !=0 → failed (never collapsed to 'not passed')", classifyGateStatus(true, 1) === "failed");

// 5) auto-detect is the final fallback (unchanged), and the OwLLM card's own
//    verify command is the no-tsc vite build (passes despite baseline tsc errors).
section("5) auto-detect fallback + OwLLM card sanity");
check("npm build script → 'npm run build'", detectVerifyCommand({ packageJson: JSON.stringify({ scripts: { build: "vite build" } }) }) === "npm run build");
check("cargo only → 'cargo check'", detectVerifyCommand({ hasCargo: true }) === "cargo check");
check("nothing → '' (honest unverified)", detectVerifyCommand({}) === "");
const ownCard = fs.readFileSync(path.resolve(REPO, "..", ".owllm/project.json"), "utf8");
const own = parseCardVerify(ownCard);
check("OwLLM card has a verify section", own && typeof own === "object");
check("OwLLM verify command is the no-tsc vite build (passes)", /npm run build/.test(own.command || ""));
check("OwLLM backend lane is cargo check", /cargo check/.test((own.lanes && own.lanes.backend) || ""));

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (fails.length) { console.log("Failed:"); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fail === 0 ? 0 : 1);
