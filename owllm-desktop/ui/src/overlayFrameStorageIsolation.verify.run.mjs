// Focused verification for the overlay-frame memory leak fix.
//
// The decorative overlay window used to read `localStorage` for its accent and
// listen for `storage` events to track frame visibility. It is passive,
// occluded and click-through: it runs no tasks, so anything pushed into it is
// never drained. Measured live at ~45 MB/min of monotonic, never-GC'd growth,
// reaching ~4 GB in a session for a 12 KB static page — roughly 85% of the
// app's footprint, and the cause of system-wide paging stalls.
//
// IMPORTANT — do not "fix" this by re-reading localStorage here. Removing the
// overlay's own storage calls is necessary hygiene but is NOT what stops the
// growth: Blink replicates every localStorage mutation into every renderer
// hosting the origin, including documents that never touch storage and have no
// `storage` listener. Controlled measurement (three same-origin pages, separate
// renderers, one writing 1.4 MB 8x/s): writer 55 MB, two never-touching passive
// pages 944 MB and 903 MB. The actual cure is keeping large, hot-path payloads
// out of localStorage entirely — see HOT_BLOB_PREFIXES in runtime/stateMirror
// and hotBlobStorage.verify.run.mjs.
//
// It cannot use Tauri events either: the app's only capability is scoped to
// `windows: ["main"]` and `withGlobalTauri` is off, so `window.__TAURI__` is
// undefined there. Rust therefore pushes state in: the cold-boot accent via an
// initialization script, live changes via `eval`.
//
// These are source-level checks; no browser required.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const TAURI_SRC = path.join(DESKTOP, "src-tauri", "src");

const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`✓ ${message}`);
}

// --- the overlay page must be storage-free ---------------------------
// Strip comments first: the file DOCUMENTS why localStorage is forbidden, so a
// naive scan would match the explanation rather than real code.
const stripComments = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const overlayRaw = read(DESKTOP, "ui", "public", "overlay-frame.html");
const overlay = stripComments(overlayRaw);

check(!/\blocalStorage\b/.test(overlay),
  "overlay-frame.html never touches localStorage (binding it replicates every same-origin mutation into a renderer that never drains them)");
check(!/addEventListener\(\s*["']storage["']/.test(overlay),
  "overlay-frame.html registers no `storage` listener");
check(!/sessionStorage|indexedDB/.test(overlay),
  "overlay-frame.html uses no other origin-bound storage either");

// The old Tauri-event branches were dead code (no capability covers this
// window). Keeping them would invite a future author to 'restore' the
// localStorage path as a fallback when they silently fail.
check(!/__TAURI__/.test(overlay),
  "overlay-frame.html contains no dead __TAURI__ branch (the overlay has no IPC capability)");

// --- the replacement channels must exist -----------------------------
check(overlay.includes("window.__OWLLM_ACCENT__"),
  "overlay-frame.html reads its cold-boot accent from the Rust-injected global");
check(overlay.includes("window.__owllmSetAccent"),
  "overlay-frame.html exposes the accent hook Rust calls via eval");
check(overlay.includes("window.__owllmSetFrameVisible"),
  "overlay-frame.html exposes the frame-visibility hook Rust calls via eval");

const rust = read(TAURI_SRC, "overlay_frame.rs");
check(rust.includes("initialization_script"),
  "overlay_frame.rs injects the accent before any page script runs (race-free cold boot)");
check(rust.includes('mirrored_value("owllm:theme:accent")'),
  "overlay_frame.rs sources the cold-boot accent from the SQLite state mirror, not localStorage");
check(rust.includes("overlay_frame_set_accent") && rust.includes("__owllmSetAccent"),
  "overlay_frame.rs pushes live accent changes into the overlay by eval");
check(rust.includes("__owllmSetFrameVisible"),
  "overlay_frame.rs pushes frame visibility into the overlay by eval");

const mirror = read(TAURI_SRC, "state_mirror.rs");
check(/pub fn mirrored_value/.test(mirror),
  "state_mirror.rs exposes a single-key read so the overlay needn't load all ~4 MB of mirrored keys");

// --- the emitter side must not re-introduce a broadcast --------------
const shell = stripComments(read(DESKTOP, "ui", "src", "AppShell.tsx"));
check(!shell.includes("owllm:window-frame:visibility"),
  "AppShell no longer writes the frame-visibility key to localStorage (it had no readers left, and every write broadcast origin-wide)");
check(shell.includes('invoke("overlay_frame_set_visible"'),
  "AppShell drives frame visibility through the Rust command");

const theme = stripComments(read(DESKTOP, "ui", "src", "theme.ts"));
check(theme.includes('invoke("overlay_frame_set_accent"'),
  "theme.ts drives the overlay accent through the Rust command");
check(!theme.includes("owllm:accent-changed"),
  "theme.ts no longer emits the accent event the overlay could never receive");

// --- the commands must be reachable ----------------------------------
const lib = read(TAURI_SRC, "lib.rs");
for (const cmd of ["overlay_frame_set_accent", "overlay_frame_set_visible"]) {
  check(lib.includes(`overlay_frame::${cmd}`), `${cmd} is registered in the invoke handler`);
}

console.log(`OK overlay-frame storage isolation: ${passed}/${passed} checks passed`);
