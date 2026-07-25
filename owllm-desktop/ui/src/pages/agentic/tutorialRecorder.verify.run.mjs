// Focused verification for the Tutorial Recorder's two new controls: selectable
// capture FPS (so long videos don't fill the drive) and auto-stop 3s after a job
// finishes. Transpiles the real pure prefs module; no browser/React/Tauri
// runtime. Covers FPS clamp bounds, persistence/restore, the job-end transition
// edge, and the fps→bitrate mapping, plus source pins that the component threads
// the chosen FPS through the whole capture pipeline and arms the auto-stop off
// the shared runActivity signal (so a squash merge can't silently drop them).
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
check(prefs.DEFAULT_FPS === 30, "default FPS is 30 (unchanged prior behaviour)");
check(prefs.FPS_OPTIONS.includes(5) && prefs.FPS_OPTIONS.includes(60),
  "FPS options include a low 5 (small files) and a high 60");
for (const opt of prefs.FPS_OPTIONS) {
  check(prefs.clampFps(opt) === opt, `a valid option ${opt} clamps to itself`);
}
check(prefs.clampFps(7) === 5, "7 snaps to the nearest option (5)");
check(prefs.clampFps(1000) === 60, "an absurdly high value clamps to the max option (60)");
check(prefs.clampFps(NaN) === prefs.DEFAULT_FPS, "a non-finite FPS falls back to the default");

// --- 2. FPS persistence / restore ------------------------------------------
const s1 = memStore();
check(prefs.readFps(s1) === prefs.DEFAULT_FPS, "fresh install reads the default FPS");
prefs.saveFps(10, s1);
check(prefs.readFps(s1) === 10, "a chosen FPS persists and restores after a simulated restart");
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

// --- 6. Source pins ---------------------------------------------------------
const rec = readSrc("tutorial/TutorialRecorder.tsx");
check(rec.includes('from "./tutorialRecorderPrefs"'),
  "the recorder imports the pure prefs module");
check(rec.includes('requestDisplayStream("screen", fps)'),
  "the chosen FPS is passed to getDisplayMedia");
check(rec.includes("canvas.captureStream(fps)"),
  "the crop pipeline captures at the chosen FPS (not a hardcoded 30)");
check(rec.includes("videoBitsPerSecond: bitrateForFps(fps)"),
  "the MediaRecorder caps its bitrate to the chosen FPS");
check(rec.includes('from "../runtime/runActivity"') &&
  rec.includes("subscribeRunActivity") && rec.includes("isRunActive"),
  "the recorder subscribes to the app-wide run-activity signal");
check(rec.includes("jobJustEnded(prevActive, nowActive)") &&
  rec.includes("AUTO_STOP_DELAY_MS") && rec.includes("stop();"),
  "auto-stop arms on the job-end edge and stops after the delay");
check(rec.includes('data-ui="TutorialRecorderFps"') &&
  rec.includes('data-ui="TutorialRecorderAutoStop"'),
  "the FPS selector and auto-stop checkbox are rendered in the panel");
check(!/canvas\.captureStream\(30\)/.test(rec) && !/frameRate: 30\b/.test(rec),
  "no hardcoded 30fps remains in the capture pipeline");

fs.rmSync(temp, { recursive: true, force: true });
console.log(`OK tutorial recorder fps + auto-stop: ${passed}/${passed} checks passed`);
