// Regression gate for chat-created document links and the shared document studio.
// Auto-discovered by scripts/smoke-matrix.mjs via *.verify.run.mjs.
//
// Run from owllm-desktop/: node ui/src/components/documentStudio.verify.run.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as esbuild from "esbuild";

const link = fs.readFileSync(new URL("./MarkdownLink.tsx", import.meta.url), "utf8");
const bubble = fs.readFileSync(new URL("./ChatBubble.tsx", import.meta.url), "utf8");
const codePage = fs.readFileSync(new URL("../pages/agentic/CodePage.tsx", import.meta.url), "utf8");
const agentsPage = fs.readFileSync(new URL("../pages/agentic/AgentsPage.tsx", import.meta.url), "utf8");
const chatPage = fs.readFileSync(new URL("../pages/finetuning/ChatPage.tsx", import.meta.url), "utf8");
const localTools = fs.readFileSync(new URL("../pages/agentic/localTools.ts", import.meta.url), "utf8");
const studioUrl = new URL("./DocumentStudio.tsx", import.meta.url);
const linksUrl = new URL("./documentLinks.ts", import.meta.url);
const rust = fs.readFileSync(new URL("../../../src-tauri/src/documents.rs", import.meta.url), "utf8");
const lib = fs.readFileSync(new URL("../../../src-tauri/src/lib.rs", import.meta.url), "utf8");

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}`);
  }
}

check("shared DocumentStudio component exists", fs.existsSync(studioUrl));
check("document link classifier exists", fs.existsSync(linksUrl));
check("MarkdownLink distinguishes documents from websites",
  /classifyDocumentLink/.test(link) && /DocumentStudio/.test(link));
check("local links are not sent through openWebUrl",
  /kind\s*!==\s*["']web["']/.test(link)
    && link.indexOf('kind !== "web"') < link.indexOf("openWebUrl(href)"));
check("chat markdown preserves safe local document URLs",
  /safeMarkdownUrlTransform/.test(bubble) && /urlTransform=/.test(bubble));
check("Coding chat resolves relative documents from its workspace",
  /workspace=\{workspace \|\| undefined\}/.test(codePage)
    && /workspace=\{chatScratchRef\.current \|\| undefined\}/.test(codePage));
check("Fine Tuning chat resolves relative documents from scratch workspace",
  chatPage.includes("i === colMsgs(col.id).length - 1, scratchDir || undefined"));
check("Agent and orchestrator chats resolve relative project documents",
  /workspace=\{projectCwd \|\| undefined\}/.test(agentsPage)
    && /renderUnifiedEntry\([^)]*projectCwd/.test(agentsPage));
check("models are taught to link prepared documents",
  /OWLLM can preview, edit,[\s\S]*and download that link/.test(localTools));
check("native document open command is registered",
  /documents::document_open/.test(lib));
check("native document copy command is registered",
  /documents::document_copy/.test(lib));
check("native document save command is registered",
  /documents::document_save_text/.test(lib));
check("native document open enforces a read-size ceiling",
  /MAX_STUDIO_READ_BYTES/.test(rust));
check("document saves reject stale versions",
  /expected_version/.test(rust) && /changed on disk/.test(rust));
check("document replacement retains a recoverable backup until success",
  /backup/.test(rust) && /rename/.test(rust));
check("office and PDF previews reuse offline extraction",
  /extract_document_bytes/.test(rust) && /preview_text/.test(rust));

if (fs.existsSync(linksUrl)) {
  const out = path.join(os.tmpdir(), `owllm-document-links-${process.pid}.mjs`);
  await esbuild.build({
    entryPoints: [linksUrl.pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const links = await import(`file:///${out.replace(/\\/g, "/")}?v=${Date.now()}`);
  check("Windows absolute document paths classify as documents",
    links.classifyDocumentLink(String.raw`C:\work\report.docx`) === "document");
  check("Unix, WSL, UNC, file and relative paths classify as documents",
    ["/tmp/report.pdf", "/mnt/c/work/report.md", String.raw`\\server\share\report.xlsx`, "file:///C:/work/report.pdf", "./report.md"]
      .every((value) => links.classifyDocumentLink(value) === "document"));
  check("web links remain web links",
    links.classifyDocumentLink("https://example.com/report") === "web");
  check("script and data anchors stay blocked",
    ["javascript:alert(1)", "data:text/html,bad", "vbscript:bad"]
      .every((value) => links.classifyDocumentLink(value) === "blocked"));
  check("safe transform preserves local paths and rejects script anchors",
    links.safeMarkdownUrlTransform("file:///tmp/report.md", "href") !== ""
      && links.safeMarkdownUrlTransform("javascript:alert(1)", "href") === "");
  fs.rmSync(out, { force: true });
}

console.log(`\nDocument Studio regression: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
