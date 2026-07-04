// Harness verifier for the deterministic brief/attachment preflight (briefPreflight.ts).
// Centres on the real failure: a goal referencing C:\Users\mc\Downloads\BRIEF.md while
// the project root is /mnt/c/1_Git/LocaLLM — that path must be found AND judged
// out-of-root, so the run can stop in seconds instead of churning 23 minutes.
//
// Run:  node owllm-desktop/ui/src/pages/agentic/briefPreflight.verify.run.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "briefpre-"));
function load(rel) {
  const out = path.join(tmp, rel.replace(/\.ts$/, ".cjs"));
  const js = ts.transpileModule(fs.readFileSync(path.join(HERE, rel), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  fs.writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}
const { extractAbsPaths, canonPath, isInsideRoot, suggestInRoot } = await load("briefPreflight.ts");

let pass = 0, fail = 0; const fails = [];
const check = (n, c) => { if (c) pass++; else { fail++; fails.push(n); } };
const section = s => console.log(`\n${s}`);

// 1) extractAbsPaths — find referenced files across formats.
section("1) extractAbsPaths finds referenced file paths");
check("Windows path", extractAbsPaths("implement C:\\Users\\mc\\Downloads\\BRIEF.md A-to-Z").includes("C:\\Users\\mc\\Downloads\\BRIEF.md"));
check("WSL path", extractAbsPaths("read /mnt/c/Users/mc/Downloads/BRIEF.md").includes("/mnt/c/Users/mc/Downloads/BRIEF.md"));
check("git-bash path", extractAbsPaths("see /c/tmp/spec.txt please").includes("/c/tmp/spec.txt"));
check("trailing punctuation trimmed", extractAbsPaths("build C:\\a\\b.md.").includes("C:\\a\\b.md"));
check("no false path in plain prose", extractAbsPaths("make the button bigger and ship it").length === 0);
check("directory (no extension) ignored", extractAbsPaths("look in C:\\Users\\mc\\Downloads").length === 0);
check("dedup", extractAbsPaths("C:\\a\\b.md and again C:\\a\\b.md").length === 1);
check("https URL is NOT a path (the 's://github.com' bug)", extractAbsPaths("read https://github.com/foo/bar and build it").length === 0);
check("URL with file-ish path segments is NOT a path", extractAbsPaths("see https://example.com/c/docs/spec.md").length === 0);
check("URL ending in .com is NOT a path", extractAbsPaths("go to https://github.com").length === 0);
check("real path NEXT TO a URL is still found", extractAbsPaths("read https://github.com/foo and C:\\a\\b.md").includes("C:\\a\\b.md"));

// 2) canonPath — cross-format normalization.
section("2) canonPath normalizes formats to the same canonical string");
check("Windows → c/…", canonPath("C:\\1_Git\\LocaLLM") === "c/1_git/locallm");
check("WSL → c/…", canonPath("/mnt/c/1_Git/LocaLLM") === "c/1_git/locallm");
check("git-bash → c/…", canonPath("/c/1_Git/LocaLLM") === "c/1_git/locallm");
check("drive-forward → c/…", canonPath("C:/1_Git/LocaLLM/") === "c/1_git/locallm");
check("wsl UNC → c/…", canonPath("\\\\wsl.localhost\\Ubuntu\\mnt\\c\\1_Git\\LocaLLM") === "c/1_git/locallm");

// 3) isInsideRoot — THE decision that would have saved 23 minutes.
section("3) isInsideRoot — the Downloads brief is OUTSIDE the project root");
const ROOT = "/mnt/c/1_Git/LocaLLM";
check("Downloads brief is OUTSIDE root (Windows form)", isInsideRoot("C:\\Users\\mc\\Downloads\\BRIEF.md", ROOT) === false);
check("Downloads brief is OUTSIDE root (WSL form)", isInsideRoot("/mnt/c/Users/mc/Downloads/BRIEF.md", ROOT) === false);
check("in-root BRIEF.md is INSIDE", isInsideRoot("C:\\1_Git\\LocaLLM\\BRIEF.md", ROOT) === true);
check("in-root nested file is INSIDE", isInsideRoot("/mnt/c/1_Git/LocaLLM/owllm-desktop/x.ts", ROOT) === true);
check("root vs Windows root", isInsideRoot("C:\\1_Git\\LocaLLM", "C:\\1_Git\\LocaLLM") === true);
check("sibling dir is OUTSIDE (no prefix false-positive)", isInsideRoot("/mnt/c/1_Git/LocaLLM-steer/x.ts", ROOT) === false);

// 4) suggestInRoot — the concrete unblock destination.
section("4) suggestInRoot points at the in-project destination");
check("Windows root keeps backslashes", suggestInRoot("C:\\Users\\mc\\Downloads\\BRIEF.md", "C:\\1_Git\\LocaLLM") === "C:\\1_Git\\LocaLLM\\BRIEF.md");
check("posix root keeps slashes", suggestInRoot("/mnt/c/Users/mc/Downloads/BRIEF.md", "/mnt/c/1_Git/LocaLLM") === "/mnt/c/1_Git/LocaLLM/BRIEF.md");

console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
if (fails.length) { console.log("Failed:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail === 0 ? 0 : 1);
