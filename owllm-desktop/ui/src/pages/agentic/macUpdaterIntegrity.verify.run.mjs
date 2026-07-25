#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const libPath = path.resolve(here, "../../../../src-tauri/src/lib.rs");
const source = fs.readFileSync(libPath, "utf8");

const checks = [
  [
    "startup diagnostics use the mutable user-data directory",
    /paths::user_data_root\(\)[\s\S]*root\.join\("owllm-paths\.log"\)/.test(source),
  ],
  [
    "startup diagnostics retain a writable temporary fallback",
    /std::env::temp_dir\(\)\.join\("owllm-paths\.log"\)/.test(source),
  ],
  [
    "startup diagnostics never write beside the signed executable",
    !/current_exe\(\)[\s\S]{0,300}owllm-paths\.log/.test(source),
  ],
];

let failures = 0;
for (const [label, passed] of checks) {
  if (passed) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}`);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`mac updater integrity: ${checks.length}/${checks.length} passed`);
}
