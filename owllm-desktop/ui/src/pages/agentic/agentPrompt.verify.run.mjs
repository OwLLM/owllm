// Harness verifier for the structured per-agent prompt helpers
// (parseAgentPrompt / serializeAgentPrompt). Proves the parse↔serialize bridge
// between the four-section editor and the single stored `extra_prompt` string
// is lossless where it must be: legacy freeform round-trips byte-for-byte, a
// user's own `##` line survives untouched, and parse(serialize(x)) is stable.
//
// No test framework in this repo — transpile the pure .ts module and import it
// standalone (same trick as routing.verify.run.mjs; agentPrompt.ts has zero
// runtime imports so it loads clean).
//
// Run:  node owllm-desktop/ui/src/pages/agentic/agentPrompt.verify.run.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));        // …/ui/src/pages/agentic
const REPO = path.resolve(HERE, "../../../..");                    // owllm-desktop
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "agentprompt-verify-"));
function load(rel) {
  const out = path.join(tmp, rel.replace(/\.ts$/, ".cjs"));
  const js = ts.transpileModule(fs.readFileSync(path.join(HERE, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}
const { parseAgentPrompt, serializeAgentPrompt } = await load("agentPrompt.ts");

let pass = 0, fail = 0;
const fails = [];
function check(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }
const section = (s) => console.log(`\n${s}`);

// 1) Legacy freeform → General → serialize is byte-identical (back-compat).
section("1) Legacy freeform round-trips byte-for-byte");
const LEGACY = "You are the Coder.\nMake precise, minimal changes.\nAlways verify before saying done.";
const legacyParsed = parseAgentPrompt(LEGACY);
check("freeform lands entirely in General", legacyParsed.general === LEGACY);
check("Mission/Rules/DoD empty", legacyParsed.mission === "" && legacyParsed.rules === "" && legacyParsed.dod === "");
check("serialize(parse(legacy)) === legacy (byte-identical, no heading added)", serializeAgentPrompt(legacyParsed) === LEGACY);

// 2) A user's own `## My own note` inside Rules survives parse→serialize.
section("2) Unknown `##` line stays literal inside its section");
const WITH_NOTE = {
  general: "",
  mission: "Ship the feature.",
  rules: "Be terse.\n## My own note\nDon't refactor unrelated code.",
  dod: "",
};
const noteRoundTrip = serializeAgentPrompt(parseAgentPrompt(serializeAgentPrompt(WITH_NOTE)));
check("`## My own note` preserved as literal text in Rules", noteRoundTrip.includes("## My own note\nDon't refactor unrelated code."));
check("the note did NOT become a section boundary", parseAgentPrompt(serializeAgentPrompt(WITH_NOTE)).rules === WITH_NOTE.rules);

// 3) parse(serialize(x)) idempotent for a multi-section value.
section("3) parse∘serialize is idempotent (multi-section)");
const MULTI = {
  general: "Augment the base role.",
  mission: "Own the UI layer end-to-end.",
  rules: "Edit only ui/.\nNever touch src-tauri/.",
  dod: "npm run build is green.",
};
const s1 = serializeAgentPrompt(MULTI);
const p1 = parseAgentPrompt(s1);
const s2 = serializeAgentPrompt(p1);
check("parse(serialize(x)) === x", JSON.stringify(p1) === JSON.stringify(MULTI));
check("serialize is stable (s1 === s2)", s1 === s2);

// 4) Heading recognition rules.
section("4) Heading recognition (exact + case-insensitive, order-canonical)");
check("case-insensitive headings split", parseAgentPrompt("## mission\nm\n## RULES\nr").mission === "m");
check("...and Rules picked up too", parseAgentPrompt("## mission\nm\n## RULES\nr").rules === "r");
check("text before first heading → General", parseAgentPrompt("preamble\n## Mission\nm").general === "preamble");
check("empty input → all empty", JSON.stringify(parseAgentPrompt("")) === JSON.stringify({ general: "", mission: "", rules: "", dod: "" }));
check("all-empty serialize → ''", serializeAgentPrompt({ general: "", mission: "", rules: "", dod: "" }) === "");
// canonical order: General first regardless of input order
const reordered = serializeAgentPrompt({ general: "g", mission: "m", rules: "", dod: "d" });
check("serialize emits General→Mission→DoD in order, skips empty Rules",
  reordered === "## General\ng\n\n## Mission\nm\n\n## Definition of Done\nd");

// Sample with all 4 sections filled — reported in the handoff.
const SAMPLE = serializeAgentPrompt({
  general: "Augment the base coder role.",
  mission: "Own the UI layer end-to-end against the locked contract.",
  rules: "Edit only ui/. Never touch src-tauri/. Smallest change that works.",
  dod: "npm run build is green and the four states render.",
});
console.log("\n--- SAMPLE extra_prompt (all 4 sections) ---\n" + SAMPLE + "\n--- end sample ---");

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (fails.length) { console.log("Failed:"); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fail === 0 ? 0 : 1);
