// Browser shell visual contract. Source-level coverage keeps this stable in
// the release gate without requiring a native Tauri window in the verifier.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "BrowserPanel.tsx"), "utf8").replace(/\r\n/g, "\n");

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

check(source.includes('data-ui="BrowserWindowShell"'), "browser shell has a stable visual test hook");
check(source.includes('data-ui="BrowserWindowShellContent"'), "shell content has a stable visual test hook");
check(source.includes('width: 560') && source.includes('maxWidth: "92vw"'), "floating shell preserves its established dimensions");
check(source.includes('boxSizing: "border-box"'), "border and inset are included in the established outer dimensions");
check(source.includes('border: "1px solid var(--border-strong)"'), "floating shell uses the standard OWLLM frame border");
check(source.includes('padding: 4'), "floating shell has a small uniform inset on every edge");
check(source.includes('background: "var(--bg-panel)"'), "floating shell uses the main OWLLM panel surface");
check(source.includes('maxHeight: "calc(82vh - 10px)"'), "inner height compensates for border and four-edge inset");
check(source.includes('borderRadius: 8') && !source.includes('borderRadius: 15'), "content radius follows the standard inset shell");
check(!source.includes('conic-gradient(from 0deg') && !source.includes('owllmBrowserFrameHue'), "owl-specific gradient frame and animation are removed");

if (failed) {
  console.error(`browserWindowShell: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`browserWindowShell: ${passed} passed, 0 failed`);
