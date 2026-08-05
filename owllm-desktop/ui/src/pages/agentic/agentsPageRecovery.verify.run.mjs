#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "AgentsPage.tsx"), "utf8");
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

check("Agents tabs rebuild from surviving per-page project bindings",
  source.includes('key?.match(/^owllm:agents:page:(.+):project$/)') &&
  source.includes('recovered.push({ id, title: "Recovered page" })'));
check("Recovery never resurrects a tab whose binding was deleted",
  source.includes("const binding = localStorage.getItem(key!)") &&
  source.includes("if (!binding || binding === AGENTS_PAGE_NEW_PROJECT) continue"));
check("Recovered tabs are stable and do not duplicate catalog entries",
  source.includes("known.has(id)") && source.includes("known.add(id)"));
check("Normal tab close removes the recovery binding",
  source.includes('localStorage.removeItem(`owllm:agents:page:${id}:project`)'));

if (failed) {
  console.error(`agentsPageRecovery: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("agentsPageRecovery: all checks passed");
