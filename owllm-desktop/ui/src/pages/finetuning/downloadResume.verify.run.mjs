// Verify script (repo pattern — see modelPickerCollapse.verify.run.mjs):
// proves the Models-page auto-resume actually continues interrupted
// downloads instead of restarting at 0% or re-opening the quantization
// picker. Exercises the REAL downloadStore.ts with a controllable Tauri
// stub: the scan command, the per-file hf_download calls, and the
// resumedFrom offset on the Started event.
//
// Run from owllm-desktop/:  node ui/src/pages/finetuning/downloadResume.verify.run.mjs

import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const stubPlugin = {
  name: "stub-tauri",
  setup(b) {
    b.onResolve({ filter: /^@tauri-apps\// }, (args) => ({
      path: args.path,
      namespace: "tauri-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "tauri-stub" }, () => ({
      contents: `
        export const invoke = (...a) => globalThis.__verifyInvoke(...a);
        export class Channel {
          set onmessage(cb) { this.__cb = cb; }
          get onmessage() { return this.__cb; }
          emit(ev) { this.__cb && this.__cb(ev); }
        }
        export default {};
      `,
      loader: "js",
    }));
  },
};

const outDir = mkdtempSync(path.join(tmpdir(), "dl-resume-verify-"));
const outFile = path.join(outDir, "downloadStore.bundle.mjs");

await build({
  entryPoints: [new URL("./downloadStore.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
  plugins: [stubPlugin],
  logLevel: "silent",
});

// Browser globals the store touches at runtime.
globalThis.window = globalThis.window ?? { dispatchEvent: () => true };
globalThis.CustomEvent = globalThis.CustomEvent ?? class { constructor(type) { this.type = type; } };

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? (pass++, console.log("ok  ", name)) : (fail++, console.log("FAIL", name)); };
const tick = () => new Promise((r) => setTimeout(r, 20));

// ---- controllable IPC ----------------------------------------------------
const invokeLog = [];            // every { cmd, args } the store sends
const channels = new Map();      // "modelId|file" -> Channel (from hf_download)
let scanRows = [];               // what models_interrupted_downloads returns
let holdDownloads = true;        // hf_download stays pending until released
const releases = [];

globalThis.__verifyInvoke = (cmd, args) => {
  invokeLog.push({ cmd, args });
  if (cmd === "models_interrupted_downloads") return Promise.resolve(scanRows);
  if (cmd === "hf_download") {
    channels.set(`${args.modelId}|${args.file}`, args.channel);
    if (!holdDownloads) return Promise.resolve();
    return new Promise((resolve) => releases.push(resolve));
  }
  if (cmd === "hf_model_files") return Promise.resolve([]);
  return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
};

const store = await import(pathToFileURL(outFile).href);

// ---- scenario: one model mid-flight, one interrupted on disk --------------
// "busy/model" is already downloading this session; the scan also reports it
// (its .partial exists) — auto-resume must NOT double-start it.
void store.startDownload("busy/model", ["busy.gguf"]);
await tick();
check("in-flight model is marked active", store.isActive("busy/model"));

scanRows = [
  { modelId: "unsloth/Qwen-GGUF", file: "q4.gguf", bytesOnDisk: 120_000_000 },
  { modelId: "unsloth/Qwen-GGUF", file: "sub/q8.gguf", bytesOnDisk: 5_000 },
  { modelId: "busy/model", file: "busy.gguf", bytesOnDisk: 999 },
];

const resumed = await store.resumeInterrupted();
await tick();

check("resume reports the interrupted model's files (not the in-flight one)",
  resumed.length === 2 && resumed.every((r) => r.modelId === "unsloth/Qwen-GGUF"));

const hfCalls = invokeLog.filter((c) => c.cmd === "hf_download");
check("hf_download called once per interrupted file",
  hfCalls.filter((c) => c.args.modelId === "unsloth/Qwen-GGUF").length >= 1);
check("resume passes the exact partial file names (no re-listing, no picker)",
  hfCalls.some((c) => c.args.file === "q4.gguf") &&
  !invokeLog.some((c) => c.cmd === "hf_model_files"));
check("in-flight model NOT double-started by the scan",
  hfCalls.filter((c) => c.args.modelId === "busy/model").length === 1);

// Progress is pre-seeded at the on-disk offset BEFORE any HTTP event.
const seeded = store.getSnapshot().progress.get("unsloth/Qwen-GGUF");
check("progress banner seeded at bytesOnDisk, not 0",
  !!seeded && seeded.received === 120_000_000 && seeded.error === null);
check("resumed model marked active (banner shows, picker path skipped)",
  store.isActive("unsloth/Qwen-GGUF"));

// ---- Started event carries resumedFrom: bar keeps the real offset ---------
const ch = channels.get("unsloth/Qwen-GGUF|q4.gguf");
check("hf_download channel wired", !!ch && typeof ch.onmessage === "function");
ch.emit({ kind: "started", total: 415_000_000, resumedFrom: 120_000_000 });
let p = store.getSnapshot().progress.get("unsloth/Qwen-GGUF");
check("Started(resumedFrom) keeps received at the resumed offset",
  p.received === 120_000_000 && p.total === 415_000_000);

ch.emit({ kind: "progress", received: 200_000_000, total: 415_000_000 });
p = store.getSnapshot().progress.get("unsloth/Qwen-GGUF");
check("progress advances cumulatively from the offset", p.received === 200_000_000);

// A FRESH download's Started (resumedFrom: 0) still begins at 0.
const busyCh = channels.get("busy/model|busy.gguf");
busyCh.emit({ kind: "started", total: 100, resumedFrom: 0 });
check("fresh download still starts at 0",
  store.getSnapshot().progress.get("busy/model").received === 0);

// ---- one-shot guard: remounts don't rescan --------------------------------
const scansBefore = invokeLog.filter((c) => c.cmd === "models_interrupted_downloads").length;
const again = await store.resumeInterrupted();
check("second call (page remount) is a no-op",
  again.length === 0 &&
  invokeLog.filter((c) => c.cmd === "models_interrupted_downloads").length === scansBefore);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
