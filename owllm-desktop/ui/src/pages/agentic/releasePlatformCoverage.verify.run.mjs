#!/usr/bin/env node
// A release must never claim an OS is covered when it is shipping that OS an
// older build.
//
// publish-release.sh builds ONE platform and carry_forward_assets() copies the
// newest existing installer for the others onto the new tag under a stable,
// unversioned name so download links don't 404. That was silent: macOS shipped
// the v0.9.91 dmg unchanged for 13 consecutive releases (v0.9.91 -> v1.0.4,
// byte-identical at 200996212, while v0.9.88/89/90 each differed) and Linux
// x86_64 the v0.9.90 AppImage, while every release page listed a .dmg and an
// .AppImage as though they were current. The user found out by installing a
// "new" build that contained none of the new work.
//
// Two invariants keep that from recurring:
//   1. BEHAVIOUR - platform-coverage.mjs dates a carried asset correctly and
//      exits 3 when a platform drifts past the staleness budget unacknowledged.
//   2. WIRING    - publish-release.sh runs it BEFORE building, fails the publish
//      on exit 3, and puts the disclosure in the GitHub release body (not in
//      latest.json's notes, which the in-app update popup renders).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, "../../../../scripts");
const SH = process.env.OWLLM_VERIFY_PUBLISH_SH || path.join(SCRIPTS, "publish-release.sh");
const FINISH_SH = process.env.OWLLM_VERIFY_FINISH_SH || path.join(SCRIPTS, "finish-and-publish.sh");
const COVERAGE_MJS = process.env.OWLLM_VERIFY_COVERAGE_MJS || path.join(SCRIPTS, "platform-coverage.mjs");

let failed = 0;
const check = (name, ok) => {
  if (ok) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}`);
  }
};

// ---------------------------------------------------------- 1. behaviour ---
if (!fs.existsSync(COVERAGE_MJS)) {
  check("scripts/platform-coverage.mjs exists", false);
} else {
  const mod = await import(pathToFileURL(COVERAGE_MJS).href);
  const { coverage, versionFromName, publishedNewestFirst } = mod;

  const rel = (tag, published_at, assets, draft = false) => ({ tag_name: tag, published_at, draft, assets });
  const dmg = (size) => [{ name: "OwLLM.Desktop.Setup.dmg", size }];

  // The real shape of the bug: one dmg copied onto many tags. Origin is the
  // OLDEST tag in the identical-size run, not the newest one carrying it.
  const carried = [
    rel("v1.0.4", "2026-08-04T14:50:01Z", dmg(200996212)),
    rel("v1.0.3", "2026-08-04T13:48:45Z", dmg(200996212)),
    rel("v1.0.2", "2026-08-04T12:47:45Z", dmg(200996212)),
    rel("v0.9.91", "2026-08-01T10:23:52Z", dmg(200996212)),
    rel("v0.9.90", "2026-08-01T09:44:36Z", dmg(200984358)),
  ];
  const covWin = coverage(carried, { version: "1.0.5", tag: "v1.0.5", builtPlatform: "windows-x86_64", budget: 2 });
  const mac = covWin.platforms.find((p) => p.key === "darwin");
  check("a carried asset is dated to the release that built it, not the newest copy", mac.version === "0.9.91");
  check("carried state is reported as 'carried'", mac.state === "carried");
  check("releasesBehind counts the release being cut (v0.9.91 -> v1.0.5 = 4)", mac.releasesBehind === 4);
  check("a platform past the budget blocks the publish", mac.blocking === true);

  const win = covWin.platforms.find((p) => p.key === "windows-x86_64");
  check("the platform being built is fresh by construction, never inferred", win.state === "fresh" && win.releasesBehind === 0);

  // Acknowledgement releases the block but must NOT hide the disclosure.
  const acked = coverage(carried, { version: "1.0.5", tag: "v1.0.5", builtPlatform: "windows-x86_64", budget: 2, allowStale: ["darwin"] });
  const ackedMac = acked.platforms.find((p) => p.key === "darwin");
  check("--allow-stale unblocks the named platform", ackedMac.blocking === false);
  check("an acknowledged platform is still reported as carried", ackedMac.state === "carried" && ackedMac.overBudget === true);
  check("the release body still discloses an acknowledged stale platform", mod.toMarkdown(acked).includes("0.9.91"));

  // Within budget: a one-release lag on a coordinated multi-OS publish is normal.
  const fresh = [rel("v1.0.4", "2026-08-04T14:50:01Z", dmg(1)), rel("v1.0.3", "2026-08-04T13:00:00Z", dmg(2))];
  const near = coverage(fresh, { version: "1.0.5", tag: "v1.0.5", builtPlatform: "windows-x86_64", budget: 2 });
  check("a platform inside the budget does not block", near.platforms.find((p) => p.key === "darwin").blocking === false);

  // A gap is not a boundary — v0.9.91 shipped no AppImage at all, and reading
  // that as "the bytes changed here" mis-dated Linux x86_64 by two releases.
  const gapped = [
    rel("v1.0.4", "2026-08-04T14:50:01Z", [{ name: "OwLLM.Desktop.AppImage", size: 286669304 }]),
    rel("v0.9.91", "2026-08-01T10:23:52Z", []),
    rel("v0.9.90", "2026-08-01T09:44:36Z", [{ name: "OwLLM.Desktop.AppImage", size: 286669304 }]),
    rel("v0.9.89", "2026-08-01T08:16:49Z", [{ name: "OwLLM.Desktop.AppImage", size: 111 }]),
  ];
  const gapCov = coverage(gapped, { version: "1.0.5", tag: "v1.0.5", builtPlatform: "windows-x86_64", budget: 2 });
  check("a release missing the asset is skipped, not treated as the origin", gapCov.platforms.find((p) => p.key === "linux-x86_64").version === "0.9.90");

  // Drafts sort FIRST in GitHub's list endpoint regardless of date.
  const withDraft = [rel("v9.9.9", "2030-01-01T00:00:00Z", dmg(999), true), ...carried];
  check("draft releases are excluded from history", publishedNewestFirst(withDraft).every((r) => r.tag_name !== "v9.9.9"));

  check("a versioned filename dates itself exactly", versionFromName("OwLLM.Desktop_1.0.4_aarch64.AppImage") === "1.0.4");
  check("an unversioned filename yields no version", versionFromName("OwLLM.Desktop.Setup.dmg") === "");

  // aarch64 Linux has no stable name; it must still be tracked via its
  // versioned AppImage or THOR's builds go unnoticed.
  const arm = coverage(
    [rel("v1.0.4", "2026-08-04T14:50:01Z", [{ name: "OwLLM.Desktop_1.0.4_aarch64.AppImage", size: 5 }])],
    { version: "1.0.5", tag: "v1.0.5", builtPlatform: "windows-x86_64", budget: 2 },
  );
  check("linux-aarch64 is tracked through its versioned AppImage", arm.platforms.find((p) => p.key === "linux-aarch64").version === "1.0.4");

  // Re-running a publish for an existing tag (a retry, or the second OS of a
  // coordinated release) must see what is already uploaded to that tag —
  // otherwise THOR's aarch64 build of v1.0.4 read as 15 releases stale and
  // blocked the very release that contained it.
  const rerun = coverage(
    [rel("v1.0.4", "2026-08-04T14:50:01Z", [{ name: "OwLLM.Desktop_1.0.4_aarch64.AppImage", size: 5 }, ...dmg(200996212)]),
      rel("v0.9.91", "2026-08-01T10:23:52Z", dmg(200996212))],
    { version: "1.0.4", tag: "v1.0.4", builtPlatform: "windows-x86_64", budget: 2 },
  );
  const rerunArm = rerun.platforms.find((p) => p.key === "linux-aarch64");
  check("an asset already on the tag being published counts as fresh", rerunArm.state === "fresh" && rerunArm.releasesBehind === 0 && rerunArm.blocking === false);
  check("the log distinguishes 'built now' from 'already on the tag'", rerunArm.source === "onTag" && mod.toConsole(rerun).includes("already uploaded to v1.0.4"));
  check("the platform actually built this run is marked as built", rerun.platforms.find((p) => p.key === "windows-x86_64").source === "built");

  // Never published at all must not read as "fine".
  const none = coverage([rel("v1.0.4", "2026-08-04T14:50:01Z", [])], { version: "1.0.5", tag: "v1.0.5", builtPlatform: "windows-x86_64", budget: 99 });
  check("a platform never built is 'missing' and blocks regardless of budget", none.platforms.find((p) => p.key === "darwin").state === "missing" && none.platforms.find((p) => p.key === "darwin").blocking === true);

  check("every shipped platform is covered", covWin.platforms.length === 4);
}

// ------------------------------------------------------------- 2. wiring ---
const sh = fs.readFileSync(SH, "utf8");
const finish = fs.readFileSync(FINISH_SH, "utf8");

check("publish-release.sh runs the coverage gate", /platform-coverage\.mjs/.test(sh));
check(
  "the gate runs BEFORE the build, not after a 20-minute compile",
  sh.indexOf("platform-coverage.mjs") >= 0
    && sh.indexOf('step "1/5 build') > sh.indexOf("platform-coverage.mjs"),
);
check("exit 3 fails the publish", /COVERAGE_RC["}]*\s*=\s*3[\s\S]{0,200}fail /.test(sh));
check("a non-zero, non-3 rc also fails", /COVERAGE_RC["}]*\s*!=\s*0[\s\S]{0,160}fail /.test(sh));
check("unreadable release history fails a real publish", /could not read release history/.test(sh));
check("--allow-stale is accepted", /--allow-stale\)\s*ALLOW_STALE=/.test(sh));
check("OWLLM_ALLOW_STALE is honoured", /ALLOW_STALE="\$\{OWLLM_ALLOW_STALE:-\}"/.test(sh));
check("the acknowledged list reaches the gate", /--allow-stale "\$ALLOW_STALE"/.test(sh));

// The disclosure must reach the release body, and only the body: latest.json's
// notes render inside the in-app update popup, where a markdown table is noise.
check("the coverage table is appended to the release body", /BODY="\$NOTES\n\n\$\(cat "\$COVERAGE_MD"\)"/.test(sh));
check("gh release create publishes BODY", /gh release create[^\n]*--notes "\$BODY"/.test(sh));
check("gh release edit refreshes BODY", /gh release edit[^\n]*--notes "\$BODY"/.test(sh));
check("latest.json still gets the clean NOTES, not the table", /NOTES="\$NOTES"[^\n]*node -e/.test(sh) || /^NOTES="\$NOTES"/m.test(sh) || /SIG="\$SIG" NOTES="\$NOTES"/.test(sh));

// Drafts sort first in the list endpoint, so a 30-item page can be all drafts.
check("carry-forward pages deep enough to see published releases", !/releases\?per_page=30/.test(sh));

check("finish-and-publish.sh forwards --allow-stale", /--allow-stale\)\s*ALLOW_STALE=/.test(finish));
check("finish-and-publish.sh exports it for card overrides", /export OWLLM_ALLOW_STALE="\$ALLOW_STALE"/.test(finish));

if (failed) {
  console.error(`releasePlatformCoverage: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("releasePlatformCoverage: all checks passed");
