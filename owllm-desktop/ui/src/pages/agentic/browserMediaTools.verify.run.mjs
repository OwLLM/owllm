import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "../../../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const browser = read("src-tauri/src/browser.rs");
const support = read("src-tauri/src/support.rs");
const gateway = read("src-tauri/src/mcp_gateway.rs");
const lib = read("src-tauri/src/lib.rs");
const local = read("ui/src/pages/agentic/localTools.ts");
const dispatch = read("ui/src/pages/agentic/dispatch.ts");
const personal = read("src-tauri/src/personal_agents.rs");
const teams = read("src-tauri/src/personal_agent_teams.rs");
const teamsUi = read("ui/src/pages/agentic/personalAgentTeams.ts");
const releaseWorkflow = read("../.github/workflows/release.yml");

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

// The scope match moved into run_browser_action when a wedged session became
// replayable (browser auto-recovery); `screenshot_scope` is a &str there, and
// the app handle is borrowed rather than re-borrowed. Same invariant: a
// screenshot is captured pixels, scoped to the requested tab.
check("browser_screenshot captures pixels instead of returning page metadata",
  browser.includes('"screenshot" => match screenshot_scope {') &&
  browser.includes('capture_browser_window(app, tab_id, req)') &&
  !browser.includes("return a page summary rather than pixels"));
check("capture is scoped to an OWLLM-owned window on every desktop platform",
  support.includes("capture_hwnd_rgba(hwnd)") &&
  support.includes("capture_gtk_window_png(&window)") &&
  support.includes("capture_macos_window_png(win)"));
check("saved screenshots use an atomic app-cache path and bounded retention",
  browser.includes('.join("browser-screenshots")') &&
  browser.includes('path.with_extension("png.tmp")') &&
  browser.includes("index >= 50 || expired"));
check("capture scopes are explicit and reject ambiguous values",
  browser.includes('unwrap_or("viewport")') &&
  browser.includes('"full_page" | "full-page" | "page"') &&
  browser.includes('unknown screenshot scope') &&
  local.includes('scope=viewport') &&
  gateway.includes('["viewport", "full_page", "app", "desktop"]'));
check("desktop scope bypasses browser startup and uses the shared native capture",
  browser.indexOf('screenshot_scope == "desktop"') < browser.indexOf('browser_start_inner(&app)?') &&
  browser.includes('block_on(crate::support::capture_screen_png())'));
check("desktop capture has real Windows, macOS, and Linux implementations",
  support.includes("capture_virtual_screen_rgba") && support.includes("SM_CXVIRTUALSCREEN") &&
  support.includes('Command::new("/usr/sbin/screencapture")') && support.includes('.arg("-D")') &&
  support.includes("ashpd::desktop::screenshot::Screenshot::request()") &&
  support.includes("Linux screen capture was cancelled or denied"));
check("full-page capture never scrolls or resizes the shared browser",
  browser.includes('CallDevToolsProtocolMethod') &&
  browser.includes('"Page.captureScreenshot"') &&
  browser.includes('SnapshotRegion::FullDocument') &&
  !browser.includes('scroll-and-stitch'));
check("full-page capture is bounded against hostile document sizes",
  browser.includes("MAX_FULL_PAGE_PIXELS / area") &&
  browser.includes("page is too large to capture safely"));
check("macOS full-page capture uses a non-scrolling WebKit PDF and CoreGraphics render",
  browser.includes("createPDFWithConfiguration_completionHandler") &&
  browser.includes("WKPDFConfiguration") &&
  browser.includes("CGContextDrawPDFPage") &&
  browser.includes("render_macos_pdf(&pdf, metrics)") &&
  browser.includes('target_os = "linux", target_os = "macos"'));
check("saved captures are validated as real PNGs before hitting the filesystem",
  browser.includes("crate::support::png_dimensions(png)?;") &&
  support.includes('capture did not produce a valid PNG'));
check("release CI compiles the capture code on Windows, macOS, and Linux",
  releaseWorkflow.includes("rust_target: 'x86_64-pc-windows-msvc'") &&
  // macOS is built universal, so its rust_target is the lipo target and the two
  // real slices are listed separately.
  (releaseWorkflow.includes("rust_target: 'aarch64-apple-darwin'")
    || (releaseWorkflow.includes("rust_target: 'universal-apple-darwin'")
      && releaseWorkflow.includes("aarch64-apple-darwin,x86_64-apple-darwin"))) &&
  releaseWorkflow.includes("rust_target: 'x86_64-unknown-linux-gnu'") &&
  releaseWorkflow.includes('run: npm run build'));
check("vision readback is restricted to browser-created PNGs",
  browser.includes("only PNGs created by browser_screenshot can be read") &&
  browser.includes("requested.starts_with(&root)") &&
  lib.includes("browser::browser_read_capture"));
check("local/API screenshot results carry pixels into the next model turn",
  local.includes('image: { kind: "image", mime: "image/png", data_b64, filename }') &&
  (dispatch.match(/openaiUserContent\(parts\.join\("\\n\\n"\), toolImages\)/g) ?? []).length === 2);
check("local/API and CLI calls forward screenshot scope",
  local.includes('params: { scope, tab_id: call.args.tab_id ?? null }') &&
  gateway.includes('args.get("scope").and_then(Value::as_str).unwrap_or("viewport")'));
check("upload uses a FileList without opening an OS file picker",
  browser.includes("new DataTransfer()") &&
  browser.includes('upload.input.files = transfer.files') &&
  browser.includes('fire(upload.input, "change")') &&
  !browser.includes("rfd::FileDialog"));
check("upload is chunked and capped before entering the WebView",
  browser.includes("MAX_BROWSER_UPLOAD_BYTES: u64 = 25 * 1024 * 1024") &&
  browser.includes("bytes.chunks(UPLOAD_CHUNK_BYTES)") &&
  browser.includes("meta.len() > MAX_BROWSER_UPLOAD_BYTES"));
check("local/API registry and executor expose browser_upload_file",
  local.includes('name: "browser_upload_file"') &&
  local.includes('case "browser_upload_file"') &&
  local.includes('action: "upload_file"'));
check("subscription CLI gateway exposes and executes browser_upload_file",
  gateway.includes('"name": "browser_upload_file"') &&
  gateway.includes('"browser_upload_file" => crate::browser::browser_cmd'));
check("persistent personal agents and teams recognize the capability",
  personal.includes('"browser_upload_file"') &&
  teams.includes('"browser_upload_file" => crate::browser::browser_cmd') &&
  teamsUi.includes('"browser_upload_file"'));
check("negative control catches the old metadata-only screenshot",
  !browser.replace('"screenshot" => match screenshot_scope.as_str()',
    '"screenshot" => eval_until_reply(&win, req, "info", &json!({}), Duration::from_secs(8)), //')
    .includes('"screenshot" => match screenshot_scope.as_str()'));
check("negative control catches an unbounded upload",
  !browser.replace("meta.len() > MAX_BROWSER_UPLOAD_BYTES", "false")
    .includes("meta.len() > MAX_BROWSER_UPLOAD_BYTES"));
check("negative control catches desktop capture silently falling back to viewport",
  browser.includes('"desktop" => return capture_desktop(&app, None, req)') &&
  !browser.replace('"desktop" => return capture_desktop(&app, None, req)', '"desktop" => return capture_browser_window(&app, None, req)')
    .includes('"desktop" => return capture_desktop(&app, None, req)'));
check("negative control catches removal of macOS full-page capture",
  !browser.replace("render_macos_pdf(&pdf, metrics)", 'Err("macOS full-page unavailable".into())')
    .includes("render_macos_pdf(&pdf, metrics)"));

console.log(`\nbrowserMediaTools.verify: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
