// Verify script (repo pattern — see modelPickerCollapse.verify.run.mjs):
// proves the bridge dispatch path's prompt builders actually inject the
// SKILL block after the fix (dispatch.ts previously hardcoded `undefined`
// for specialists and had no skill param on the orchestrator builder).
//
// Run from ui/:  node src/pages/agentic/dispatchSkillBlock.verify.run.mjs
// (bundles dispatch.ts with esbuild, stubbing the Tauri runtime).

import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const stubPlugin = {
  name: "stub-tauri",
  setup(b) {
    b.onResolve({ filter: /^@tauri-apps\// }, (args) => ({
      path: args.path,
      namespace: "tauri-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "tauri-stub" }, () => ({
      contents: `
        export const invoke = async () => { throw new Error("no tauri in verify"); };
        export class Channel { set onmessage(_) {} }
        export const listen = async () => () => {};
        export default {};
      `,
      loader: "js",
    }));
  },
};

const outDir = mkdtempSync(path.join(tmpdir(), "dispatch-verify-"));
const outFile = path.join(outDir, "dispatch.bundle.mjs");

await build({
  entryPoints: [new URL("./dispatch.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
  plugins: [stubPlugin],
  jsx: "automatic",
  logLevel: "silent",
});

// Browser globals some transitive modules expect at call time.
globalThis.window = globalThis.window ?? globalThis;
globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0, clear: () => {},
};
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "verify" }, configurable: true });
}

const mod = await import(pathToFileURL(outFile).href);
const { buildOrchestratorPrompt, buildSpecialistPrompt } = mod;

const roleByName = new Map([
  ["orchestrator", { id: "orchestrator", name: "orchestrator", systemPrompt: "Plan the work.", defaultTemperature: 0.3, skillAllowlist: [] }],
  ["coder", { id: "coder", name: "coder", systemPrompt: "You are the Coder.", defaultTemperature: 0.2, skillAllowlist: [] }],
]);
const team = {
  id: "t1", display: "Verify Team",
  agents: [
    { name: "orchestrator", base: "orchestrator", description: "plans" },
    { name: "coder", base: "coder", description: "codes" },
  ],
};
const orch = team.agents[0];
const spec = team.agents[1];

const SKILL_MARKER = "--- YOUR SKILLS (capability packs available to you — use them when relevant) ---\n### Skill: verify-skill\nVERIFY_SKILL_BODY_MARKER";

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? (pass++, console.log("ok  ", name)) : (fail++, console.log("FAIL", name)); };

// Orchestrator builder: new trailing skillBlock param is injected verbatim.
const withBlock = buildOrchestratorPrompt(team, roleByName, orch, undefined, false, "", null, SKILL_MARKER);
check("orchestrator prompt contains the skill block", withBlock.includes("VERIFY_SKILL_BODY_MARKER"));
check("orchestrator skill block precedes the roster", withBlock.indexOf("VERIFY_SKILL_BODY_MARKER") < withBlock.indexOf("YOUR SPECIALISTS"));

// Omitting it (old call shape) stays clean — no "undefined", no marker.
const without = buildOrchestratorPrompt(team, roleByName, orch, undefined, false, "", null);
check("orchestrator prompt w/o block has no marker", !without.includes("VERIFY_SKILL_BODY_MARKER"));
check("orchestrator prompt w/o block has no stray 'undefined' line", !/^undefined$/m.test(without));

// Specialist builder: skillBlock param (5th) is injected.
const specWith = buildSpecialistPrompt(team, spec, roleByName, undefined, SKILL_MARKER, null, true);
check("specialist prompt contains the skill block", specWith.includes("VERIFY_SKILL_BODY_MARKER"));

const specWithout = buildSpecialistPrompt(team, spec, roleByName, undefined, undefined, null, true);
check("specialist prompt w/o block has no marker", !specWithout.includes("VERIFY_SKILL_BODY_MARKER"));
check("specialist role prompt still present", specWithout.includes("You are the Coder."));

// Empty/whitespace block is dropped, not injected as blank section.
const specBlank = buildSpecialistPrompt(team, spec, roleByName, undefined, "   ", null, true);
check("whitespace-only block is not injected", !specBlank.includes("--- YOUR SKILLS"));

console.log(fail === 0 ? `\nall ${pass} checks passed` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
