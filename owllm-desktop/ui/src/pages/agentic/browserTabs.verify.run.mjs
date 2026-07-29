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
const localTools = readLF(path.join(root, "ui", "src", "pages", "agentic", "localTools.ts"));
const gatewayRs = readLF(path.join(root, "src-tauri", "src", "mcp_gateway.rs"));
const libRs = readLF(path.join(root, "src-tauri", "src", "lib.rs"));
const browserPanel = readLF(path.join(root, "ui", "src", "pages", "agentic", "BrowserPanel.tsx"));

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
  "inactive framed tabs are parked offscreen without losing their page state");
check(browserRs.includes("fn attach_legacy_tab(") &&
      browserRs.includes("WebviewWindowBuilder::new(app, tab_label(id), initial_url)") &&
      browserRs.includes(".visible(active)") &&
      /fn activate_tab[\s\S]{0,2500}win\.hide\(\)/.test(browserRs),
  "Linux safety fallback keeps independent top-level WebViews and shows only the selected tab");
check(browserRs.includes("ProcessModel::MultipleSecondaryProcesses") &&
      /fn attach_legacy_tab[\s\S]{0,900}about:blank[\s\S]{0,5000}linux_configure_browser_webview/.test(browserRs),
  "Linux configures browser process isolation before loading an internet page");
check(/linux_configure_browser_webview[\s\S]{0,3000}connect_web_process_terminated[\s\S]{0,1800}webview\.reload\(\)/.test(browserRs) &&
      browserRs.includes("browser-webkit.log"),
  "a failed Linux browser renderer is recovered and logged inside its own tab");
check(libRs.includes("MAIN_WINDOW_CLOSE_REQUESTED") &&
      /ExitRequested \{ code, api,[\s\S]{0,350}app\.get_window\("main"\)\.is_some\(\)[\s\S]{0,500}api\.prevent_exit\(\)/.test(libRs),
  "an auxiliary browser failure cannot request a clean whole-app exit");
check(/fn destroy_browser_windows[\s\S]{0,900}tabs\.order\.clone\(\)[\s\S]{0,500}window\.destroy\(\)/.test(browserRs),
  "stopping or rebuilding closes every platform-specific tab window");
check(browserRs.includes("__owllmTabsSet"),
  "Rust pushes the live tab list into the chrome strip");
// 58px identity strip (30px taller than a plain tab bar, so the open page's
// real logo reads as identity, not decoration — user spec 2026-07-29) over a
// 38px nav toolbar. Unchanged intent: the height Rust reserves for the chrome
// webview must match the bar the HTML actually draws.
check(browserRs.includes("const CHROME_H: f64 = 96.0"),
  "chrome bar is two rows (58px identity strip + 38px nav toolbar)");
check(/fn content_webview_for_tab[\s\S]{0,500}tab_id\.or_else\(active_tab_id\)[\s\S]{0,300}tab_label\(id\)/.test(browserRs),
  "agent commands resolve an explicit tab id before falling back to the active tab");
check(/pub fn browser_cmd[\s\S]{0,500}tab_id_from_params[\s\S]{0,250}content_webview_for_tab/.test(browserRs),
  "every DOM action captures its target tab before navigation or evaluation");
check(browserRs.includes("pub fn browser_list_tabs") &&
      browserRs.includes("pub fn browser_select_tab") &&
      browserRs.includes("pub fn browser_close_tab"),
  "agents can list, select, and close tabs explicitly");
check(/pub fn browser_open_tab[\s\S]{0,900}new_tab\(&app, parsed\.as_str\(\), activate\)/.test(browserRs),
  "agent browser_open creates a separate addressable tab");
check(/fn open_web_url[\s\S]{0,800}new_tab\(app, parsed\.as_str\(\), true\)/.test(browserRs),
  "user-facing app links create a new selected tab instead of replacing the active page");
check(/\.on_new_window\([\s\S]{0,500}BrowserUiEvent::OpenTab[\s\S]{0,200}NewWindowResponse::Deny/.test(browserRs),
  "target=_blank and window.open are captured as managed tabs, not unmanaged popups");
check(/OpenTab \{[\s\S]{0,150}url: String,[\s\S]{0,100}activate: bool/.test(browserRs) &&
      /open_tabs: Vec<\(String, bool\)>/.test(browserRs),
  "simultaneous native new-tab requests remain separate queued operations");
check(libRs.includes("browser::browser_open_tab") && libRs.includes("browser::browser_list_tabs") &&
      libRs.includes("browser::browser_select_tab") && libRs.includes("browser::browser_close_tab"),
  "tab commands are registered with the desktop invoke handler");
check(localTools.includes('name: "browser_tabs"') && localTools.includes('name: "browser_tab_select"') &&
      localTools.includes('name: "browser_tab_close"') &&
      /case "browser_snapshot"[\s\S]{0,250}tab_id: call\.args\.tab_id/.test(localTools),
  "local/API agents receive tab management and tab-addressed DOM tools");
check(gatewayRs.includes('"browser_tabs" => crate::browser::browser_list_tabs') &&
      /"browser_snapshot"[\s\S]{0,220}as_optional_index\(args, "tab_id"\)/.test(gatewayRs),
  "CLI/MCP agents receive the same tab management and tab-id routing");
check(/status\?\.tabs/.test(browserPanel) && /browserTabs\.map\(/.test(browserPanel) && browserPanel.includes('invoke("browser_select_tab"') &&
      browserPanel.includes('invoke("browser_close_tab"'),
  "the in-app user browser panel exposes the same open/select/close tab surface");
check(/const navigate[\s\S]{0,350}browser_open_tab[\s\S]{0,100}activate: true/.test(browserPanel),
  "URLs opened by the user panel create selected tabs instead of replacing the current tab");

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
// The site tile (open page's real logo + name) must live INSIDE the identity
// strip that grew by 30px — not in a separate row below (user spec 2026-07-29,
// after a regression put it in #navrow beneath the header).
const tabsRowStart = chromeHtml.indexOf('<div id="tabsrow">');
const navRowStart = chromeHtml.indexOf('<div id="navrow">');
const siteAt = chromeHtml.indexOf('<div id="site">');
check(tabsRowStart !== -1 && navRowStart !== -1 && tabsRowStart < navRowStart,
  "chrome structure has an identity strip above the nav toolbar");
check(siteAt !== -1 && siteAt > tabsRowStart && siteAt < navRowStart,
  "the big site tile renders inside the identity strip, not in a row below it");
check(chromeHtml.slice(navRowStart).match(/id="site"|id="sitemark"|id="sitename"/) === null,
  "the nav toolbar never carries the site tile again (regression guard)");
check(/#tabsrow\s*\{[^}]*height:\s*58px/.test(chromeHtml),
  "identity strip is the 58px height CHROME_H reserves for it");
check(/#sitemark\s*\{[^}]*width:\s*46px[^}]*height:\s*46px/.test(chromeHtml),
  "site logo tile is drawn at the promised big size");
check(chromeHtml.includes('evt("tabnew")') && chromeHtml.includes('evt("tabsel", t.id)') &&
      chromeHtml.includes('evt("tabclose", t.id)'),
  "tab pills + New tab button emit the tab events");
const copyRows = chromeHtml.match(/"(en|zh-CN|ko|ja|ar|it|hi|pt)":\s*\[[^\]]+\]/g) || [];
check(copyRows.length === 8 && copyRows.every((r) => (r.match(/"/g) || []).length >= 2 * 9 + 2),
  "all eight languages localize the chrome incl. New tab / Close tab");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
