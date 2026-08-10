#!/usr/bin/env node
// Keeps a coordinated multi-host release on the canonical publish path.
//
// v1.0.12 took 82 minutes because only ONE of four platforms actually ran
// publish-release.sh. Two defects pushed the rest onto hand-driven steps:
//
//  1. The WSL distro that builds the native linux-x86_64 AppImage was typed as
//     HOST_OS=windows (WSL is normally used to drive a WINDOWS build through
//     Windows tooling). It then looked for "dist/OwLLM Desktop Setup.exe", so
//     the Linux host could never publish itself — its AppImage had to be signed
//     and uploaded by hand.
//  2. carry_forward_assets copied the PREVIOUS version's stable-named installer
//     onto the new tag for any platform not yet uploaded. In a multi-host
//     release those platforms are not missing, they are still building — so the
//     first host to finish published a v1.0.11 dmg under the v1.0.12 tag, and
//     the Mac's real upload then collided with the name it had just created.
//     The release served a stale dmg until it was deleted by hand.
//
// Both checks EXECUTE the script's own bash, so they cannot drift from what
// actually runs at release time.
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
function check(name, ok, detail) {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

// Same resolver the sibling release harnesses use: the matrix runs on Windows,
// macOS and Linux hosts, and only Git Bash is guaranteed on the Windows one.
let bash = "";
for (const c of ["bash", "/usr/bin/bash", "C:/Program Files/Git/bin/bash.exe"]) {
  try {
    execFileSync(c, ["-c", "exit 0"], { stdio: "ignore" });
    bash = c;
    break;
  } catch {
    /* try the next candidate */
  }
}

/** Slice the script between two literal anchors, inclusive of `from`. */
function slice(from, to) {
  const a = sh.indexOf(from);
  if (a < 0) return "";
  const b = sh.indexOf(to, a);
  return b > a ? sh.slice(a, b) : "";
}

/** Run a bash program, returning {status, stdout}. Never throws. */
function run(program, env = {}) {
  try {
    const stdout = execFileSync(bash, ["-s"], {
      input: program,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? 1, stdout: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

// ---------------------------------------------------------------- HOST_OS ---
const hostOsBlock = slice('case "$UNAME_S" in', 'ARCH="$(uname -m)"');
check(
  "the HOST_OS resolution block is still where the harness reads it",
  hostOsBlock.includes("is_wsl_windows") && hostOsBlock.includes("OWLLM_HOST_OS"),
);

// A WSL host is the ambiguous one: it builds BOTH the Windows installer (via
// Windows tooling) and the native linux-x86_64 AppImage.
const asWsl = (over) =>
  [
    "set -euo pipefail",
    'UNAME_S="Linux"',
    "is_wsl_windows=1",
    over ? `OWLLM_HOST_OS=${over}` : "",
    hostOsBlock,
    'echo "HOST_OS=$HOST_OS"',
  ].join("\n");

if (!bash) {
  console.log("SKIP executed HOST_OS checks — no bash on this host");
} else {
  const dflt = run(asWsl(""));
  check(
    "WSL still defaults to windows (drives the Windows build through Windows tooling)",
    dflt.status === 0 && /HOST_OS=windows/.test(dflt.stdout),
    dflt.stdout.trim(),
  );

  const forced = run(asWsl("linux"));
  check(
    "OWLLM_HOST_OS=linux lets the WSL host publish its own linux-x86_64 build",
    forced.status === 0 && /HOST_OS=linux/.test(forced.stdout),
    forced.stdout.trim(),
  );

  const bogus = run(asWsl("darwin"));
  check(
    "an unsupported OWLLM_HOST_OS fails loudly instead of picking the wrong artifacts",
    bogus.status === 2 && !/HOST_OS=/.test(bogus.stdout),
    `status=${bogus.status} ${bogus.stdout.trim()}`,
  );
}

// --------------------------------------------------------- carry-forward ---
const carryFn = slice("carry_forward_assets() {", "\n}");
check(
  "carry_forward_assets is still where the harness reads it",
  carryFn.includes("OWLLM_PENDING_PLATFORMS"),
);

if (!bash) {
  console.log("SKIP executed carry-forward checks — no bash on this host");
} else {
  // Stub the network so the real loop, the real skip test and the real
  // already-present test all execute against canned GitHub responses.
  const GH_STUB = `
gh() {
  case "$1" in
    api) echo "v1.0.11"; return 0 ;;
    release)
      case "$2" in
        view) return 0 ;;                      # this tag has no stable-named assets yet
        download)
          pat=""; dir=""
          while [ $# -gt 0 ]; do
            case "$1" in
              --pattern) pat="$2"; shift 2 ;;
              --dir) dir="$2"; shift 2 ;;
              *) shift ;;
            esac
          done
          : > "$dir/$pat"; return 0 ;;
        upload) echo "UPLOADED $(basename "$4")"; return 0 ;;
      esac ;;
  esac
  return 0
}
`;
  const carryProgram = (pending) =>
    [
      "set -uo pipefail",
      GH_STUB,
      carryFn,
      "}",
      pending ? `export OWLLM_PENDING_PLATFORMS='${pending}'` : "",
      'carry_forward_assets "OwLLM/owllm" "v9.9.9"',
    ].join("\n");

  const none = run(carryProgram(""));
  const carriedAll = (none.stdout.match(/UPLOADED /g) || []).length;
  check(
    "with nothing pending, every missing OS installer is still carried forward",
    none.status === 0 && carriedAll === 4,
    `carried ${carriedAll}: ${none.stdout.trim()}`,
  );

  const pending = run(carryProgram("OwLLM.Desktop.Setup.dmg OwLLM.Desktop.AppImage"));
  check(
    "a platform still building is never shadowed by the previous version's binary",
    pending.status === 0
      && !/UPLOADED OwLLM\.Desktop\.Setup\.dmg/.test(pending.stdout)
      && !/UPLOADED OwLLM\.Desktop\.AppImage/.test(pending.stdout),
    pending.stdout.trim(),
  );
  check(
    "platforms that are genuinely absent are still carried forward alongside pending ones",
    /UPLOADED OwLLM\.Desktop\.Setup\.exe/.test(pending.stdout)
      && /UPLOADED OwLLM\.Desktop\.deb/.test(pending.stdout),
    pending.stdout.trim(),
  );
}

console.log(failed ? `\n${failed} FAILED` : "\nreleaseMultiHost: all checks passed");
process.exit(failed ? 1 : 0);
