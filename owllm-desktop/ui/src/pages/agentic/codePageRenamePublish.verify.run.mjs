// Runner for codePageRenamePublish.verify.ts (Code page per-page rename +
// GitHub functions container).
//
// Two layers, so a revert can't slip past a logic mirror that still agrees
// with itself:
//   1. Source anchors — the load-bearing expressions of both features must
//      still exist in the REAL CodePage.tsx / PublishCards.tsx.
//   2. Behaviour mirror — transpile and execute the self-contained verify
//      test (same mechanism as codePageTwoAgent.verify.run.mjs: no test
//      runner in this repo, and the bundled esbuild binary is per-OS, so the
//      pure-JS TypeScript compiler API does the transpile).
//
// Run from the repo:  node owllm-desktop/ui/src/pages/agentic/codePageRenamePublish.verify.run.mjs
// Exits non-zero if any anchor or assertion fails.
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));            // …/ui/src/pages/agentic
const REPO = path.resolve(HERE, "../../../..");                        // owllm-desktop

// ---- layer 1: source anchors ----------------------------------------------
let failures = 0;
function anchor(file, src, label, needle) {
  if (src.includes(needle)) {
    console.log(`  ✓ ${file}: ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${file}: ${label} — missing \`${needle}\``);
  }
}

console.log("Source anchors (real CodePage.tsx / PublishCards.tsx):\n");

const codePage = fs.readFileSync(path.join(HERE, "CodePage.tsx"), "utf8");
anchor("CodePage.tsx", codePage, "CodeState carries the per-page rename field", "pageRename?: string");
anchor("CodePage.tsx", codePage, "tab title composes folder(rename)", "`${folder}(${rename})`");
anchor("CodePage.tsx", codePage, "unrenamed fallback is the folder name only", "rename ? `${folder}(${rename})` : folder");
anchor("CodePage.tsx", codePage, "same-project reopen keeps the rename, switch resets it",
  "(stx.projectRoot === dir || stx.workspace === dir) ? stx.pageRename : undefined");
anchor("CodePage.tsx", codePage, "header rename box normalises on blur",
  'setField("pageRename", e.target.value.trim() || undefined)');

const cards = fs.readFileSync(path.join(HERE, "PublishCards.tsx"), "utf8");
anchor("PublishCards.tsx", cards, "visibility comes from the cheap LOCAL git_status",
  'invoke<GitStatusInfo>("git_status"');
anchor("PublishCards.tsx", cards, "isRepo prefers local git over the network probe",
  'git ? git.isRepo : (ready?.find((c) => c.id === "repo")?.ok ?? false)');
anchor("PublishCards.tsx", cards, "isolated pages get Merge without a remote",
  "(isolated && !!projectRoot && !!branch) || hasRemote");
anchor("PublishCards.tsx", cards, "failed readiness probe keeps the last known checks",
  "used to make the WHOLE container vanish");
anchor("PublishCards.tsx", cards, "polling pauses while the keep-alive page is hidden",
  "rootRef.current.offsetParent === null");
anchor("PublishCards.tsx", cards, "network probe interval is 30s (not 8s)", "refresh(); }, 30000)");
anchor("PublishCards.tsx", cards, "header shows ahead / behind / dirty facts", "↑{git.ahead}");
anchor("PublishCards.tsx", cards, "Commit button carries the live change count",
  "Commit{git && git.total > 0 ? ` (${git.total})` : \"\"}");
anchor("PublishCards.tsx", cards, "Push button carries the live ahead count",
  "Push{git && git.ahead > 0 ? ` (${git.ahead})` : \"\"}");
anchor("PublishCards.tsx", cards, "readiness summary renders READY / N issues",
  'readyFails.length === 0 ? "READY" : `${readyFails.length} issue');
anchor("PublishCards.tsx", cards, "expanded checklist shows the actionable detail per failing check",
  "{!c.ok && <div style={{ color: \"var(--fg-muted)\", wordBreak: \"break-word\" }}>{c.detail}</div>}");
// Action feedback: every button acknowledges immediately (inline + shared line)
// and a not-ready Publish explains itself instead of swallowing the click.
anchor("PublishCards.tsx", cards, "run() gives an immediate inline ⏳ acknowledgement",
  'setActivity({ kind: "run", msg: `${label}…` });');
anchor("PublishCards.tsx", cards, "run() pushes an immediate ⏳ to the shared status line",
  "status(`⏳ ${label}…`);");
anchor("PublishCards.tsx", cards, "the inline activity row renders in the card",
  '{activity.kind === "run" ? "⏳" : activity.kind === "ok" ? "✓" : "✗"}');
anchor("PublishCards.tsx", cards, "a not-ready Publish stays clickable and surfaces the reason",
  "if (canPublish) { doPublish(); return; }");

if (failures > 0) {
  console.error(`\n${failures} source anchor(s) FAILED — the feature code has drifted or been reverted.`);
  process.exit(1);
}

// ---- layer 2: behaviour mirror ---------------------------------------------
console.log("");
const ts = (await import(pathToFileURL(path.join(REPO, "node_modules/typescript/lib/typescript.js")).href)).default;

const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || "/tmp", "codepage-rnp-verify-"));
const AGENTIC = path.join(ROOT, "ui/src/pages/agentic");
fs.mkdirSync(AGENTIC, { recursive: true });

const code = fs.readFileSync(path.join(HERE, "codePageRenamePublish.verify.ts"), "utf8");
const js = ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
fs.writeFileSync(path.join(AGENTIC, "verify.js"), js);

try {
  createRequire(path.join(AGENTIC, "verify.js"))(path.join(AGENTIC, "verify.js"));
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
