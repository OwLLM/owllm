// Verifies the module publishing chain: bootstrap-manifest.json (what we BUILD)
// against data/modules/registry.json (what installed apps FETCH).
//
// Two real failures motivated this, both silent:
//
//   1. The registry sat at llama.cpp b3850 for Windows while the manifest was
//      pinned to b9488. Every Windows install kept an engine that predated the
//      pin by months, so a model whose architecture landed upstream later
//      ("unknown model architecture: 'muse-glimmer'") could never load no
//      matter how often the manifest was bumped.
//   2. build-modules.ps1 cached downloads and output zips under the variant id
//      alone, so bumping moduleVersion repacked the PREVIOUS engine's bytes and
//      republished them under the new version. The composite CUDA module went
//      further and shipped the cudart DLLs with no llama-server.exe at all,
//      because each component wiped the previous one's extraction directory.
//
// Offline by design: filenames, versions and hashes are checked for internal
// consistency, never fetched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const REPO = path.resolve(DESKTOP, "..");

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
const bootstrap = readJson(path.join(DESKTOP, "bootstrap-manifest.json"));
const registry = readJson(path.join(REPO, "data/modules/registry.json"));
const packer = fs.readFileSync(path.join(DESKTOP, "scripts/build-modules.ps1"), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
const failures = [];
function check(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`✓ ${message}`);
  } else {
    failures.push(message);
    console.log(`✗ ${message}`);
  }
}

// Every variant the registry serves, keyed by id.
const variants = new Map();
for (const mod of registry.modules) {
  for (const v of mod.variants) variants.set(v.id, v);
}

// --- the registry must not lag the pins it is built from --------------------
const pinned = Object.entries(bootstrap.modules).filter(([id]) => variants.has(id));
check(pinned.length > 0, "bootstrap-manifest and registry share at least one variant id");

// Version-stamped asset names and real hashes start with this release. Assets
// published before it keep their legacy <variant>-<build>.zip names and, for
// some, the zero-hash sentinel; they are reported but do not fail the gate
// until their module is next republished.
const CONVENTION_TAG = "modules-2026.08.11";
const tagOf = (url) => (url.match(/\/download\/([^/]+)\//) || [])[1] || "";

for (const [id, cfg] of pinned) {
  const v = variants.get(id);
  for (const [channel, rel] of Object.entries(v.channels)) {
    check(
      rel.version === cfg.moduleVersion,
      `${id} [${channel}] serves the pinned version (registry ${rel.version} === manifest ${cfg.moduleVersion})`,
    );

    if (tagOf(rel.downloadUrl) < CONVENTION_TAG) {
      console.log(`· ${id} [${channel}] predates ${CONVENTION_TAG} — legacy asset name/hash not enforced`);
      continue;
    }

    // The asset name build-modules.ps1 emits is <variant>-<version>.zip. A URL
    // that does not match it points at something never uploaded.
    const expected = `${id}-${cfg.moduleVersion.replace(/[^A-Za-z0-9._-]/g, "_")}.zip`;
    const actual = rel.downloadUrl.split("/").pop();
    check(actual === expected, `${id} [${channel}] downloadUrl filename is ${expected}`);

    check(
      /^[0-9a-f]{64}$/.test(rel.sha256) && !/^0+$/.test(rel.sha256),
      `${id} [${channel}] carries a real sha256, not the zero placeholder`,
    );
  }
}

// --- an engine payload must contain its entrypoint --------------------------
for (const [id, cfg] of Object.entries(bootstrap.modules)) {
  if (!id.startsWith("local-inference")) continue;
  const expectServer = id.includes("cuda") && !id.includes("linux") ? "llama-server.exe"
    : /vulkan|cpu/.test(id) && !/linux|arm64|metal/.test(id) ? "llama-server.exe"
    : "llama-server";
  check(
    Array.isArray(cfg.requireFiles) && cfg.requireFiles.includes(expectServer),
    `${id} declares ${expectServer} in requireFiles so a payload missing it cannot be packaged`,
  );
}

// --- the packer defects themselves ------------------------------------------
check(
  /function Get-CacheTag/.test(packer) && /Get-CacheTag \$cfg/.test(packer),
  "build-modules.ps1 keys its download cache by version (bumping a pin refetches)",
);
check(
  /\$outZip = Join-Path \$outDir \(\$variantId \+ \$suffix \+ "\.zip"\)/.test(packer),
  "build-modules.ps1 names output zips <variant>-<version>.zip (a bump cannot 'cache hit' the old engine)",
);
check(
  /param\(\[string\]\$zip, \[string\]\$dest, \[int\]\$strip = 0, \[switch\]\$Merge\)/.test(packer)
    && /if \(-not \$Merge -and \(Test-Path \$dest\)\)/.test(packer),
  "Expand-Strip can merge, so composite components no longer delete each other",
);
check(
  /-strip \$compStrip -Merge/.test(packer),
  "Build-Composite extracts every component with -Merge (CUDA keeps llama-server.exe AND cudart)",
);
check(
  /refusing to package/.test(packer),
  "Build-Zip refuses to package a payload missing a required file",
);

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`FAILED: ${f}`);
  process.exit(1);
}
