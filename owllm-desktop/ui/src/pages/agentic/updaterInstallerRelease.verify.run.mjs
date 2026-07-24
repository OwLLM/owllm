#!/usr/bin/env node
// Pins the Windows updater's executable-release wait.  Tauri starts NSIS and
// exits immediately; the stock NSIS process guard waits only 500 ms, which is
// not enough on machines where process teardown or security scanning retains
// the installed executable's write lock.  The installer must wait itself,
// without truncating the executable or waiting forever.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const installer = fs.readFileSync(
  path.resolve(HERE, "../../../../src-tauri/installer.nsi"),
  "utf8",
);

let failed = 0;
function check(name, ok) {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

const waitStart = installer.indexOf("Function WaitForMainBinaryRelease");
const waitEnd = installer.indexOf("FunctionEnd", waitStart);
const waitBody = waitStart >= 0 && waitEnd > waitStart
  ? installer.slice(waitStart, waitEnd)
  : "";
const guard = installer.indexOf("!insertmacro CheckIfAppIsRunning");
const waitCall = installer.indexOf("Call WaitForMainBinaryRelease", guard);
const copy = installer.indexOf('File "${MAINBINARYSRCPATH}"', guard);

check(
  "installer probes the installed executable for write access without writing",
  waitBody.includes('FileOpen $R9 "$INSTDIR\\${MAINBINARYNAME}.exe" a')
    && waitBody.includes("FileClose $R9")
    && !waitBody.includes("FileWrite"),
);
check(
  "locked executable retries instead of immediately entering NSIS File error UI",
  /IfErrors owllm_binary_still_locked/.test(waitBody)
    && /Sleep 250/.test(waitBody)
    && /Goto owllm_binary_release_retry/.test(waitBody),
);
check(
  "release wait is bounded to 30 seconds",
  /\$R8 >= 120/.test(waitBody)
    && waitBody.includes("still locked after 30 seconds"),
);
check(
  "release wait runs after process shutdown guard and before executable copy",
  guard >= 0 && waitCall > guard && copy > waitCall,
);

if (failed) {
  console.error(`updaterInstallerRelease: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("updaterInstallerRelease: all checks passed");
