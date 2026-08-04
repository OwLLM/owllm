#!/usr/bin/env node
// Regression gate for the native Agent Browser deadlock fixed after v0.8.75.
// WebView callbacks share the app's native UI thread on WebView2, WKWebView,
// and WebKitGTK. They may capture data and enqueue work, but must never call a
// Window/Webview operation directly or every OwLLM window can freeze together.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const browserPath = path.join(APP, "src-tauri/src/browser.rs");
const source = fs.readFileSync(browserPath, "utf8");
// Multi-tab shape: the chrome bar + window handler live in build_framed; each
// tab's content webview (title/load callbacks) is built in attach_tab.
const framed = source.slice(source.indexOf("fn build_framed"), source.indexOf("fn build_legacy"));
const attach = source.slice(source.indexOf("fn attach_tab"), source.indexOf("fn new_tab"));

function bodies(slice, name) {
  const re = new RegExp(`\\.${name}\\(.*?\\|[^|]*\\|\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\)`, "g");
  return [...slice.matchAll(re)].map((m) => m[1]);
}

function fail(message) {
  console.error(`FAIL browser UI-thread gate: ${message}`);
  process.exit(1);
}

if (!source.includes("owllm-browser-ui-dispatch") || !source.includes("fn queue_browser_ui")) {
  fail("the cross-platform browser UI dispatcher is missing");
}

const chromeNavigation = bodies(framed, "on_navigation");
const chromeLoad = bodies(framed, "on_page_load");
const tabTitle = bodies(attach, "on_document_title_changed");
const tabLoad = bodies(attach, "on_page_load");
const windowCallbacks = [...framed.matchAll(/\.on_window_event\(move \|[^|]*\|\s*\{([\s\S]*?)\n\s*\}\);/g)].map((m) => m[1]);
if (chromeNavigation.length !== 1 || chromeLoad.length !== 1 || tabTitle.length !== 1 ||
    tabLoad.length !== 1 || windowCallbacks.length !== 1) {
  fail(`unexpected callback shape: chrome navigation=${chromeNavigation.length}, chrome load=${chromeLoad.length}, ` +
       `tab title=${tabTitle.length}, tab load=${tabLoad.length}, window=${windowCallbacks.length}`);
}

const callbacks = [...chromeNavigation, ...chromeLoad, ...tabTitle, ...tabLoad, ...windowCallbacks];
// on_tab_title/push_tabs eval into the chrome webview and store_typed_login
// does vault I/O — all must be reached only via the dispatcher, never called
// from inside a native callback.
const forbidden = /handle_chrome_event|update_chrome_bar|layout_children|on_tab_title|push_tabs\s*\(|store_typed_login|\.eval\s*\(|\.navigate\s*\(|\.destroy\s*\(|\.set_(?:position|size|focus)\s*\(/;
for (const [index, body] of callbacks.entries()) {
  if (!body.includes("queue_browser_ui")) fail(`callback ${index + 1} does not enqueue its work`);
  if (forbidden.test(body)) fail(`callback ${index + 1} directly performs native window/webview work`);
}
if (!tabTitle[0].includes("capture_reply")) {
  fail("the tab-title callback no longer captures browser tool replies");
}
if (!source.includes("for event in rx.try_iter()") || !source.includes("batch.layout")) {
  fail("resize/title burst coalescing is missing");
}
// The dispatcher must actually perform the queued tab work.
if (!/for \(id, title\) in batch\.tab_titles/.test(source) || !/batch\.push_tabs/.test(source) ||
    !/for data in batch\.creds/.test(source)) {
  fail("the dispatcher does not drain tab-title / push-tabs / typed-login events");
}

console.log("PASS browser callbacks are enqueue-only and cross-platform UI work is coalesced off-thread");
