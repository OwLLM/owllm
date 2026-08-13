#!/usr/bin/env node
// latest.json pairs ONE signature with ONE url per platform. If that url floats
// — `releases/latest/download/<name>` — the pair comes apart the moment a newer
// tag is promoted to Latest: a client that fetched the older manifest first then
// downloads the NEWER binary from the same url and checks it against the OLDER
// signature. Tauri reports "The signature verification failed", and Try again
// never recovers because it re-downloads the binary, not the manifest.
//
// That is how v1.0.18 shipped while this PC was stuck being offered v1.0.17:
// Windows was the one platform still on a floating url (macOS and Linux were
// pinned to $TAG). Measured on the real releases — v1.0.17's signature verifies
// against v1.0.17's Setup.exe and fails against v1.0.18's, and vice versa; both
// signatures were correct, only the url was wrong.
//
// This gate asserts every platform arm of publish-release.sh publishes a
// TAG-PINNED updater url, and proves the consequence by running the same
// pairing rule over both url shapes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "../../../../scripts/publish-release.sh");
const release = fs.readFileSync(SCRIPT, "utf8");

let failed = 0;
const check = (name, ok) => {
  if (!ok) { failed++; console.error(`FAIL ${name}`); } else console.log(`PASS ${name}`);
};

// --- the per-platform artifact map ----------------------------------------
const map = release.match(/case "\$HOST_OS" in\n([\s\S]*?)\nesac/);
check("the per-platform artifact map is extractable", !!map);

const arms = [...(map?.[1] ?? "").matchAll(/^ {2}(windows|macos|linux)\)\n([\s\S]*?)^ {4};;/gm)];
check("all three platform arms are present", arms.length === 3);

for (const [, os, body] of arms) {
  const url = body.match(/^\s*URL="([^"]+)"/m)?.[1];
  check(`${os}: the arm assigns an updater URL`, !!url);
  check(
    `${os}: the updater URL is pinned to $TAG, not to releases/latest`,
    !!url && url.includes("/releases/download/$TAG/") && !url.includes("/releases/latest/"),
  );
}

// --- executed proof: the pairing rule the updater applies ------------------
// A minimal stand-in for "resolve the url, then verify the bytes against the
// signature that shipped beside it". No crypto needed: the identity a signature
// commits to is the exact artifact, so pairing survives iff the url resolves to
// the version the manifest was written for.
const RELEASES = { "v1.0.17": "exe@1.0.17", "v1.0.18": "exe@1.0.18" };
const resolve = (url, latestTag) => {
  const pinned = url.match(/\/releases\/download\/(v[\d.]+)\//);
  return RELEASES[pinned ? pinned[1] : latestTag];
};
// The client fetched the v1.0.17 manifest, then GitHub promoted v1.0.18.
const verifies = (url) => resolve(url, "v1.0.18") === "exe@1.0.17";

check(
  "a floating URL hands the client the WRONG binary once Latest moves",
  !verifies("https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.Setup.exe"),
);
check(
  "a $TAG-pinned URL still resolves to the signed binary after Latest moves",
  verifies("https://github.com/OwLLM/owllm/releases/download/v1.0.17/OwLLM.Desktop.Setup.exe"),
);

// The human-download links in the READMEs are a DIFFERENT contract: they must
// keep floating so `releases/latest` always offers every OS an installer.
// Pinning the updater url must not have been done by rewriting those.
check(
  "the stable /releases/latest/download/ human link is left alone",
  /releases\/latest\/download\/OwLLM\.Desktop\.Setup\.exe/.test(
    fs.readFileSync(path.resolve(HERE, "../../../../../owllm-dotgithub-profile-README.md"), "utf8"),
  ),
);

if (failed) process.exit(1);
