// Tripwire: editing the built-in project rules without bumping the seed version
// ships nothing.
//
// DEFAULT_DIRECTIVES is delivered to a project's Rules page ONCE, stamped with
// CURRENT_SEED_VERSION. An already-seeded project only re-reads the set when
// that number changes. So adding, rewriting or removing a rule while leaving
// the version alone is a silent no-op: the rule exists in source, looks
// shipped, and no existing user ever sees it.
//
// This guard pins a fingerprint of the rule set. Change the rules and it fails,
// telling you to bump CURRENT_SEED_VERSION and re-pin — the two edits can no
// longer drift apart.
//
// Source-level checks; no browser required.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIRECTIVES = path.resolve(HERE, "../../src-tauri/src/directives.rs");

// Bump BOTH of these together with CURRENT_SEED_VERSION whenever the rules change.
const EXPECTED_SEED_VERSION = 5;
const EXPECTED_FINGERPRINT = "830291a2de61b872";

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

const src = fs.readFileSync(DIRECTIVES, "utf8");

const versionMatch = src.match(/CURRENT_SEED_VERSION:\s*i64\s*=\s*(\d+)/);
check(Boolean(versionMatch), "directives.rs declares CURRENT_SEED_VERSION");
const version = Number(versionMatch[1]);

const blockMatch = src.match(/DEFAULT_DIRECTIVES: &\[\(&str, &str\)\] = &\[([\s\S]*?)\n\];/);
check(Boolean(blockMatch), "directives.rs declares DEFAULT_DIRECTIVES");

const rules = [...blockMatch[1].matchAll(/\(\s*"(must|prefer|avoid)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g)]
  .map((m) => `${m[1]}:${m[2]}`);
check(rules.length >= 20, `the built-in rule set is populated (${rules.length} rules)`);

const fingerprint = crypto.createHash("sha256").update(rules.join("\n")).digest("hex").slice(0, 16);

if (fingerprint !== EXPECTED_FINGERPRINT || version !== EXPECTED_SEED_VERSION) {
  throw new Error(
    `the built-in rules changed without a matching seed version.\n` +
    `    DEFAULT_DIRECTIVES fingerprint: ${fingerprint} (pinned ${EXPECTED_FINGERPRINT})\n` +
    `    CURRENT_SEED_VERSION:           ${version} (pinned ${EXPECTED_SEED_VERSION})\n` +
    `    Bump CURRENT_SEED_VERSION in directives.rs, then update EXPECTED_SEED_VERSION\n` +
    `    and EXPECTED_FINGERPRINT = "${fingerprint}" in this file. Without the bump,\n` +
    `    already-seeded projects never receive the change.`,
  );
}
check(true, "the rule set and CURRENT_SEED_VERSION are in sync");

// The upgrade path must refresh untouched builtins while keeping user edits.
check(/source='builtin'/.test(src) || /source = 'builtin'/.test(src),
  "the upgrade path distinguishes builtin rows from user-typed ones (user edits survive a re-seed)");

console.log(`OK directives seed: ${passed}/${passed} checks passed`);
