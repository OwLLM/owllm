// The single regression gate.
//
// Before this existed, package.json named six `*.verify.run.mjs` harnesses by
// hand while 180+ others sat on disk executing nowhere. Each one was written
// the day a bug was fixed and then never ran again, so the same bugs kept
// coming back and the repo *looked* far better protected than it was. A gate
// you have to remember to extend is not a gate.
//
// So this discovers every harness instead of listing any: add a
// `*.verify.run.mjs` file anywhere in the repo and it is in the gate from that
// moment, with nothing to wire up.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const REPO = path.resolve(HERE, "../..");
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "dist-portable", ".cache"]);

const discover = (dir, found = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      discover(path.join(dir, entry.name), found);
    } else if (entry.name.endsWith(".verify.run.mjs")) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
};

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const harnesses = discover(REPO)
  .filter((file) => !only.length || only.some((needle) => file.includes(needle)))
  .sort();

if (!harnesses.length) {
  console.error(`regression gate: no *.verify.run.mjs harnesses found under ${REPO}`);
  process.exit(1);
}

console.log(`regression gate: running ${harnesses.length} harness(es)`);

const failures = [];
for (const file of harnesses) {
  const rel = path.relative(REPO, file);
  // Each harness runs in its own process from the repo root, so one that
  // crashes or chdir's cannot take the rest of the gate down with it.
  const run = spawnSync(process.execPath, [file], { cwd: REPO, encoding: "utf8", timeout: 600_000 });
  const output = `${run.stdout || ""}${run.stderr || ""}`.trim();
  if (run.status === 0) {
    console.log(`  PASS ${rel}`);
    continue;
  }
  failures.push({ rel, output, status: run.status });
  console.log(`  FAIL ${rel}`);
}

if (failures.length) {
  console.error(`\n${"=".repeat(72)}`);
  for (const failure of failures) {
    console.error(`\nFAIL ${failure.rel} (exit ${failure.status})`);
    console.error(failure.output.split(/\r?\n/).slice(-25).join("\n"));
  }
  console.error(`\nregression gate: ${harnesses.length - failures.length}/${harnesses.length} harnesses passed, ${failures.length} FAILED`);
  process.exit(1);
}

console.log(`regression gate: ${harnesses.length}/${harnesses.length} harnesses passed`);
