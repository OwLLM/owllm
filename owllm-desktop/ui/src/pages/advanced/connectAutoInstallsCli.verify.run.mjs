// Guards "Connect does the whole job" on the Accounts page.
//
// The reported failure: on a machine with no CLI, Connect spawned the sign-in
// anyway and the terminal showed only
//   [spawn error] 'codex' not found on PATH or common install dirs
// The remedy existed — a separate "Install CLI" button — but nothing in the
// flow used it, so a first-run user hit a dead end on the button that is
// supposed to connect them.
//
// Invariants:
//   1. Connect decides from the CLI's REAL state: missing → install,
//      version-blamed → update, otherwise straight to sign-in (no 30-90 s
//      reinstall on every single Connect);
//   2. Connect prepares the CLI BEFORE it spawns the login terminal;
//   3. it reads a FRESH probe, not the polled card state, so a CLI installed
//      seconds ago is not reinstalled and a deleted one is not assumed present;
//   4. a failed install stops the sign-in with an actionable message instead
//      of handing the user another "not found on PATH";
//   5. every CLI-backed provider is covered, not just the one in the report.

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

const page = read("AccountsPage.tsx");

// ---- wiring: the decision runs, and it runs before the terminal ----------
const connectBody = page.slice(
  page.indexOf("async function handleConnect("),
  page.indexOf("function handleAuthTabOpened("),
);
check("Connect prepares the CLI before spawning the sign-in terminal",
  connectBody.includes("await ensureCliReady(route, provider)")
    && connectBody.indexOf("ensureCliReady(route, provider)") < connectBody.indexOf("setActiveTerm({"));
check("a failed preparation aborts the sign-in instead of spawning a dead CLI",
  /if \(!\(await ensureCliReady\(route, provider\)\)\) return;/.test(connectBody));

const ensureBody = page.slice(
  page.indexOf("async function ensureCliReady("),
  page.indexOf("async function handleDisconnect("),
);
check("the install decision comes from cliPrepAction, not a local guess",
  page.includes("cliPrepAction,") && ensureBody.includes("cliPrepAction(installed,"));
check("Connect re-probes the real CLI state instead of trusting the polled card",
  ensureBody.includes("await invalidateAccounts()")
    && ensureBody.includes("Boolean(fresh[field])"));
check("a stale probe never silently claims the CLI is installed",
  /catch \{ \/\* backend probe unavailable/.test(ensureBody)
    && ensureBody.includes("let installed = card?.installed ?? false;"));
check("a failed install reports why and stops, rather than signing in anyway",
  ensureBody.includes("couldn't be installed, so there is nothing to sign in with yet")
    && /if \(action === "update"\) \{/.test(ensureBody));
check("a second Connect during an install does not start a parallel install",
  ensureBody.includes("if (card?.installing)"));
check("the install runner reports success so Connect can wait on it",
  page.includes("function runCliInstall(")
    && /runCliInstall\([^)]*\n?[^)]*\): Promise<boolean>/.test(page));
check("the Connect button shows the install it is running",
  page.includes("const primaryBusy = cliBackedSub && state.installing;")
    && page.includes('primaryBusy ? (state.installed ? "Updating CLI…" : "Installing CLI…")')
    && page.includes("disabled={primaryBusy}"));
check("the card no longer tells the user to press a different button first",
  !page.includes("CLI not installed · install it first")
    && page.includes("CLI not installed · Connect installs it for you"));

// Every CLI-backed subscription backend must map to a real status flag, or
// Connect silently skips preparation for that provider.
const fieldMap = page.slice(
  page.indexOf("const CLI_INSTALLED_FIELD"),
  page.indexOf("const ACCOUNT_ONBOARDING_KEY"),
);
for (const [backend, flag] of [
  ["claude_cli", "claude_cli_installed"],
  ["codex_cli", "codex_cli_installed"],
  ["kimi_cli", "kimi_cli_installed"],
  ["gemini_cli", "gemini_cli_installed"],
  ["grok_cli", "grok_cli_installed"],
]) {
  check(`${backend} maps to its accounts_status flag`,
    new RegExp(`${backend}: "${flag}"`).test(fieldMap));
}
// The flags must exist on the payload type, or the map compiles against a lie.
const store = (() => {
  try {
    return fs.readFileSync(path.join(HERE, "../core/accountsStore.ts"), "utf8");
  } catch { return ""; }
})();
for (const flag of ["claude_cli_installed", "codex_cli_installed", "kimi_cli_installed",
  "gemini_cli_installed", "grok_cli_installed"]) {
  check(`accounts_status really carries ${flag}`, store.includes(`${flag}: boolean;`));
}

// ---- behaviour, by executing the shipped module --------------------------
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-connect-install-"));
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

const { cliPrepAction, classifySubscriptionFailure } = await load("accountHealth");

if (typeof cliPrepAction !== "function") {
  check("accountHealth exports cliPrepAction", false);
} else {
  check("a machine with no CLI installs it — the exact reported case",
    cliPrepAction(false, null) === "install");
  check("a missing CLI is installed even when a stale failure is on the card",
    cliPrepAction(false, "reauth") === "install"
      && cliPrepAction(false, "update") === "install");
  check("an installed, healthy CLI goes straight to sign-in",
    cliPrepAction(true, null) === "none");
  check("an outdated CLI is updated before sign-in",
    cliPrepAction(true, "update") === "update");
  check("a CLI that failed its live check is refreshed before sign-in",
    cliPrepAction(true, "retry") === "update");
  check("an expired session is NOT a reason to reinstall — just sign in again",
    cliPrepAction(true, "reauth") === "none");
  check("a billing/quota problem is never treated as a broken install",
    cliPrepAction(true, "subscription") === "none");

  // End-to-end with the real classifier: the CLI-version errors it reports
  // must be the ones that trigger an update.
  check("a real 'unknown option' CLI error ends in an update",
    cliPrepAction(true, classifySubscriptionFailure("error: unknown option '--device-auth'")) === "update");
  check("a real 401 ends in a sign-in, not a reinstall",
    cliPrepAction(true, classifySubscriptionFailure("401 Unauthorized")) === "none");
  check("a real quota message ends in neither",
    cliPrepAction(true, classifySubscriptionFailure("You have exceeded your weekly limit")) === "none");
}

fs.rmSync(temp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
