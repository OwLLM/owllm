// Regression guard for native browser downloads (WhatsApp documents included).
// Auto-discovered by scripts/smoke-matrix.mjs via *.verify.run.mjs.
// Run from owllm-desktop/: node ui/src/utils/browserDownloads.verify.run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../../..");
const browser = fs.readFileSync(path.join(DESKTOP, "src-tauri/src/browser.rs"), "utf8");
const chrome = fs.readFileSync(path.join(DESKTOP, "ui/public/browser-chrome.html"), "utf8");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`OK ${message}`);
}

check((browser.match(/\.on_download\(/g) || []).length === 2,
  "both framed and legacy browser WebViews report native downloads");
check(browser.includes("BrowserUiEvent::DownloadFinished")
  && browser.includes("show_download_result"),
  "download completion leaves the native callback and reaches the UI worker");
check(chrome.includes("window.__owllmDownloadSet")
  && chrome.includes('id="downloadToast"')
  && chrome.includes('role="status"')
  && chrome.includes('aria-live="polite"'),
  "the browser chrome visibly and accessibly announces success or failure");
check(/copy\[10\][\s\S]*copy\[11\][\s\S]*copy\[12\]/.test(chrome),
  "download results use the browser chrome's localized copy");

console.log(`OK browser-download audit: ${passed} checks passed`);
