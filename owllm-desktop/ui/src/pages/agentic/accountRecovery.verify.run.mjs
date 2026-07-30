#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, "../../..");
const APP = path.resolve(UI, "..");
const read = (relative) => fs.readFileSync(path.join(APP, relative), "utf8");
const healthSource = read("ui/src/pages/advanced/accountHealth.ts");
const browser = read("src-tauri/src/browser.rs");
const onboarding = read("ui/src/pages/core/AccountSyncModal.tsx");
const accounts = read("ui/src/pages/advanced/AccountsPage.tsx");
const pty = read("ui/src/pages/advanced/PtyTerminal.tsx");

const compiled = ts.transpileModule(healthSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const temp = path.join(os.tmpdir(), `owllm-account-health-${process.pid}.cjs`);
fs.writeFileSync(temp, compiled);
const require = createRequire(import.meta.url);
const { classifySubscriptionFailure, isKimiLoginSuccess } = require(temp);
fs.rmSync(temp, { force: true });

let failed = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failed += 1; console.error(`FAIL ${name}`); }
}

check("401 becomes reconnect", classifySubscriptionFailure("HTTP 401 invalid authentication") === "reauth");
check("expired OAuth grant becomes reconnect", classifySubscriptionFailure("authorization grant is invalid") === "reauth");
check("newer CLI requirement becomes update", classifySubscriptionFailure("model requires a newer version of the CLI") === "update");
check("unknown legacy option becomes update", classifySubscriptionFailure("unknown option --output-format") === "update");
check("quota becomes subscription remediation", classifySubscriptionFailure("quota exceeded") === "subscription");
check("unclassified transport failures remain retryable", classifySubscriptionFailure("child exited unexpectedly") === "retry");
check("Kimi JSON success is recognized", isKimiLoginSuccess('{"type":"success","message":"Logged in successfully."}'));
check("Kimi success survives split terminal buffering", isKimiLoginSuccess('noise\\n{"type":"success"'));

check(
  "GitHub device code is filled and submitted in the OwLLM browser",
  browser.includes('case "fill_device_code"')
    && browser.includes('input[autocomplete="one-time-code"]')
    && onboarding.includes("openAndFillGithubDeviceCode")
    && onboarding.includes('action: "fill_device_code"')
    && onboarding.includes("filled your code automatically"),
);
check(
  "connected subscriptions are health-probed without blocking the WebView",
  accounts.includes("autoHealthProbedBackends")
    && accounts.includes("probeSubscriptionHealth(route, false)")
    && accounts.includes("for (const route of routes) await probeSubscriptionHealth"),
);
check(
  "subscription cards expose precise recovery actions",
  accounts.includes("CLI not installed · install it first")
    && accounts.includes("CLI installed · sign in required")
    && accounts.includes("CLI outdated or incompatible · update required")
    && accounts.includes('data-cli-repair={route.backend}')
    && accounts.includes('"Update CLI"'),
);
check(
  "Kimi JSON success replaces a blank auth page with a completion screen",
  pty.includes("onAuthTabOpened")
    && pty.includes('invoke<string>("browser_open_tab"')
    && accounts.includes("isKimiLoginSuccess(buffered)")
    && accounts.includes('action: "auth_complete"')
    && browser.includes('case "auth_complete"')
    && browser.includes("Authentication completed successfully"),
);
check(
  "Claude reconnect starts the dedicated subscription auth flow",
  accounts.includes('claude_cli: { cli: "claude", args: ["auth", "login", "--claudeai"] }')
    && !accounts.includes('claude_cli: { cli: "claude", args: [], send: "/login\\r" }'),
);

if (failed) {
  console.error(`accountRecovery: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("accountRecovery: all checks passed");
