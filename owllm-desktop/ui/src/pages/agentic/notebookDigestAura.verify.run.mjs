// Regression gate for the Notebook working-notes digestion aura.
// Run from owllm-desktop/: node ui/src/pages/agentic/notebookDigestAura.verify.run.mjs
// The state checks deliberately exercise the pure helper so active, completed,
// and interrupted digestion remain distinguishable without a browser race.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const req = createRequire(path.join(REPO, "package.json"));
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const source = fs.readFileSync(path.join(HERE, "RunNotebook.tsx"), "utf8").replace(/\r\n/g, "\n");
const auraSource = fs.readFileSync(path.join(HERE, "notebookDigestAura.ts"), "utf8").replace(/\r\n/g, "\n");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-digest-aura-"));
const compiled = ts.transpileModule(auraSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
fs.writeFileSync(path.join(tmp, "notebookDigestAura.js"), compiled);
const aura = req(path.join(tmp, "notebookDigestAura.js"));

let failures = 0;
function check(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures++;
}

check("RunNotebook imports the shared reduced-motion policy", /continuousUiAnimation/.test(source));
check("working notes expose the digestion state", /data-ui="NotebookWorkingNotes"/.test(source) && /data-digest-state=\{digestVisualState\}/.test(source));
check("active digestion owns the aura", /notebookDigestCardStyle\(digestBusy, NOTEBOOK_DIGEST_AURA_ANIMATION\)/.test(source));
check("the aura animation is stopped in reduced motion", /continuousUiAnimation\("owllm-aura-spin 4s linear infinite"\)/.test(source));
check("the digest lifecycle always clears the active state", /finally\s*\{\s*setDigestBusy\(false\);\s*\}/.test(source));
check("the ring uses the established psychedelic stops", aura.NOTEBOOK_DIGEST_AURA_STOPS.split(", ").length === 7 && aura.NOTEBOOK_DIGEST_AURA_RING.includes("conic-gradient"));
check("active state is observable", aura.notebookDigestVisualState(true, "", false) === "active");
check("completed state is observable", aura.notebookDigestVisualState(false, "", true) === "completed");
check("interrupted state is observable", aura.notebookDigestVisualState(false, "provider stopped", true) === "interrupted");

const active = aura.notebookDigestCardStyle(true, "owllm-aura-spin 4s linear infinite");
check("active style paints a psychedelic ring", active.background.includes("conic-gradient") && active.background.includes("var(--bg-card)"));
check("active style uses a subtle halo", /rgba\([^)]*,\.20\)/.test(active.boxShadow) && /rgba\([^)]*,\.12\)/.test(active.boxShadow));
check("active style animates when motion is allowed", active.animation === "owllm-aura-spin 4s linear infinite");

const reduced = aura.notebookDigestCardStyle(true, undefined);
check("reduced motion keeps the static aura", reduced.background.includes("conic-gradient") && reduced.boxShadow && reduced.animation === undefined);

const inactive = aura.notebookDigestCardStyle(false, "owllm-aura-spin 4s linear infinite");
check("completed/interrupted styles have no aura animation or glow", inactive.animation === undefined && inactive.boxShadow === undefined && inactive.background === "var(--bg-card)");
check("working-note content stays on an opaque readable fill", aura.NOTEBOOK_DIGEST_AURA_FILL.includes("var(--bg-card)"));

console.log(failures === 0 ? "\nAll Notebook digestion aura checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
