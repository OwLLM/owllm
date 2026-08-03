// Native browser shell visual contract. Source-level coverage keeps the actual
// separate browser window stable without requiring a Tauri desktop session.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../../../..");
const browser = fs.readFileSync(path.join(app, "src-tauri/src/browser.rs"), "utf8").replace(/\r\n/g, "\n");
const chrome = fs.readFileSync(path.join(app, "ui/public/browser-chrome.html"), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

check(browser.includes("const BROWSER_FRAME_T: f64 = 3.0"), "native browser uses the main window's three-pixel edge thickness");
check(chrome.includes('id="windowFrame"'), "native browser chrome has a stable edge-frame test hook");
check(chrome.includes("border: 3px solid var(--accent)"), "native browser edge uses the standard accent frame");
check(chrome.includes("pointer-events: none"), "browser edge never blocks page or window controls");
check(chrome.includes("box-sizing: border-box"), "browser edge is painted inside the window bounds");
check(browser.includes("LogicalPosition::new(BROWSER_FRAME_T, CHROME_H)"), "page leaves only the visible left frame edge");
check(browser.includes("ls.width - (BROWSER_FRAME_T * 2.0)"), "page leaves matching left and right frame edges");
check(browser.includes("ls.height - CHROME_H - BROWSER_FRAME_T"), "page leaves the matching bottom frame edge");
check(browser.includes("LogicalSize::new(ls.width, ls.height)"), "chrome backing spans the complete native browser window");
check(!chrome.includes("conic-gradient") && !chrome.includes("owllmBrowserFrameHue"), "native browser frame is standard, not owl-specific or animated");

if (failed) {
  console.error(`browserWindowShell: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`browserWindowShell: ${passed} passed, 0 failed`);
