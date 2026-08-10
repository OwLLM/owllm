// Guards the Connect → "browser opens the sign-in page" path.
//
// The recurring failure was never that the URL was missing from the terminal:
// the CLI printed it every time. It was that the URL was rebuilt from the byte
// stream, where a hard wrap or a PTY chunk boundary is indistinguishable from
// the end of the URL. Claude puts `state` last, so a cut inside that value
// produced a URL that satisfied every "required parameter present" check and
// was silently truncated — the browser opened an authorization request the
// server rejects, or nothing opened at all.
//
// Invariants:
//   1. the URL is read from the terminal buffer's per-row wrap flag, not
//      re-derived from row widths;
//   2. no truncated URL is ever offered, at any terminal width or chunk
//      boundary;
//   3. there is always a manual way to open the sign-in page, so a miss can
//      never leave sign-in with no route at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => {
  try {
    return fs.readFileSync(path.join(HERE, file), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
};

let failed = 0;
let passed = 0;
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
  }
}

const terminal = read("PtyTerminal.tsx");
const capture = read("authUrlCapture.ts");
const unwrapSource = read("unwrapTerminalLines.ts");

// ---- source-level wiring -------------------------------------------------
check("terminal rebuilds logical lines from the buffer's wrap flag",
  terminal.includes('from "./unwrapTerminalLines"')
    && terminal.includes("isWrapped: line.isWrapped")
    && terminal.includes("unwrapTerminalLines(rows)"));
check("the auth-URL scan reads the unwrapped buffer, not the raw byte stream",
  terminal.includes("const url = firstCompleteAuthUrl(bufferedText());"));
check("buffer scan is bounded",
  terminal.includes("MAX_SCANNED_ROWS"));
check("auto-open stays opt-in",
  terminal.includes("autoOpenAuthUrls?: boolean")
    && terminal.includes("if (!autoOpenAuthUrls) return;"));
check("a manual way to open the sign-in page exists",
  terminal.includes("Open sign-in page")
    && /onClick=\{\(\) => \{ void invoke\("browser_open_auth_tab", \{ url: authUrl \}\); \}\}/.test(terminal));
check("the manual route survives a failed automatic open",
  terminal.includes("setAuthUrl(url);")
    && terminal.indexOf("setAuthUrl(url);") < terminal.indexOf("if (authUrlOpened) return;"));
check("OSC payloads terminate at ST as well as BEL",
  capture.includes("[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?"));
check("the scan starts at the scheme so a mid-scheme wrap is still found",
  capture.includes("const starts = /https?:/g;"));
check("Claude hosts require an exact authorization endpoint",
  capture.includes("CLAUDE_AUTH_HOSTS")
    && capture.includes("if (!CLAUDE_AUTH_ENDPOINTS.has(`${url.origin}${url.pathname}`)) return false;"));

// ---- behaviour, by executing the shipped modules -------------------------
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-auth-open-"));
const load = async (name) => {
  const source = read(`${name}.ts`);
  if (!source) return {};
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = path.join(temp, `${name}.mjs`);
  fs.writeFileSync(file, compiled);
  return import(pathToFileURL(file).href);
};

const { firstCompleteAuthUrl } = await load("authUrlCapture");
const { unwrapTerminalLines } = await load("unwrapTerminalLines");

if (typeof firstCompleteAuthUrl !== "function" || typeof unwrapTerminalLines !== "function") {
  // Report as failures rather than crashing: a gate that dies on a missing
  // export looks like a broken gate instead of a broken product.
  check("authUrlCapture exports firstCompleteAuthUrl", typeof firstCompleteAuthUrl === "function");
  check("unwrapTerminalLines module exists and exports its function",
    typeof unwrapTerminalLines === "function");
  check("no truncated login URL is ever offered (skipped: modules missing)", false);
  check("streaming never offers a truncated URL (skipped: modules missing)", false);
  check("URL ending exactly at the row edge (skipped: modules missing)", false);
} else {
  // The exact URL Claude Code printed on the user's machine.
  const LOGIN_URL = "https://claude.com/cai/oauth/authorize?code=true"
    + "&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    + "&response_type=code"
    + "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
    + "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions"
    + "+claude_code+user%3Amcp_servers+user%3Afile_upload"
    + "&code_challenge=K_aERTu1G8DnVmCO8fWufHqsi_zcaat5yRwwn4C9KIg"
    + "&code_challenge_method=S256"
    + "&state=ZNrFDGoie3xUnlm1bupRTaMIzF8O08HZTwBBNYaR704";
  const PREFIX = "Opening browser to sign in\nIf the browser didn't open, visit: ";
  const SUFFIX = "\nPaste code here if prompted > ";

  // A terminal lays text into fixed-width rows and flags every row that
  // continues the one above — the shape xterm exposes as `isWrapped`.
  const renderRows = (text, cols) => {
    const rows = [];
    for (const logical of text.split("\n")) {
      if (logical === "") {
        rows.push({ text: "", isWrapped: false });
        continue;
      }
      for (let i = 0; i < logical.length; i += cols) {
        rows.push({ text: logical.slice(i, i + cols), isWrapped: i > 0 });
      }
    }
    return rows;
  };
  const captured = (text, cols) => firstCompleteAuthUrl(unwrapTerminalLines(renderRows(text, cols)));

  const wrong = [];
  for (let cols = 20; cols <= 200; cols += 1) {
    if (captured(PREFIX + LOGIN_URL + SUFFIX, cols) !== LOGIN_URL) wrong.push(cols);
  }
  check(`the whole login URL is recovered at every terminal width 20..200 (bad widths: ${wrong.join(",") || "none"})`,
    wrong.length === 0);

  // Re-read after every byte, as the terminal is re-scanned on each PTY chunk.
  const whole = PREFIX + LOGIN_URL + SUFFIX;
  let firstOffered = null;
  for (let n = 1; n <= whole.length && !firstOffered; n += 1) {
    firstOffered = captured(whole.slice(0, n), 55);
  }
  check("a partially arrived URL is never offered while it is still growing",
    firstOffered === LOGIN_URL);

  check("a URL ending exactly on the last column does not absorb the next word",
    captured(`${LOGIN_URL}${SUFFIX}`, LOGIN_URL.length) === LOGIN_URL);

  // Truncating anywhere inside `state` still satisfies every presence check,
  // which is precisely how a broken URL used to reach the browser.
  const truncated = LOGIN_URL.slice(0, LOGIN_URL.length - 12);
  check("a URL cut inside the final parameter is not treated as complete",
    firstCompleteAuthUrl(`visit: ${truncated}`) === null);

  check("a row-truncated Claude authorization prefix is rejected",
    firstCompleteAuthUrl("visit: https://claude.com/cai/oau \n") === null
      && firstCompleteAuthUrl("visit: https://claude.com/c \n") === null);

  const ESC = "\x1b";
  check("an ST-terminated OSC-8 hyperlink does not erase the URL it wraps",
    firstCompleteAuthUrl(`${ESC}]8;;${LOGIN_URL}${ESC}\\${LOGIN_URL}${ESC}]8;;${ESC}\\\n> `) === LOGIN_URL);
  check("a BEL-terminated OSC-8 hyperlink still works",
    firstCompleteAuthUrl(`${ESC}]8;;${LOGIN_URL}\x07${LOGIN_URL}${ESC}]8;;\x07\n> `) === LOGIN_URL);

  check("promotional links never consume the automatic open",
    firstCompleteAuthUrl("Learn more: https://support.claude.com/en/articles/promotion \n") === null);

  check("unwrapping joins only rows flagged as continuations",
    unwrapTerminalLines([
      { text: "https://x.test/a", isWrapped: false },
      { text: "bc", isWrapped: true },
      { text: "next", isWrapped: false },
    ]) === "https://x.test/abc\nnext");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
