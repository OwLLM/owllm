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
const framed = source.slice(source.indexOf("fn build_framed"), source.indexOf("fn build_legacy"));

function bodies(name) {
  const re = new RegExp(`\\.${name}\\(.*?\\|[^|]*\\|\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\)`, "g");
  return [...framed.matchAll(re)].map((m) => m[1]);
}

function fail(message) {
  console.error(`FAIL browser UI-thread gate: ${message}`);
  process.exit(1);
}

if (!source.includes("owllm-browser-ui-dispatch") || !source.includes("fn queue_browser_ui")) {
  fail("the cross-platform browser UI dispatcher is missing");
}

const titleCallbacks = bodies("on_document_title_changed");
const loadCallbacks = bodies("on_page_load");
const windowCallbacks = [...framed.matchAll(/\.on_window_event\(move \|[^|]*\|\s*\{([\s\S]*?)\n\s*\}\);/g)].map((m) => m[1]);
if (titleCallbacks.length !== 2 || loadCallbacks.length !== 1 || windowCallbacks.length !== 1) {
  fail(`unexpected callback shape: title=${titleCallbacks.length}, load=${loadCallbacks.length}, window=${windowCallbacks.length}`);
}

const callbacks = [...titleCallbacks, ...loadCallbacks, ...windowCallbacks];
const forbidden = /handle_chrome_event|update_chrome_bar|layout_children|\.eval\s*\(|\.navigate\s*\(|\.destroy\s*\(|\.set_(?:position|size|focus)\s*\(/;
for (const [index, body] of callbacks.entries()) {
  if (!body.includes("queue_browser_ui")) fail(`callback ${index + 1} does not enqueue its work`);
  if (forbidden.test(body)) fail(`callback ${index + 1} directly performs native window/webview work`);
}
if (!titleCallbacks[1].includes("capture_reply")) {
  fail("the page-title callback no longer captures browser tool replies");
}
if (!source.includes("for event in rx.try_iter()") || !source.includes("batch.layout")) {
  fail("resize/title burst coalescing is missing");
}

console.log("PASS browser callbacks are enqueue-only and cross-platform UI work is coalesced off-thread");
