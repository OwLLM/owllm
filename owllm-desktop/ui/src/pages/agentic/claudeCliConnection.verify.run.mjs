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

console.log(`Claude CLI connection verification: ${passed}/${passed} passed`);
