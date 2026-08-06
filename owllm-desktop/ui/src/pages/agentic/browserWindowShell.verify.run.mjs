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

// RESIZE. The window is undecorated on every OS, so nothing resizes it unless
// something still hit-tests its edges. Measured before this was fixed: Windows
// resized from the right/bottom only (left and top returned HTNOWHERE or sat
// under the webview's own HWND), Linux not at all (WebKitGTK covered the
// toplevel edge-to-edge and swallowed the press tao's own edge handler needs),
// and macOS had no path at all — tao maps decorations(false) to a BORDERLESS
// NSWindow, which AppKit does not resize, and its drag_resize_window is
// NotSupported there. Each platform below is the mechanism that fixed one.
check(browser.includes(".resizable(true)"), "the framed browser window is created resizable");
for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
  check(chrome.includes(`data-dir="${dir}"`), `chrome bar exposes a "${dir}" resize grip`);
}
check(/\.grip\b/.test(chrome) && chrome.includes('evt("resize"'), "resize grips report the gesture to Rust");
check(chrome.includes("cursor: ns-resize") && chrome.includes("cursor: ew-resize") && chrome.includes("cursor: nwse-resize") && chrome.includes("cursor: nesw-resize"), "resize grips show a resize cursor so the edge is discoverable");
check(/"resize" => \{\s*if let Some\(direction\) = parse_resize_direction\(data\)\s*\{\s*let _ = win\.start_resize_dragging\(direction\)/.test(browser), "Rust turns a grip gesture into a native resize drag");
check(/"nw" => D::NorthWest/.test(browser) && /"se" => D::SouthEast/.test(browser), "grip ids map onto the runtime's resize directions");
check(browser.includes("const RESIZE_EDGE: i32 = 5"), "the exposed Linux edge is at least tao's five-pixel hit-test border");
check(/fn linux_expose_resize_edges[\s\S]{0,600}vbox\.set_margin_start\(RESIZE_EDGE\)[\s\S]{0,300}set_margin_bottom\(RESIZE_EDGE\)/.test(browser), "Linux insets the webview box so the toplevel keeps its resize edge");
check(browser.includes("linux_expose_resize_edges(&win)"), "the Linux resize edge is applied to the browser window");
check(/fn mac_enable_native_resize[\s\S]{0,900}setStyleMask: mask \| TITLED \| RESIZABLE \| FULL_SIZE_CONTENT_VIEW/.test(browser), "macOS re-adds the titled style AppKit needs to resize a window");
check(browser.includes("mac_enable_native_resize(&win)"), "the macOS resize style is applied to the browser window");
check(/setTitlebarAppearsTransparent: true/.test(browser) && /setTitleVisibility: TITLE_HIDDEN/.test(browser) && /standardWindowButton[\s\S]{0,200}setHidden: true/.test(browser), "macOS stays frameless: no titlebar, no title, no second set of window buttons");

if (failed) {
  console.error(`browserWindowShell: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`browserWindowShell: ${passed} passed, 0 failed`);
