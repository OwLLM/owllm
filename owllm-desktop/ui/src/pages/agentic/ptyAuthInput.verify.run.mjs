// Regression coverage for auth-code entry in the embedded subscription CLI.
// There is one input surface: xterm itself. It must remain usable after
// returning from the browser, and input typed before the PTY handshake must
// not disappear.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "../..");
const terminal = fs.readFileSync(path.join(UI, "pages/advanced/PtyTerminal.tsx"), "utf8").replace(/\r\n/g, "\n");
const accounts = fs.readFileSync(path.join(UI, "pages/advanced/AccountsPage.tsx"), "utf8").replace(/\r\n/g, "\n");
const ptyRs = fs.readFileSync(path.resolve(UI, "../../src-tauri/src/pty.rs"), "utf8").replace(/\r\n/g, "\n");

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
// Reconnecting to the SAME provider used to reuse the exited terminal: identical
// props meant no remount, so the visible terminal wrote to a session Rust had
// already dropped and silently ignored every keystroke and paste.
check("every same-provider Connect remounts a fresh PTY", /launchId:\s*number/.test(accounts) && /key=\{activeTerm\.launchId\}/.test(accounts) && /launchId:\s*\+\+terminalLaunchId\.current/.test(accounts));
check("late async spawns are killed instead of adopted", /if \(disposed\)[\s\S]{0,240}pty_kill/.test(terminal) && /disposed = true/.test(terminal));
check("PTY write failures are visible and actionable", /\[input error\][\s\S]{0,200}click Connect/.test(terminal));

// ---- child exit must be detected while the reader is still blocked --------
// On Windows the ConPTY read blocks past child exit for as long as the master
// half is alive, so exit detection sequenced AFTER the read loop never fires:
// the CLI dies (Claude exits on its first rejected code), no exit line is
// shown, the session stays registered, and every later paste feeds a dead
// console. Exit detection must live in its own waiter thread.
{
  const spawnBlocks = ptyRs.split("std::thread::spawn");
  const readerBlock = spawnBlocks.find((block) => block.includes("reader.read(&mut buf)")) ?? "";
  const waiterBlock = spawnBlocks.find((block) => block.includes("child.wait()")) ?? "";
  check("the PTY read loop does not gate exit detection",
    readerBlock !== "" && !readerBlock.includes("child.wait()"));
  check("a dedicated waiter thread reports the exit and unregisters the session",
    waiterBlock !== "" && waiterBlock.includes("PtyEvent::Exit") && waiterBlock.includes("SESSIONS.lock().unwrap().remove"));
  check("the waiter lets the child's final output drain before dropping the session",
    waiterBlock.includes("bytes_read_waiter"));
}

// ---- stale sign-in codes must never reach the CLI -------------------------
// Claude's CLI exits permanently on the FIRST rejected code. A sign-in tab
// left over from an earlier Connect delivers a code whose `#state` cannot
// match the current session's authorize URL — typing it kills the login.
check("callback codes are screened against the session's auth state",
  /isStaleAuthCode\(code, authStateRef\.current\)/.test(terminal)
    && /authStateFromUrl\(url\)/.test(terminal));
check("a stale code is reported instead of silently dropped",
  /Ignored a code from an earlier sign-in attempt/.test(terminal));
check("Connect closes the previous attempt's sign-in tab",
  /browser_close_tab[\s\S]{0,80}staleAuthTab/.test(accounts) || /staleAuthTab[\s\S]{0,120}browser_close_tab/.test(accounts));
check("a failed login CLI exit is surfaced with recovery guidance",
  /onTermExit/.test(accounts) && /click Connect to start a fresh sign-in/.test(accounts)
    && /onExit=\{\(code\) => onTermExit\(activeTerm\.backend, code\)\}/.test(accounts));

// ---- executable proof of the guard itself ---------------------------------
{
  const source = fs.readFileSync(path.join(UI, "pages/advanced/authCodeGuard.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-auth-guard-"));
  const file = path.join(temp, "authCodeGuard.mjs");
  fs.writeFileSync(file, compiled);
  const { authStateFromUrl, isStaleAuthCode } = await import(pathToFileURL(file).href);
  const AUTH_URL = "https://claude.com/cai/oauth/authorize?code=true&code_challenge=x&state=lBW-MMQVK52i3NITwcvPTOuBEJuaylTxIbuXK7ztsCc";
  const state = authStateFromUrl(AUTH_URL);
  check("authStateFromUrl extracts the state parameter",
    state === "lBW-MMQVK52i3NITwcvPTOuBEJuaylTxIbuXK7ztsCc");
  check("a matching code#state is typed",
    isStaleAuthCode(`XwotYzArX8kWLQzcVDXJEVmKy6jh#${state}`, state) === false);
  check("a code minted by an earlier attempt is refused",
    isStaleAuthCode("XwotYzArX8kWLQzcVDXJEVmKy6jh#DIFFERENT-STATE-FROM-A-STALE-TAB", state) === true);
  check("a bare code without a state suffix is not judged stale",
    isStaleAuthCode("XwotYzArX8kWLQzcVDXJEVmKy6jh", state) === false);
  check("no session state yet leaves the guard permissive",
    isStaleAuthCode("XwotYzArX8kWLQzcVDXJEVmKy6jh#anything", "") === false);
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`PTY auth input verification: ${passed}/${passed} passed`);
