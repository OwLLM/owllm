import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "../..");
const ROOT = path.resolve(UI, "../..");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const agents = read(path.join(HERE, "AgentsPage.tsx"));
const capture = read(path.join(UI, "pages/advanced/authUrlCapture.ts"));
const terminal = read(path.join(UI, "pages/advanced/PtyTerminal.tsx"));
const pty = read(path.join(ROOT, "src-tauri/src/pty.rs"));

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`  PASS ${name}`);
}

const compiled = ts.transpileModule(capture, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-auth-url-"));
const modulePath = path.join(temp, "capture.mjs");
fs.writeFileSync(modulePath, compiled);

try {
  const { firstCompleteAuthUrl } = await import(pathToFileURL(modulePath).href);
  const partial = '{"type":"verification_url","url":"https://www.kimi.com/code/authorize_device?user_cod';
  const complete = `${partial}e=ABCD-1234"}\r\n`;
  check("PTY chunk ending mid-Kimi URL is not opened", firstCompleteAuthUrl(partial) === null);
  check("completed Kimi device URL opens with the full user_code",
    firstCompleteAuthUrl(complete) === "https://www.kimi.com/code/authorize_device?user_code=ABCD-1234");
  const hardWrapped = [
    '{"type":"verification_url","message":"Verification URL: https://www.kimi.com/code/authorize_device?user_cod',
    'e=ZJFH-EQQ0","data":{"verification_url":"https://www.kimi.com/code/authorize_device?user_cod',
    'e=ZJFH-EQQ0","user_code":"ZJFH-EQQ0"}}',
  ].join("\r\n");
  check("PTY hard-wrap inside Kimi user_code is rejoined before opening",
    firstCompleteAuthUrl(hardWrapped)
      === "https://www.kimi.com/code/authorize_device?user_code=ZJFH-EQQ0");
  check("hard-wrapped Kimi URL without a complete user_code is not opened",
    firstCompleteAuthUrl(
      '{"type":"verification_url","url":"https://www.kimi.com/code/authorize_device?user_cod\r\n'
        + 'still-incomplete"}\r\n',
    ) === null);
  // A wrap inside the host still parses as a URL (`https://www`), so the
  // extractor must rebuild it instead of opening `https://www/`.
  const hostWrapped = [
    '{"type": "verification_url", "message": "Verification U',
    'RL: https://www.kimi.com/code/authorize_device?user_cod',
    'e=02NI-TFN3", "data": {"verification_url": "https://www',
    '.kimi.com/code/authorize_device?user_code=02NI-TFN3", "',
    'user_code": "02NI-TFN3"}}',
    "",
  ].join("\r\n");
  check("PTY hard-wrap inside the URL host never opens a truncated host",
    firstCompleteAuthUrl(hostWrapped)
      === "https://www.kimi.com/code/authorize_device?user_code=02NI-TFN3");
  check("a wrapped host with no continuation yet is not opened",
    firstCompleteAuthUrl('{"verification_url": "https://www\r\n') === null);
  check("dotless hosts are refused for every provider, not just Kimi",
    firstCompleteAuthUrl('visit https://www "\r\n') === null
      && firstCompleteAuthUrl("visit http://localhost:8080/auth \r\n")
        === "http://localhost:8080/auth");
  check("ordinary banner links cannot consume the one automatic auth-tab open",
    firstCompleteAuthUrl(
      "Learn more: https://support.claude.com/en/articles/promotion \r\n"
        + "Authorize: https://claude.ai/oauth/authorize?client_id=owllm \r\n",
    ) === "https://claude.ai/oauth/authorize?client_id=owllm");
  check("a support link alone is never treated as an authorization URL",
    firstCompleteAuthUrl("Help: https://support.claude.com/en \r\n") === null);
  check("a complete URL is never glued onto the next log line",
    firstCompleteAuthUrl('{"url":"https://example.com/auth?code=ok"}\r\nnext-line-token\r\n')
      === "https://example.com/auth?code=ok");
  check("OSC-8 wrapped authorization URL is normalized",
    firstCompleteAuthUrl('\x1b]8;;https://example.com/auth?code=ok\x07https://example.com/auth?code=ok\x1b]8;;\x07\r\n')
      === "https://example.com/auth?code=ok");

  check("PTY terminal uses only the complete-URL extractor",
    terminal.includes('import { firstCompleteAuthUrl } from "./authUrlCapture"')
      && terminal.includes("const url = firstCompleteAuthUrl(outputText);"));
  check("Windows Kimi browser suppression is a valid Python webbrowser template",
    pty.includes('cmd.env("BROWSER", "cmd.exe /c exit 0 %s")')
      && !pty.includes('cmd.env("BROWSER", "cmd.exe /c exit 0");'));
  check("Unix Kimi browser suppression is explicit and cross-platform",
    pty.includes('cmd.env("BROWSER", "/usr/bin/true %s")'));

  check("mid-run steer queue retains attachment payloads",
    agents.includes("type QueuedSteer = { text: string; attachments: Attachment[] }")
      && agents.includes("const steerQueueRef = useRef<QueuedSteer[]>([])")
      && agents.includes("steerQueueRef.current.push({ text: t, attachments: images })"));
  check("queued image echo keeps its visible thumbnail",
    agents.includes("images: visualImages.length > 0 ? attachmentThumbs(visualImages) : undefined"));
  check("text-only local mid-turn drain cannot consume queued images",
    agents.includes("const drainTextOnlySteers = (): string =>")
      && agents.includes("some((item) => item.attachments.length > 0)"));
  check("queued attachments reach subsequent model turns",
    agents.includes("sSteer.attachments.length > 0 ? sSteer.attachments : undefined")
      && agents.includes("specSteer && specSteer.attachments.length > 0 ? specSteer.attachments : undefined")
      && agents.includes("steer.attachments.length > 0 ? steer.attachments : undefined"));
  check("late follow-up redispatch preserves leftover attachments",
    agents.includes("onSupSendRef.current?.(leftoverSteerText, leftoverSteerAttachments)"));

  console.log(`queuedImagesKimiAuth: ${passed}/${passed} checks passed`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
