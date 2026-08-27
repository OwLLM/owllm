// Native webview crash recovery, both desktop engines.
//
// Every platform runs the page in a process the OS may take away. WebKitGTK
// kills its web process; WebView2 sheds its render process under host memory
// pressure. Either way the native window survives with nothing painting into
// it — measured on Windows as a live "OwLLM Desktop" HWND whose entire
// Chromium widget tree (Chrome_WidgetWin_0/1, Chrome_RenderWidgetHostHWND,
// Intermediate D3D Window) had vanished while a healthy sibling window still
// had all four. A host window with no render widget under it paints solid
// black, and nothing listened for the event that reports it, so it stayed
// black until the app was restarted.
//
// These are source assertions over lib.rs because the failure is a native COM /
// GLib subscription that no JavaScript harness can raise. They check the wiring
// AND its order: re-arm before recovery, burst limit before reload, recovery
// only for a render-process exit.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const rust = fs
  .readFileSync(path.join(DESKTOP, "src-tauri/src/lib.rs"), "utf8")
  .replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

// `a` appears before `b`, and BOTH are present. Plain indexOf comparison is
// blind here: a missing needle scores -1, which sorts before every real
// position, so deleting the code an ordering check guards makes it pass.
function before(haystack, a, b) {
  const ia = haystack.indexOf(a);
  const ib = haystack.indexOf(b);
  return ia !== -1 && ib !== -1 && ia < ib;
}

// Slice one top-level `fn name(...) { ... }` body: from its signature to the
// next closing brace in column 0.
function body(name) {
  const start = rust.indexOf(`fn ${name}(`);
  if (start === -1) return "";
  const end = rust.indexOf("\n}\n", start);
  return end === -1 ? rust.slice(start) : rust.slice(start, end + 2);
}

// ---- both engines are wired, from the one setup hook -----------------------
const setup = rust.slice(rust.indexOf(".setup(|app|"), rust.indexOf(".setup(|app|") + 4000);
check(
  setup.includes("install_linux_webview_recovery(app);")
    && setup.includes("install_windows_webview_recovery(app);"),
  "app setup installs native webview crash recovery for BOTH WebKitGTK and WebView2",
);
check(
  rust.includes('#[cfg(not(windows))]\nfn install_windows_webview_recovery(_app: &tauri::App) {}')
    && rust.includes('#[cfg(not(target_os = "linux"))]\nfn install_linux_webview_recovery(_app: &tauri::App) {}'),
  "each recovery has a no-op twin, so the shared call site compiles on every platform",
);

// ---- Windows / WebView2 ----------------------------------------------------
const install = body("install_windows_webview_recovery");
check(
  install.includes('app.get_webview_window("main")')
    && install.includes('arm_windows_webview_recovery(&main, "main")'),
  "the main WebView2 view is armed at startup",
);
const armWindow = body("arm_windows_webview_recovery");
check(
  armWindow.includes("platform.controller().CoreWebView2()")
    && armWindow.includes("arm_webview2_process_failed(&core, label)"),
  "arming goes through the window's own WebView2 controller",
);
// The subscription is per ICoreWebView2, not per app: an unarmed webview stays
// black even while its sibling recovers. Measured — killing both render
// processes brought back only the armed one.
const overlay = fs
  .readFileSync(path.join(DESKTOP, "src-tauri/src/overlay_frame.rs"), "utf8")
  .replace(/\r\n/g, "\n");
check(
  overlay.includes('crate::arm_windows_webview_recovery(&overlay, "overlay frame")')
    && before(overlay, "builder.build()?", "arm_windows_webview_recovery"),
  "the overlay frame — the app's own chrome — is armed too, right after it is built",
);
check(
  rust.includes("#[cfg(not(windows))]\npub(crate) fn arm_windows_webview_recovery("),
  "the shared armer has a no-op twin, so overlay_frame.rs compiles off Windows",
);

const arm = body("arm_webview2_process_failed");
check(
  arm.includes("ProcessFailedEventHandler::create")
    && arm.includes("core.add_ProcessFailed(&handler, &mut raw)"),
  "a ProcessFailed handler is subscribed on the WebView2 core",
);
// The trap this whole function exists for: webview2-com builds every event
// callback from a FnOnce that its Invoke take()s out of the cell on first use.
// One add_ProcessFailed recovers exactly one renderer death and is then dead —
// the same permanent black window, one crash later.
check(
  before(arm, "ProcessFailedEventHandler::create", "arm_webview2_process_failed(&core, label);")
    && before(arm, "arm_webview2_process_failed(&core, label);", "core.Reload()"),
  "the handler re-arms itself before recovering, so recovery survives more than one failure",
);
// Leaving the spent subscription registered doubled the handler list on every
// failure — measured as 1, 2, then 4 log lines per view across three kills.
check(
  before(arm, "core.remove_ProcessFailed(token.get())", "arm_webview2_process_failed(&core, label);")
    && arm.includes("token.set(raw);")
    && arm.includes("Rc::clone(&token)"),
  "the spent subscription is removed by token before re-arming, so the handler list cannot grow",
);
check(
  /if kind == Some\(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED\)\s*\n?\s*&& webview2_recovery_allowed\(label\)/.test(arm),
  "only a render-process exit is reloaded, and only when this view's burst limit allows it",
);
check(
  !arm.includes("COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE"),
  "an unresponsive-but-alive renderer is never reloaded out from under a busy page",
);
check(
  arm.includes('append_native_webview_log("windows-webview2.log", &entry)')
    && arm.includes("args.cast::<ICoreWebView2ProcessFailedEventArgs2>()")
    && arm.includes("args.Reason(&mut reason)"),
  "the native failure kind and reason are recorded durably before recovery",
);

const burst = body("webview2_recovery_allowed");
check(
  burst.includes("const MAX_PER_WINDOW: u32")
    && burst.includes("const BURST_WINDOW: Duration")
    && burst.includes("return false;"),
  "a page that kills its own renderer on load cannot drive an endless reload storm",
);
// Measured with a shared counter: killing every render process three times over
// recovered 2 views, then 1, then 0 — one view's failures ate another's budget.
check(
  burst.includes("HashMap<&'static str, (u32, Instant)>")
    && burst.includes("bursts.get(label)")
    && burst.includes("bursts.insert(label,"),
  "the burst budget is per webview, so one view's failures cannot starve another's recovery",
);

// ---- Linux / WebKitGTK — unchanged behaviour, shared log helper ------------
const linux = body("install_linux_webview_recovery");
check(
  linux.includes("connect_web_process_terminated")
    && linux.includes("WebProcessTerminationReason::Crashed")
    && linux.includes("WebProcessTerminationReason::ExceededMemoryLimit")
    && linux.includes("webview.reload()")
    && linux.includes('append_native_webview_log("linux-webkit.log", &entry)'),
  "WebKitGTK crashes and memory-limit terminations are still logged and reloaded",
);

const log = body("append_native_webview_log");
check(
  before(log, "paths::user_data_root()", "std::env::temp_dir()")
    && log.includes("root.join(file_name)")
    && log.includes(".append(true)"),
  "both engines append to the durable user-data directory, falling back to TEMP",
);

console.log(`OK native webview crash recovery: ${passed}/${passed} checks passed`);
