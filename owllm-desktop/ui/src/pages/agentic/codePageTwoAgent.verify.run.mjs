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

// ---- Source pins (CRLF-normalized reads — Windows checkouts are CRLF) ------
// Guard the meta-notice wiring in the REAL CodePage.tsx so a merge can't
// silently revert the timing footer back into a forwardable assistant answer.
const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const codePageSrc = readLF(path.join(HERE, "CodePage.tsx"));
let pinFailures = 0;
const pin = (label, cond) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { pinFailures++; console.error(`  ✗ ${label}`); }
};
console.log("\nCodePage meta-notice source pins:\n");
pin("timing footer is appended as kind meta",
  codePageSrc.includes('kind: "meta", content: runTimingFooter('));
pin("auto-feed pause note is appended as kind meta",
  codePageSrc.includes('kind: "meta", content: `📓 Auto-feed paused'));
pin("forward control skips trailing meta notices",
  codePageSrc.includes('messages.slice(i + 1).every((n) => n.kind === "meta")'));
pin("legacy sessions are migrated at hydration",
  codePageSrc.includes("stampLegacyMetaNotices(loadPageSession(pageId)"));
pin("primary composer owns its model picker above its textarea",
  codePageSrc.includes('toolbarDataUi="CodePrimaryComposerToolbar"')
  && codePageSrc.indexOf('toolbarDataUi="CodePrimaryComposerToolbar"') < codePageSrc.indexOf("textareaRef={codeDraftRef}"));
pin("second composer owns its independent model picker above its textarea",
  codePageSrc.includes('toolbarDataUi="CodeSecondaryComposerToolbar"')
  && codePageSrc.indexOf('toolbarDataUi="CodeSecondaryComposerToolbar"') < codePageSrc.indexOf("textareaRef={secondaryDraftRef}"));
pin("both composer pickers open upward and share a Terminal control",
  codePageSrc.includes('owner === "primary" ? "CodePrimaryComposerModelPicker" : "CodeSecondaryComposerModelPicker"')
  && codePageSrc.includes('renderCodeModelPicker("primary", modelId, setModelId, busy')
  && codePageSrc.includes('renderCodeModelPicker("secondary", secondaryModelId, setSecondaryModelId, secondaryBusy')
  && codePageSrc.includes('placement="top"')
  && codePageSrc.includes('renderTerminalButton("primary")')
  && codePageSrc.includes('renderTerminalButton("secondary")'));
pin("model pickers are absent from both crowded chat headers",
  !codePageSrc.slice(
    codePageSrc.indexOf('data-ui="code-primary-agent-header"'),
    codePageSrc.indexOf("<div", codePageSrc.indexOf('data-ui="code-primary-agent-header"') + 20),
  ).includes("<ModelPicker")
  && !codePageSrc.slice(
    codePageSrc.indexOf('data-ui="code-secondary-agent-header"'),
    codePageSrc.indexOf("{/* Transcript", codePageSrc.indexOf('data-ui="code-secondary-agent-header"')),
  ).includes("<ModelPicker"));
pin("old page-level second-agent row is removed",
  !codePageSrc.includes("Hide 2nd agent")
  && !codePageSrc.includes("Show 2nd agent")
  && !codePageSrc.includes("Second-agent pane toggle"));
pin("second agent remains openable from inside the primary chat header",
  codePageSrc.includes("+ 2nd agent")
  && codePageSrc.includes('onClick={() => setSecondaryOpen(true)}'));
pin("both project-agent composers reuse one attachment parser and picker",
  codePageSrc.includes("const addProjectComposerFiles = async")
  && codePageSrc.includes("void addProjectComposerFiles(files, setCodeAttachments)")
  && codePageSrc.includes("void addProjectComposerFiles(files, setSecondaryAttachments)")
  // The picker/tray themselves now live in the ONE shared <Composer/>, so both
  // agents get the identical control by construction rather than by convention.
  && codePageSrc.includes('attachmentInputDataUi="CodePrimaryAttachmentInput"')
  && codePageSrc.includes('attachmentInputDataUi="CodeSecondaryAttachmentInput"')
  && (codePageSrc.match(/attachmentAccept=\{CHAT_ATTACHMENT_ACCEPT\}/g) ?? []).length >= 2);
pin("second agent accepts attachment-only sends and clears only its own tray",
  codePageSrc.includes("const attachments = fromComposer ? secondaryAttachments : []")
  && codePageSrc.includes("if (!text && attachments.length === 0) return")
  && codePageSrc.includes("setSecondaryAttachments([])"));
pin("second-agent documents and images use the same model payload path as the first",
  codePageSrc.includes("opts?: { withEvents?: boolean; attachments?: Attachment[] }")
  && codePageSrc.includes("enrichSecondaryCodePromptWithMemory(appendDocumentAttachmentText(user, attachments))")
  && codePageSrc.includes("userContent: imgs.length ? openaiUserContent(enrichedUser, imgs) : enrichedUser")
  && codePageSrc.includes('["all"], imgs.length ? imgs : undefined'));
pin("second-agent history retains document context and image thumbnails",
  codePageSrc.includes("context: appendDocumentAttachmentText(text, attachments)")
  && codePageSrc.includes("images: images.length ? attachmentThumbs(images) : undefined")
  && codePageSrc.includes("m.context || m.content"));
if (pinFailures > 0) {
  throw new Error(`FAILED: ${pinFailures} source pin(s) failed.`);
}
