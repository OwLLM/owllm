// Tripwire for the startup white flash.
//
// This bug has shipped, been fixed, and come back TWICE. It came back because
// nothing failed when it did: the fix is two cooperating facts in two different
// files, and either one can be undone by an unrelated change with no signal.
//
// The contract:
//   1. the main window starts hidden  (tauri.conf.json  "visible": false)
//   2. it is revealed only from on_page_load / PageLoadEvent::Finished
//   3. NOT from setup() — setup runs before the first paint, so showing there
//      reveals an unpainted white surface, which IS the flash
//   4. main is shown BEFORE the overlay frame — an overlay arriving early or
//      unpainted is the other half of the flash
//
// Source-level checks; no browser required.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

// --- 1. the window must start hidden ---------------------------------------
const conf = JSON.parse(fs.readFileSync(path.join(DESKTOP, "src-tauri", "tauri.conf.json"), "utf8"));
const windows = conf.app?.windows ?? [];
const main = windows.find((w) => w.label === "main");
check(Boolean(main), "tauri.conf.json defines the main window");
check(main.visible === false,
  'main window is created hidden ("visible": false) — a visible window paints white before the UI exists');

// --- 2..4. the reveal must happen on page load, after paint ----------------
const lib = fs.readFileSync(path.join(DESKTOP, "src-tauri", "src", "lib.rs"), "utf8");

const setupAt = lib.indexOf(".setup(");
const pageLoadAt = lib.indexOf(".on_page_load(");
const handlerAt = lib.indexOf(".invoke_handler(", pageLoadAt);
check(setupAt >= 0 && pageLoadAt > setupAt && handlerAt > pageLoadAt,
  "lib.rs still has the setup() → on_page_load() → invoke_handler() builder shape this guard reads");

const setupBlock = lib.slice(setupAt, pageLoadAt);
const pageLoadBlock = lib.slice(pageLoadAt, handlerAt);

check(/PageLoadEvent::Finished/.test(pageLoadBlock),
  "the reveal is gated on PageLoadEvent::Finished (the UI has painted)");
check(/webview\.label\(\) == "main"/.test(pageLoadBlock),
  "the reveal is gated on the main window");
check(/\.show\(\)/.test(pageLoadBlock),
  "the main window is shown from on_page_load");
check(!/\.show\(\)/.test(setupBlock),
  "setup() shows no window — setup runs before the first paint, so revealing there IS the flash");

// --- 4. ordering: main first, overlay second -------------------------------
const mainShowAt = pageLoadBlock.indexOf("dispatch_window.show()");
const overlayShowAt = pageLoadBlock.indexOf("prepare_and_show_for_main");
check(mainShowAt >= 0 && overlayShowAt >= 0,
  "both the main reveal and the overlay reveal are present");
check(mainShowAt < overlayShowAt,
  "main is revealed BEFORE the overlay frame (an early or unpainted overlay is the other half of the flash)");

console.log(`OK startup white flash: ${passed}/${passed} checks passed`);
