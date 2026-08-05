import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = process.argv.includes("--stdin")
  ? fs.readFileSync(0, "utf8")
  : fs.readFileSync(path.join(dir, "ServerPage.tsx"), "utf8");

const checks = [
  ["legacy server log key is removed once", source.includes('const LEGACY_LOG_STORAGE_KEY = "owllm.server.logs";') && source.includes("localStorage.removeItem(LEGACY_LOG_STORAGE_KEY)")],
  ["server log hub starts in memory", /class ServerLogHub[\s\S]*constructor\(\)[\s\S]{0,300}this\.lines = \[\]/.test(source)],
  ["server log stream is never rewritten to localStorage", !source.includes("localStorage.setItem(LEGACY_LOG_STORAGE_KEY") && !source.includes("localStorage.setItem(LOG_STORAGE_KEY")],
  ["push and clear no longer persist the rolling tail", !source.includes("this.persist()") && !source.includes("private persist()")],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "ok" : "not ok"} - ${name}`);
  if (!ok) failed += 1;
}
console.log(`${checks.length - failed}/${checks.length} server log persistence checks passed`);
process.exit(failed ? 1 : 0);
