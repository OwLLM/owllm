#!/usr/bin/env node
// Pins publish-release.sh to the build it actually produced.
//
// v0.9.92 shipped a Windows installer whose payload was 0.9.85: build-release.bat
// redirects CARGO_TARGET_DIR to a short path (%SystemDrive%\owllm-t) to dodge
// CMake's 250-char object-path limit, but the publisher's signing step read a
// hardcoded in-tree "src-tauri/target/...", which still held the previous
// in-tree build. It signed, repacked and uploaded those stale binaries under the
// new tag, so every user installed 0.9.85 while latest.json advertised 0.9.92 —
// an update prompt that reappeared after every "successful" update.
//
// Two invariants keep that unshippable: the release dir is resolved from the
// same rules the build uses, and the artifact's own version must equal the
// release version before anything is signed or uploaded.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT =
  process.env.OWLLM_VERIFY_PUBLISH_SH
  || path.resolve(HERE, "../../../../scripts/publish-release.sh");
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

const fn = (name) => {
  const start = sh.indexOf(`${name}() {`);
  if (start < 0) return "";
  const end = sh.indexOf("\n}", start);
  return end > start ? sh.slice(start, end) : "";
};

const resolveTargetDir = fn("resolve_target_dir");
const assertVersion = fn("assert_installer_version");

check(
  "the Windows release dir is never hardcoded to the in-tree target",
  !/RELEASE_DIR=["']?src-tauri\/target/.test(sh),
);
check(
  "the Windows release dir is resolved from the build's target dir",
  /RELEASE_DIR="\$\(resolve_target_dir\)\/x86_64-pc-windows-gnu\/release"/.test(sh),
);
check(
  "resolve_target_dir honours a caller-supplied CARGO_TARGET_DIR first",
  resolveTargetDir.includes("CARGO_TARGET_DIR")
    && resolveTargetDir.indexOf("CARGO_TARGET_DIR") < resolveTargetDir.indexOf("owllm-t"),
);
check(
  "resolve_target_dir mirrors build-release.bat's short-path fallbacks",
  /SystemDrive[^\n]*owllm-t/.test(resolveTargetDir)
    && /LOCALAPPDATA[^\n]*owllm-t/.test(resolveTargetDir),
);
check(
  "the built exe's version is checked against the release version before signing",
  /BUILT_VERSION="\$\(exe_file_version /.test(sh)
    && /\[ "\$BUILT_VERSION" = "\$VERSION" \]/.test(sh)
    && sh.indexOf("BUILT_VERSION") < sh.indexOf('sign_payload "$RELEASE_DIR/owllm-desktop.exe"'),
);
check(
  "a version mismatch fails the publish instead of uploading",
  /\[ "\$got" = "\$VERSION" \] \|\| fail /.test(assertVersion)
    && /\[ -n "\$got" \] \|\| fail /.test(assertVersion),
);

const buildAssert = sh.indexOf('assert_installer_version "build"');
const signAssert = sh.indexOf('assert_installer_version "payload signing"');
const repack = sh.indexOf('cp -f "$BUNDLED_INSTALLER" "$INSTALLER"');
const upload = sh.indexOf("UPLOADS=(");
check(
  "the installer is version-checked after the build",
  buildAssert > 0 && buildAssert < upload,
);
check(
  "the installer is re-checked after the NSIS repack, before upload",
  repack > 0 && signAssert > repack && signAssert < upload,
);

// macOS shipped single-arch (aarch64) for its whole history, so latest.json
// never carried a darwin-x86_64 key: Intel Macs could download the dmg but were
// never offered an update, on any version. One universal bundle serves both, and
// both keys must point at it.
check(
  "the mac bundle is built universal (arm64 + x86_64)",
  /npm run tauri -- build --target universal-apple-darwin/.test(sh),
);
check(
  "the mac bundle is read from the universal target dir",
  /BUNDLE="src-tauri\/target\/universal-apple-darwin\/release\/bundle"/.test(sh),
);
check(
  "a non-universal mac bundle fails the publish instead of shipping",
  /lipo -archs/.test(sh) && /fail "mac bundle is not universal/.test(sh),
);
check(
  "both Apple platform keys are served by the one universal artifact",
  /PLATFORM_KEY="darwin-aarch64"/.test(sh)
    && /EXTRA_PLATFORM_KEYS="darwin-x86_64"/.test(sh)
    && /OwLLM\.Desktop_universal\.app\.tar\.gz/.test(sh),
);
check(
  "every platform key in the manifest gets the signature and url",
  /for\s*\(const k of keys\) platforms\[k\]=\{signature:process\.env\.SIG,url:process\.env\.URL\}/.test(sh),
);
// modules::Platform::host() refuses to guess (compile_error! on an unknown
// target), so shipping an arch it does not know is a hard build failure. Every
// platform key the publisher advertises must have a matching host() arm.
{
  const modulesRs = fs.readFileSync(
    path.resolve(HERE, "../../../../src-tauri/src/modules.rs"),
    "utf8",
  );
  const keys = [
    ...new Set(
      [...sh.matchAll(/PLATFORM_KEYS?="([^"]+)"/g)]
        .flatMap((m) => m[1].split(/\s+/))
        .filter((k) => k && !k.includes("$")),
    ),
  ];
  const OS = { darwin: "macos", linux: "linux", windows: "windows" };
  const missing = keys.filter((key) => {
    const [os, arch] = [key.slice(0, key.indexOf("-")), key.slice(key.indexOf("-") + 1)];
    const re = new RegExp(
      `target_os = "${OS[os] || os}", target_arch = "${arch}"`,
    );
    return !re.test(modulesRs);
  });
  check(
    `every published platform key is known to modules::Platform::host() (${keys.join(", ")})`,
    keys.length > 0 && missing.length === 0,
  );
}
check(
  "the dmg is stapled so offline Gatekeeper does not have to phone Apple",
  /xcrun stapler validate "\$DMG"/.test(sh) && /xcrun stapler staple "\$DMG"/.test(sh),
);

// Behavioural check: run the real function, don't just read it. Skipped where no
// POSIX shell exists, so the static pins above stay the portable floor.
let bash = "";
for (const c of ["bash", "/usr/bin/bash", "C:/Program Files/Git/bin/bash.exe"]) {
  try {
    execFileSync(c, ["-c", "exit 0"], { stdio: "ignore" });
    bash = c;
    break;
  } catch {
    /* try next */
  }
}
if (!resolveTargetDir) {
  check("resolve_target_dir returns the caller's CARGO_TARGET_DIR verbatim", false);
} else if (bash) {
  const probe = `
CARGO_TARGET_DIR=/tmp/owllm-probe-target
to_posix_path() { printf '%s' "$1"; }
${resolveTargetDir}
}
resolve_target_dir
`;
  let got = "";
  try {
    // Via stdin with the variable set inside the script: on Windows, PATH
    // `bash` can be the WSL interop shim, which space-joins argv (a multi-line
    // -c script arrives flattened onto one line) and forwards no Windows env
    // vars without WSLENV. stdin + in-script assignment survive every
    // candidate (WSL, Git bash, native).
    got = execFileSync(bash, ["-s"], {
      encoding: "utf8",
      input: probe,
    }).trim();
  } catch (err) {
    console.error(`  probe failed: ${err.stderr || err.message}`);
  }
  check(
    "resolve_target_dir returns the caller's CARGO_TARGET_DIR verbatim",
    got === "/tmp/owllm-probe-target",
  );
} else {
  console.log("SKIP resolve_target_dir behavioural probe (no POSIX shell)");
}

if (failed) {
  console.error(`releaseArtifactVersion: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("releaseArtifactVersion: all checks passed");
