// Runner for codePageTwoAgent.verify.ts.
//
// There is no test runner configured in this repo, and the bundled esbuild
// native binary in node_modules is the Windows build (this tree is developed
// from WSL), so it can't run under Linux. The TypeScript compiler API, by
// contrast, is pure JS and runs anywhere. This script transpiles the self-
// contained verify test and executes its assertions.
//
// Run from the repo:  node owllm-desktop/ui/src/pages/agentic/codePageTwoAgent.verify.run.mjs
// Exits non-zero if any assertion fails.
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));            // …/ui/src/pages/agentic
const REPO = path.resolve(HERE, "../../../..");                        // owllm-desktop
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "codepage2a-verify-"));
const AGENTIC = path.join(ROOT, "ui/src/pages/agentic");
fs.mkdirSync(AGENTIC, { recursive: true });

const code = fs.readFileSync(path.join(HERE, "codePageTwoAgent.verify.ts"), "utf8");
const js = ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
fs.writeFileSync(path.join(AGENTIC, "verify.js"), js);

try {
  createRequire(path.join(AGENTIC, "verify.js"))(path.join(AGENTIC, "verify.js"));
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
