#!/usr/bin/env node
// Pins the Usage panel + terminal contracts:
//  * PtyTerminal only auto-opens auth URLs when a login surface opts in —
//    the Coding-page workspace terminal must NEVER hijack the browser.
//  * The usage meter track is theme-agnostic (var(--bg-surface) vanishes
//    on black themes).
//  * account_usage covers Claude, Codex/OpenAI, Moonshot AND DeepSeek, and
//    the panel actually renders balance-style providers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pty = fs.readFileSync(path.resolve(HERE, "../advanced/PtyTerminal.tsx"), "utf8");
const accountsPage = fs.readFileSync(path.resolve(HERE, "../advanced/AccountsPage.tsx"), "utf8");
const codePage = fs.readFileSync(path.join(HERE, "CodePage.tsx"), "utf8");
const sidePanel = fs.readFileSync(path.join(HERE, "CodeSidePanel.tsx"), "utf8");
const accountsRs = fs.readFileSync(path.resolve(HERE, "../../../../src-tauri/src/accounts.rs"), "utf8");

let failed = 0;
function check(name, ok) {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

check(
  "PtyTerminal URL auto-open is opt-in (autoOpenAuthUrls gate)",
  pty.includes("autoOpenAuthUrls?: boolean")
    && /if \(!autoOpenAuthUrls \|\| authUrlOpened\) return;/.test(pty),
);
check(
  "Accounts login terminal opts in to auth-URL auto-open",
  /<PtyTerminal[\s\S]*?autoOpenAuthUrls/.test(accountsPage),
);
check(
  "Coding-page workspace terminals never auto-open the browser",
  !codePage.includes("autoOpenAuthUrls"),
);
check(
  "Usage meter track is theme-agnostic, not var(--bg-surface)",
  !/height: 4,[^\n]*background: "var\(--bg-surface\)"/.test(sidePanel)
    && /height: 4,[^\n]*background: "rgba\(/.test(sidePanel),
);
check(
  "account_usage routes Codex/OpenAI to the ChatGPT quota endpoint",
  /fetch_codex_usage\(&provider, &stats\)\.await/.test(accountsRs)
    && accountsRs.includes("https://chatgpt.com/backend-api/wham/usage")
    && accountsRs.includes("additional_rate_limits"),
);
check(
  "account_usage routes DeepSeek to the documented balance endpoint",
  /fetch_deepseek_balance\(&provider, &stats\)\.await/.test(accountsRs)
    && accountsRs.includes("https://api.deepseek.com/user/balance"),
);
check(
  "Usage panel renders balance-style providers (Moonshot/DeepSeek)",
  sidePanel.includes("balance?: string | null")
    && /usage\?\.balance &&/.test(sidePanel),
);

if (failed) {
  console.error(`providerUsagePanel: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("providerUsagePanel: all checks passed");
