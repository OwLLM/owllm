// Regression gate: an in-app bug report from an ORDINARY user must actually
// reach the team.
//
// Observed 2026-08-27 against the live intake. support_send_report wrote the
// redacted bundle to the PRIVATE repo OwLLM/bug-reports using the REPORTING
// USER'S own GitHub token. Measured with the GitHub permissions API, an
// outside account's permission on that repo is exactly "none":
//
//   GET /repos/OwLLM/bug-reports/collaborators/octocat/permission -> "none"
//   GET /repos/OwLLM/owllm/collaborators/octocat/permission       -> "read"
//
// GitHub masks a repo you cannot see as 404, so the very first upload failed
// and the whole report died before any issue was created. The evidence that
// this had ALWAYS been true: every one of the 33 issues and every commit in
// the intake repo was authored by `ruigro`, the org's only member. Not one
// external report ever arrived, and the UI told the reporter "Most likely
// GitHub isn't connected" — which sent them round in circles reconnecting an
// account that was already connected.
//
// The fix: on an ACCESS failure (401/403/404) fall back to filing an issue on
// the PUBLIC repo, which any authenticated user can do with their own token.
// On any other failure (network, 5xx) it must NOT fall back -- a transient
// server error must never turn a report meant for the private intake into a
// public issue.
//
// Run from owllm-desktop/:  node ui/src/pages/agentic/bugReportIntake.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const supportRs = fs.readFileSync(path.join(APP, "src-tauri", "src", "support.rs"), "utf8");
const drawerTsx = fs.readFileSync(
  path.join(APP, "ui", "src", "support", "WatcherDrawer.tsx"),
  "utf8",
);

let failures = 0;
const check = (label, cond) => {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failures += 1; }
};
// Ordering helper: indexOf returns -1 for ABSENT code, which sorts before
// everything, so a missing needle would silently satisfy a naive `a < b`.
const before = (hay, a, b) => {
  const i = hay.indexOf(a), j = hay.indexOf(b);
  return i >= 0 && j >= 0 && i < j;
};

console.log("bug-report intake — reports from non-team users must land");

// ---------------------------------------------------------------------------
// 1. Two destinations exist, and they are the right two
// ---------------------------------------------------------------------------
check("the private team intake is still OwLLM/bug-reports",
  /const BUG_REPORT_REPO: &str = "OwLLM\/bug-reports";/.test(supportRs));
check("a PUBLIC fallback repo is defined",
  /const PUBLIC_REPORT_REPO: &str = "OwLLM\/owllm";/.test(supportRs));
check("the fallback repo is NOT the private one",
  !/const PUBLIC_REPORT_REPO: &str = "OwLLM\/bug-reports";/.test(supportRs));

// ---------------------------------------------------------------------------
// 2. The access-denied predicate — executed, not just matched
// ---------------------------------------------------------------------------
const predicate = /pub\(crate\) fn gh_status_is_access_denied\(status: u16\) -> bool \{\s*matches!\(status,([^)]*)\)/
  .exec(supportRs);
check("gh_status_is_access_denied() exists as a pure, testable predicate", !!predicate);
if (predicate) {
  const codes = predicate[1].split("|").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  const denies = (n) => codes.includes(n);
  // Run the SHIPPED status list against every case that decides the branch.
  check("403 Forbidden is an access failure -> falls back", denies(403));
  check("404 is an access failure -> falls back (GitHub masks private repos as 404)",
    denies(404));
  check("401 is an access failure -> falls back (token rejected for this repo)",
    denies(401));
  check("500 is NOT an access failure -> a server hiccup never publishes publicly",
    !denies(500));
  check("502 is NOT an access failure -> a bad gateway never publishes publicly",
    !denies(502));
  check("422 is NOT an access failure -> a malformed request never publishes publicly",
    !denies(422));
  check("201 is NOT an access failure", !denies(201));
}

// ---------------------------------------------------------------------------
// 3. The send path actually branches on it
// ---------------------------------------------------------------------------
check("the bundle upload no longer aborts the whole report with `?`",
  !/&format!\("\{dir\}\/report\.json"\),[\s\S]{0,200}?\.await\s*\n\s*\.map_err[\s\S]{0,120}?\)\?;/.test(supportRs));
check("a non-access failure on the bundle upload is still a hard error",
  /if !gh_status_is_access_denied\(e\.status\) \{\s*return Err\(/.test(supportRs));
check("an access failure files the issue on the PUBLIC repo instead",
  before(supportRs, "if !gh_status_is_access_denied(e.status)", "PUBLIC_REPORT_REPO,")
  && /gh_create_issue\(\s*&client,\s*&token,\s*PUBLIC_REPORT_REPO,/.test(supportRs));
check("the public path reports itself as public",
  /bundle_url: String::new\(\),\s*public: true,/.test(supportRs));
check("the private path still reports itself as private",
  /bundle_url,\s*public: false,/.test(supportRs));
check("SentReport carries the destination to the UI",
  /pub struct SentReport \{[\s\S]*?pub public: bool,/.test(supportRs));

// The helpers must be repo-parameterised, or the fallback would silently POST
// back to the private repo the user was just refused by.
check("gh_put_file takes the repo as a parameter",
  /async fn gh_put_file\(\s*client: &reqwest::Client,\s*token: &str,\s*repo: &str,/.test(supportRs));
check("gh_create_issue takes the repo as a parameter",
  /async fn gh_create_issue\(\s*client: &reqwest::Client,\s*token: &str,\s*repo: &str,/.test(supportRs));
check("neither helper hardcodes a repo in its URL",
  /https:\/\/api\.github\.com\/repos\/\{\}\/contents\/\{\}", repo, path/.test(supportRs)
  && /https:\/\/api\.github\.com\/repos\/\{\}\/issues", repo/.test(supportRs));
check("the failed-call status survives to the caller",
  /struct GhErr \{\s*status: u16,/.test(supportRs));

// ---------------------------------------------------------------------------
// 4. Honest UI — the old message blamed the wrong thing
// ---------------------------------------------------------------------------
check("the drawer no longer guesses 'GitHub isn't connected' on every failure",
  !/Most likely GitHub isn't connected/.test(drawerTsx));
check("the failure message shows the real error and where the copy was saved",
  /Couldn't send it: \$\{e\}/.test(drawerTsx));
check("the drawer reads the destination back",
  /issueUrl: string; bundleUrl: string; public: boolean/.test(drawerTsx));
check("a public send keeps the screenshot locally instead of dropping it",
  before(drawerTsx, "if (sent.public)", "support_export_report"));
check("it never tells the user to attach the screenshot to the PUBLIC issue",
  !/drag it into the issue/.test(drawerTsx));
check("it says the screenshot was not uploaded",
  /screenshot was NOT uploaded/.test(drawerTsx));
check("the composer discloses the public destination BEFORE the send click",
  /encrypted public issue<\/b> on github\.com\/OwLLM\/owllm/.test(drawerTsx));
check("the disclosure sits with the connected-account line, not after sending",
  before(drawerTsx, "GitHub connected as {ghLogin}", "encrypted public issue</b> on github.com/OwLLM/owllm")
  && before(drawerTsx, "encrypted public issue</b> on github.com/OwLLM/owllm", "aria-label=\"Send report\""));

// ---------------------------------------------------------------------------
// 5. The public issue must be UNREADABLE
// ---------------------------------------------------------------------------
// A public repo is the only place a stranger's own token can write, so the
// payload is sealed to the team's X25519 key before it is posted. The failure
// this guards against is subtle: the send path still compiles and still works
// if someone passes the raw title/body straight to gh_create_issue -- it just
// silently publishes the reporter's paths, projects and machine details.
check("the public issue body is built by the sealing helper",
  /let body = sealed_public_body\(&title, &body_md\)\?;/.test(supportRs));
check("the public issue does NOT post the raw body_md",
  !/gh_create_issue\(\s*&client,\s*&token,\s*PUBLIC_REPORT_REPO,\s*&title,\s*&body_md/.test(supportRs));
check("the public issue title is generic, not the user's first line",
  /PUBLIC_REPORT_REPO,\s*&public_issue_title\(&stamp\),/.test(supportRs));
check("public_issue_title carries only the timestamp",
  /fn public_issue_title\(stamp: &str\) -> String \{\s*format!\("Encrypted bug report — \{stamp\}"\)/.test(supportRs));
check("the private team path still posts the real title and body in the clear",
  /gh_create_issue\(&client, &token, BUG_REPORT_REPO, &title, &body\)/.test(supportRs));
check("an oversized report is truncated to fit, never dropped",
  /truncated: the report exceeded GitHub's issue size limit/.test(supportRs));

const sealRs = fs.readFileSync(path.join(APP, "src-tauri", "src", "support_seal.rs"), "utf8");
const decryptMjs = fs.readFileSync(path.join(APP, "scripts", "decrypt-report.mjs"), "utf8");
const libRs = fs.readFileSync(path.join(APP, "src-tauri", "src", "lib.rs"), "utf8");

check("the seal module is actually compiled into the app", /^mod support_seal;$/m.test(libRs));
check("only the PUBLIC key is embedded — no secret ships",
  /pub const SUPPORT_REPORT_PUBLIC_KEY_B64: &str = "[A-Za-z0-9+/]{42,44}=?";/.test(sealRs)
  && !/SECRET|PRIVATE_KEY/.test(sealRs.replace(/\/\/.*|secret half[\s\S]{0,80}/g, "")));

// The Rust sealer and the Node decryptor are two implementations of one wire
// format. If either drifts, every future report becomes unopenable -- and
// nothing would notice, because sealing keeps working. Pin all three values.
const rustKdf = /const KDF_CONTEXT: &\[u8\] = b"([^"]+)"/.exec(sealRs)?.[1];
const nodeKdf = /const KDF_CONTEXT = Buffer\.from\("([^"]+)"\)/.exec(decryptMjs)?.[1];
check("Rust and Node agree on the KDF context", !!rustKdf && rustKdf === nodeKdf);
const rustAlg = /const SEAL_ALG: &str = "([^"]+)"/.exec(sealRs)?.[1];
const nodeAlg = /const SEAL_ALG = "([^"]+)"/.exec(decryptMjs)?.[1];
check("Rust and Node agree on the algorithm name", !!rustAlg && rustAlg === nodeAlg);
const rustVer = /const SEAL_VERSION: u32 = (\d+)/.exec(sealRs)?.[1];
const nodeVer = /const SEAL_VERSION = (\d+)/.exec(decryptMjs)?.[1];
check("Rust and Node agree on the envelope version", !!rustVer && rustVer === nodeVer);
check("the AAD binds version, algorithm, both keys and the nonce on both sides",
  /v=\{SEAL_VERSION\};alg=\{SEAL_ALG\};epk=\{eph_pub_b64\};rpk=\{recipient_pub_b64\};n=\{nonce_b64\}/.test(sealRs)
  && /v=\$\{SEAL_VERSION\};alg=\$\{SEAL_ALG\};epk=\$\{env\.epk\};rpk=\$\{env\.rpk\};n=\$\{env\.n\}/.test(decryptMjs));
check("the harness seals with the EXACT module the app ships",
  fs.readFileSync(path.join(APP, "src-tauri", "seal-harness", "src", "main.rs"), "utf8")
    .includes('#[path = "../../src/support_seal.rs"]'));

// The frozen fixture below proves the two sides agreed ONCE. It cannot catch the
// Rust sealer reordering its KDF inputs afterwards: the old block still opens,
// the gate stays green, and every NEW report becomes permanently unopenable.
// (Measured: swapping the two h.update lines left this file reporting all
// checks passed.) So pin the derivation ORDER itself, on both sides.
const KDF_NAMES = {
  KDF_CONTEXT: "ctx", shared: "shared",
  eph_pub: "epk", epk: "epk", recipient_pub: "rpk", rpk: "rpk",
};
const rustDerive = /fn derive_key\([\s\S]*?let out = h\.finalize\(\);/.exec(sealRs)?.[0] ?? "";
const rustOrder = [...rustDerive.matchAll(/h\.update\(&?(\w+)\)/g)].map((m) => KDF_NAMES[m[1]] ?? m[1]);
const nodeDerive = /createHash\("sha256"\)((?:\.update\(\w+\))+)\.digest\(\)/.exec(decryptMjs)?.[1] ?? "";
const nodeOrder = [...nodeDerive.matchAll(/\.update\((\w+)\)/g)].map((m) => KDF_NAMES[m[1]] ?? m[1]);
check("the AEAD key folds in context, shared secret and both public keys, in that order",
  rustOrder.join(",") === "ctx,shared,epk,rpk");
check("Rust and Node derive the key in the SAME order",
  rustOrder.length === 4 && rustOrder.join(",") === nodeOrder.join(","));

// ---------------------------------------------------------------------------
// 6. EXECUTED: open a block that the real Rust sealer produced
// ---------------------------------------------------------------------------
// Sealed by src-tauri/seal-harness (i.e. by src/support_seal.rs itself) to the
// throwaway key below. That key is a TEST key with no access to anything -- the
// team's real secret is never in this repo. This proves the two implementations
// interoperate, which no source check can.
const FIXTURE_SECRET_B64 = "iNmR5ZiFQOvQ9n7/Mo6V3l13CUTFM/wUSaHz1LSEP0A=";
const FIXTURE = `-----BEGIN OWLLM SEALED REPORT-----
eyJhbGciOiJ4MjU1MTktYWVzMjU2Z2NtIiwiY3QiOiJrVmowWHd1bHR2Wmx6TkszN0ViemRHS0xB
TmdkYUZHd09mUzR3a0JnYWhVaWNZS0NrMEh0WGIzVUk5M1pKek8ydlVJa2RLQUM2Um55dWZGbmlt
SFEzaHNMU2UwbXk1TjA2TE5BTEo0VnpHMUdVMDhvaHRsc3VZcXlxT3FDMnVkUkZ3PT0iLCJlcGsi
OiI4VUFDMS8xd0s4cEhJT2MwWXVCdW1BcSs4blZzWS9MUE1MMFllK3NLeENrPSIsIm4iOiJBVWtW
Z0JSSVV1dXYwcVgyIiwicnBrIjoiWUZPbU9LaytaZWkxL3hIQmhmV0hkL0Z4VnNOYkVSK3ozaE5S
K0JhWkxqMD0iLCJ2IjoxfQ==
-----END OWLLM SEALED REPORT-----`;

const { openSealedReport } = await import(
  new URL("../../../../scripts/decrypt-report.mjs", import.meta.url).href
);
const secret = Buffer.from(FIXTURE_SECRET_B64, "base64");
let opened = null;
try { opened = JSON.parse(openSealedReport(secret, FIXTURE)); } catch (e) { opened = { error: String(e) }; }
check("the Node decryptor opens a block sealed by the shipped Rust code",
  opened?.bodyMd === "seal format v1" && opened?.title === "fixture");
check("the armored block leaks none of its plaintext",
  !FIXTURE.includes("seal format v1") && !FIXTURE.includes("fixture"));
// Negative control: a decryptor that "succeeds" on the wrong key proves nothing.
let wrongKeyThrew = false;
try {
  openSealedReport(Buffer.alloc(32, 7), FIXTURE);
} catch { wrongKeyThrew = true; }
check("a different key CANNOT open it", wrongKeyThrew);
// And the instrument must reject a tampered header rather than return garbage.
let tamperThrew = false;
try {
  const inner = FIXTURE.split("\n").filter((l) => !l.startsWith("-----")).join("");
  const env = JSON.parse(Buffer.from(inner, "base64").toString("utf8"));
  env.n = Buffer.alloc(12).toString("base64");
  openSealedReport(secret,
    `-----BEGIN OWLLM SEALED REPORT-----\n${Buffer.from(JSON.stringify(env)).toString("base64")}\n-----END OWLLM SEALED REPORT-----`);
} catch { tamperThrew = true; }
check("a tampered envelope is rejected, not silently mis-decrypted", tamperThrew);

// Deepest proof, on demand: seal a FRESH block with the real Rust module and
// open it here. Needs a Rust toolchain, so it is opt-in -- the order checks
// above are what runs on every host. Run: node <this file> --live
if (process.argv.includes("--live")) {
  const { generateKeyPairSync } = await import("node:crypto");
  const { spawnSync } = await import("node:child_process");
  const kp = generateKeyPairSync("x25519");
  const rawPub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const rawSec = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const plain = JSON.stringify({ title: "live", bodyMd: "fresh round-trip" });
  const run = spawnSync("cargo",
    ["run", "--quiet", "--manifest-path",
      path.join(APP, "src-tauri", "seal-harness", "Cargo.toml"),
      "--", rawPub.toString("base64")],
    { encoding: "utf8", shell: process.platform === "win32",
      env: { ...process.env, SEAL_HARNESS_PLAINTEXT: plain } });
  check("the live harness sealed a fresh block", run.status === 0 && /BEGIN OWLLM SEALED REPORT/.test(run.stdout || ""));
  let live = null;
  try { live = JSON.parse(openSealedReport(rawSec, run.stdout)); } catch (e) { live = { error: String(e) }; }
  check("Node opens a block the shipped Rust sealed JUST NOW",
    live?.bodyMd === "fresh round-trip" && live?.title === "live");
}

console.log(failures === 0
  ? `\nbugReportIntake: all checks passed`
  : `\nbugReportIntake: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
