// Regression coverage for auth-code entry in the embedded subscription CLI.
// There is one input surface: xterm itself. It must remain usable after
// returning from the browser, and input typed before the PTY handshake must
// not disappear.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "../..");
const terminal = fs.readFileSync(path.join(UI, "pages/advanced/PtyTerminal.tsx"), "utf8").replace(/\r\n/g, "\n");
const accounts = fs.readFileSync(path.join(UI, "pages/advanced/AccountsPage.tsx"), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`  PASS ${name}`);
}

check("terminal does not duplicate xterm with an auth-code textbox", !/Paste or type authentication code|manualInput|Auth code/.test(terminal));
check("xterm remains the interactive provider input", /aria-label=\"Interactive provider terminal\"/.test(terminal) && /term\.onData\(\(data\) => ptyWrite\(data\)\)/.test(terminal));
check("terminal input is queued until PTY spawn completes", /pendingInputRef/.test(terminal));
check("terminal can be explicitly focused after browser auth", /term\.focus\(\)/.test(terminal));
check("terminal receives visibility changes from the rail", /visible=\{tab === "terminal"\}/.test(accounts));
check("macOS command-paste is bridged before xterm can drop it", /onPasteCapture=\{handlePaste\}/.test(terminal) && /clipboardData\.getData\("text\/plain"\)/.test(terminal));
check("terminal exposes an explicit clipboard paste control", /navigator\.clipboard\.readText\(\)/.test(terminal) && /Paste clipboard into terminal/.test(terminal));
check("Claude callback codes return to the matching live PTY", /owllm:claude-auth-code/.test(terminal) && /authProvider !== "claude_cli"/.test(terminal));
check("Accounts identifies the PTY provider for safe callback routing", /authProvider=\{activeTerm\.backend\}/.test(accounts));

console.log(`PTY auth input verification: ${passed}/${passed} passed`);
