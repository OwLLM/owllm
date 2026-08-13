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
const MULTIHOST = path.join(SCRIPTS, "finish-multihost.sh");

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

check("a placeholder passed as --notes is discarded, not published", () => {
  // NOTES is also latest.json's "notes", which the in-app update popup renders.
  // v1.0.16/.17 shipped "OwLLM Desktop 1.0.16" as the entire release note there.
  const i = pubSrc.indexOf("OWLLM_RELEASE_NOTES:-");
  const j = pubSrc.indexOf('if [ -z "$NOTES" ]; then');
  assert.ok(i > 0 && j > i, "the notes-resolution block moved");
  const seg = pubSrc.slice(i, j);
  // Pin the whole condition, not just the call: `if false && body_is_placeholder`
  // would satisfy a substring match while disabling the guard entirely.
  assert.match(
    seg,
    /(^|\n)if \[ -n "\$NOTES" \] && body_is_placeholder "\$NOTES" "\$TAG" "\$VERSION"; then/,
    "supplied notes are no longer placeholder-tested",
  );
  assert.match(seg, /(^|\n)\s*NOTES=""/, "a placeholder value is no longer cleared, so derivation is skipped");
});

check("the coverage markdown is kept for the publish step", () => {
  assert.match(pubSrc, /COVERAGE_TEXT="\$\(cat "\$COVERAGE_MD"\)"/);
  assert.match(pubSrc, /^COVERAGE_TEXT=""$/m, "COVERAGE_TEXT must be initialised, or `set -u` aborts when the gate is skipped");
});

// -------------------------------------------------- multi-host refresh ---
// REGRESSION (v1.0.20): the table is computed on the host that publishes FIRST,
// before the other hosts have uploaded anything, so it necessarily records them
// as carried forward. finish-multihost.sh then uploaded the real Linux/macOS
// artifacts and merged latest.json but never recomputed the table, so v1.0.20's
// page told users Linux was "1.0.19 — carried forward, 2 releases behind,
// auto-update no" while latest.json served fresh 1.0.20 Linux AppImages.
const mhSrc = fs.readFileSync(MULTIHOST, "utf8");

check("finish-multihost.sh recomputes coverage from the live release history", () => {
  assert.match(mhSrc, /\.\s+"\$_SCRIPT_DIR\/lib\/release-body\.sh"/, "the composer is no longer sourced");
  assert.match(mhSrc, /gh api "repos\/\$REPO\/releases\?per_page=100"/, "release history is no longer fetched");
  assert.match(mhSrc, /platform-coverage\.mjs/, "the coverage table is no longer recomputed after the foreign uploads");
  // The recompute must come AFTER the artifacts land, or it reads the same
  // incomplete history publish-release.sh already saw.
  assert.ok(
    mhSrc.indexOf("platform-coverage.mjs") > mhSrc.lastIndexOf('gh release upload "$TAG" "$W/latest.json"'),
    "coverage is recomputed before the artifacts are uploaded, so it sees the same stale history",
  );
});

check("finish-multihost.sh rewrites the body unconditionally", () => {
  const lines = mhSrc.split(/\r?\n/);
  let i = lines.findIndex((l) => l.includes("compose_release_body") && !l.trim().startsWith("#"));
  assert.ok(i > 0, "finish-multihost.sh no longer composes a refreshed body");
  while (i > 0 && /\\\s*$/.test(lines[i - 1])) i -= 1;
  assert.match(lines[i].trim(), /^gh release edit\b/, `the refresh is gated — statement begins: ${lines[i].trim()}`);
  assert.match(
    mhSrc,
    /compose_release_body "\$FALLBACK_NOTES" "\$\(cat "\$W\/platform-coverage\.md"\)" "\$EXISTING_BODY" "\$TAG" "\$VERSION"/,
    "the live body / tag / version are no longer passed, so a hand-written changelog loses its protection",
  );
});

check("a still-stale platform (rc 3) discloses itself instead of aborting", () => {
  // rc 3 means "past the staleness budget" — here that is a legitimate outcome
  // to publish loudly, not a reason to leave the page lying.
  assert.match(mhSrc, /\[ "\$COVERAGE_RC" = 0 \] \|\| \[ "\$COVERAGE_RC" = 3 \]/, "rc 3 handling changed");
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

// The bash we found may be Git Bash (understands "C:/x") or WSL's (needs
// "/mnt/c/x"). On a release host the publish script runs this under Windows
// node, so a WSL bash got "C:/…/driver.sh: No such file or directory" (exit
// 127) and the whole ship gate went red on a path dialect, not a defect.
const forBash = (p) => {
  const direct = posix(p);
  if (!/^[A-Za-z]:\//.test(direct)) return direct;
  if (spawnSync(BASH, ["-c", `test -e "${direct}"`]).status === 0) return direct;
  const mounted = `/mnt/${direct[0].toLowerCase()}${direct.slice(2)}`;
  return spawnSync(BASH, ["-c", `test -e "${mounted}"`]).status === 0 ? mounted : direct;
};

// Inputs are baked into the driver rather than passed as env: when Windows node
// spawns WSL's bash, Windows environment variables do NOT cross into the distro
// unless they are listed in WSLENV, so every value arrived empty and compose
// printed nothing. base64 also keeps newlines and ✅ intact across the boundary.
const b64 = (value) => Buffer.from(String(value), "utf8").toString("base64");

const run = (mode, vars) => {
  const values = { LIB: forBash(LIB), MODE: mode, NOTES: "", COVERAGE: "", EXISTING: "", TAG: "", VERSION: "", ...vars };
  fs.writeFileSync(
    driver,
    Object.entries(values).map(([k, v]) => `${k}="$(printf %s ${b64(v)} | base64 -d)"\n`).join("") +
      `. "$LIB"\n` +
      `case "$MODE" in\n` +
      `  compose) compose_release_body "$NOTES" "$COVERAGE" "$EXISTING" "$TAG" "$VERSION" ;;\n` +
      `  placeholder) if body_is_placeholder "$EXISTING" "$TAG" "$VERSION"; then echo YES; else echo NO; fi ;;\n` +
      `  strip) strip_coverage_section "$EXISTING" ;;\n` +
      `esac\n`,
  );
  const r = spawnSync(BASH, [forBash(driver)], { encoding: "utf8" });
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

// ------------------------------------------------ PowerShell transport ---
// v1.0.20's body was assembled in Windows PowerShell 5.1, which decodes a native
// command's stdout with the OEM codepage (437) and writes files with a BOM. The
// published body starts EF BB BF and renders the em dash as "ΓÇö"; v1.0.18/.19,
// published through these bash scripts, carry neither. Reproduced on the hub by
// capturing the same commit subject through powershell.exe.
const BOM = "﻿";
const POISONED = `${BOM}- fix(startup): kill the double GUI start ΓÇö repaint\r\n- itΓÇÖs fine`;

check("THE REPRO: a BOM + cp437 body is repaired, not republished", () => {
  const body = compose({ EXISTING: POISONED });
  assert.ok(!body.startsWith(BOM), "the UTF-8 BOM survived to the release page");
  assert.ok(!body.includes("ΓÇ"), `mojibake survived: ${JSON.stringify(body)}`);
  assert.ok(body.includes("double GUI start — repaint"), `the em dash was not restored: ${body}`);
  assert.ok(body.includes("it’s fine"), `the apostrophe was not restored: ${body}`);
  assert.ok(!body.includes("\r"), "CR from Out-File survived");
  assert.ok(body.includes("## Platform builds"), "the disclosure did not reach the repaired body");
});

check("every cp437 punctuation shape is repaired", () => {
  const pairs = [
    ["ΓÇô", "–"], ["ΓÇö", "—"],
    ["ΓÇÿ", "‘"], ["ΓÇÖ", "’"],
    ["ΓÇ£", "“"], ["ΓÇ¥", "”"],
    ["ΓÇó", "•"], ["ΓÇª", "…"],
  ];
  for (const [bad, good] of pairs) {
    const body = compose({ EXISTING: `- a ${bad} b` });
    assert.ok(body.includes(`- a ${good} b`), `${JSON.stringify(bad)} was not repaired: ${JSON.stringify(body)}`);
  }
});

check("a BOM'd placeholder is still recognised as a placeholder", () => {
  assert.equal(isPlaceholder(`${BOM}OwLLM Desktop 1.0.19`), "YES", "a BOM froze a placeholder body forever");
});

check("ordinary prose is left untouched", () => {
  const human = "- Γ is a real letter\n- 100% — unchanged";
  const body = compose({ EXISTING: human });
  assert.ok(body.includes(human), `sanitisation damaged legitimate text: ${JSON.stringify(body)}`);
});

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\nRELEASE_BODY_OK ${checks} checks`);
