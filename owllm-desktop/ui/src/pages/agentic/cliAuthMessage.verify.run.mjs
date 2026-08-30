// Regression check for the subscription-CLI unavailable message.
//
// The bug: when Claude Code's OAuth refresh fails it drops
// ~/.claude/.credentials.json, so accounts_status.claude_cli flips false while
// claude_cli_installed stays true. Every subscription path read only the first
// flag and reported "Claude Code CLI not detected", which sends the user
// hunting for a broken install instead of re-running sign-in.
//
// Transpiles the real module; no browser required.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../../../..");
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");
const source = fs.readFileSync(path.join(HERE, "cliAuthMessage.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-cli-auth-"));
const modulePath = path.join(temp, "cliAuthMessage.cjs");
fs.writeFileSync(modulePath, output);
const { claudeCliUnavailableMessage } = require(modulePath);

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

const signedOut = claudeCliUnavailableMessage({ loggedIn: false, installed: true });
const missing = claudeCliUnavailableMessage({ loggedIn: false, installed: false });

// --- the regression itself -------------------------------------------
check(signedOut !== missing, "signed-out and not-installed read differently");

// --- installed but signed out must not accuse the install ------------
check(/installed but not signed in/.test(signedOut), "signed-out text says the CLI IS installed");
check(!/not detected/.test(signedOut), "signed-out text never claims the CLI is missing");
check(/claude \/login/.test(signedOut), "signed-out text gives the login command");

// --- genuinely absent binary keeps the install instruction -----------
check(/not detected/.test(missing), "missing text says not detected");
check(
  /npm install -g @anthropic-ai\/claude-code/.test(missing),
  "missing text gives the install command",
);

// --- every call site routes through the helper ------------------------
// Source-level: a future edit that reinstates a hardcoded string fails here.
// AgentsPage's duplicated cloud stack collapsed onto dispatch.ts (2026-08-14),
// so the ONE Claude branch lives in dispatch.ts; AgentsPage's pin is that it
// delegates there and never regrows a branch of its own.
const dispatchText = fs.readFileSync(path.join(HERE, "dispatch.ts"), "utf8");
check(/claudeCliUnavailableMessage\(/.test(dispatchText), "dispatch.ts uses the shared helper");
check(!/"Claude Code CLI not detected/.test(dispatchText), "dispatch.ts has no hardcoded conflated message");
check(/claude_cli_installed/.test(dispatchText), "dispatch.ts reads claude_cli_installed");
const agentsText = fs.readFileSync(path.join(HERE, "AgentsPage.tsx"), "utf8");
check(!/"Claude Code CLI not detected/.test(agentsText), "AgentsPage has no hardcoded conflated message");
check(
  /streamChatCompletion,[\s\S]{0,3000}\} from "\.\/dispatch"/.test(agentsText)
    && !/function streamAnthropic/.test(agentsText),
  "AgentsPage delegates to the ONE shared Claude path (no duplicate branch)",
);

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\ncliAuthMessage: ${passed} checks passed`);
