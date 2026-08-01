// Runner for askUserBubble.verify.ts.
//
// There is no test runner configured in this repo, and the bundled esbuild
// native binary in node_modules is the Windows build (this tree is developed
// from WSL), so it can't run under Linux. The TypeScript compiler API, by
// contrast, is pure JS and runs anywhere. This script transpiles the REAL
// dispatch.ts + the verify test through it, stubs the heavy imports the pure
// helpers under test never call, and runs the assertions.
//
// Run from the repo:  node owllm-desktop/ui/src/pages/agentic/askUserBubble.verify.run.mjs
// Exits non-zero if any assertion fails.
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));            // …/ui/src/pages/agentic
const REPO = path.resolve(HERE, "../../../..");                        // owllm-desktop
// pathToFileURL: on Windows a bare `C:\…` path is not a valid ESM import URL.
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "askuser-verify-"));
const AGENTIC = path.join(ROOT, "ui/src/pages/agentic");
const UTILS = path.join(ROOT, "ui/src/utils");
const ADVANCED = path.join(ROOT, "ui/src/pages/advanced");
fs.mkdirSync(AGENTIC, { recursive: true });
fs.mkdirSync(UTILS, { recursive: true });
fs.mkdirSync(ADVANCED, { recursive: true });

function transpile(file, outDir, outName, sourceDir = HERE) {
  const code = fs.readFileSync(path.join(sourceDir, file), "utf8");
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(path.join(outDir, outName), js);
}
transpile("dispatch.ts", AGENTIC, "dispatch.js");
transpile("askUserBubble.verify.ts", AGENTIC, "verify.js");
// Real (not stubbed): dispatch's model routing calls these peer-id helpers on
// EVERY model id, so a stub would silently change which branch is taken.
transpile("peerCatalogue.ts", AGENTIC, "peerCatalogue.js");
transpile("accountHealth.ts", ADVANCED, "accountHealth.js", path.join(HERE, "../advanced"));

// Heavy imports of dispatch.ts that the pure helpers under test never call.
const STUB = "module.exports = new Proxy({}, { get: () => () => {} });";
for (const m of ["localTools", "toolNormalizer", "modelProfiles", "inferenceEndpoint", "ModelPicker", "teamConfig", "dispatchParse", "teamMemoryFormat", "skillRuntime", "personalAgentRuntime", "agentSandbox", "contextBudget"]) {
  fs.writeFileSync(path.join(AGENTIC, m + ".js"), STUB);
}
fs.writeFileSync(path.join(UTILS, "genStats.js"), STUB);                // ../../utils/genStats
fs.writeFileSync(path.join(ADVANCED, "remoteDevices.js"), STUB);        // peerCatalogue's device channel
const TNM = path.join(ROOT, "node_modules/@tauri-apps/api");            // bare specifier
fs.mkdirSync(TNM, { recursive: true });
fs.writeFileSync(path.join(TNM, "package.json"),
  JSON.stringify({ name: "@tauri-apps/api", version: "0.0.0", exports: { "./core": "./core.js" } }));
fs.writeFileSync(path.join(TNM, "core.js"), "module.exports = { invoke: () => {}, Channel: function () {} };");

try {
  createRequire(path.join(AGENTIC, "verify.js"))(path.join(AGENTIC, "verify.js"));
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
