import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "../..");
const ROOT = path.resolve(UI, "../..");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const dispatch = read(path.join(HERE, "dispatch.ts"));
const agents = read(path.join(HERE, "AgentsPage.tsx"));
const coding = read(path.join(HERE, "CodePage.tsx"));
const tuning = read(path.join(UI, "pages/finetuning/ChatPage.tsx"));
const rust = read(path.join(ROOT, "src-tauri/src/documents.rs"));
const lib = read(path.join(ROOT, "src-tauri/src/lib.rs"));

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`  PASS ${name}`);
}

// Execute the real model-context formatter (not a copied implementation).
const docFilter = dispatch.match(/export function documentAttachments[\s\S]*?\n}/)?.[0];
const appendDocs = dispatch.match(/export function appendDocumentAttachmentText[\s\S]*?\n}/)?.[0];
if (!docFilter || !appendDocs) throw new Error("FAIL locate document context helpers");
const fragment = `
  type Attachment = { kind: "image" | "audio" | "document"; filename?: string; text?: string; truncated?: boolean };
  const MAX_DOCUMENT_CONTEXT_CHARS = 240_000;
  ${docFilter}
  ${appendDocs}
`;
const compiled = ts.transpileModule(fragment, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-doc-attachments-"));
const modulePath = path.join(temp, "context.mjs");
fs.writeFileSync(modulePath, compiled);
const context = await import(pathToFileURL(modulePath).href);

try {
  const prompt = context.appendDocumentAttachmentText("Compare these files", [
    { kind: "document", filename: "paper.pdf", text: "PDF attachment context" },
    { kind: "document", filename: "notes.txt", text: "TXT attachment context" },
    { kind: "document", filename: "brief.docx", text: "DOCX attachment context" },
  ]);
  check("multiple document texts enter one model-visible chat turn",
    prompt.includes("Compare these files")
      && prompt.includes("paper.pdf") && prompt.includes("PDF attachment context")
      && prompt.includes("notes.txt") && prompt.includes("TXT attachment context")
      && prompt.includes("brief.docx") && prompt.includes("DOCX attachment context"));
  check("document context is explicitly delimited", (prompt.match(/<attached-document>/g) ?? []).length === 3);

  for (const ext of [".pdf", ".txt", ".doc", ".docx", ".rtf", ".odt", ".pptx", ".xlsx"]) {
    check(`picker accepts ${ext}`, dispatch.includes(`"${ext}"`));
  }
  check("shared picker permits multiple attachments", [agents, coding, tuning].every((source) => /type="file"[\s\S]{0,180}multiple/.test(source)));
  check("all chat surfaces show attached document filenames", [agents, coding, tuning].every((source) => source.includes('a.filename') || source.includes('attachment.filename')));
  check("attachment text survives into follow-up chat history", [agents, coding, tuning].every((source) => source.includes("context:") && source.includes(".context ||")));
  check("agentic chat uses the shared parser", agents.includes("fileToChatAttachment(file)"));
  check("coding chat uses the shared parser", coding.includes("fileToChatAttachment(f)"));
  check("fine-tuning chat uses the shared parser", tuning.includes("fileToChatAttachment(file)"));
  check("parse failures are visible instead of dropped", dispatch.includes('throw new Error(`Couldn\'t attach "${file.name}": ${detail}`)'));
  check("native command is registered", lib.includes("documents::document_extract"));
  check("PDF extraction uses the bundled native parser", rust.includes("pdf_extract::extract_text_from_mem(bytes)"));
  check("DOCX and ODT parse their document XML", rust.includes('"docx" | "odt" | "pptx" | "xlsx" => extract_zip_xml'));
  check("legacy DOC has explicit compound-file parsing", rust.includes("fn extract_legacy_doc"));
  check("native tests cover PDF TXT DOC and DOCX", ["note.txt", "paper.pdf", "legacy.doc", "report.docx"].every((name) => rust.includes(name)));
  check("unsupported formats return an actionable error", rust.includes("unsupported document type"));

  console.log(`documentAttachments: ${passed}/${passed} checks passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
