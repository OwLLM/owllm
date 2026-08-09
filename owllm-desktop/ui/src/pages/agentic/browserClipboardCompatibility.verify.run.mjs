// Regression gate for two WebKit-specific failures:
//   1. The desktop agent browser must identify its Safari compatibility level.
//   2. The shared chat composer must accept image/document clipboard items
//      even when WebKit leaves DataTransfer.files empty.

import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8").replace(/\r\n/g, "\n");
let pass = 0;
let fail = 0;
const check = (name, ok) => {
  if (ok) { pass++; console.log("ok  ", name); }
  else { fail++; console.error("FAIL", name); }
};

const browser = src("../../../../src-tauri/src/browser.rs");
check("desktop browser advertises the installed Safari compatibility version",
  browser.includes("fn macos_desktop_user_agent()")
  && browser.includes('"CFBundleShortVersionString"')
  && browser.includes("Version/{version} Safari/605.1.15")
  && browser.includes('if device.name == "desktop"'));

let clipboard;
let outDir;
try {
  outDir = mkdtempSync(path.join(tmpdir(), "owllm-clipboard-verify-"));
  const outFile = path.join(outDir, "clipboardFiles.mjs");
  await build({
    entryPoints: [new URL("./clipboardFiles.ts", here).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: outFile,
    logLevel: "silent",
  });
  clipboard = await import(pathToFileURL(outFile).href);
} catch (error) {
  console.error(String(error));
} finally {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
}

check("shared clipboard extractor exists", typeof clipboard?.filesFromClipboard === "function");
if (clipboard?.filesFromClipboard) {
  const image = { name: "pasted.png", type: "image/png", size: 42 };
  const item = { kind: "file", type: "image/png", getAsFile: () => image };
  const document = { name: "notes.pdf", type: "application/pdf", size: 84 };
  const documentItem = { kind: "file", type: "application/pdf", getAsFile: () => document };
  const text = { kind: "string", type: "text/plain", getAsFile: () => null };

  check("macOS WKWebView item fallback accepts an image when files is empty",
    clipboard.filesFromClipboard({ files: [], items: [item] })[0] === image);
  check("Linux WebKitGTK uses the same item fallback",
    clipboard.filesFromClipboard({ files: [], items: [text, item] })[0] === image);
  check("macOS Finder document items use the same fallback",
    clipboard.filesFromClipboard({ files: [], items: [documentItem] })[0] === document);
  check("Windows populated files path does not duplicate clipboard items",
    clipboard.filesFromClipboard({ files: [image], items: [item] }).length === 1);
  check("plain text paste remains a normal text paste",
    clipboard.filesFromClipboard({ files: [], items: [text] }).length === 0);
}

const composer = src("../../components/Composer.tsx");
check("the one shared composer uses the WebKit clipboard extractor",
  composer.includes("filesFromClipboard(e.clipboardData)"));
check("the shared composer no longer reads only clipboardData.files",
  !composer.includes("e.clipboardData?.files"));
check("all five chat surfaces remain routed through the one composer",
  [
    [src("./CodePage.tsx"), 'dataUi="CodePrimaryComposer"'],
    [src("./CodePage.tsx"), 'dataUi="CodeSecondaryComposer"'],
    [src("./CodePage.tsx"), 'dataUi="CodeJustChatComposer"'],
    [src("./AgentsPage.tsx"), 'dataUi="UserInput"'],
    [src("../finetuning/ChatPage.tsx"), 'dataUi="FinetuneChatComposer"'],
  ].every(([source, marker]) => source.includes("<Composer") && source.includes(marker)));

console.log(fail === 0 ? `\nall ${pass} checks passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
