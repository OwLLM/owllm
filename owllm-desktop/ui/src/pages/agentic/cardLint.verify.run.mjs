// Harness verifier for the PURE Project Card linter (cardLint.ts) — the rule-based
// backbone of the Steward agent. Proves each incongruence rule fires on a bad card
// and stays silent on a good one, and that "unknown" facts (null) never produce a
// false warning.
//
// No test framework in this repo — transpile the pure .ts module and import it
// standalone (same trick as gate.verify.run.mjs; cardLint.ts has zero runtime
// imports so it loads clean).
//
// Run:  node owllm-desktop/ui/src/pages/agentic/cardLint.verify.run.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));        // …/ui/src/pages/agentic
const REPO = path.resolve(HERE, "../../../..");                    // owllm-desktop
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "cardlint-verify-"));
function load(rel) {
  const out = path.join(tmp, rel.replace(/\.ts$/, ".cjs"));
  const js = ts.transpileModule(fs.readFileSync(path.join(HERE, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}
const { parseProjectCard, lintProjectCard, renderCardFindings } = await load("cardLint.ts");

let pass = 0, fail = 0;
const fails = [];
function check(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }
const section = (s) => console.log(`\n${s}`);
const has = (findings, field, sev) => findings.some(f => f.field === field && (!sev || f.severity === sev));

// 0) parse
section("0) parseProjectCard");
check("blank/malformed → null", parseProjectCard("") === null && parseProjectCard("{nope") === null);
check("object → parsed", parseProjectCard('{"name":"X"}').name === "X");

// 1) absent card → a single info nudge (not an error).
section("1) absent card");
const none = lintProjectCard(null, {});
check("one finding", none.length === 1);
check("it is info, field (card)", none[0].severity === "info" && none[0].field === "(card)");

// 2) a fully congruent card with facts → NO findings.
section("2) congruent card → clean");
const GOOD = {
  name: "X", goal: "Build the thing and publish it.", mode: "team",
  verify: { command: "npm run build", lanes: { backend: "cargo check" } },
  release: { versionFile: "src-tauri/tauri.conf.json", stagePath: "app", command: "publish.sh" },
};
const goodFindings = lintProjectCard(GOOD, {
  versionFileExists: true, stagePathExists: true,
  hasPackageJson: true, hasCargo: true, remoteIsPublic: false,
});
check("no findings on a congruent card", goodFindings.length === 0);
check("renderCardFindings says congruent", renderCardFindings(goodFindings).includes("congruent"));

// 3) release: missing/nonexistent versionFile, missing stagePath, empty command.
section("3) release incongruences");
check("versionFile missing → error", has(lintProjectCard({ release: { command: "x" } }, {}), "release.versionFile", "error"));
check("versionFile path doesn't exist → error",
  has(lintProjectCard({ release: { versionFile: "nope.json", command: "x" } }, { versionFileExists: false }), "release.versionFile", "error"));
check("versionFile unknown existence (null) → NO error",
  !has(lintProjectCard({ release: { versionFile: "x.json", command: "x" } }, { versionFileExists: null }), "release.versionFile"));
check("stagePath doesn't exist → error",
  has(lintProjectCard({ release: { versionFile: "x.json", stagePath: "ghost", command: "x" } }, { versionFileExists: true, stagePathExists: false }), "release.stagePath", "error"));
check("empty release.command → warn",
  has(lintProjectCard({ release: { versionFile: "x.json", command: "" } }, { versionFileExists: true }), "release.command", "warn"));

// 4) publish intent but no release config → warn.
section("4) publish goal, no release config");
check("goal 'ship it' + no release → warn on `release`",
  has(lintProjectCard({ goal: "Just ship it to users." }, {}), "release", "warn"));
check("no publish intent + no release → no release warning",
  !has(lintProjectCard({ goal: "A local note-taking tool.", verify: { command: "npm test" } }, {}), "release"));

// 5) verify section issues + toolchain mismatch (only when fact === false).
section("5) verify incongruences");
check("no verify section → info",
  has(lintProjectCard({ goal: "x", release: { versionFile: "x", command: "y" } }, { versionFileExists: true }), "verify", "info"));
check("empty verify section → warn",
  has(lintProjectCard({ verify: { lanes: {} } }, {}), "verify", "warn"));
check("npm verify but NO package.json (fact false) → warn",
  has(lintProjectCard({ verify: { command: "npm run build" } }, { hasPackageJson: false }), "verify.command", "warn"));
check("npm verify but package.json existence UNKNOWN (null) → NO warn",
  !has(lintProjectCard({ verify: { command: "npm run build" } }, { hasPackageJson: null }), "verify.command"));
check("cargo verify but NO Cargo.toml → warn",
  has(lintProjectCard({ verify: { command: "cargo check" } }, { hasCargo: false }), "verify.command", "warn"));
check("npm verify WITH package.json → no toolchain warn",
  !lintProjectCard({ verify: { command: "npm run build" } }, { hasPackageJson: true }).some(f => f.field === "verify.command"));

// 6) mode validation.
section("6) mode");
check("bogus mode → warn", has(lintProjectCard({ mode: "turbo", verify: { command: "x" } }, {}), "mode", "warn"));
check("mode 'solo' ok", !has(lintProjectCard({ mode: "solo", verify: { command: "x" } }, {}), "mode"));

// 7) THE #1 rule: card says PRIVATE but remote is public → error.
section("7) private-source-vs-public-remote (the #1 standing rule)");
check("private goal + public remote → ERROR on goal",
  has(lintProjectCard({ goal: "Source stays PRIVATE.", verify: { command: "x" } }, { remoteIsPublic: true }), "goal", "error"));
check("private goal + private remote → no error",
  !has(lintProjectCard({ goal: "Source stays PRIVATE.", verify: { command: "x" } }, { remoteIsPublic: false }), "goal"));
check("private goal + UNKNOWN remote (null) → no error (never a guess)",
  !has(lintProjectCard({ goal: "Source stays PRIVATE.", verify: { command: "x" } }, { remoteIsPublic: null }), "goal"));

// 8) ordering: error before warn before info.
section("8) findings ordered error → warn → info");
const mixed = lintProjectCard({ goal: "ship it", release: { command: "x" } }, {});  // versionFile error + (maybe) verify info
const ranks = mixed.map(f => ({ error: 0, warn: 1, info: 2 }[f.severity]));
check("severities are non-decreasing", ranks.every((r, i) => i === 0 || r >= ranks[i - 1]));

// 9) OwLLM's own card lints clean against a faithful fact set.
section("9) OwLLM's own card is congruent");
const ownText = fs.readFileSync(path.resolve(REPO, "..", ".owllm/project.json"), "utf8");
const own = parseProjectCard(ownText);
check("own card parses", !!own);
const ownFindings = lintProjectCard(own, {
  versionFileExists: true,   // owllm-desktop/src-tauri/tauri.conf.json exists
  stagePathExists: true,     // owllm-desktop/ exists
  // verify commands cd into subdirs → runner leaves toolchain facts null (skip)
  hasPackageJson: null, hasCargo: null,
  remoteIsPublic: false,     // origin is the PRIVATE source repo
});
check("OwLLM card → no error/warn findings", !ownFindings.some(f => f.severity !== "info"));
if (ownFindings.length) console.log("   (own card notes:\n" + renderCardFindings(ownFindings).split("\n").map(l => "    " + l).join("\n") + "\n   )");

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (fails.length) { console.log("Failed:"); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fail === 0 ? 0 : 1);
