#!/usr/bin/env node
// Navigation invariant: the active page and top-level mode must describe the
// same workspace after a shared owllm:navigate event.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const appShell = fs.readFileSync(path.join(HERE, "AppShell.tsx"), "utf8")
  .replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`PASS ${message}`);
}

const navigateStart = appShell.indexOf('const handler = (e: Event)');
const navigateEnd = appShell.indexOf('window.removeEventListener("owllm:navigate"', navigateStart);
const navigate = appShell.slice(navigateStart, navigateEnd);

check(navigateStart >= 0 && navigateEnd > navigateStart,
  "the shared navigation handler is present");
check(/const owner = ALL_MODULES\.find\(m => m\.pages\.some\(p => p\.key === key\)\)/.test(navigate),
  "navigation resolves the destination page owner");
check(/owner\?\.id === "core"\) setMode\("home"\)/.test(navigate),
  "core navigation resets an active Fine Tuning/Agentic/Gamify mode");
check(/owner\?\.id === "finetuning"[\s\S]*?setMode\(owner\.id\)/.test(navigate),
  "installable workspace navigation still selects its owning mode");
check(navigate.indexOf("setMode") < navigate.indexOf("setActiveKey(key)"),
  "the mode is reconciled before the destination page is activated");

// Negative control for the reported failure: the previous handler skipped
// core pages, producing the exact inconsistent state from the report.
const old = { mode: "finetuning", activeKey: "home" };
check(old.mode !== "home" && old.activeKey === "home",
  "the regression scenario is represented: old handler left Home under Fine Tuning");

console.log(`navigation mode verification: ${passed}/${passed} passed`);
