#!/usr/bin/env node
// Dependency-free release regression for the Claude CLI failure chain:
// a rejected long-window usage limit is a connected-but-unavailable account,
// not an authentication failure and not a transient retry candidate.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "../../..");
const APP = path.resolve(UI, "..");
const read = (relative) => fs.readFileSync(path.join(APP, relative), "utf8");
const accounts = read("src-tauri/src/accounts.rs");
const browser = read("src-tauri/src/browser.rs");
const smoke = read("scripts/smoke-matrix.mjs");
const health = read("ui/src/pages/advanced/accountHealth.ts");
const dispatch = read("ui/src/pages/agentic/dispatch.ts");

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`  PASS ${name}`);
}

check(
  "live CLI probe names a rejected provider limit without requesting login",
  accounts.includes('lower.contains("rate_limit_event")')
    && accounts.includes('lower.contains("\\\"status\\\":\\\"rejected\\\"")')
    && accounts.includes("usage limit reached (provider-side)")
    && accounts.includes("Wait for its reset or choose another model"),
);
check(
  "account health classifies rejected long-window limits as subscription state",
  health.includes("isProviderUsageLimit(detail)")
    && /weekly limit\|usage limit\|quota exceeded/.test(health),
);
check(
  "CLI preflight stops before launching a real job at the provider limit",
  dispatch.includes("if (!probe.ok && isProviderUsageLimit(probe.detail))")
    && dispatch.includes("throw new CliPreflightError(probe.detail)")
    && dispatch.includes("if (error instanceof CliPreflightError) throw error"),
);
check(
  "rejected long-window limits never enter the transient retry schedule",
  dispatch.includes("if (isProviderUsageLimit(msg)) return false"),
);
check(
  "modern Keychain-backed Claude login is detected through the CLI",
  accounts.includes('"auth"')
    && accounts.includes('"status"')
    && accounts.includes('"loggedIn"')
    && accounts.includes("claude_auth_status_logged_in"),
);
check(
  "legacy Claude credential files remain a compatible fast path",
  accounts.includes('.join(".credentials.json")')
    && /credentials.*is_file\(\)/s.test(accounts),
);
check(
  "Claude browser callback is parsed and emitted only to the main app",
  browser.includes("claude_auth_code_from_callback")
    && browser.includes('"platform.claude.com"')
    && browser.includes('emit_to("main", "owllm:claude-auth-code"'),
);
check(
  "the release gate exercises Keychain-backed Claude instead of skipping it",
  smoke.includes("claudeAuthStatusLoggedIn")
    && smoke.includes('runCli(bin, ["auth", "status"]'),
);

console.log(`Claude CLI connection verification: ${passed}/${passed} passed`);
