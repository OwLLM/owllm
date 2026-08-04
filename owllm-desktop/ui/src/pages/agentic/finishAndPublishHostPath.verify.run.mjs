#!/usr/bin/env node
// Regression gate: host publish must work from fleet worktrees whose Git common
// dir is reported as a Windows path while the publish shell is WSL/MSYS bash.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT =
  process.env.OWLLM_VERIFY_FINISH_PUBLISH_SH
  || path.resolve(HERE, "../../../../scripts/finish-and-publish.sh");
const sh = fs.readFileSync(SCRIPT, "utf8");

let failed = 0;
function check(name, ok) {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

const lockBlock = sh.slice(
  sh.indexOf("GIT_COMMON_RAW="),
  sh.indexOf("PUBLISH_LOCK=", sh.indexOf("GIT_COMMON_RAW=")),
);

check(
  "finish-and-publish defines a Windows-to-POSIX path normalizer",
  /to_posix_path\(\) \{[\s\S]*cygpath -u "\$1"[\s\S]*wslpath -u "\$1"/.test(sh),
);
check(
  "git common-dir is captured before normalization",
  /GIT_COMMON_RAW="\$\(git rev-parse --git-common-dir\)"/.test(sh),
);
check(
  "publish lock uses the normalized git common-dir",
  /GIT_COMMON="\$\(cd "\$\(to_posix_path "\$GIT_COMMON_RAW"\)" && pwd\)"/.test(sh),
);
check(
  "publish lock no longer cds directly into git rev-parse output",
  !/GIT_COMMON="\$\(cd "\$\(git rev-parse --git-common-dir\)" && pwd\)"/.test(sh),
);
check(
  "normalization happens before PUBLISH_LOCK is derived",
  lockBlock.includes("GIT_COMMON_RAW=")
    && lockBlock.includes('to_posix_path "$GIT_COMMON_RAW"'),
);

if (failed) {
  console.error(`finishAndPublishHostPath: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("finishAndPublishHostPath: all checks passed");
