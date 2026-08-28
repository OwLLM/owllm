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
const accounts = read(path.join(UI, "pages/advanced/AccountsPage.tsx"));
const pty = read(path.join(ROOT, "src-tauri/src/pty.rs"));
const browser = read(path.join(ROOT, "src-tauri/src/browser.rs"));

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
        + "Authorize: https://claude.ai/oauth/authorize?client_id=owllm"
        + "&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback&code_challenge=pkce&state=state \r\n",
    ) === "https://claude.ai/oauth/authorize?client_id=owllm"
      + "&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback&code_challenge=pkce&state=state");
  const claudePrefix = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44";
  const claudeComplete = `${claudePrefix}`
    + "&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback&code_challenge=pkce&state=state";
  check("wrapped Claude OAuth prefix without redirect_uri is never opened",
    firstCompleteAuthUrl(`Authorize: ${claudePrefix} \r\n`) === null);
  check("hard-wrapped Claude OAuth is reassembled instead of opening its prefix",
    firstCompleteAuthUrl(
      `Authorize: ${claudePrefix}\r\n`
        + "&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback&code_challenge=pkce&state=state \r\n",
    ) === claudeComplete);
  check("Claude OAuth opens only after callback and PKCE parameters arrive",
    firstCompleteAuthUrl(`Authorize: ${claudeComplete} \r\n`) === claudeComplete);
  check("Claude OAuth without state is never opened",
    firstCompleteAuthUrl(`Authorize: ${claudePrefix}`
      + "&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback&code_challenge=pkce \r\n") === null);
  const currentClaudePrefix = "https://claude.com/cai/oauth/authorize?code=true"
    + "&client_id=9d1c250a-e61b-44";
  const currentClaudeComplete = `${currentClaudePrefix}fe-93d9-2f5e`
    + "&response_type=code"
    + "&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback"
    + "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference"
    + "&code_challenge=pkce&code_challenge_method=S256&state=state";
  check("current Claude /cai OAuth prefix cannot open with a partial client_id",
    firstCompleteAuthUrl(`Authorize: ${currentClaudePrefix} \r\n`) === null);
  check("current Claude /cai OAuth is reassembled before opening",
    firstCompleteAuthUrl(
      `Authorize: ${currentClaudePrefix}\r\n`
        + "fe-93d9-2f5e&response_type=code\r\n"
        + "&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback\r\n"
        + "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference\r\n"
        + "&code_challenge=pkce&code_challenge_method=S256&state=state \r\n",
    ) === currentClaudeComplete);
  check("a support link alone is never treated as an authorization URL",
    firstCompleteAuthUrl("Help: https://support.claude.com/en \r\n") === null);
  check("a complete URL is never glued onto the next log line",
    firstCompleteAuthUrl('{"url":"https://example.com/auth?code=ok"}\r\nnext-line-token\r\n')
      === "https://example.com/auth?code=ok");
  check("OSC-8 wrapped authorization URL is normalized",
    firstCompleteAuthUrl('\x1b]8;;https://example.com/auth?code=ok\x07https://example.com/auth?code=ok\x1b]8;;\x07\r\n')
      === "https://example.com/auth?code=ok");

  // Asserted on the extractor's role, not on an exact import or call line: the
  // invariant is "the URL handed to the browser comes from the complete-URL
  // extractor", and pinning the literal source text made unrelated edits (an
  // added named import, a hoisted local) fail a rule they never broke.
  check("PTY terminal takes its authorization URL from the complete-URL extractor",
    /import\s*\{[^}]*\bfirstCompleteAuthUrlFromTerminal\b[^}]*\}\s*from\s*"\.\/authUrlCapture"/.test(terminal)
      && /\bconst\s+url\s*=\s*firstCompleteAuthUrlFromTerminal\(/.test(terminal)
      && terminal.includes("openAuthUrl(url)"));
  check("PTY terminal has no second authorization-URL extractor",
    (terminal.match(/firstCompleteAuthUrlFromTerminal\(/g) || []).length === 1
      && !/firstAuthUrl\(|extractAuthUrl\(|matchAuthUrl\(/.test(terminal));
  check("Claude reconnect never deletes the last credential before OAuth succeeds",
    accounts.includes('if (route.backend === "kimi_cli")')
      && accounts.includes("Keeping the existing ${provider.name} credential until the replacement sign-in succeeds."));
  const nativeAuthGuard = browser.slice(
    browser.indexOf("fn validate_provider_auth_url"),
    browser.indexOf("fn parse_web_url"),
  );
  check("native browser boundary rejects incomplete Claude and Kimi authorization URLs",
    nativeAuthGuard.includes('Some("claude.ai"), "/oauth/authorize"')
      && nativeAuthGuard.includes('Some("claude.com"), "/cai/oauth/authorize"')
      && nativeAuthGuard.includes('"client_id", "redirect_uri", "code_challenge", "state"')
      && nativeAuthGuard.includes('Some("www.kimi.com"), "/code/authorize_device"')
      && nativeAuthGuard.includes('!has_param("user_code")'));
  const nativeOpenRoute = browser.slice(
    browser.indexOf("fn parse_web_url"),
    browser.indexOf("pub(crate) fn open_web_url"),
  );
  const nativeNavigationRoute = browser.slice(
    browser.indexOf("fn parse_navigation_url"),
    browser.indexOf("#[tauri::command(async)]\\npub fn browser_open_url"),
  );
  const nativeTabRoute = browser.slice(
    browser.indexOf("fn new_tab"),
    browser.indexOf("fn on_tab_title"),
  );
  check("every native browser-opening route applies the provider authorization guard",
    nativeOpenRoute.includes("validate_provider_auth_url(&parsed)?")
      && nativeNavigationRoute.includes("validate_provider_auth_url(&parsed)?")
      && nativeTabRoute.includes("validate_provider_auth_url(&parsed)?"));
  // The literal env values moved into the shared `NO_EXTERNAL_BROWSER`
  // constant so the pty and accounts spawn paths cannot drift. Assert the rule
  // (a no-op browser carrying the `%s` URL placeholder on both platforms)
  // rather than the old inline `cmd.env(...)` string.
  const noExternalBrowser = pty.slice(
    pty.indexOf("pub(crate) const NO_EXTERNAL_BROWSER"),
    pty.indexOf("pub(crate) const NO_EXTERNAL_BROWSER") + 400,
  );
  check("Windows browser suppression is a valid Python webbrowser template",
    /\bcfg!\(windows\)\s*\{\s*\n\s*"cmd\.exe \/c exit 0 %s"/.test(noExternalBrowser));
  check("Unix browser suppression is explicit and cross-platform",
    noExternalBrowser.includes('"/usr/bin/true %s"'));
  check("every spawned login CLI gets the shared no-op BROWSER value",
    /cmd\.env\("BROWSER",\s*NO_EXTERNAL_BROWSER\)/.test(pty)
      && !/cmd\.env\("BROWSER",\s*"/.test(pty));

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
