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
check(rec.includes("createFinalizedVideoRecorder(videoTrack, fps, bitrate, handleEncoderFailure)"),
  "the recorder is told about encoder failures while it is still recording");

// --- 8. Finalized recorder behavior, executed against a stub muxer ----------
// A window/screen capture changes size whenever the user resizes, maximizes or
// drags the window to a display with different scaling. `sizeChangeBehavior:
// 'deny'` threw at finalize and DESTROYED the whole recording (reproduced in
// Chromium with a real captured surface). These checks run the real factory.
const stubDir = path.join(temp, "node_modules", "mediabunny");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({ name: "mediabunny", main: "index.js" }));
fs.writeFileSync(path.join(stubDir, "index.js"), `
const calls = { encodings: [], probes: [], source: null };
class BufferTarget { constructor() { this.buffer = new ArrayBuffer(8); } }
class Mp4OutputFormat { constructor(options) { this.options = options; } }
class WebMOutputFormat {}
class MediaStreamVideoTrackSource {
  constructor(track, encoding) {
    calls.encodings.push(encoding);
    this.errorPromise = new Promise((_resolve, reject) => { this.failNow = reject; });
    this.errorPromise.catch(() => {});
  }
  pause() {} resume() {} close() {}
}
class Output {
  constructor({ format, target }) { this.format = format; this.target = target; }
  addVideoTrack(source) { calls.source = source; }
  async start() {}
  async finalize() {}
  async cancel() {}
}
async function canEncodeVideo(codec, options) { calls.probes.push({ codec, options }); return codec === "avc"; }
module.exports = {
  BufferTarget, Mp4OutputFormat, WebMOutputFormat, MediaStreamVideoTrackSource, Output, canEncodeVideo,
  __calls: calls,
};
`);
const muxer = require(path.join(stubDir, "index.js"));
const recorderModule = require(transpileInto("tutorial/finalizedVideoRecorder.ts", "finalizedVideoRecorder.js"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A fresh display-capture track commonly reports no dimensions until its first
// frame arrives; bailing out there silently downgraded capture to the
// fragmented, unseekable MediaRecorder path this module exists to replace.
let reported = null;
const sizelessTrack = { kind: "video", getSettings: () => ({}) };
const recorder = await recorderModule.createFinalizedVideoRecorder(
  sizelessTrack, 30, 8_000_000, (error) => { reported = error; },
);
check(recorder !== null,
  "a capture track that reports no dimensions still gets the finalized WebCodecs recorder");
check(muxer.__calls.probes.length > 0 && muxer.__calls.probes[0].options.width === 1920,
  "encoder support is probed at a standard size instead of refusing the track");
check(muxer.__calls.encodings.length > 0
  && muxer.__calls.encodings.every(e => e.sizeChangeBehavior === "contain"),
  "resizing the captured window letterboxes into the original box instead of killing the recording");
check(muxer.__calls.encodings.length > 0
  && muxer.__calls.encodings.every(e => e.sizeChangeBehavior !== "deny"),
  "the size-change behavior that destroyed finished recordings is gone");

muxer.__calls.source.failNow(new Error("encoder died"));
await tick();
check(reported instanceof Error && /encoder died/.test(reported.message),
  "an encoder failure is reported the moment it happens, not an hour later at save time");

// Closing the source during a normal save must not be reported as a failure.
let lateReport = null;
muxer.__calls.encodings.length = 0;
const saved = await recorderModule.createFinalizedVideoRecorder(
  { kind: "video", getSettings: () => ({ width: 1280, height: 720 }) },
  30, 8_000_000, (error) => { lateReport = error; },
);
await saved.finalize();
muxer.__calls.source.failNow(new Error("closed during finalize"));
await tick();
check(lateReport === null,
  "closing the encoder during a normal save is not reported as a recording failure");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`OK tutorial recorder fps + auto-stop: ${passed}/${passed} checks passed`);
