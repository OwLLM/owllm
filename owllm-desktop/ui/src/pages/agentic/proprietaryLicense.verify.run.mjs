#!/usr/bin/env node
// Prevent first-party OWLLM ownership/license metadata from silently reverting
// to an open-source license. Third-party notices and Marketplace listing
// licenses are intentionally outside this contract.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../../..");
const OWNER = "Far island Corporation Ltd.";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

const license = read("LICENSE");
const readme = read("README.md");
const tauri = JSON.parse(read("owllm-desktop/src-tauri/tauri.conf.json"));
const cargo = read("owllm-desktop/src-tauri/Cargo.toml");
const harnessCargo = read("owllm-desktop/src-tauri/sync-harness/Cargo.toml");
const packagePaths = [
  "owllm-desktop/package.json",
  "owllm-marketplace/package.json",
  "services/world-presence/package.json",
  "download-map/package.json",
];

let failed = 0;
function check(name, ok) {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

check(
  "root license is proprietary and all rights reserved",
  license.startsWith("OWLLM PROPRIETARY SOFTWARE LICENSE")
    && license.includes(`Copyright (c) 2025-2026 ${OWNER}`)
    && license.includes("All rights reserved.")
    && !license.includes("MIT License"),
);
check(
  "README describes OWLLM as proprietary, not MIT",
  readme.includes(`proprietary software owned by **${OWNER}**`)
    && !/MIT\s*(?:©|license)/i.test(readme),
);
check(
  "installer metadata names the corporate owner and has no MIT claim",
  tauri.bundle.publisher === OWNER
    && tauri.bundle.copyright.includes(OWNER)
    && !/MIT/i.test(tauri.bundle.copyright),
);
check(
  "desktop Rust crate is proprietary and cannot be published",
  cargo.includes(`authors = ["${OWNER}"]`)
    && cargo.includes("publish = false")
    && cargo.includes('license-file = "../../LICENSE"'),
);
check(
  "sync harness is proprietary and cannot be published",
  harnessCargo.includes(`authors = ["${OWNER}"]`)
    && harnessCargo.includes("publish = false")
    && harnessCargo.includes('license-file = "../../../LICENSE"'),
);

for (const packagePath of packagePaths) {
  const manifest = JSON.parse(read(packagePath));
  check(
    `${packagePath} is private, unlicensed, and corporately owned`,
    manifest.private === true
      && manifest.license === "UNLICENSED"
      && manifest.author === OWNER,
  );
}

if (failed) {
  console.error(`proprietaryLicense: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("proprietaryLicense: all checks passed");
