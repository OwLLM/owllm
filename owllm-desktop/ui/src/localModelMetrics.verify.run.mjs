// Regression guard for live local-model metrics. Auto-discovered by
// scripts/smoke-matrix.mjs, so a release cannot silently restore the old
// NVIDIA-only VRAM path or discard llama-server's authoritative tok/s timing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

const hardware = read("src-tauri/src/hardware.rs");
const shell = read("ui/src/AppShell.tsx");
const info = read("ui/src/pages/core/InfoPage.tsx");
const genStats = read("ui/src/utils/genStats.ts");
const dispatch = read("ui/src/pages/agentic/dispatch.ts");
const fineTune = read("ui/src/pages/finetuning/ChatPage.tsx");

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  passed += 1;
  console.log(`✓ ${message}`);
}

check(hardware.includes("macos_unified_vram_status")
  && hardware.includes("local_model_resident_mib")
  && hardware.includes("unified: true"),
"Apple Silicon reports the local model's unified-memory working set");
check(shell.includes("Unified model:") && info.includes("unified model memory"),
"the UI labels Apple unified memory honestly instead of calling it dedicated VRAM");
check(genStats.includes("predicted_per_second")
  && genStats.includes("exactToksPerSec") && genStats.includes("complete: true"),
"a completed stream can publish an authoritative final generation speed");
check(dispatch.includes("timingTokensPerSecond(j)") && dispatch.includes("onTiming"),
"the shared agentic/local SSE parser preserves llama-server timing");
check(fineTune.includes("timingTokensPerSecond(j)")
  && fineTune.includes("timingTokensPerSecond(fj)") && fineTune.includes("exactToksPerSec"),
"the fine-tuning chat's independent SSE loops preserve llama-server timing too");

console.log(`local-model metrics verification: ${passed}/${passed} passed`);
