// Regression coverage for auth-code entry in the embedded subscription CLI.
// The terminal must remain usable after returning from the browser: xterm's
// hidden textarea is easy to leave unfocused, and input typed before the PTY
// handshake must not disappear.
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

check("terminal exposes a native auth-code input", /aria-label=\"Paste or type authentication code\"/.test(terminal));
check("auth-code input sends a line to the live PTY", /ptyWrite\(.*manualInput|manualInput.*ptyWrite/s.test(terminal));
check("clipboard paste is handled by a real input", /onPaste=\{/.test(terminal));
check("terminal input is queued until PTY spawn completes", /pendingInputRef/.test(terminal));
check("terminal can be explicitly focused after browser auth", /term\.focus\(\)/.test(terminal));
check("terminal receives visibility changes from the rail", /visible=\{tab === "terminal"\}/.test(accounts));

console.log(`PTY auth input verification: ${passed}/${passed} passed`);
