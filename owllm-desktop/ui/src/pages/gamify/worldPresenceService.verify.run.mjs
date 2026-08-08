// Runs the World Presence service's own miniflare suite as part of the release
// matrix. The suite already existed under services/world-presence/test but was
// wired into NOTHING — it only ran if somebody remembered to type `npm test` in
// that folder, so its regression pins (one install stays one recorded node; a
// no-id client is never persisted; the release column must not bump
// schema_version, which deletes every node) could rot unnoticed.
//
// The worldMap harness pins the worker's SOURCE; this one proves its BEHAVIOUR
// against a real Durable Object.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const SERVICE = path.resolve(HERE, "../../../../../services/world-presence");
const suite = path.join(SERVICE, "test/presence.test.mjs");

if (!fs.existsSync(suite)) {
  console.error(`world presence service verification: suite missing at ${suite}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(SERVICE, "node_modules/miniflare"))) {
  // Loud and actionable rather than a silent pass: a skipped behavioural gate
  // reads as "covered" when it is not.
  console.error("world presence service verification: miniflare is not installed — run `npm install` in services/world-presence");
  process.exit(1);
}

const run = spawnSync(process.execPath, ["--test", suite], { cwd: SERVICE, encoding: "utf8", timeout: 110_000 });
const output = `${run.stdout || ""}${run.stderr || ""}`;
const pass = Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? /^ℹ pass (\d+)$/m.exec(output)?.[1] ?? 0);
const fail = Number(/^# fail (\d+)$/m.exec(output)?.[1] ?? /^ℹ fail (\d+)$/m.exec(output)?.[1] ?? 0);

if (run.status !== 0 || fail > 0 || pass === 0) {
  console.error(output.trim().split(/\r?\n/).slice(-40).join("\n"));
  console.error(`world presence service verification: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`world presence service verification: ${pass}/${pass + fail} passed`);
