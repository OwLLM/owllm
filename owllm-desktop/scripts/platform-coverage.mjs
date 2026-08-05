#!/usr/bin/env node
// Platform coverage — what each OS ACTUALLY gets from a release, and the gate
// that stops a release from pretending otherwise.
//
// WHY THIS EXISTS
// publish-release.sh builds exactly ONE platform (the host it runs on) and then
// carry_forward_assets() copies the newest existing installer for every other OS
// onto the new tag under a stable, UNVERSIONED name, so the download links on the
// site/READMEs never 404. That part is correct and must stay.
//
// What was wrong is that it was SILENT. The release page listed a .dmg and an
// .AppImage for every tag, so every release looked complete for every OS — while
// macOS shipped the v0.9.91 disk image unchanged for 13 consecutive releases
// (v0.9.91 → v1.0.4: byte-identical, 200996212 bytes, while v0.9.88/89/90 each
// differed — so that dating is measured, not assumed). Nobody noticed because
// nothing ever said so out loud, and the only way it ever surfaced was a user
// installing a "new" build and finding none of the new features in it.
//
// So: before anything is built or uploaded, resolve what each OS will really
// ship, state it in the release body where users can see it, and REFUSE to
// publish when a platform has drifted past the staleness budget unless the
// operator names it explicitly. A stale platform is now impossible to ship
// unnoticed — it either gets rebuilt or it gets disclosed.
//
// HOW A CARRIED ASSET IS DATED (no new state, works retroactively)
// A carried-forward asset is a byte-identical re-upload, so its size is
// unchanged across every tag it was copied onto. Walking published releases
// newest-first, the run of identical sizes ends at the release that actually
// built it — that release is the origin. Assets whose NAME embeds a version
// (OwLLM.Desktop_1.0.4_aarch64.AppImage) are read directly and need no
// inference at all. The platform being built right now is never inferred: it is
// fresh by construction.
//
// Pure and offline: takes the releases JSON as a file, writes its outputs, and
// exits 3 when the release is blocked. That makes it directly testable —
// see ui/src/pages/agentic/releasePlatformCoverage.verify.run.mjs.
import fs from "node:fs";

// Each platform names the asset a user actually downloads for that OS. The
// stable unversioned names are the ones the site and READMEs link at; aarch64
// Linux has never had a stable name, so it is matched by its versioned one.
export const PLATFORMS = [
  {
    key: "windows-x86_64",
    label: "Windows x86_64",
    asset: "OwLLM.Desktop.Setup.exe",
    builtBy: (k) => k === "windows-x86_64",
  },
  {
    key: "darwin",
    label: "macOS",
    asset: "OwLLM.Desktop.Setup.dmg",
    // One dmg serves both Apple architectures, so any darwin-* build is fresh.
    builtBy: (k) => k.startsWith("darwin"),
  },
  {
    key: "linux-x86_64",
    label: "Linux x86_64",
    asset: "OwLLM.Desktop.AppImage",
    builtBy: (k) => k === "linux-x86_64",
  },
  {
    key: "linux-aarch64",
    label: "Linux aarch64",
    asset: /^OwLLM\.Desktop_[0-9][^_]*_aarch64\.AppImage$/,
    builtBy: (k) => k === "linux-aarch64",
  },
];

const matches = (spec, name) => (typeof spec === "string" ? spec === name : spec.test(name));

// A versioned filename dates itself exactly — prefer it over any inference.
export function versionFromName(name) {
  const m = /_([0-9]+\.[0-9]+\.[0-9]+)_/.exec(name);
  return m ? m[1] : "";
}

/** Published releases, newest first. Drafts are excluded: GitHub's list endpoint
 *  returns them FIRST regardless of date, which is exactly how a paged scan ends
 *  up reading the wrong tag. */
export function publishedNewestFirst(releases) {
  return releases
    .filter((r) => r && !r.draft && r.tag_name)
    .slice()
    .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
}

/** Resolve one platform against release history. */
export function resolvePlatform(platform, releases, { version, tag, builtPlatform }) {
  if (platform.builtBy(builtPlatform)) {
    return { key: platform.key, label: platform.label, state: "fresh", source: "built", version, tag, releasesBehind: 0 };
  }
  // The tag being published is INCLUDED: re-running a publish for an existing
  // tag (a retry, or the second OS of a coordinated multi-OS release) must see
  // the assets already uploaded to it, or a platform that genuinely shipped
  // this version reads as many releases stale and blocks its own re-run.
  const published = publishedNewestFirst(releases);
  const findAsset = (r) => (r.assets || []).find((a) => matches(platform.asset, a.name));

  let originIdx = -1;
  let asset = null;
  for (let i = 0; i < published.length; i++) {
    const a = findAsset(published[i]);
    if (a) {
      originIdx = i;
      asset = a;
      break;
    }
  }
  if (originIdx < 0) {
    return { key: platform.key, label: platform.label, state: "missing", version: "", tag: "", releasesBehind: null };
  }

  // Exact when the name carries a version; otherwise walk the identical-size run
  // back to the release that actually produced those bytes.
  const named = versionFromName(asset.name);
  let idx = originIdx;
  if (!named) {
    for (let j = originIdx + 1; j < published.length; j++) {
      const next = findAsset(published[j]);
      // A release that never carried this asset says nothing about the bytes —
      // skip it. Treating a gap as a boundary dated the Linux x86_64 AppImage
      // to v0.9.92 when v0.9.91 simply had no AppImage and v0.9.90 held the
      // very same 286669304 bytes.
      if (!next) continue;
      if (next.size !== asset.size) break;
      idx = j;
    }
  }
  const origin = published[idx];
  const originVersion = named || String(origin.tag_name).replace(/^v/, "");
  const isFresh = originVersion === version;
  return {
    key: platform.key,
    label: platform.label,
    state: isFresh ? "fresh" : "carried",
    // "onTag": this version's asset is already uploaded to the tag (a retry, or
    // another machine's half of a multi-OS release) — current, but not built by
    // this run. Saying "built now" for it would be a small lie in the log.
    source: isFresh ? "onTag" : "carried",
    version: originVersion,
    tag: origin.tag_name,
    // Releases this OS has missed, counting the one being cut. Zero when the
    // asset really is this version, however it got onto the tag.
    releasesBehind: isFresh ? 0 : idx + 1,
    assetName: asset.name,
  };
}

export function coverage(releases, opts) {
  const budget = Number.isFinite(opts.budget) ? opts.budget : 2;
  const allow = new Set(opts.allowStale || []);
  const rows = PLATFORMS.map((p) => resolvePlatform(p, releases, opts));
  for (const row of rows) {
    const overBudget = row.state === "missing" || (row.state === "carried" && row.releasesBehind > budget);
    row.overBudget = overBudget;
    row.acknowledged = allow.has(row.key);
    row.blocking = overBudget && !row.acknowledged;
  }
  return { version: opts.version, tag: opts.tag, budget, builtPlatform: opts.builtPlatform, platforms: rows };
}

/** Public disclosure. Goes in the GitHub release body — NOT in latest.json's
 *  notes, which the in-app update popup renders. */
export function toMarkdown(cov) {
  const cell = (r) => {
    if (r.state === "fresh") return `✅ **${cov.version}** — built for this release`;
    if (r.state === "missing") return "❌ **not available** — no build has ever been published";
    return `⚠️ **${r.version}** — carried forward from \`${r.tag}\`, ${r.releasesBehind} release${r.releasesBehind === 1 ? "" : "s"} behind`;
  };
  const lines = [
    "## Platform builds",
    "",
    "| Platform | What this release actually ships | Auto-update |",
    "| --- | --- | --- |",
    ...cov.platforms.map((r) => `| ${r.label} | ${cell(r)} | ${r.state === "fresh" ? "yes" : "no"} |`),
  ];
  if (cov.platforms.some((r) => r.state !== "fresh")) {
    lines.push(
      "",
      "Platforms marked ⚠️ or ❌ keep a working download link, but the file is an",
      "older build and the auto-updater deliberately skips it rather than looping",
      "on an update that never changes the installed version.",
    );
  }
  return lines.join("\n");
}

/** Operator-facing summary — this is what makes the problem impossible to miss
 *  in the publish log even when the release is allowed through. */
export function toConsole(cov) {
  const out = [`platform coverage for ${cov.version} (built here: ${cov.builtPlatform}, budget: ${cov.budget} release(s))`];
  for (const r of cov.platforms) {
    const state =
      r.state === "fresh" ? "FRESH  " : r.state === "missing" ? "MISSING" : "CARRIED";
    const detail =
      r.source === "built"
        ? `${r.version} built now`
        : r.source === "onTag"
          ? `${r.version} already uploaded to ${r.tag}`
          : r.state === "missing"
            ? "never published"
            : `${r.version} from ${r.tag} (${r.releasesBehind} behind)`;
    const mark = r.blocking ? "  <-- BLOCKING" : r.acknowledged && r.overBudget ? "  (acknowledged)" : "";
    out.push(`  ${r.label.padEnd(16)} ${state}  ${detail}${mark}`);
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ CLI ---
function main(argv) {
  const arg = (n, d = "") => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const releasesPath = arg("--releases");
  const version = arg("--version");
  const tag = arg("--tag", version && `v${version}`);
  const builtPlatform = arg("--platform");
  if (!releasesPath || !version || !builtPlatform) {
    console.error("usage: platform-coverage.mjs --releases <json> --version <x.y.z> --platform <key> [--tag v] [--budget n] [--allow-stale a,b] [--out-json f] [--out-md f]");
    return 2;
  }
  let releases;
  try {
    releases = JSON.parse(fs.readFileSync(releasesPath, "utf8"));
  } catch (err) {
    console.error(`platform-coverage: cannot read releases JSON (${err.message})`);
    return 2;
  }
  if (!Array.isArray(releases)) {
    console.error("platform-coverage: releases JSON must be an array");
    return 2;
  }
  // `gh api --paginate --slurp` yields an array of PAGES; without it, a flat
  // array. Accept either so the fetch never has to depend on the gh version.
  if (releases.some(Array.isArray)) releases = releases.flat();

  const budgetRaw = arg("--budget", process.env.OWLLM_STALE_BUDGET || "2");
  const allowRaw = arg("--allow-stale", process.env.OWLLM_ALLOW_STALE || "");
  const cov = coverage(releases, {
    version,
    tag,
    builtPlatform,
    budget: Number.parseInt(budgetRaw, 10),
    allowStale: allowRaw.split(",").map((s) => s.trim()).filter(Boolean),
  });

  console.log(toConsole(cov));
  const write = (flag, data) => {
    const p = arg(flag);
    if (p) fs.writeFileSync(p, data);
  };
  write("--out-json", `${JSON.stringify(cov, null, 2)}\n`);
  write("--out-md", `${toMarkdown(cov)}\n`);

  const blocked = cov.platforms.filter((r) => r.blocking);
  if (blocked.length) {
    console.error("");
    console.error(`platform-coverage: ${blocked.length} platform(s) would ship a build older than the ${cov.budget}-release budget:`);
    for (const r of blocked) {
      console.error(`  ${r.label} -> ${r.state === "missing" ? "never built" : `${r.version} (${r.releasesBehind} releases behind)`}`);
    }
    console.error("");
    console.error("Build them, or state the exception explicitly:");
    console.error(`  scripts/publish-release.sh --allow-stale ${blocked.map((r) => r.key).join(",")}`);
    console.error("Either way the release body will disclose it to users.");
    return 3;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("platform-coverage.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
