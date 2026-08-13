// The tutorial recorder must not depend on xdg-desktop-portal on GNOME.
//
// getDisplayMedia() reaches WebKitGTK -> xdg-desktop-portal-gnome, and that
// backend SEGVs on WebKit's parent-window handle ("Failed to associate portal
// window with parent window", status=11/SEGV), so the capture request dies with
// OverconstrainedError ~25 s later and Record silently does nothing. GNOME
// Shell's own org.gnome.Shell.Screencast sits below the portal and works.
//
// These checks keep the native fallbacks wired: Linux holds its D-Bus connection
// open for the whole recording (dropping it truncates the file to a stub), macOS
// uses the OS recorder because WKWebView has no getDisplayMedia, Windows keeps
// getDisplayMedia, and the UI prefers native capture before the WebView path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../../..");
const read = (relative) =>
  fs.readFileSync(path.join(DESKTOP, relative), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

const rust = read("src-tauri/src/screencast.rs");
check(rust.includes('interface = "org.gnome.Shell.Screencast"')
  && rust.includes("fn screencast_area(")
  && rust.includes("fn stop_screencast("),
  "the backend drives GNOME Shell's recorder directly, below the portal");
check(/struct Session \{\s*conn: zbus::Connection/.test(rust)
  && rust.includes("static SESSION: OnceLock<Mutex<Option<Session>>>"),
  "the recording's D-Bus connection is parked in a process-global, not dropped per command");
check(rust.includes("fn safe_stem(") && rust.includes("is_ascii_alphanumeric()"),
  "the file name from the UI is sanitised before it becomes a path");
check(rust.includes('#[cfg(target_os = "macos")]')
  && rust.includes('Command::new("/usr/sbin/screencapture")')
  && rust.includes('arg("-v")'),
  "macOS records through the bounded native screencapture process instead of absent getDisplayMedia");
check(rust.includes("CGPreflightScreenCaptureAccess")
  && rust.includes("CGRequestScreenCaptureAccess")
  && rust.includes("Privacy & Security > Screen Recording"),
  "macOS requests Screen Recording access and reports an actionable denial");
check(rust.includes('#[cfg(not(any(target_os = "linux", target_os = "macos")))]')
  && /#\[cfg\(not\(any\(target_os = "linux", target_os = "macos"\)\)\)\][\s\S]*?pub async fn supported\(\) -> bool \{\s*false/.test(rust),
  "Windows reports no native recorder and keeps getDisplayMedia");
check(rust.includes('arg("-INT")') && rust.includes("FINALIZE_TIMEOUT")
  && rust.includes("static STARTING: AtomicBool"),
  "macOS stop is graceful and bounded so capture cannot hold the GUI hostage");
check(rust.includes("BUS_TIMEOUT") && rust.includes("tokio::time::timeout"),
  "a non-GNOME session cannot hang the recorder on a D-Bus probe");

const lib = read("src-tauri/src/lib.rs");
check(lib.includes("mod screencast;")
  && lib.includes("screencast::screencast_supported")
  && lib.includes("screencast::screencast_start")
  && lib.includes("screencast::screencast_stop"),
  "the three screencast commands are registered with Tauri");
check((lib.match(/screencast::shutdown\(\)/g) ?? []).length >= 2,
  "a native macOS recording is stopped on both normal app-exit paths");

const bridge = read("ui/src/tutorial/nativeScreencast.ts");
check(/nativeScreencastSupported[\s\S]*?catch \{\s*return false;/.test(bridge),
  "a missing backend command degrades to unsupported instead of throwing");

const recorder = read("ui/src/tutorial/TutorialRecorder.tsx");
check(recorder.includes("const canRecord = nativeCapture || webViewCapture"),
  "the native recorder counts as capture support even when getDisplayMedia is unusable");
const startBody = recorder.slice(recorder.indexOf("const start = async ()"));
const nativeBranch = startBody.indexOf("if (nativeCapture) {");
const portalCall = startBody.indexOf("await requestDisplayStream(");
check(nativeBranch > -1 && portalCall > -1 && nativeBranch < portalCall,
  "the native path is taken BEFORE getDisplayMedia, not as a fallback after it fails");
check(/if \(nativeCapture\) \{[\s\S]*?nativeScreencastStart\([\s\S]*?return;\s*\}/.test(startBody),
  "the native start returns without touching the portal");
const stopBody = recorder.slice(recorder.indexOf("const stop = ()"));
check(stopBody.indexOf("nativeScreencastStop(") < stopBody.indexOf("finalizedRecorderRef.current"),
  "stop ends the native recording before the WebView recorder paths");
check(recorder.includes("disabled={nativeCapture || (state !== \"recording\" && state !== \"paused\")}"),
  "pause is disabled under the native recorder, which cannot pause");
check(recorder.includes("nativeStemRef.current = null") && /failRecording = \(error[\s\S]*?nativeStemRef\.current = null/.test(recorder),
  "a failed save clears the native recording state so Record works again");

console.log(`OK screencast fallback: ${passed}/${passed} checks passed`);
