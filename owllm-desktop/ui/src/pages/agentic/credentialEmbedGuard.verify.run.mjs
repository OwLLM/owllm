#!/usr/bin/env node
// CREDENTIAL-EMBED GUARD — a ship-gate tripwire (auto-run by smoke-matrix.mjs).
//
// WHY THIS EXISTS: user API keys / account credentials have shipped INSIDE the
// installer more than once (a bundled resource path or a `git add -A` sweep
// dragged the dev's runtime vault into a bundled/tracked file). A clean install
// on someone else's PC then had working keys that were never theirs. This gate
// makes that class impossible to ship silently: it fails the build if any
// credential material could reach a release artifact or the repository.
//
// Four independent checks, all fail-closed:
//   A) CONFIG GUARD  — tauri.conf.json `bundle.resources` may not reference any
//      credential/runtime path (vault, .owllm state, WebView2 profile, auth
//      files, secrets, private keys). Blocks the "new glob leaks creds" vector.
//   B) VALUE SCAN    — every file that will actually be bundled is scanned for
//      real secret VALUES (provider key prefixes, private-key blocks, cloud
//      tokens). Blocks the "a secret physically sits in a shipped file" vector.
//   C) TRACKED NAMES — no git-tracked file may have a credential-typed filename
//      (vault.json, auth.json, *.pem, owllm_agent_secrets.json, .env, …).
//      Blocks the "a vault got committed and a future glob will ship it" vector.
//   D) TRACKED VALUES — every git-tracked text file is scanned for real secret
//      values, plus first-party source is checked for literal credential
//      assignments and passwords piped to sudo. Blocks secrets in build helpers
//      and other files outside Tauri's current bundle resource list.
//
// Exit 0 = nothing embeddable. Non-zero = a finding + exactly where it is.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../.."); // owllm-desktop
const REPO = path.resolve(APP, ".."); // repo root
const TAURI = path.join(APP, "src-tauri");

const findings = []; // {check, where, detail}
const fail = (check, where, detail) => findings.push({ check, where, detail });

// ---- secret VALUE patterns (high-signal; length-gated to avoid false hits) ---
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key (sk-ant-)"],
  [/sk-proj-[A-Za-z0-9_-]{20,}/, "OpenAI project key (sk-proj-)"],
  [/sk-[A-Za-z0-9]{32,}/, "OpenAI-style secret key (sk-)"],
  [/AIzaSy[A-Za-z0-9_-]{20,}/, "Google API key (AIzaSy)"],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token (ghp_/gho_/…)"],
  [/github_pat_[A-Za-z0-9_]{40,}/, "GitHub fine-grained PAT"],
  [/xai-[A-Za-z0-9]{20,}/, "xAI API key (xai-)"],
  [/gsk_[A-Za-z0-9]{20,}/, "Groq API key (gsk_)"],
  [/pplx-[A-Za-z0-9]{20,}/, "Perplexity API key (pplx-)"],
  [/glpat-[A-Za-z0-9_-]{20,}/, "GitLab PAT (glpat-)"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id (AKIA)"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "private key block"],
];
const CREDENTIAL_ASSIGNMENT_RE =
  /\b(?:sudo[_-]?pass(?:word)?|password|passwd|passphrase|secret|token|api[_-]?key)\b\s*[:=]\s*(["'])([^\r\n"']{4,})\1/gi;
const SUDO_STDIN_LITERAL_RE =
  /\b(?:echo|printf)\s+(["'])([^\r\n"']{4,})\1[^\r\n|]*\|\s*sudo\s+-S\b/gi;
const PLACEHOLDER_VALUE_RE =
  /(?:example|sample|dummy|fake|test|mock|redact|mask|placeholder|your[_ -]|change[_ -]?me|password|passphrase|secret|token|api[_ -]?key|x{4,}|\{\{|\$\{|<[^>]+>|\bnone\b|\bnull\b)/i;
const VENDORED_PATH_RE =
  /(?:^|\/)(?:node_modules|vendor|third[_-]?party|target|dist|\.tmp_wheels)(?:\/|$)/i;

// ---- credential/runtime paths that must never be bundled or committed --------
const CRED_PATH_SUBSTRINGS = [
  "user_data",
  "browser_profile",
  "ebwebview",
  "login data",
  "owllm_state",
  "agent_secrets",
  "brainstorm.json",
  ".owllm-inbox",
];
const CRED_FILENAME_RE =
  /^(?:(?:.*[._-])?vault[^/]*\.(?:json|db|ya?ml)|.*credentials?\.(?:json|ya?ml|txt|db)|auth\.json|owllm_agent_secrets\.json|login data|\.env|id_rsa|id_ed25519|.*\.pem|.*\.pfx|.*\.p12)$/i;
// A resource glob is suspect if it names any credential/runtime concept.
const RESOURCE_DENY_RE =
  /(vault|credential|secret|\.owllm|user_data|browser_profile|ebwebview|login[ _]data|owllm_state|agent_secrets|auth\.json|\.env|\.pem|\.pfx|\.p12|id_rsa|id_ed25519)/i;

const isProbablyText = (buf) => {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false; // NUL → binary
  return true;
};

function scanFileForSecrets(abs, rel) {
  const base = path.basename(abs);
  if (CRED_FILENAME_RE.test(base)) {
    fail("B", rel, `bundled file has a credential-typed name (${base})`);
    return;
  }
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return;
  }
  if (buf.length > 5 * 1024 * 1024 || !isProbablyText(buf)) return; // skip big/binary
  const text = buf.toString("utf8");
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) fail("B", rel, `contains ${label}`);
  }
}

function scanTrackedTextForSecrets(abs, rel) {
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return;
  }
  if (buf.length > 5 * 1024 * 1024 || !isProbablyText(buf)) return;
  const text = buf.toString("utf8");
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) fail("D", rel, `contains ${label}`);
  }
  if (VENDORED_PATH_RE.test(rel)) return;

  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT_RE)) {
    const value = match[2];
    if (PLACEHOLDER_VALUE_RE.test(value) || /[$\\]/.test(value)) continue;
    fail("D", rel, "contains a literal credential assignment");
  }
  for (const match of text.matchAll(SUDO_STDIN_LITERAL_RE)) {
    const value = match[2];
    if (PLACEHOLDER_VALUE_RE.test(value) || /[$\\]/.test(value)) continue;
    fail("D", rel, "pipes a literal credential to sudo");
  }
}

// Expand one tauri resource entry (relative to src-tauri) into concrete files.
function expandResource(entry) {
  const files = [];
  const star = entry.indexOf("*");
  if (star === -1) {
    const abs = path.resolve(TAURI, entry);
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, files);
      else files.push(abs);
    }
    return files;
  }
  // Root = everything before the last separator that precedes the first star.
  const head = entry.slice(0, star);
  const sep = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
  const rootRel = sep === -1 ? "." : head.slice(0, sep);
  const rootAbs = path.resolve(TAURI, rootRel);
  if (!fs.existsSync(rootAbs)) return files;
  walk(rootAbs, files); // over-approximate: scan the whole matched subtree
  return files;
}

function walk(dir, out) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

// ---- A) config guard --------------------------------------------------------
let resources = [];
try {
  const conf = JSON.parse(fs.readFileSync(path.join(TAURI, "tauri.conf.json"), "utf8"));
  resources = (conf.bundle && conf.bundle.resources) || [];
} catch (e) {
  fail("A", "src-tauri/tauri.conf.json", `unreadable bundle config: ${e.message}`);
}
for (const entry of resources) {
  if (RESOURCE_DENY_RE.test(String(entry))) {
    fail("A", "tauri.conf.json bundle.resources", `credential/runtime path bundled: "${entry}"`);
  }
}

// ---- B) value scan of every bundled file ------------------------------------
const seen = new Set();
for (const entry of resources) {
  for (const abs of expandResource(entry)) {
    if (seen.has(abs)) continue;
    seen.add(abs);
    scanFileForSecrets(abs, path.relative(REPO, abs).replace(/\\/g, "/"));
  }
}

// ---- C/D) tracked filenames and text values ---------------------------------
const ls = spawnSync("git", ["-C", REPO, "ls-files", "-z"], {
  encoding: "utf8",
  timeout: 60_000,
});
if (ls.status === 0 && ls.stdout) {
  for (const rel of ls.stdout.split("\0")) {
    if (!rel) continue;
    const base = path.basename(rel).toLowerCase();
    if (base === ".env.example" || base === ".env.sample" || base === ".env.template") continue;
    if (CRED_FILENAME_RE.test(base)) {
      fail("C", rel, `git-tracked credential-typed file (${base})`);
      continue;
    }
    if (CRED_PATH_SUBSTRINGS.some((s) => rel.toLowerCase().includes(s))) {
      fail("C", rel, "git-tracked runtime/credential path");
    }
    scanTrackedTextForSecrets(path.join(REPO, rel), rel.replace(/\\/g, "/"));
  }
} else {
  fail("C", "repository", "git ls-files unavailable; tracked filenames could not be checked");
  fail("D", "repository", "git ls-files unavailable; tracked values could not be checked");
}

// Keep the generic assignment tripwire executable without committing a literal
// credential fixture that the tracked-value scan would correctly reject.
const assignmentSelfTest = ["SUDO_", 'PASS="', "not-a-placeholder", '"'].join("");
CREDENTIAL_ASSIGNMENT_RE.lastIndex = 0;
if (!CREDENTIAL_ASSIGNMENT_RE.test(assignmentSelfTest)) {
  fail("D", "credential guard self-test", "literal credential assignment detector is inactive");
}

// ---- report -----------------------------------------------------------------
const CHECK_LABEL = {
  A: "config guard (no credential path in bundle.resources)",
  B: "value scan (no secret in a bundled file)",
  C: "tracked names (no credential-typed file committed)",
  D: "tracked values (no secret in any tracked text file)",
};
for (const c of ["A", "B", "C", "D"]) {
  const hits = findings.filter((f) => f.check === c);
  if (hits.length === 0) {
    console.log(`PASS ${c}: ${CHECK_LABEL[c]}`);
  } else {
    for (const h of hits) console.error(`FAIL ${c}: ${h.where} — ${h.detail}`);
  }
}

if (findings.length > 0) {
  console.error(
    `\ncredential-embed guard: ${findings.length} finding(s) — credentials must never ship in a build or repo. Remove them and keep secrets in per-user local runtime storage only.`,
  );
  process.exitCode = 1;
} else {
  console.log(`credential-embed guard: 4/4 checks clean (${seen.size} bundled files scanned)`);
}
