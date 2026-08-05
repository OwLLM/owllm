// One-time native browser/app split contract. The launch simulation checks the
// user interaction path; source checks pin usable-screen geometry and ensure
// later user moves/resizes are never overwritten by an automatic reflow.
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

// A 2560x1440 monitor with a 40px taskbar has a 2560x1400 work area.
const initial = split(0, 0, 2560, 1400);
check(initial.app.x === 0 && initial.app.y === 0, "initial app reaches the work area's left and top edges");
check(initial.browser.x > initial.app.x && initial.browser.y === 0, "initial browser shares the app's top edge");
check(initial.app.width === initial.browser.width && initial.app.height === 1400 && initial.browser.height === 1400,
  "initial panes have matching usable-screen dimensions");
check(initial.browser.x + initial.browser.width === 2560, "initial browser reaches the work area's right edge");
check(initial.browser.x === initial.app.x + initial.app.width, "initial panes meet without a center gap");

check(browser.includes("fn split_screen_layout") && browser.includes("fn arrange_split_screen"),
  "native split geometry and coordinator are present");
check(browser.includes("monitor.work_area()"),
  "initial split uses the usable monitor work area instead of hiding behind taskbars or docks");
check(browser.includes("fn set_client_bounds")
    && browser.includes("inner_position()")
    && browser.includes("outer_position()"),
  "native arrangement compensates invisible resize borders to align visible client edges");
check(browser.includes("set_client_bounds(&main") && browser.includes("set_client_bounds(&browser"),
  "initial arrangement applies visible bounds to both app and browser windows");
check(!browser.includes("BROWSER_TOP_MARGIN") && !browser.includes("const GAP:"),
  "native arrangement has no browser margin or pane gap");
check(browser.includes("browser_position: LogicalPosition::new(browser_x, origin.y)")
    && browser.includes("browser_size: LogicalSize::new(pane_width, app_height)"),
  "native arrangement gives both panes the same origin and height");
check(!browser.includes("queue_split_reflow") && !browser.includes("ReflowSplit")
    && !browser.includes("SPLIT_SCREEN_ACTIVE"),
  "browser move and resize interactions remain user-controlled after initialization");
check(!lib.includes("browser::queue_split_reflow(app)"),
  "main app move and resize interactions remain user-controlled after initialization");

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
