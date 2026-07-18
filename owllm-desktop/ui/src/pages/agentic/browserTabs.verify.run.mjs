// Verify harness: agent-browser tabs + typed-login capture + OwLLM chrome.
//
// Guards the multi-tab browser window (browser.rs), the chrome bar's tab
// strip / app icon / app-header colour (browser-chrome.html), and the
// auto-capture of logins typed in the browser into the encrypted vault
// (browser_vault.rs). Source-level checks — the window itself is native.
//
// Run: node ui/src/pages/agentic/browserTabs.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..", "..");
// CRLF-normalize reads: Windows checkouts materialize LF-committed sources as
// CRLF, and multi-line needles with \n must still match (recurring lesson).
const readLF = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const browserRs = readLF(path.join(root, "src-tauri", "src", "browser.rs"));
const vaultRs = readLF(path.join(root, "src-tauri", "src", "browser_vault.rs"));
const chromeHtml = readLF(path.join(root, "ui", "public", "browser-chrome.html"));

let failures = 0;
function check(cond, label) {
  if (cond) console.log(`  PASS ${label}`);
  else { failures++; console.log(`  FAIL ${label}`); }
}

console.log("browserTabs.verify — multi-tab browser + typed-login capture + chrome");

// --- multi-tab window (browser.rs) ---------------------------------------
check(browserRs.includes("struct Tabs") && browserRs.includes("static TABS:"),
  "browser.rs keeps per-window tab state (order + active + titles)");
check(browserRs.includes("fn tab_label(id: u64)"),
  "each tab is its own labelled content webview");
check(browserRs.includes("fn next_active_after_close"),
  "closing a tab has an explicit next-active rule");
check(/"tabnew"\s*=>/.test(browserRs) && /"tabsel"\s*=>/.test(browserRs) && /"tabclose"\s*=>/.test(browserRs),
  "chrome-bar tab events (new/select/close) are handled");
check(browserRs.includes("fn attach_tab(") && browserRs.includes("fn new_tab(") &&
      browserRs.includes("fn activate_tab(") && browserRs.includes("fn close_tab("),
  "tab lifecycle functions exist (attach/new/activate/close)");
check(browserRs.includes("PARK_X"),
  "inactive tabs are parked offscreen (cross-platform, no hide())");
check(browserRs.includes("__owllmTabsSet"),
  "Rust pushes the live tab list into the chrome strip");
check(browserRs.includes("const CHROME_H: f64 = 66.0"),
  "chrome bar is two rows (28px tab strip + 38px nav)");
check(/fn content_webview[\s\S]{0,400}tab_label\(id\)/.test(browserRs),
  "agent commands resolve the ACTIVE tab's webview");

// --- typed-login capture --------------------------------------------------
check(browserRs.includes("function reportCred()") &&
      browserRs.includes('addEventListener("submit", reportCred, true)') &&
      browserRs.includes('addEventListener("pagehide", reportCred)'),
  "bridge reports typed logins on form submit and page leave");
check((browserRs.match(/BrowserUiEvent::TypedLogin \{ data \}/g) || []).length >= 2 &&
      /for data in batch\.creds[\s\S]{0,200}store_typed_login/.test(browserRs),
  "both window shapes (framed tabs + legacy fallback) route creds to the vault");
check(vaultRs.includes("pub fn store_typed_login"),
  "vault exposes store_typed_login");
check(/store_typed_login[\s\S]{0,700}password\.is_empty\(\)[\s\S]{0,200}return Ok\(\(\)\)/.test(vaultRs),
  "blank passwords are ignored, never saved");
check(/store_typed_login[\s\S]{0,900}upsert\(/.test(vaultRs),
  "typed logins merge through the same upsert path as manual/imported creds");

// --- chrome bar (browser-chrome.html) ------------------------------------
const logoAt = chromeHtml.indexOf('<img id="logo" src="app-icon.png"');
const ttlAt = chromeHtml.indexOf('id="ttl"');
check(logoAt !== -1 && ttlAt !== -1 && logoAt < ttlAt,
  "the launcher app icon renders before the OwLLM title");
check(fs.existsSync(path.join(root, "ui", "public", "app-icon.png")),
  "app-icon.png is bundled with the chrome page");
check(chromeHtml.includes("0.70 * r + 0.30 * 28") && chromeHtml.includes("0.70 * b + 0.30 * 68"),
  "chrome bar colour uses the app header's --bg-header recipe (70% accent over #1c2244)");
check(chromeHtml.includes("__owllmTabsSet"),
  "chrome renders the tab strip Rust pushes");
check(chromeHtml.includes('evt("tabnew")') && chromeHtml.includes('evt("tabsel", t.id)') &&
      chromeHtml.includes('evt("tabclose", t.id)'),
  "tab pills + New tab button emit the tab events");
const copyRows = chromeHtml.match(/"(en|zh-CN|ko|ja|ar|it|hi|pt)":\s*\[[^\]]+\]/g) || [];
check(copyRows.length === 8 && copyRows.every((r) => (r.match(/"/g) || []).length >= 2 * 9 + 2),
  "all eight languages localize the chrome incl. New tab / Close tab");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
