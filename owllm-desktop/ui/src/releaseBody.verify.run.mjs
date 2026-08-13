// releaseBody.verify.run.mjs — the platform-coverage disclosure must survive
// publishing into a release object that already exists.
//
// REGRESSION (v1.0.16, v1.0.17, v1.0.19): publish-release.sh folded the
// "## Platform builds" table into $BODY once, then wrote $BODY only when the
// existing release body matched a short placeholder list ('', tag, version,
// "Release <version>"). v1.0.19's release had been pre-created with the body
// "OwLLM Desktop 1.0.19" — not on that list — so the table was computed, gated
// on, and then discarded. The only recent release whose four platforms were all
// genuinely fresh is the one that shows no coverage table.
//
// This EXECUTES scripts/lib/release-body.sh through bash, so it tests the real
// composition rather than the shape of the source. The wiring assertions below
// pin the call sites, which execution alone cannot reach.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPTS = path.join(APP, "scripts");
const LIB = path.join(SCRIPTS, "lib/release-body.sh");
const PUBLISH = path.join(SCRIPTS, "publish-release.sh");

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  console.log(`  ok  ${name}`);
};

const posix = (p) => p.replace(/\\/g, "/");

// ---------------------------------------------------------------- wiring ---
assert.ok(fs.existsSync(LIB), `missing ${posix(path.relative(APP, LIB))} — the coverage table cannot be recomposed without it`);
const libSrc = fs.readFileSync(LIB, "utf8");
const pubSrc = fs.readFileSync(PUBLISH, "utf8");

check("publish-release.sh sources lib/release-body.sh", () => {
  assert.match(pubSrc, /\.\s+"\$_SCRIPT_DIR\/lib\/release-body\.sh"/);
});

check("the existing-release path edits the body unconditionally", () => {
  const branch = pubSrc.slice(pubSrc.indexOf("if gh release view \"$TAG\""));
  assert.ok(branch.includes("gh release edit"), "existing-release branch no longer edits the body");
  // The old code wrapped the edit in `if <placeholder-test> … fi`. Walk back to
  // the first line of the statement that carries the composed notes and require
  // it to BE the command — no `if`, no `[ … ] &&`, no `||` guard in front of it.
  const lines = branch.split(/\r?\n/);
  let i = lines.findIndex((l) => l.includes("compose_release_body"));
  assert.ok(i > 0, "the refreshed body is no longer composed on the existing-release path");
  while (i > 0 && /\\\s*$/.test(lines[i - 1])) i -= 1;   // line-continuation backslash
  assert.match(
    lines[i].trim(),
    /^gh release edit\b/,
    `body refresh is still gated — the statement begins with: ${lines[i].trim()}`,
  );
  // …and nothing may re-open a conditional between reading the body and rewriting it.
  const between = lines.slice(lines.findIndex((l) => l.includes("EXISTING_BODY=")), i).join("\n");
  assert.doesNotMatch(between, /(^|\n)\s*(if|elif|case)\b/, "a conditional was reintroduced around the body refresh");
});

check("the refreshed body is built by compose_release_body with the live body", () => {
  assert.match(
    pubSrc,
    /compose_release_body "\$NOTES" "\$COVERAGE_TEXT" "\$EXISTING_BODY" "\$TAG" "\$VERSION"/,
    "the existing body / tag / version are no longer passed, so hand-written notes lose their protection",
  );
});

check("the existing body is read verbatim, not whitespace-stripped", () => {
  // `| tr -d ' \r\n'` destroyed the prose it was meant to protect; the
  // normalisation belongs inside body_is_placeholder.
  assert.doesNotMatch(pubSrc, /EXISTING_BODY="\$\(gh release view[^\n]*tr -d/);
});

check("the coverage markdown is kept for the publish step", () => {
  assert.match(pubSrc, /COVERAGE_TEXT="\$\(cat "\$COVERAGE_MD"\)"/);
  assert.match(pubSrc, /^COVERAGE_TEXT=""$/m, "COVERAGE_TEXT must be initialised, or `set -u` aborts when the gate is skipped");
});

// ------------------------------------------------------------- execution ---
const bashCandidates = ["bash", "C:/Program Files/Git/bin/bash.exe", "/bin/bash"];
let BASH = null;
for (const c of bashCandidates) {
  if (spawnSync(c, ["-c", "exit 0"], { encoding: "utf8" }).status === 0) { BASH = c; break; }
}

if (!BASH) {
  console.log(`\n  SKIP  no bash found — ${checks} wiring checks ran, composition NOT executed`);
  console.log(`RELEASE_BODY_PARTIAL ${checks} checks`);
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-release-body-"));
const driver = path.join(temp, "driver.sh");
fs.writeFileSync(
  driver,
  `. "$LIB"\n` +
    `case "$MODE" in\n` +
    `  compose) compose_release_body "$NOTES" "$COVERAGE" "$EXISTING" "$TAG" "$VERSION" ;;\n` +
    `  placeholder) if body_is_placeholder "$EXISTING" "$TAG" "$VERSION"; then echo YES; else echo NO; fi ;;\n` +
    `  strip) strip_coverage_section "$EXISTING" ;;\n` +
    `esac\n`,
);

const run = (mode, vars) => {
  const r = spawnSync(BASH, [posix(driver)], {
    encoding: "utf8",
    env: { ...process.env, LIB: posix(LIB), MODE: mode, NOTES: "", COVERAGE: "", EXISTING: "", TAG: "", VERSION: "", ...vars },
  });
  assert.equal(r.status, 0, `bash driver failed (${mode}): ${r.stderr}`);
  return r.stdout.replace(/\r\n/g, "\n");
};

const TAG = "v1.0.19";
const VERSION = "1.0.19";
const COVERAGE = [
  "## Platform builds",
  "",
  "| Platform | What this release actually ships | Auto-update |",
  "| --- | --- | --- |",
  "| Windows x86_64 | ✅ **1.0.19** — built for this release | yes |",
].join("\n");
const NOTES = "- release: v1.0.19\n- fix(chrome): the owl comes back on screen whenever it speaks";

const compose = (extra) => run("compose", { NOTES, COVERAGE, TAG, VERSION, ...extra });
const isPlaceholder = (body) => run("placeholder", { EXISTING: body, TAG, VERSION }).trim();

check("a brand-new release gets notes then the coverage table", () => {
  const body = compose({});
  assert.ok(body.startsWith(NOTES), body);
  assert.ok(body.includes("## Platform builds"), body);
  assert.match(body, /speaks\n\n## Platform builds/, "exactly one blank line separates the halves");
});

check("THE REPRO: 'OwLLM Desktop <version>' is replaced, table included", () => {
  const body = compose({ EXISTING: "OwLLM Desktop 1.0.19" });
  assert.ok(body.includes("## Platform builds"), "v1.0.19's body shape still swallows the coverage table");
  assert.ok(body.includes("built for this release"), body);
  assert.ok(!body.includes("OwLLM Desktop 1.0.19"), "the placeholder headline survived");
});

check("every known placeholder shape is overwritable", () => {
  for (const body of [
    "",
    "   \n\n ",
    "v1.0.19",
    "1.0.19",
    "Release 1.0.19",
    "Release v1.0.19",
    "OwLLM Desktop 1.0.19",
    "OwLLM Desktop v1.0.19",
    "OwLLM.Desktop 1.0.19",
  ]) {
    assert.equal(isPlaceholder(body), "YES", `not treated as a placeholder: ${JSON.stringify(body)}`);
  }
});

check("a real changelog is NOT a placeholder", () => {
  for (const body of [
    "- vault sync: the app ran 14 hours doing nothing",
    "OwLLM Desktop 1.0.18 — hand-written summary",
    "OwLLM Desktop 1.0.20",           // a different version's title is still prose here
    "## Platform builds\n\n| a | b |", // coverage alone is not a licence to drop the changelog
  ]) {
    assert.equal(isPlaceholder(body), "NO", `wrongly discarded as a placeholder: ${JSON.stringify(body)}`);
  }
});

check("hand-written notes survive, and still gain the table", () => {
  const human = "- vault sync: the app ran 14 hours doing nothing, for any model\n- a second hand-written line";
  const body = compose({ EXISTING: human });
  assert.ok(body.includes(human), "the human's changelog was clobbered");
  assert.ok(body.includes("## Platform builds"), "the disclosure never reached a human-authored body");
});

check("republishing does not stack duplicate coverage tables", () => {
  const first = compose({ EXISTING: "- hand-written line" });
  const second = compose({ EXISTING: first });
  assert.equal(second.match(/## Platform builds/g).length, 1, second);
  assert.ok(second.includes("- hand-written line"));
});

check("a stale table is replaced, not merely re-appended", () => {
  const stale = "- hand-written line\n\n## Platform builds\n\n| macOS | ⚠️ **1.0.15** — carried forward | no |";
  const body = compose({ EXISTING: stale });
  assert.ok(!body.includes("carried forward"), "the previous, now-wrong coverage row survived");
  assert.ok(body.includes("built for this release"), body);
});

check("headings after the coverage section are preserved", () => {
  const existing = "- line\n\n## Platform builds\n\n| old | table |\n\n## Known issues\n\n- something";
  const body = compose({ EXISTING: existing });
  assert.ok(body.includes("## Known issues"), "stripping ran past the end of the coverage section");
  assert.ok(body.includes("- something"));
  assert.ok(!body.includes("| old | table |"));
});

check("no coverage available → body is the prose alone, no dangling blanks", () => {
  const body = run("compose", { NOTES, COVERAGE: "", TAG, VERSION });
  assert.equal(body, `${NOTES}\n`);
});

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\nRELEASE_BODY_OK ${checks} checks`);
