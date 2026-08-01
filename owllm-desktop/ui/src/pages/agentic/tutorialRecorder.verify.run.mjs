// Release-discovered regression for tutorial capture quality, finalized seekable
// files, recorder-overlay exclusion, selectable FPS, and auto-stop. The pure
// preference behavior executes here; source guards protect the browser-only
// capture/muxing boundary from being lost during a squash merge. The finalized
// muxer is also exercised in the real OWLLM WebView during implementation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../..");            // ui/src
const DESKTOP = path.resolve(HERE, "../../..");     // owllm-desktop
const require = createRequire(path.join(DESKTOP, "package.json"));
const ts = require("typescript");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owllm-recorder-"));
function transpileInto(relFromSrc, outName) {
  const source = fs.readFileSync(path.join(SRC, relFromSrc), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const out = path.join(temp, outName);
  fs.writeFileSync(out, output);
  return out;
}
const prefs = require(transpileInto("tutorial/tutorialRecorderPrefs.ts", "tutorialRecorderPrefs.js"));

// Read source for content matching independent of the checkout's line endings
// (Windows core.autocrlf checks LF-committed files out as CRLF).
const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

// --- 1. FPS options + clamp bounds -----------------------------------------
check(prefs.DEFAULT_FPS === 30, "default FPS is a smooth, readable 30");
check(!prefs.FPS_OPTIONS.includes(5) && !prefs.FPS_OPTIONS.includes(10) && prefs.FPS_OPTIONS.includes(60),
  "unreadable 5/10 FPS modes are removed while 60 FPS remains available");
for (const opt of prefs.FPS_OPTIONS) {
  check(prefs.clampFps(opt) === opt, `a valid option ${opt} clamps to itself`);
}
check(prefs.clampFps(7) === 15, "a legacy low FPS preference upgrades to the readable minimum");
check(prefs.clampFps(1000) === 60, "an absurdly high value clamps to the max option (60)");
check(prefs.clampFps(NaN) === prefs.DEFAULT_FPS, "a non-finite FPS falls back to the default");

// --- 2. FPS persistence / restore ------------------------------------------
const s1 = memStore();
check(prefs.readFps(s1) === prefs.DEFAULT_FPS, "fresh install reads the default FPS");
prefs.saveFps(24, s1);
check(prefs.readFps(s1) === 24, "a chosen FPS persists and restores after a simulated restart");
prefs.saveFps(9999, s1);
check(prefs.readFps(s1) === 60, "a stored out-of-range FPS is clamped on read");
check(prefs.readFps(null) === prefs.DEFAULT_FPS, "a null store is safe and yields the default");

// --- 3. Auto-stop persistence ----------------------------------------------
const s2 = memStore();
check(prefs.readAutoStop(s2) === false, "auto-stop defaults OFF");
prefs.saveAutoStop(true, s2);
check(prefs.readAutoStop(s2) === true, "auto-stop persists ON and restores after restart");
prefs.saveAutoStop(false, s2);
check(prefs.readAutoStop(s2) === false, "auto-stop persists OFF");

// --- 4. Job-end transition edge --------------------------------------------
check(prefs.jobJustEnded(true, false) === true, "active → inactive IS the job-just-ended edge");
check(prefs.jobJustEnded(false, false) === false, "staying idle is not a job-end edge");
check(prefs.jobJustEnded(true, true) === false, "staying active is not a job-end edge");
check(prefs.jobJustEnded(false, true) === false, "a job starting is not a job-end edge");
check(prefs.AUTO_STOP_DELAY_MS === 3000, "the auto-stop delay is exactly 3 seconds");

// --- 5. FPS → bitrate mapping (real disk savings) --------------------------
check(prefs.bitrateForFps(5) < prefs.bitrateForFps(30),
  "a lower FPS yields a lower bitrate (so long recordings shrink)");
check(prefs.bitrateForFps(30) < prefs.bitrateForFps(60),
  "a higher FPS yields a higher bitrate");
check(prefs.bitrateForFps(5) >= 300_000,
  "the bitrate has a sane floor so low-FPS video stays watchable");

// --- 6. Seekable format + resolution-aware quality -------------------------
check(typeof prefs.chooseRecorderFormat === "function",
  "the recorder exposes a testable format selector");
if (typeof prefs.chooseRecorderFormat === "function") {
  const mp4 = prefs.chooseRecorderFormat((mime) => mime === "video/mp4;codecs=avc1.42E01E");
  check(mp4.extension === "mp4" && mp4.mimeType.includes("avc1"),
    "H.264 MP4 is preferred when the runtime supports it");
  const webm = prefs.chooseRecorderFormat((mime) => mime === "video/webm;codecs=vp9");
  check(webm.extension === "webm" && webm.mimeType.includes("vp9"),
    "VP9 WebM remains a cross-platform fallback");
}
check(typeof prefs.bitrateForCapture === "function",
  "the recorder exposes a resolution-aware bitrate calculator");
if (typeof prefs.bitrateForCapture === "function") {
  check(
    prefs.bitrateForCapture(30, 3840, 2160, "video/mp4") >
      prefs.bitrateForCapture(30, 1280, 720, "video/mp4"),
    "higher-resolution capture receives enough bitrate to keep text sharp",
  );
  check(
    prefs.bitrateForCapture(10, 1920, 1080, "video/mp4") <
      prefs.bitrateForCapture(30, 1920, 1080, "video/mp4"),
    "lower FPS still produces a smaller long recording at the same resolution",
  );
}

// --- 7. Source pins ---------------------------------------------------------
const rec = readSrc("tutorial/TutorialRecorder.tsx");
const finalized = readSrc("tutorial/finalizedVideoRecorder.ts");
check(rec.includes('from "./tutorialRecorderPrefs"'),
  "the recorder imports the pure prefs module");
check(rec.includes('requestDisplayStream(appOnly ? "window" : "screen", fps)'),
  "app-only mode captures the OWLLM window directly instead of rescaling the screen");
check(!rec.includes("cropScreenToApp") && !rec.includes("canvas.captureStream(fps)"),
  "the blurry full-screen canvas crop path is removed");
check(rec.includes("await hideRecorderUiForCapture()") && rec.includes("setCaptureUiHidden(true)"),
  "the recorder UI leaves the compositor before capture begins");
check(finalized.includes('new Mp4OutputFormat({ fastStart: "in-memory" })') &&
  finalized.includes("new MediaStreamVideoTrackSource"),
  "the primary recorder writes a finalized fast-start MP4 with WebCodecs");
check(finalized.includes("await output.finalize()") && finalized.includes("target.buffer"),
  "the file is finalized before it is offered for download");
check(finalized.includes('codec: "avc"') && finalized.includes("keyFrameInterval: 2"),
  "H.264 uses two-second keyframes for compatible seeking");
check(finalized.includes('codec: "vp9"') && finalized.includes("WebMOutputFormat"),
  "finalized VP9 WebM remains the cross-platform WebCodecs fallback");
check(rec.includes("describeCaptureSettings(settings, fps)"),
  "the UI reports the dimensions actually granted by the capture runtime");
check(!rec.includes("1080p max"),
  "the UI no longer makes an unverified 1080p quality claim");
check(rec.includes('data-ui="TutorialRecorderFormat"') &&
  rec.includes("Finalized H.264 MP4") && rec.includes("VP9 fallback"),
  "the recorder panel identifies the finalized primary format and fallback");
check(rec.includes('contentHint = "detail"'),
  "screen capture tells the encoder to preserve text and UI detail");
const cursorSize = rec.match(/const TUTORIAL_CURSOR =[\s\S]*?width='(\d+)' height='(\d+)'/);
check(Boolean(cursorSize) && Number(cursorSize[1]) <= 26 && Number(cursorSize[2]) <= 30,
  "the recording cursor is a compact custom pointer, not the oversized hand");
check(rec.includes('from "../runtime/runActivity"') &&
  rec.includes("subscribeRunActivity") && rec.includes("isRunActive"),
  "the recorder subscribes to the app-wide run-activity signal");
check(rec.includes("jobJustEnded(prevActive, nowActive)") &&
  rec.includes("AUTO_STOP_DELAY_MS") && rec.includes("stop();"),
  "auto-stop arms on the job-end edge and stops after the delay");
check(rec.includes('data-ui="TutorialRecorderFps"') &&
  rec.includes('data-ui="TutorialRecorderAutoStop"'),
  "the FPS selector and auto-stop checkbox are rendered in the panel");
check(!rec.includes("recorder.start(250)"),
  "the broken 250ms fragmented-MP4 path is no longer the primary recorder");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`OK tutorial recorder fps + auto-stop: ${passed}/${passed} checks passed`);
