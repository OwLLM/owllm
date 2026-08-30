#!/usr/bin/env node
// Regression gate for the agent-browser credential vault (save + autofill).
//
// Pins the three guarantees that make website logins work on EVERY OS:
//   1. At-rest encryption exists on macOS/Linux too (AES-256-GCM + 0600 key
//      file), not just Windows DPAPI — with legacy plaintext read compat.
//   2. Typed-login CAPTURE survives SPA logins: provisional buffer + extra
//      report triggers beyond submit/pagehide.
//   3. AUTOFILL is automatic on page load in BOTH tab shapes (framed child
//      webviews and the legacy top-level-window shape), fills only empty
//      fields, and rides the enqueue-only browser UI channel.
// Any of these silently dropping = "browser stopped saving my logins" again.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../../../src-tauri/src");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

const browser = read("browser.rs");
const vault = read("browser_vault.rs");
const crypt = read("crypt.rs");
const accounts = fs.readFileSync(path.join(HERE, "../advanced/AccountsPage.tsx"), "utf8");

let checks = 0;
// Report EVERY failure rather than exiting on the first — one run should show
// the whole picture, which is also what makes the discrimination test against
// the previous sources measurable rather than a single early bail-out.
const failures = [];
function must(cond, what) {
  checks += 1;
  if (!cond) failures.push(what);
}

// ---- 1. cross-platform at-rest encryption (crypt.rs) -----------------------
must(crypt.includes("CryptProtectData"), "Windows DPAPI protect missing");
must(crypt.includes("Aes256Gcm"), "non-Windows AES-256-GCM encryption missing");
must(crypt.includes("OWLLMSEC1"), "sealed-blob magic prefix missing");
must(crypt.includes("0o600"), "vault key file is not restricted to 0600");
must(/legacy plaintext blob/.test(crypt), "legacy plaintext read-compat dropped — old vaults would stop loading");
must(!/pub fn protect\(plain: &\[u8\]\) -> Result<Vec<u8>, String> \{\s*Ok\(plain\.to_vec\(\)\)/.test(crypt),
  "non-Windows protect() regressed to a plaintext passthrough");
must(crypt.includes("fn seal_open_roundtrip") && crypt.includes("fn wrong_key_and_tamper_fail"),
  "crypt unit tests were removed");

// ---- 2. capture reliability -----------------------------------------------
// The scanner and the transport are deliberately SPLIT:
//   * FRAME_CRED_JS  — the scanner, injected into EVERY frame.
//   * BRIDGE_JS      — the transport, main-frame-only (Tauri hardcodes
//                      for_main_frame_only:true on initialization_script).
// An iframe's document.title never reaches the window, so a sub-frame cannot
// use the EVT channel itself; it postMessages its find to the top frame. Before
// the split the scanner lived in BRIDGE_JS alone, so an iframed login (Google's
// identity iframe, most embedded OAuth) was never captured at all.
const bridgeStart = browser.indexOf("const BRIDGE_JS");
const bridge = browser.slice(bridgeStart, browser.indexOf('"##;', bridgeStart));
const frameStart = browser.indexOf("const FRAME_CRED_JS");
const frameJs = frameStart < 0 ? "" : browser.slice(frameStart, browser.indexOf('"##;', frameStart));
must(frameJs.length > 0, "FRAME_CRED_JS (the all-frames credential scanner) is missing");

// 2a. The scanner reaches every frame — the whole point of the split.
must(
  (browser.match(/\.initialization_script_for_all_frames\(FRAME_CRED_JS\)/g) || []).length === 2,
  "FRAME_CRED_JS is not injected for ALL FRAMES in both webview builders — iframed logins would go uncaptured again",
);
must(
  !/\.initialization_script\(FRAME_CRED_JS\)/.test(browser),
  "FRAME_CRED_JS injected main-frame-only — that is the exact bug the split exists to fix",
);

// 2b. Every capture trigger still exists (was in BRIDGE_JS, now in the scanner).
must(frameJs.includes('document.addEventListener("submit", emit, true)'), "submit capture trigger missing");
must(frameJs.includes('window.addEventListener("pagehide", emit)'), "pagehide capture trigger missing");
must(/addEventListener\("input"/.test(frameJs), "input listener (provisional tracking) missing");
must(/addEventListener\("click"/.test(frameJs), "submit-click capture trigger missing");
must(/e\.key === "Enter"/.test(frameJs), "Enter-key capture trigger missing");
must(/visibilitychange/.test(frameJs), "tab-hide capture trigger missing");
must(
  /timer = setTimeout\(function \(\) \{ timer = 0; emit\(\); \}, 700\)/.test(frameJs),
  "typed credentials are not persisted before fast OAuth navigation destroys the form",
);
must(frameJs.includes("__owllmLoginUser"), "multi-step login does not retain the non-secret username");

// 2c. Provisional buffer — an SPA that clears the form must not lose the login.
must(/var prov = null/.test(frameJs), "provisional login buffer missing — SPA form clears lose the login");
must(/scan\(\) \|\| prov/.test(frameJs), "emit does not fall back to the provisional buffer");

// 2d. Shadow DOM — a plain querySelectorAll cannot cross a shadow boundary, so
// a login built as a web component was invisible.
must(/shadowRoot/.test(frameJs), "scanner does not pierce shadow roots — web-component logins go uncaptured");
must(
  /function deepPw/.test(frameJs) && /input\[type=password\]/.test(frameJs),
  "shadow-root password search (deepPw) missing",
);
// The deep walk must stay OFF the hot path: it runs only when the cheap
// top-level query finds nothing, and the result is cached while still connected.
must(
  /pwEl && pwEl\.isConnected/.test(frameJs),
  "password element is not cached — the shadow walk would run on every keystroke",
);
// Events RETARGET to the shadow host at the document level, so e.target is a
// <div> and every listener bails out. This was measured, not assumed.
must(
  /composedPath\(\)/.test(frameJs),
  "listeners use e.target instead of composedPath()[0] — shadow-DOM logins never trigger a capture",
);

// 2e. Sub-frame -> top relay, and the origin must be the FRAME's own.
must(
  /window\.top\.postMessage\(\{ __owllmCred: c \}, "\*"\)/.test(frameJs),
  "sub-frame scanner does not relay its find to the top frame",
);
must(
  /d\.__owllmCred && d\.__owllmCred\.password/.test(bridge),
  "BRIDGE_JS does not accept relayed sub-frame credentials",
);
must(
  /origin: location\.origin/.test(frameJs),
  "credential is not filed under the FRAME's own origin — an embedded provider login would be filed under the framing site",
);

// 2f. Dedupe must be a SET. With a single last-seen slot two logins on one page
// ping-pong and re-report each other forever, rewriting the vault on a loop.
must(/var credSeen = \{\}/.test(bridge), "credential dedupe is not a set — repeated vault rewrites");
must(!/var credSent = ""/.test(bridge), "single-slot credential dedupe reintroduced");

must(browser.includes('if action == "cred"'), "private provider login credentials are not captured for encrypted saving");

// ---- 3. automatic autofill -------------------------------------------------
must(bridge.includes("window.__owllmAutofill = function"), "injected __owllmAutofill missing");
must(/if \(pw\.value\) return true;/.test(bridge), "only-empty guard dropped — autofill could clobber typed/engine-filled values");
must(bridge.includes("MutationObserver"), "late-form MutationObserver retry missing (SPA logins would miss autofill)");
must(vault.includes("pub fn autofill_eval_for"), "browser_vault::autofill_eval_for missing");
must(/serde_json::to_string\(&c\.username\)/.test(vault) && /serde_json::to_string\(&c\.password\)/.test(vault),
  "autofill eval does not JSON-escape values — quote injection into the eval string");
must(browser.includes("AutofillPage {"), "AutofillPage event missing from the browser UI queue");
must(/BrowserUiEvent::AutofillPage \{ id, url \} => \{\s*self\.autofills\.insert/.test(browser),
  "AutofillPage not absorbed into the UI batch");
must(/autofill_eval_for\(&url\)/.test(browser) && /content_webview_for_tab\(&app, Some\(id\)\)/.test(browser),
  "worker does not resolve the tab and inject the vault autofill");
must(vault.includes("find_for_origin_user") && vault.includes("browser_vault_autofill_tab")
  && vault.includes("autofill_eval_for_user"),
  "selected multi-account provider autofill is missing");
must(accounts.includes("Saved account") && accounts.includes("browser_vault_autofill_tab")
  && accounts.includes("selectedClaudeAccount"),
  "Accounts page does not expose the selected Claude identity");

// Fired from BOTH creation paths, gated to finished http(s) loads, and only
// ever via the enqueue-only channel (native callbacks must not touch the vault).
function fnSlice(name) {
  const start = browser.indexOf(`fn ${name}`);
  must(start >= 0, `${name} missing from browser.rs`);
  const next = browser.indexOf("\nfn ", start + 1);
  return browser.slice(start, next < 0 ? browser.length : next);
}
const attach = fnSlice("attach_tab");
const legacy = fnSlice("attach_legacy_tab");
for (const [name, slice] of [["attach_tab", attach], ["attach_legacy_tab", legacy]]) {
  must(slice.includes("PageLoadEvent::Finished"), `${name} does not gate autofill on load-finished`);
  must(slice.includes('url.starts_with("http")'), `${name} does not restrict autofill to http(s) pages`);
  must(/queue_browser_ui\(\s*&\w+\.app_handle\(\)\.clone\(\),\s*BrowserUiEvent::AutofillPage/.test(slice),
    `${name} does not queue AutofillPage through the browser UI channel`);
}

// The frontend must never receive passwords: list returns CredMeta only.
const credMeta = /pub struct CredMeta \{[\s\S]*?\n\}/.exec(vault);
must(credMeta && !credMeta[0].includes("password"),
  "CredMeta grew a password field — passwords must never reach the frontend");

if (failures.length) {
  console.error(`FAIL browser credential vault gate: ${failures.length} of ${checks} checks failed`);
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`browser credential vault gate: ${checks} checks passed`);
