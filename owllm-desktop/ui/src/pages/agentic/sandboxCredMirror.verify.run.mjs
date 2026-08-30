#!/usr/bin/env node
// Guards the agentic-team 401 on subscription CLIs.
//
// THE BUG THIS PINS: an isolated (WSL) project runs `claude`/`codex` INSIDE the
// distro against a COPY of the Windows credentials. Only a re-mirror can keep
// that copy alive. `accounts_refresh_sandbox_creds` was supposed to do it, but
// it called the ASYNC `sandbox_sync_logins` from inside a blocking closure as
// `let _ = ...` — which merely CONSTRUCTS a future and drops it. `let _`
// suppresses the `#[must_use]` warning, so it compiled silently and the mirror
// NEVER RAN. Measured: sandbox token expired 18:04 with no refreshToken while
// the Windows token was valid until 02:12 — the team 401'd, chat did not.
//
// These checks fail on that shape and pass on the blocking call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const read = (rel) => fs.readFileSync(path.join(APP, rel), "utf8");

let failed = 0;
function check(name, condition) {
  if (condition) console.log(`PASS ${name}`);
  else { failed += 1; console.error(`FAIL ${name}`); }
}

const accounts = read("src-tauri/src/accounts.rs");
const sandbox = read("src-tauri/src/sandbox.rs");
const agentsPage = read("ui/src/pages/agentic/AgentsPage.tsx");
const dispatch = read("ui/src/pages/agentic/dispatch.ts");

// ── 1. The blocking entry point exists and is the one the mirror uses ───────
check(
  "sandbox exposes a BLOCKING login-mirror entry point",
  /pub\(crate\)\s+fn\s+sandbox_sync_logins_blocking\s*\(/.test(sandbox),
);
check(
  "the blocking entry delegates to the real impl",
  /fn\s+sandbox_sync_logins_blocking[\s\S]{0,400}?sync_logins_impl\s*\(/.test(sandbox),
);

const refreshFn = (() => {
  const at = accounts.indexOf("pub async fn accounts_refresh_sandbox_creds");
  if (at < 0) return "";
  // Bounded slice — the whole command body.
  return accounts.slice(at, at + 2000);
})();
check("accounts_refresh_sandbox_creds exists", refreshFn.length > 0);
check(
  "the sandbox cred refresh calls the BLOCKING mirror",
  /sandbox_sync_logins_blocking\s*\(/.test(refreshFn),
);
check(
  "the sandbox cred refresh does NOT call the async mirror (dropped future)",
  !/[^_]sandbox_sync_logins\s*\(/.test(refreshFn),
);
check(
  "the mirror result is inspected, not discarded",
  /match\s+crate::sandbox::sandbox_sync_logins_blocking/.test(refreshFn) ||
  /sandbox_sync_logins_blocking\s*\([^)]*\)\s*\{?\s*\n?\s*(Ok|\?)/.test(refreshFn),
);
check(
  "a failed mirror cannot report success",
  /Err\s*\(_\)\s*=>\s*false/.test(refreshFn),
);

// ── 2. Tree-wide: no blocking caller may drop the async mirror's future ─────
// `let _ = <async fn>(...)` is the exact silent no-op that caused this.
const rustDir = path.join(APP, "src-tauri/src");
const rustFiles = fs.readdirSync(rustDir).filter((f) => f.endsWith(".rs"));
const droppers = [];
// Comments are stripped first: the doc comment that EXPLAINS this anti-pattern
// quotes it verbatim, and a gate that trips on its own documentation is noise.
const stripRustComments = (src) => src
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");
for (const f of rustFiles) {
  const src = stripRustComments(fs.readFileSync(path.join(rustDir, f), "utf8"));
  // Any `let _ = ...sandbox_sync_logins(` — with or without a crate path.
  if (/let\s+_\s*(?::[^=]+)?=\s*(?:crate::)?(?:sandbox::)?sandbox_sync_logins\s*\(/.test(src)) {
    droppers.push(f);
  }
}
check(
  `no file drops the async sandbox_sync_logins future${droppers.length ? ` (offenders: ${droppers.join(", ")})` : ""}`,
  droppers.length === 0,
);

// The async command must still exist for the Accounts page button.
check(
  "the async Tauri command is still registered for the Accounts UI",
  /pub async fn sandbox_sync_logins\s*\(/.test(sandbox),
);

// ── 3. Every auth retry must be able to REACH the sandbox (needs cwd) ───────
// withCliAuthRetry re-mirrors into the distro only when it is given the cwd;
// without it, is_isolated(None) short-circuits and the retry can never repair
// an isolated project. One Gemini call site shipped without it.
function callSites(src, file) {
  const out = [];
  const re = /withCliAuthRetry\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (depth > 0 && j < src.length) {
      const ch = src[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      j += 1;
    }
    const body = src.slice(m.index + m[0].length, j - 1);
    let d = 0;
    let commas = 0;
    for (const ch of body) {
      if ("([{".includes(ch)) d += 1;
      else if (")]}".includes(ch)) d -= 1;
      else if (ch === "," && d === 0) commas += 1;
    }
    out.push({ file, line: src.slice(0, m.index).split("\n").length, args: commas + 1 });
  }
  return out;
}
const sites = [
  ...callSites(agentsPage, "AgentsPage.tsx"),
  ...callSites(dispatch, "dispatch.ts"),
];
// The retry funnel lives in dispatch.ts — the ONE dispatch stack (AgentsPage's
// ~1000-line copy was collapsed onto it 2026-08-14; any AgentsPage site that
// remains must still pass cwd, but none are REQUIRED there anymore).
check("withCliAuthRetry call sites were found", callSites(dispatch, "dispatch.ts").length >= 9);
// Claude was the one backend with NO retry funnel in dispatch.ts (drift item
// #1 of the census): Code page / bridge Claude-sub calls got no mid-run 401
// backoff, no refusal detection, no OOM diagnosis. All four Claude CLI call
// sites (stream + one-shot, forced-sub + no-key fallback) must ride it now.
check(
  "the dispatch.ts Claude branch rides withCliAuthRetry (all four call sites)",
  (dispatch.match(/withCliAuthRetry\("claude_cli"/g) || []).length >= 4,
);
// …and its warm-ups pass the cwd so a sandboxed project re-mirrors creds.
check(
  "the dispatch.ts Claude warm-ups pass the cwd (sandbox re-mirror)",
  !/ensureCliWarm\("claude_cli"\)/.test(dispatch)
    && (dispatch.match(/ensureCliWarm\("claude_cli", claudeCwd\)/g) || []).length >= 2,
);
const missingCwd = sites.filter((s) => s.args < 4);
check(
  `every withCliAuthRetry passes cwd${missingCwd.length ? ` (offenders: ${missingCwd.map((s) => `${s.file}:${s.line}`).join(", ")})` : ""}`,
  missingCwd.length === 0,
);

// ── 4. The warm path still re-mirrors, proactively and reactively ──────────
check(
  "ensureCliWarm re-mirrors creds into the sandbox",
  /accounts_refresh_sandbox_creds/.test(dispatch),
);
check(
  "the 401 retry force-refreshes the warm before retrying",
  /clearCliWarm\(backend\);\s*await ensureCliWarm\(backend, cwd\)/.test(dispatch),
);
check(
  "withCliAuthRetry accepts a cwd so the re-warm can reach the distro",
  /export async function withCliAuthRetry[\s\S]{0,600}?cwd\?:\s*string\s*\|\s*null/.test(dispatch),
);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nsandboxCredMirror: all checks passed");
