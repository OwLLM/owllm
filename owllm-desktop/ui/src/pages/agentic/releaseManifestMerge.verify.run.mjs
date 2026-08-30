#!/usr/bin/env node
// A coordinated multi-OS publish of ONE tag has each host run publish-release.sh
// in turn, every run merging its platform key into the tag's latest.json. That
// merge is seeded from a manifest fetched over HTTP; if the seed is the WRONG
// manifest the version guard drops it and each host silently WIPES the sibling
// platforms published minutes earlier. v1.0.9/1.0.10/1.0.11 all shipped with a
// hand-repaired manifest for exactly this reason.
//
// This gate runs the script's REAL merge program (extracted from the file, not
// a paraphrase) and asserts the seed URL points at the tag being published.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "../../../../scripts/publish-release.sh");
const release = fs.readFileSync(SCRIPT, "utf8");

let failed = 0;
const check = (name, ok) => {
  if (!ok) { failed++; console.error(`FAIL ${name}`); } else console.log(`PASS ${name}`);
};

// --- seed URL -------------------------------------------------------------
const seed = release.match(/EXISTING_LATEST="\$\(curl [^\n]*\)"/);
check(
  "the manifest merge is seeded from THIS tag, not from releases/latest",
  !!seed && seed[0].includes("releases/download/$TAG/latest.json"),
);
// Anchored to the guard itself, not to a bare substring: the old code's seed
// line CONTAINED "releases/latest/download/latest.json", so a plain search
// after the match index scored the bug as a fallback.
check(
  "releases/latest is reached only as a shape-guarded fallback",
  !!seed
    && /\bcase "\$EXISTING_LATEST" in[\s\S]{0,300}releases\/latest\/download\/latest\.json/.test(
      release.slice(seed.index + seed[0].length),
    ),
);

// --- executed proof: run the script's own merge program --------------------
const merge = release.match(/EXISTING_LATEST="\$EXISTING_LATEST" node -e '([\s\S]*?)'\n/);
check("the merge program is extractable from the script", !!merge);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-manifest-"));
fs.mkdirSync(path.join(tmp, "dist"));
const prog = path.join(tmp, "merge.js");
if (merge) fs.writeFileSync(prog, merge[1]);

const run = (env) => {
  execFileSync(process.execPath, [prog], { cwd: tmp, env: { ...process.env, ...env }, stdio: "pipe" });
  return JSON.parse(fs.readFileSync(path.join(tmp, "dist/latest.json"), "utf8"));
};

const SIB = JSON.stringify({
  version: "9.9.9",
  platforms: { "darwin-aarch64": { signature: "MAC_SIG", url: "mac_url" } },
});

if (merge) {
  // The case that has broken three releases: a sibling host already published
  // darwin for this same tag, and this host is publishing windows.
  const m = run({
    SIG: "WIN_SIG", NOTES: "n", VERSION: "9.9.9", URL: "win_url",
    PLATFORM_KEY: "windows-x86_64", EXTRA_PLATFORM_KEYS: "", EXISTING_LATEST: SIB,
  });
  check(
    "a sibling platform published for the same tag SURVIVES this host's run",
    m.platforms["darwin-aarch64"]?.signature === "MAC_SIG",
  );
  check(
    "this host's own platform is written",
    m.platforms["windows-x86_64"]?.url === "win_url",
  );

  // The guard that must NOT be relaxed: an OLDER version's entry would tell
  // that platform "an update exists" and hand it the previous build — a loop.
  const stale = run({
    SIG: "WIN_SIG", NOTES: "n", VERSION: "9.9.9", URL: "win_url",
    PLATFORM_KEY: "windows-x86_64", EXTRA_PLATFORM_KEYS: "",
    EXISTING_LATEST: JSON.stringify({
      version: "1.0.0",
      platforms: { "darwin-aarch64": { signature: "OLD", url: "old_url" } },
    }),
  });
  check(
    "a STALE-version sibling entry is still dropped (no update loop)",
    !stale.platforms["darwin-aarch64"],
  );

  // A tag with no manifest yet (first host of the release) must not throw.
  const first = run({
    SIG: "S", NOTES: "n", VERSION: "9.9.9", URL: "u",
    PLATFORM_KEY: "linux-x86_64", EXTRA_PLATFORM_KEYS: "", EXISTING_LATEST: "",
  });
  check(
    "the first host of a release publishes a valid single-platform manifest",
    first.version === "9.9.9" && Object.keys(first.platforms).length === 1,
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) process.exit(1);
