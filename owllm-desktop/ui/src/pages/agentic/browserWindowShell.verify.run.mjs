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
// The page is inset by frame_t(), which is BROWSER_FRAME_T wherever the chrome
// webview sits BEHIND the page (Windows/macOS) and 0 where the bar is tiled
// above it (Linux) and has no edge to show through. Same invariant as the old
// literal BROWSER_FRAME_T checks, expressed against the shape-aware code.
check(/fn frame_t\(\) -> f64 \{\s*if chrome_overlaps_page\(\) \{\s*BROWSER_FRAME_T\s*\} else \{\s*0\.0/.test(browser), "the accent edge is still BROWSER_FRAME_T wherever the chrome sits behind the page");
check(browser.includes("let inset = frame_t();") && browser.includes("LogicalPosition::new(inset, CHROME_H)"), "page leaves only the visible left frame edge");
check(browser.includes("(ls.width - (inset * 2.0)).max(50.0)"), "page leaves matching left and right frame edges");
check(browser.includes("(ls.height - CHROME_H - inset).max(50.0)"), "page leaves the matching bottom frame edge");
check(/LogicalSize::new\(\s*win_w,\s*if chrome_overlaps_page\(\) \{ win_h \} else \{ CHROME_H \},?\s*\)/.test(browser), "chrome backing spans the whole window where it backs the page, and the bar strip where it is tiled");
check(!chrome.includes("conic-gradient") && !chrome.includes("owllmBrowserFrameHue"), "native browser frame is standard, not owl-specific or animated");

if (failed) {
  console.error(`browserWindowShell: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`browserWindowShell: ${passed} passed, 0 failed`);
