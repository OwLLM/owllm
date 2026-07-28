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

let checks = 0;
function must(cond, what) {
  checks += 1;
  if (!cond) {
    console.error(`FAIL browser credential vault gate: ${what}`);
    process.exit(1);
  }
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

// ---- 2. capture reliability (BRIDGE_JS in browser.rs) ----------------------
const bridgeStart = browser.indexOf("const BRIDGE_JS");
const bridge = browser.slice(bridgeStart, browser.indexOf('"##;', bridgeStart));
must(bridge.includes('document.addEventListener("submit", reportCred, true)'), "submit capture trigger missing");
must(bridge.includes('window.addEventListener("pagehide", reportCred)'), "pagehide capture trigger missing");
must(bridge.includes("__owllmProv"), "provisional login buffer missing — SPA form clears lose the login");
must(bridge.includes('grabCred() || window.__owllmProv'), "reportCred does not fall back to the provisional buffer");
must(/addEventListener\("input"/.test(bridge), "input listener (provisional tracking) missing");
must(/addEventListener\("click"/.test(bridge), "submit-click capture trigger missing");
must(/e\.key === "Enter"/.test(bridge), "Enter-key capture trigger missing");
must(/visibilitychange/.test(bridge), "tab-hide capture trigger missing");

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

console.log(`browser credential vault gate: ${checks} checks passed`);
