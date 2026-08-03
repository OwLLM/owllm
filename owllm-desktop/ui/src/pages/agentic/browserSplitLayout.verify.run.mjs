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
  const pane = Math.max(320, width / 2);
  return {
    app: { x: originX, y: originY, width: pane, height: Math.max(320, height) },
    browser: { x: originX + pane, y: originY, width: pane, height: Math.max(320, height) },
  };
};

const initial = split(100, 20, 1920, 1080);
check(initial.app.x === 100 && initial.app.y === 20, "initial app reaches the monitor's left and top edges");
check(initial.browser.x > initial.app.x && initial.browser.y === 20, "initial browser shares the app's top edge");
check(initial.app.width === initial.browser.width && initial.app.height === 1080 && initial.browser.height === 1080,
  "initial panes have matching full-screen dimensions");
check(initial.browser.x + initial.browser.width === 2020, "initial browser reaches the monitor's right edge");
check(initial.browser.x === initial.app.x + initial.app.width, "initial panes meet without a center gap");

const resized = split(0, 0, 1440, 900);
check(resized.app.width < initial.app.width && resized.app.height < initial.app.height,
  "monitor resize recomputes the smaller left app pane");
check(resized.browser.x > resized.app.x && resized.browser.width === resized.app.width,
  "monitor resize keeps the browser right of an equally sized app pane");
check(resized.app.x === 0 && resized.app.y === 0 && resized.browser.y === 0
    && resized.browser.x + resized.browser.width === 1440,
  "resized panes remain flush with the monitor's outer edges");
check(resized.app.height === resized.browser.height && resized.browser.x === resized.app.x + resized.app.width,
  "resized panes remain equal and adjacent");

check(browser.includes("fn split_screen_layout") && browser.includes("fn arrange_split_screen"),
  "native split geometry and coordinator are present");
check(browser.includes("main.set_position(layout.app_position)")
    && browser.includes("main.set_size(layout.app_size)")
    && browser.includes(".set_position(layout.browser_position)")
    && browser.includes(".set_size(layout.browser_size)"),
  "native arrangement resizes and positions both app and browser windows");
check(!browser.includes("BROWSER_TOP_MARGIN") && !browser.includes("const GAP:"),
  "native arrangement has no browser margin or pane gap");
check(browser.includes("browser_position: LogicalPosition::new(browser_x, origin.y)")
    && browser.includes("browser_size: LogicalSize::new(pane_width, app_height)"),
  "native arrangement gives both panes the same origin and height");
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
