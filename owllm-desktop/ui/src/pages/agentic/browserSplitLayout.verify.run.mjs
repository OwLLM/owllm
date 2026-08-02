// Coordinated native browser/app split contract. The launch simulation checks
// the user interaction path; the geometry checks cover both initial placement
// and a later monitor resize without requiring a Tauri desktop session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const app = path.resolve(here, "../../../..");
const source = fs.readFileSync(path.join(here, "projectEnvironment.ts"), "utf8");
const browser = fs.readFileSync(path.join(app, "src-tauri/src/browser.rs"), "utf8");
const lib = fs.readFileSync(path.join(app, "src-tauri/src/lib.rs"), "utf8");

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

const split = (originX, originY, width, height) => {
  const margin = 12;
  const gap = 8;
  const pane = Math.max(320, Math.max(width - margin * 2 - gap, 640) / 2);
  const paneHeight = Math.max(320, height - margin * 2);
  return {
    app: { x: originX + margin, y: originY + margin, width: pane, height: paneHeight },
    browser: { x: originX + margin + pane + gap, y: originY + margin, width: pane, height: paneHeight },
  };
};

const initial = split(100, 20, 1920, 1080);
check(initial.app.x === 112 && initial.app.y === 32, "initial app is placed on the left with the shared inset");
check(initial.browser.x > initial.app.x && initial.browser.y === 32, "initial browser is placed on the right with a small top margin");
check(initial.app.width === initial.browser.width && initial.app.height === initial.browser.height,
  "initial app and browser panes have matching dimensions");
check(initial.browser.x + initial.browser.width === 2008, "initial browser ends at the monitor's inset right edge");

const resized = split(0, 0, 1440, 900);
check(resized.app.width < initial.app.width && resized.app.height < initial.app.height,
  "monitor resize recomputes the smaller left app pane");
check(resized.browser.x > resized.app.x && resized.browser.width === resized.app.width,
  "monitor resize keeps the browser right of an equally sized app pane");

check(browser.includes("fn split_screen_layout") && browser.includes("fn arrange_split_screen"),
  "native split geometry and coordinator are present");
check(browser.includes("main.set_position(layout.app_position)")
    && browser.includes("main.set_size(layout.app_size)")
    && browser.includes(".set_position(layout.browser_position)")
    && browser.includes(".set_size(layout.browser_size)"),
  "native arrangement resizes and positions both app and browser windows");
check(browser.includes("const MARGIN: f64 = 12.0") && browser.includes("const GAP: f64 = 8.0"),
  "native arrangement preserves the top margin and pane gap");
check(browser.includes("WindowEvent::Moved(_) | WindowEvent::Resized(_)")
    && browser.includes("queue_split_reflow(&handle)"),
  "browser resize and move interactions request a coordinated reflow");
check(lib.includes("browser::queue_split_reflow(app)"),
  "main app resize interactions request a coordinated reflow");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-browser-split-"));
try {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modulePath = path.join(temp, "projectEnvironment.mjs");
  fs.writeFileSync(modulePath, compiled);
  const environment = await import(pathToFileURL(modulePath).href);
  const calls = [];
  await environment.launchProjectEnvironment(environment.createProjectEnvironment("web"), async (command, args) => {
    calls.push({ command, args });
    if (command === "browser_open_tab") return JSON.stringify({ tab_id: calls.length });
    return null;
  });
  const arrangeIndex = calls.findIndex(call => call.command === "browser_arrange");
  check(arrangeIndex >= 0 && calls[arrangeIndex].args.layout === "right-half",
    "opening a right-half browser recipe invokes the coordinated layout command");
  check(arrangeIndex > calls.findIndex(call => call.command === "browser_open_tab"),
    "right-half arrangement occurs after the browser tab is opened");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

if (failed) {
  console.error(`browserSplitLayout: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`browserSplitLayout: ${passed} passed, 0 failed`);
